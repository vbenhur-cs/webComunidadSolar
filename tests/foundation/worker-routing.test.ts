import assert from "node:assert/strict";
import test from "node:test";

import { routeBeforeAstro } from "../../src/lib/routing/before-astro.ts";

test("returns gone before Astro with the captured body and headers", async () => {
  const response = routeBeforeAstro(
    new Request("https://example.test/subvenciones"),
  );

  assert.equal(response?.status, 410);
  assert.equal(response?.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(
    response?.headers.get("content-type"),
    "text/plain; charset=utf-8",
  );
  assert.equal(response?.headers.get("x-robots-tag"), "noindex");
  assert.equal(
    await response?.text(),
    "Esta página ya no forma parte del catálogo de Comunidad Solar.",
  );
});

test("preserves query strings in permanent redirects", () => {
  const response = routeBeforeAstro(
    new Request("https://example.test/mision?utm_source=x"),
  );

  assert.equal(response?.status, 308);
  assert.equal(
    response?.headers.get("location"),
    "https://example.test/nosotros?utm_source=x#mision",
  );
  assert.equal(response?.headers.get("cache-control"), "public, max-age=3600");
});

test("keeps the legacy case and trailing-slash normalization", () => {
  const response = routeBeforeAstro(
    new Request("https://example.test/MISION///?campaign=legacy"),
  );

  assert.equal(response?.status, 308);
  assert.equal(
    response?.headers.get("location"),
    "https://example.test/nosotros?campaign=legacy#mision",
  );
});

test("serves retired Elementor descendants even when they were not enumerated", async () => {
  const response = routeBeforeAstro(
    new Request("https://example.test/blog/elementor-hf/future-widget"),
  );

  assert.equal(response?.status, 410);
  assert.equal(
    await response?.text(),
    "Esta página ya no forma parte del catálogo de Comunidad Solar.",
  );
});

test("leaves routes outside the legacy contract for Astro", () => {
  assert.equal(
    routeBeforeAstro(new Request("https://example.test/nosotros")),
    null,
  );
});
