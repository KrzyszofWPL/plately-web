import { getSiteMode } from "./lib/site-mode.js";

export const config = {
  matcher: [
    "/((?!api/|admin|maintenance\\.html|logo\\.png|LogoAPK\\.png|favicon\\.ico).*)",
  ],
};

export default async function middleware(request) {
  const mode = await getSiteMode();
  if (mode !== "maintenance") return;

  const { pathname } = new URL(request.url);
  if (pathname === "/" || pathname === "/index.html") {
    return Response.rewrite(new URL("/maintenance.html", request.url));
  }
  // Every other real site asset (support.js, image-slot.js, landing-i18n.js, ...)
  // is hidden while in maintenance mode so it can't be fetched directly either.
  return new Response("Not found", { status: 404 });
}
