// ============================================================================
// /api/status — what the public status page draws.
//
// Two answers in one response:
//
//   now      four components checked live, this second, with the round trip
//            in milliseconds
//   history  seven days of those same checks, rolled up per day in Postgres
//
// The checks are real requests to the real things, made from Vercel's edge and
// timed end to end. That is the only kind of check worth publishing: a status
// page that reports a boolean somebody flipped by hand is a status page that
// says "operational" through an outage, which is worse than having none — it
// spends the trust it exists to build.
//
// It follows that this endpoint can be wrong in one direction only. If Vercel
// itself is down, nothing here answers and the page says so plainly rather
// than pretending. There is no way around that short of hosting the status
// page somewhere else, which is a real option later and a lie to pretend we
// have taken now.
//
// Writing the history
// -------------------
// No cron job (Vercel Hobby gives one run a day, which is not a graph) and no
// monitoring vendor. Instead: every request checks live, and *at most one
// request every SAMPLE_EVERY_MS* also records what it found. History therefore
// accumulates from ordinary traffic to /status — free, and self-limiting under
// load, because a hundred simultaneous visitors still write one row each.
//
// The honest cost is that a quiet night leaves a gap, and a gap is not an
// outage. The page renders those days as "no data" instead of green.
// ============================================================================

import { select, insert, rpc, DbError } from "./_lib/db.js";
import { getSiteMode } from "../lib/site-mode.js";

// Pinned to one region, deliberately.
//
// An unpinned edge function runs nearest the *visitor*, so the same check took
// 90 ms from Warsaw and 340 ms from São Paulo — and both were written into the
// same history table as if they measured the same thing. The seven-day average
// was then a measure of where the readers were, not of how the service was
// doing, and a quiet night in Europe made the graph look like a regression.
//
// fra1 is Frankfurt: closest Vercel region to a Supabase EU project, so it also
// takes the longest hop out of the number that dominates the database check.
// If the database moves, this moves with it.
export const config = { runtime: "edge", regions: ["fra1"] };

const DAYS = 7;
const RETENTION_DAYS = 30;

// Five minutes between recorded samples: 288 points per component per day,
// which is enough to notice a fifteen-minute outage and small enough that a
// month of four components stays well inside a free Postgres.
const SAMPLE_EVERY_MS = 5 * 60 * 1000;

// A check that has not answered in eight seconds has failed as far as anyone
// waiting on it is concerned, and the function itself has a deadline.
const TIMEOUT_MS = 8000;

/**
 * The four things a customer would name if asked what Plately is made of.
 *
 * Not the four things the architecture is made of — nobody has an opinion
 * about PostgREST. `slow` is where "working" turns into "working badly", and
 * differs per component because a cold app shell and a single-row query have
 * no business sharing a threshold.
 */
function components() {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const resendKey = process.env.RESEND_API_KEY || "";
  const appUrl = process.env.APP_URL || "https://app.plately.eu/";

  return [
    {
      id: "site",
      slow: 1200,
      // robots.txt, because it is the one URL guaranteed to answer 200 in
      // every site mode — checking the homepage would report "down" during a
      // maintenance window, which is exactly when the page is being read.
      run: () => timed("https://www.plately.eu/robots.txt"),
    },
    {
      id: "app",
      slow: 2000,
      run: () => timed(appUrl),
    },
    {
      id: "database",
      slow: 800,
      run: () =>
        supabaseUrl && supabaseKey
          ? timed(`${supabaseUrl}/rest/v1/support_settings?select=key&limit=1`, {
              headers: supabaseKey.startsWith("eyJ")
                ? { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
                : { apikey: supabaseKey },
            })
          : unconfigured(),
    },
    {
      id: "mail",
      slow: 1500,
      // Resend's own domains list: reachable *and* our key still works, which
      // is the failure customers actually feel — a valid outage and an expired
      // key both end with nobody getting a reply.
      run: () =>
        resendKey
          ? timed("https://api.resend.com/domains", {
              headers: { Authorization: `Bearer ${resendKey}` },
            })
          : unconfigured(),
    },
  ];
}

function unconfigured() {
  return Promise.resolve({ configured: false, ok: false, ms: null, httpStatus: null });
}

/**
 * One request, timed.
 *
 * Any answer at all counts as reachable except a 5xx: a 404 from a URL we
 * chose is our mistake, not an outage, and reporting it as one would train
 * everybody to ignore the page.
 */
async function timed(url, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      // HEAD unless a caller asks for otherwise.
      //
      // Every check here asks one question — "does this answer, and how fast"
      // — and none of them reads the response. Downloading the body to throw
      // it away added the app shell's ~40 kB and the site's robots.txt to a
      // measurement that is supposed to be about reachability, which on a slow
      // connection is most of the number the status page prints.
      //
      // Time to first byte is also the honest thing to report: it is what a
      // visitor waits for before anything happens, and it is what every other
      // status page in the world means by "response time".
      method: "HEAD",
      ...init,
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // A host that refuses HEAD (405, or 501) has not told us anything about
    // whether it is up, so the check is repeated properly rather than filed as
    // an outage. Rare, and worth one extra round trip on the hosts it happens
    // to — the alternative is a red square for a service that is fine.
    if (res.status === 405 || res.status === 501) {
      // Timed from here, not from the rejected HEAD: the number is meant to be
      // what a visitor waits for, and no visitor pays for our probe choice.
      const retryStarted = Date.now();
      const retried = await fetch(url, {
        ...init,
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        configured: true,
        ok: retried.status < 500,
        ms: Date.now() - retryStarted,
        httpStatus: retried.status,
      };
    }
    return {
      configured: true,
      ok: res.status < 500,
      ms: Date.now() - started,
      httpStatus: res.status,
    };
  } catch {
    // No duration on a failure: see the note on latency_ms in the schema.
    return { configured: true, ok: false, ms: null, httpStatus: null };
  }
}

function verdict(result, slow) {
  if (!result.configured) return "unknown";
  if (!result.ok) return "down";
  return result.ms !== null && result.ms > slow ? "degraded" : "operational";
}

const RANK = { down: 3, degraded: 2, operational: 1, unknown: 0 };

/**
 * Seven days of roll-up, keyed by component, with the missing days present and
 * empty rather than absent — the chart draws seven columns either way, and a
 * day with no samples has to look different from a day at 100%.
 */
async function history() {
  const rows = await rpc("status_history", { p_days: DAYS });
  const byComponent = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!byComponent.has(row.component)) byComponent.set(row.component, new Map());
    byComponent.get(row.component).set(row.day, row);
  }

  const today = new Date();
  const days = [];
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    days.push(d.toISOString().slice(0, 10));
  }

  return (id) => {
    const found = byComponent.get(id) || new Map();
    return days.map((date) => {
      const row = found.get(date);
      if (!row) return { date, samples: 0, uptime: null, avgMs: null, maxMs: null };
      return {
        date,
        samples: Number(row.samples) || 0,
        uptime: row.uptime === null ? null : Number(row.uptime),
        avgMs: row.avg_ms === null ? null : Number(row.avg_ms),
        maxMs: row.max_ms === null ? null : Number(row.max_ms),
      };
    });
  };
}

/** Weighted by sample count, so a busy day is not outvoted by a quiet one. */
function rollup(days) {
  let samples = 0;
  let up = 0;
  let latencySum = 0;
  let latencyDays = 0;
  for (const day of days) {
    if (!day.samples) continue;
    samples += day.samples;
    if (day.uptime !== null) up += (day.uptime / 100) * day.samples;
    if (day.avgMs !== null) {
      latencySum += day.avgMs * day.samples;
      latencyDays += day.samples;
    }
  }
  return {
    uptime: samples ? Math.round((up / samples) * 10000) / 100 : null,
    avgMs: latencyDays ? Math.round(latencySum / latencyDays) : null,
    samples,
  };
}

/**
 * Records this round of checks, but only if the last one is old enough.
 *
 * Read-then-write with no lock, so two requests arriving in the same
 * millisecond can both decide to write. That is fine: the cost is one extra
 * row, and the alternative — a lock, or an advisory sequence — is real
 * machinery to prevent an outcome nobody can see on a graph.
 */
async function recordIfDue(results) {
  const latest = await select("status_samples", "select=checked_at&order=checked_at.desc&limit=1");
  const last = Array.isArray(latest) && latest.length ? Date.parse(latest[0].checked_at) : 0;
  if (Number.isFinite(last) && Date.now() - last < SAMPLE_EVERY_MS) return false;

  const rows = results
    .filter((r) => r.result.configured)
    .map((r) => ({
      component: r.id,
      ok: r.result.ok,
      latency_ms: r.result.ms,
      http_status: r.result.httpStatus,
    }));
  if (!rows.length) return false;

  await insert("status_samples", rows, { returning: false });

  // Retention, on roughly one write in fifty. Deleting a month of rows on
  // every sample would make the cheapest request on the site the most
  // expensive query in the database; a cron job for it would cost the one
  // daily run this plan has. Probabilistic is the third option, and the only
  // thing it needs to be is eventual.
  if (Math.random() < 0.02) {
    await rpc("status_prune", { p_keep_days: RETENTION_DAYS }).catch(() => {});
  }
  return true;
}

export default async function handler() {
  const defs = components();

  // All four at once. Sequentially this would take as long as the sum of the
  // four, and the slowest of them is the number the page is about.
  //
  // The history roll-up and the site mode start here too rather than after,
  // for the same reason: they are two more independent round trips to the same
  // database, and waiting for the checks first simply added their duration to
  // the page. Neither is allowed to fail the request — see below.
  const historyPromise = history().then(
    (lookup) => ({ lookup, error: null }),
    (error) => ({ lookup: null, error })
  );
  const modePromise = getSiteMode().catch(() => "live");

  const settled = await Promise.all(defs.map(async (c) => ({ ...c, result: await c.run() })));

  const mode = await modePromise;

  // Everything below is optional. A deployment with no database still gets a
  // working status page — live checks, no graph — which matters, because "the
  // database is unreachable" is precisely a moment somebody loads this page.
  let lookup = () => [];
  let historyAvailable = false;
  let historyNote = null;
  let recorded = false;

  try {
    const settledHistory = await historyPromise;
    if (settledHistory.error) throw settledHistory.error;
    lookup = settledHistory.lookup;
    historyAvailable = true;
    recorded = await recordIfDue(settled);
  } catch (err) {
    // Three different things, and telling them apart is the difference between
    // a note somebody can act on and a shrug: the SQL has not been run, the
    // database is genuinely unreachable, or this deployment simply has no
    // Supabase credentials — which is a normal state for a fork of the repo.
    historyNote =
      err instanceof DbError && err.isMissingSchema
        ? "schema-missing"
        : /are not set/.test(String(err && err.message))
          ? "unconfigured"
          : err instanceof DbError
            ? "database-unreachable"
            : "unconfigured";
  }

  const components_ = settled.map(({ id, slow, result }) => {
    const days = lookup(id);
    const summary = rollup(days);
    return {
      id,
      status: verdict(result, slow),
      latencyMs: result.ms,
      httpStatus: result.httpStatus,
      slowAboveMs: slow,
      uptime7d: summary.uptime,
      avg7dMs: summary.avgMs,
      samples7d: summary.samples,
      days,
    };
  });

  const counts = components_.reduce(
    (acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }),
    { operational: 0, degraded: 0, down: 0, unknown: 0, total: components_.length }
  );

  // The worst component decides the headline, with two exceptions.
  //
  // An announced maintenance window is not an outage, and calling it one on
  // the page whose whole job is to tell those apart would be backwards.
  //
  // And "unknown" must never be swallowed into "everything is fine". A
  // component we could not check is not a component that passed; the page says
  // so rather than printing a green tick over a measurement that never
  // happened.
  let overall = components_.reduce(
    (worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst),
    "operational"
  );
  if (overall === "operational" && counts.unknown > 0) overall = "partial";
  if (mode === "maintenance") overall = "maintenance";

  return new Response(
    JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      overall,
      counts,
      mode,
      windowDays: DAYS,
      history: { available: historyAvailable, note: historyNote, recorded },
      components: components_,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // Thirty seconds at the edge. Long enough that a page left open, or a
        // link doing the rounds during an incident, does not turn into a load
        // test on the very systems it is reporting; short enough that "is it
        // back yet" gets a fresh answer.
        "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
        "X-Robots-Tag": "noindex",
      },
    }
  );
}
