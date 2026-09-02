import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pins the Astro and Cloudflare runtime that supports custom fetch in dev", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.engines.node, ">=22.12.0");
  assert.equal(pkg.dependencies.astro, "7.2.10");
  assert.equal(pkg.dependencies["@astrojs/cloudflare"], "14.2.6");
  assert.equal(pkg.dependencies.next, undefined);
  assert.equal(pkg.dependencies.vinext, undefined);
  assert.match(
    pkg.scripts.dev,
    /CLOUDFLARE_CONFIG_PATH=\.\/wrangler\.dev\.jsonc astro dev/,
  );
  for (const script of [
    pkg.scripts.dev,
    pkg.scripts.check,
    pkg.scripts.build,
  ]) {
    assert.match(
      script,
      /wrangler types --env-file \.\/config\/wrangler-types\.env/,
    );
  }

  const typesEnvironment = await readFile("config/wrangler-types.env", "utf8");
  assert.match(typesEnvironment, /intentionally empty/i);
  assert.doesNotMatch(typesEnvironment, /=/);
  assert.match(
    pkg.scripts.build,
    /CLOUDFLARE_ENV="\$\{CLOUDFLARE_ENV-\}" CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false astro build/,
  );
  assert.match(pkg.scripts.build, /tsx scripts\/verify-build-output\.ts$/);

  const astroConfig = await readFile("astro.config.mjs", "utf8");
  assert.match(astroConfig, /output:\s*["']server["']/);
  assert.match(astroConfig, /cloudflare\(/);

  const devConfig = await readFile("wrangler.dev.jsonc", "utf8");
  assert.match(devConfig, /"directory"\s*:\s*"\.\/public"/);
  assert.match(devConfig, /"run_worker_first"\s*:\s*false/);

  const unitRunner = await readFile("scripts/run-unit-tests.ts", "utf8");
  assert.match(unitRunner, /--test-concurrency=2/);
});
