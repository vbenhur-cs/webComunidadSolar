export const legacyGoneBody =
  "Esta página ya no forma parte del catálogo de Comunidad Solar.";

export const legacyGoneHeaders = {
  "cache-control": "public, max-age=3600",
  "content-type": "text/plain; charset=utf-8",
  "x-robots-tag": "noindex",
} as const;

export function legacyGoneResponse(): Response {
  return new Response(legacyGoneBody, {
    status: 410,
    headers: legacyGoneHeaders,
  });
}
