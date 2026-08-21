import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSourceManifest,
  buildRouteMatrix,
  readExistingRouteMatrix,
  serializeSourceManifest,
  writeSourceManifest,
} from "./lib/route-inventory.ts";

type CaptureMode = "--check" | "--write";

function parseMode(args: string[]): CaptureMode {
  if (args.length === 0) return "--check";
  if (args.length === 1 && (args[0] === "--check" || args[0] === "--write")) {
    return args[0];
  }
  throw new Error("parity:manifest solo acepta --check o --write");
}

export async function captureSourceManifest(args: string[]): Promise<void> {
  const mode = parseMode(args);
  const root = process.cwd();
  const manifestPath = resolve(root, "parity/source-manifest.json");

  if (mode === "--write") {
    const manifest = await buildSourceManifest();
    await writeSourceManifest(manifest, { root });
    process.stdout.write(`SOURCE_MANIFEST_WRITTEN ${manifest.routes.length}\n`);
    return;
  }

  const frozen = JSON.parse(await readFile(manifestPath, "utf8")) as {
    generatedAt?: unknown;
  };
  if (typeof frozen.generatedAt !== "string") {
    throw new Error("parity/source-manifest.json no contiene generatedAt");
  }
  const manifest = await buildSourceManifest({
    generatedAt: frozen.generatedAt,
  });
  assert.deepEqual(
    JSON.parse(await readFile(manifestPath, "utf8")),
    manifest,
    "El manifiesto fuente cambió; ejecuta npm run parity:manifest -- --write",
  );

  const matrix = await readExistingRouteMatrix(root);
  assert.deepEqual(
    matrix,
    buildRouteMatrix(manifest, matrix),
    "La matriz de rutas cambió; ejecuta npm run parity:manifest -- --write",
  );
  process.stdout.write(`SOURCE_MANIFEST_OK ${manifest.routes.length}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  captureSourceManifest(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { serializeSourceManifest };
