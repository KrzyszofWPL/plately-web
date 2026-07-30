import { getSiteMode } from "./lib/site-mode.js";

export const config = {
  matcher: [
    "/((?!api/|admin|maintenance\\.html|logo\\.png|LogoAPK\\.png|favicon\\.ico).*)",
  ],
};

export default async function middleware(request) {
  const mode = await getSiteMode();
  if (mode !== "maintenance") {
    // No framework runtime is present to interpret a bare `return`, so
    // explicitly signal "pass the request through unmodified".
    return new Response(null, { headers: { "x-middleware-next": "1" } });
  }

  const { pathname } = new URL(request.url);
  if (pathname === "/" || pathname === "/index.html") {
    // Response.rewrite() only exists on Next.js's NextResponse. This project
    // has no framework, so rewrite via the low-level header the platform
    // itself understands.
    return new Response(null, {
      headers: { "x-middleware-rewrite": new URL("/maintenance.html", request.url).toString() },
    });
  }
  // Every other real site asset (support.js, image-slot.js, landing-i18n.js, ...)
  // is hidden while in maintenance mode so it can't be fetched directly either.
  return new Response("Not found", { status: 404 });
}
