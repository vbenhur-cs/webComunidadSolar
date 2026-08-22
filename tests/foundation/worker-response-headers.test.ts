import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeAstroStaticHtmlResponse,
  normalizeWorkerResponse,
} from "../../src/lib/routing/response-headers.ts";

test("removes only Wrangler Assets' automatic cache header from static HTML", async () => {
  const normalized = normalizeAstroStaticHtmlResponse(
    new Response("<main>contenido público</main>", {
      status: 200,
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "content-type": "text/html; charset=utf-8",
        etag: '"asset-etag"',
      },
    }),
  );

  assert.equal(normalized.headers.get("cache-control"), null);
  assert.equal(
    normalized.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assert.equal(normalized.headers.get("etag"), '"asset-etag"');
  assert.equal(await normalized.text(), "<main>contenido público</main>");
});

test("preserves source-owned cache directives and non-HTML asset cache behavior", () => {
  const redirect = normalizeAstroStaticHtmlResponse(
    new Response(null, {
      status: 308,
      headers: {
        "cache-control": "public, max-age=3600",
        location: "/nosotros",
      },
    }),
  );
  const asset = normalizeAstroStaticHtmlResponse(
    new Response(new Uint8Array([0, 1, 2]), {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "content-type": "image/png",
      },
    }),
  );

  assert.equal(redirect.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(
    asset.headers.get("cache-control"),
    "public, max-age=0, must-revalidate",
  );
});

test("normalizes the robots content type only on the exact static route", () => {
  const robots = normalizeWorkerResponse(
    new Request("https://comunidadsolar.es/robots.txt"),
    new Response(new TextEncoder().encode("User-Agent: *\n"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
  const otherText = normalizeWorkerResponse(
    new Request("https://comunidadsolar.es/notes.txt"),
    new Response(new TextEncoder().encode("nota"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );

  assert.equal(robots.headers.get("content-type"), "text/plain");
  assert.equal(
    otherText.headers.get("content-type"),
    "text/plain; charset=utf-8",
  );
});

test("routes static assets through the Worker before Assets applies its response defaults", async () => {
  const config = await readFile(
    new URL("../../wrangler.jsonc", import.meta.url),
    "utf8",
  );

  assert.match(config, /"run_worker_first"\s*:\s*true/);
});
