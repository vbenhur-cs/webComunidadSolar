import { routeBeforeAstro } from "../routing/before-astro";
import { normalizeWorkerResponse } from "../routing/response-headers";
import {
  needsPrivateResponseHeaders,
  privateResponseHeaders,
} from "./private-headers";

function responseWithPrivateHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(privateResponseHeaders)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.clone().body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Applies response-level parity adjustments after Astro has produced a route.
 * Existing route-owned directives win: source route handlers already emit more
 * specific cache/indexation headers for their dynamic and download responses.
 */
export function applyResponsePolicy(
  request: Request,
  response: Response,
): Response {
  const normalized = normalizeWorkerResponse(request, response);
  return needsPrivateResponseHeaders(request)
    ? responseWithPrivateHeaders(normalized)
    : normalized;
}

/**
 * Keeps legacy redirects and gone responses ahead of Astro, then composes the
 * existing Worker normalizer with the private response policy.
 */
export async function runWorkerResponsePipeline(
  request: Request,
  handleAstro: () => Response | Promise<Response>,
): Promise<Response> {
  const early = routeBeforeAstro(request);
  if (early) return early;
  return applyResponsePolicy(request, await handleAstro());
}
