// ============================================================================
// Turning a 500 into a sentence somebody can act on.
//
// The three route files all end in the same catch, and it used to answer
// "Something went wrong on our side" to everything. For a genuine fault that
// is the right answer — a stack trace is not the visitor's business. But the
// most common way this project breaks is not a fault at all: it is a step of
// the setup that has not been run, and for those the generic message is a dead
// end. The person sees a shrug, and the one fact that would have fixed it in
// thirty seconds is sitting in a Vercel log they have no reason to open.
//
// This is the same judgement api/_lib/staff-session.js already makes for
// Cloudflare's error codes, and the test for it is the same: a message may be
// shown when it describes OUR misconfiguration and nothing about the visitor
// or the data. A missing environment variable and an uninstalled table both
// pass that test. A constraint violation carrying somebody's e-mail address
// does not, which is why only the "does not exist" family is unwrapped here.
// ============================================================================

import { DbError } from "./db.js";

const RUN_THE_SQL =
  "the database schema is out of date — open Supabase → SQL Editor and run " +
  "supabase/support-schema.sql (it is safe to re-run)";

/**
 * A message for the browser, or null to keep the generic one.
 *
 * Returns null for anything that is not recognisably a setup problem, so an
 * unexpected fault still says nothing it should not.
 */
export function explainSetupFailure(err) {
  if (!err) return null;

  // Missing configuration throws a plain Error from the module that needed it.
  // These names are ours and are safe to repeat verbatim.
  const message = String(err.message || "");
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SESSION_SECRET",
    "PEPPER",
    "RESEND_API_KEY",
  ]) {
    if (message.includes(name)) {
      return `${name} is not set on this deployment. Add it in Vercel → Settings → ` +
        "Environment Variables, then redeploy — Vercel only hands new values to new deployments.";
    }
  }

  if (err instanceof DbError || err.name === "DbError") {
    if (err.isMissingSchema) {
      // The Postgres message names the exact table, column or function, which
      // is the difference between "run the SQL" and "run the SQL, and here is
      // which part of it you are missing".
      return err.pgMessage ? `${RUN_THE_SQL}. Postgres said: ${err.pgMessage}` : RUN_THE_SQL;
    }
    if (err.status === 401 || err.status === 403) {
      return "Supabase refused the service-role key. Check SUPABASE_SERVICE_ROLE_KEY in " +
        "Vercel — it must be the service_role (or sb_secret_…) key, never the anon or publishable one.";
    }
    if (err.status === 500) {
      return "SUPABASE_URL does not point at a working project, or the project is paused.";
    }
  }

  return null;
}
