import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { verifyBuildOutput } from "../../scripts/verify-build-output.ts";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "build-output-test-"));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("accepts a build without local environment artifacts or credentials", async () => {
  const root = await fixture();
  await mkdir(join(root, "server"));
  await writeFile(join(root, "server", "entry.mjs"), "export default {};\n");

  await verifyBuildOutput(root, ["synthetic-never-present-token"]);
});

test("rejects a copied local environment file without exposing its values", async () => {
  const root = await fixture();
  await mkdir(join(root, "server"));
  await writeFile(
    join(root, "server", ".dev.vars"),
    "CLOUDFLARE_API_TOKEN=synthetic-never-print\n",
  );

  await assert.rejects(verifyBuildOutput(root, []), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /archivo local de entorno/i);
    assert.doesNotMatch(message, /synthetic-never-print/);
    return true;
  });
});

test("rejects an operator credential embedded in the build without printing it", async () => {
  const root = await fixture();
  const token = "synthetic-operator-token-never-print";
  await writeFile(
    join(root, "worker.mjs"),
    `export default ${JSON.stringify(token)};\n`,
  );

  await assert.rejects(verifyBuildOutput(root, [token]), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /credencial de operador/i);
    assert.doesNotMatch(message, new RegExp(token));
    return true;
  });
});
