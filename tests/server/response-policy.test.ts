import assert from "node:assert/strict";
import test from "node:test";

import {
  applyResponsePolicy,
  runWorkerResponsePipeline,
} from "../../src/lib/http/response-policy.ts";

const privateHeaders = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive, noimageindex",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

test("applies the original private headers only to the four source patterns", async () => {
  for (const path of [
    "/socios",
    "/socios/",
    "/socios/recursos",
    "/guia-equipo",
    "/guia-equipo-nueva-web-comunidad-solar.md",
  ]) {
    const original = new Response("private response", {
      status: 201,
      statusText: "Created",
      headers: { "x-source-header": "preserved" },
    });
    const result = applyResponsePolicy(
      new Request(`https://example.test${path}`),
      original,
    );

    assert.notStrictEqual(result, original, path);
    assert.equal(result.status, 201, path);
    assert.equal(result.statusText, "Created", path);
    assert.equal(result.headers.get("x-source-header"), "preserved", path);
    for (const [name, value] of Object.entries(privateHeaders)) {
      assert.equal(result.headers.get(name), value, `${path} ${name}`);
      assert.equal(
        original.headers.get(name),
        null,
        `${path} original ${name}`,
      );
    }
    assert.equal(await result.text(), "private response", path);
    assert.equal(await original.text(), "private response", `${path} original`);
  }
});

test("leaves public and prefix-lookalike responses untouched", () => {
  for (const path of [
    "/",
    "/socioses",
    "/guia-equipos",
    "/guia-equipo/archivo",
    "/guia-equipo-nueva-web-comunidad-solar.md/extra",
  ]) {
    const original = new Response("public response");
    assert.strictEqual(
      applyResponsePolicy(new Request(`https://example.test${path}`), original),
      original,
      path,
    );
  }
});

test("preserves source-owned private directives while filling missing exact headers", () => {
  const result = applyResponsePolicy(
    new Request("https://example.test/socios"),
    new Response("source response", {
      headers: {
        "cache-control": "no-store, must-revalidate",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    }),
  );

  assert.equal(
    result.headers.get("cache-control"),
    "no-store, must-revalidate",
  );
  assert.equal(
    result.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
});

test("does not consume the original response when normalizing a private static HTML response", async () => {
  const original = new Response("static private response", {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": "text/html; charset=utf-8",
    },
  });
  const result = applyResponsePolicy(
    new Request("https://example.test/socios"),
    original,
  );

  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(await result.text(), "static private response");
  assert.equal(await original.text(), "static private response");
});

test("composes normalization and private policy after legacy routes retain precedence", async () => {
  let handled = 0;
  const redirect = await runWorkerResponsePipeline(
    new Request("https://example.test/mision?utm_source=x"),
    async () => {
      handled += 1;
      return new Response("unexpected handler");
    },
  );
  assert.equal(redirect.status, 308);
  assert.equal(
    redirect.headers.get("location"),
    "https://example.test/nosotros?utm_source=x#mision",
  );

  const gone = await runWorkerResponsePipeline(
    new Request("https://example.test/subvenciones"),
    async () => {
      handled += 1;
      return new Response("unexpected handler");
    },
  );
  assert.equal(gone.status, 410);
  assert.equal(handled, 0);

  const privateHtml = await runWorkerResponsePipeline(
    new Request("https://example.test/socios"),
    async () => {
      handled += 1;
      return new Response("private html", {
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          "content-type": "text/html; charset=utf-8",
        },
      });
    },
  );
  assert.equal(handled, 1);
  assert.equal(privateHtml.headers.get("cache-control"), "private, no-store");
  assert.equal(
    privateHtml.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive, noimageindex",
  );

  const robots = await runWorkerResponsePipeline(
    new Request("https://example.test/robots.txt"),
    async () =>
      new Response("User-agent: *\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
  );
  assert.equal(robots.headers.get("content-type"), "text/plain");
});
