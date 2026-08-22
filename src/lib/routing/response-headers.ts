const wranglerStaticAssetCacheControl = "public, max-age=0, must-revalidate";

/**
 * Wrangler Assets adds this cache header to static files after Astro has
 * produced them. Source HTML did not own that header, so strip only that
 * exact Assets default from HTML responses. Redirects and non-HTML assets
 * retain their source-owned or platform-owned directives.
 */
export function normalizeAstroStaticHtmlResponse(response: Response): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (
    !contentType.startsWith("text/html") ||
    response.headers.get("cache-control") !== wranglerStaticAssetCacheControl
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("cache-control");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * The Assets binding derives a charset from the `.txt` extension. The source
 * endpoint explicitly captured `robots.txt` as `text/plain`, so keep this
 * exception route-scoped instead of changing generic text responses.
 */
export function normalizeWorkerResponse(
  request: Request,
  response: Response,
): Response {
  const htmlNormalized = normalizeAstroStaticHtmlResponse(response);

  if (
    new URL(request.url).pathname !== "/robots.txt" ||
    htmlNormalized.headers.get("content-type")?.toLowerCase() !==
      "text/plain; charset=utf-8"
  ) {
    return htmlNormalized;
  }

  const headers = new Headers(htmlNormalized.headers);
  headers.set("content-type", "text/plain");
  return new Response(htmlNormalized.body, {
    headers,
    status: htmlNormalized.status,
    statusText: htmlNormalized.statusText,
  });
}
