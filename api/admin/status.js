import { verifySession } from "../_lib/auth.js";
import { getSiteMode } from "../../lib/site-mode.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  const authed = await verifySession(request);
  if (!authed) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  const mode = await getSiteMode();
  return new Response(JSON.stringify({ ok: true, mode }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
