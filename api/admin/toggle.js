import { verifySession } from "../_lib/auth.js";
import { setSiteMode } from "../../lib/site-mode.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  const authed = await verifySession(request);
  if (!authed) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const { mode } = await request.json().catch(() => ({}));
  if (mode !== "live" && mode !== "maintenance") {
    return new Response(JSON.stringify({ error: "Invalid mode" }), { status: 400 });
  }

  try {
    await setSiteMode(mode);
  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to update mode", details: String(err) }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true, mode }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
