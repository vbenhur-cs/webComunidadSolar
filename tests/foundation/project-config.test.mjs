import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pins the approved Astro and Cloudflare runtime", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.engines.node, ">=22.12.0");
  assert.equal(pkg.dependencies.astro, "7.2.4");
  assert.equal(pkg.dependencies["@astrojs/cloudflare"], "14.2.3");
  assert.equal(pkg.dependencies.next, undefined);
  assert.equal(pkg.dependencies.vinext, undefined);

  const astroConfig = await readFile("astro.config.mjs", "utf8");
  assert.match(astroConfig, /output:\s*["']server["']/);
  assert.match(astroConfig, /cloudflare\(/);
});
