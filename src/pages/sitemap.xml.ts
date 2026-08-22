import type { APIRoute } from "astro";

import { buildSitemap } from "../lib/site/sitemap.ts";

export const prerender = true;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export const GET: APIRoute = () => {
  const entries = buildSitemap(new Date());
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.flatMap((entry) => [
      "<url>",
      `<loc>${escapeXml(entry.url)}</loc>`,
      `<lastmod>${entry.lastModified.toISOString()}</lastmod>`,
      `<changefreq>${entry.changeFrequency}</changefreq>`,
      `<priority>${entry.priority}</priority>`,
      "</url>",
    ]),
    "</urlset>",
    "",
  ].join("\n");
  return new Response(body, {
    headers: { "content-type": "application/xml" },
  });
};
