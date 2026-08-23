export const privateResponseHeaders = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive, noimageindex",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export function needsPrivateResponseHeaders(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (
    pathname === "/socios" ||
    pathname.startsWith("/socios/") ||
    pathname === "/guia-equipo" ||
    pathname === "/guia-equipo-nueva-web-comunidad-solar.md" ||
    pathname === "/manganafer/interesados"
  );
}
