// ============================================================================
// The only way this project talks to Postgres.
//
// PostgREST over fetch rather than a Postgres driver, because these are Edge
// Functions: no TCP sockets, no connection pool, nothing to keep warm. The
// service-role key bypasses Row Level Security, which is exactly why it may
// never reach a browser — every caller here runs on Vercel, never in the page.
//
// Every helper throws DbError on a non-2xx so a route handler can let it
// bubble and the top-level catch turns it into one consistent JSON shape.
// ============================================================================

export class DbError extends Error {
  constructor(status, detail) {
    super(`Supabase ${status}: ${detail}`);
    this.name = "DbError";
    this.status = status;
    this.detail = detail;
    // PostgREST answers with JSON carrying a Postgres SQLSTATE. Parsing it
    // once here is what lets a caller tell "the schema has not been installed"
    // apart from "the query is wrong", which are the same 400 otherwise.
    try {
      const body = JSON.parse(detail);
      this.code = body.code || null;
      this.pgMessage = body.message || null;
    } catch {
      this.code = null;
      this.pgMessage = null;
    }
  }

  /**
   * True when the database answered correctly and the answer was "that does
   * not exist here" — a missing table, column or function. Always a
   * deployment step somebody has not run yet, never a visitor's doing.
   *
   *   42P01 undefined_table   42703 undefined_column
   *   42883 undefined_function                PGRST202 unknown RPC
   */
  get isMissingSchema() {
    return ["42P01", "42703", "42883", "PGRST202", "PGRST204"].includes(this.code);
  }
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new DbError(500, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/** Raw PostgREST call. `path` starts with a slash, e.g. "/support_tickets?..." */
async function request(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    // PostgREST caches nothing by default, but Vercel's fetch does; an inbox
    // that answers with a stale list is worse than a slow one.
    "Cache-Control": "no-store",
  };
  // Supabase has two generations of server-side key and they travel
  // differently. The legacy `service_role` key is a JWT and PostgREST expects
  // it as a bearer token. The newer `sb_secret_…` keys are not JWTs at all —
  // sent as a bearer token they come back rejected with "Invalid JWT", so they
  // ride on the `apikey` header alone. Sniffing the JWT prefix means either
  // generation works without anyone having to remember which is in use.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) throw new DbError(res.status, text.slice(0, 800));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * SELECT. `query` is a PostgREST query string without the leading "?".
 *   select("staff", "select=*&active=is.true&order=created_at.desc")
 */
export function select(table, query = "") {
  return request(`/${table}${query ? `?${query}` : ""}`);
}

/** SELECT that expects at most one row, and returns null instead of []. */
export async function selectOne(table, query = "") {
  const rows = await request(`/${table}${query ? `?${query}&` : "?"}limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function insert(table, rows, { returning = true } = {}) {
  const out = await request(`/${table}`, {
    method: "POST",
    body: rows,
    prefer: returning ? "return=representation" : "return=minimal",
  });
  if (!returning) return null;
  return Array.isArray(rows) ? out : out?.[0] ?? null;
}

export async function update(table, query, patch, { returning = true } = {}) {
  const out = await request(`/${table}?${query}`, {
    method: "PATCH",
    body: patch,
    prefer: returning ? "return=representation" : "return=minimal",
  });
  if (!returning) return null;
  return Array.isArray(out) ? out[0] ?? null : out;
}

export async function remove(table, query) {
  return request(`/${table}?${query}`, { method: "DELETE", prefer: "return=minimal" });
}

/** Calls a Postgres function. The heavy queries all live there, not here. */
export function rpc(fn, args = {}) {
  return request(`/rpc/${fn}`, { method: "POST", body: args });
}

/** PostgREST reserves , . : ( ) and quotes inside filter values. */
export function q(value) {
  return encodeURIComponent(String(value));
}
