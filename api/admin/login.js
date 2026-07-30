import { hmacHex, timingSafeEqual } from "../_lib/auth.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
  const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
  const PEPPER = process.env.PEPPER;
  const SESSION_SECRET = process.env.SESSION_SECRET;

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH || !PEPPER || !SESSION_SECRET) {
    return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500 });
  }

  const { username, password } = await request.json().catch(() => ({}));
  if (!username || !password) {
    return new Response(JSON.stringify({ error: "Missing credentials" }), { status: 400 });
  }

  const candidateHash = await hmacHex(PEPPER, password);
  const validUser = timingSafeEqual(username, ADMIN_USERNAME);
  const validPass = timingSafeEqual(candidateHash, ADMIN_PASSWORD_HASH);

  // Always compare both to avoid leaking which field was wrong via timing.
  if (!validUser || !validPass) {
    return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401 });
  }

  const exp = String(Date.now() + 12 * 60 * 60 * 1000); // 12h session
  const sig = await hmacHex(SESSION_SECRET, exp);
  const token = `${exp}.${sig}`;

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
    },
  });
}
