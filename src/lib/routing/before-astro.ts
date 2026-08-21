import { getLegacyRedirect, isLegacyGonePath } from "./legacy";
import { legacyGoneResponse } from "./gone";

const redirectHeaders = { "cache-control": "public, max-age=3600" };

export function routeBeforeAstro(request: Request): Response | null {
  const url = new URL(request.url);

  if (isLegacyGonePath(url.pathname)) return legacyGoneResponse();

  const destinationPath = getLegacyRedirect(url.pathname);
  if (destinationPath === undefined) return null;

  const destination = new URL(destinationPath, url.origin);
  destination.search = url.search;
  return new Response(null, {
    status: 308,
    headers: {
      ...redirectHeaders,
      location: destination.toString(),
    },
  });
}
