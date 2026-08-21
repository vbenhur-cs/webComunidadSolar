import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSourcePristine,
  resolveSourceRoot,
} from "./lib/source-reference.ts";

async function sourceExists(sourceRoot: string): Promise<boolean> {
  try {
    await stat(sourceRoot);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function sourceCheck(args: string[]): Promise<void> {
  if (args.some((argument) => argument !== "--if-present")) {
    throw new Error("source-check solo acepta --if-present");
  }
  if (args.filter((argument) => argument === "--if-present").length > 1) {
    throw new Error("source-check recibió --if-present más de una vez");
  }

  const discoveredAutomatically =
    process.env.COMUNIDADSOLAR_SOURCE_ROOT === undefined;
  const sourceRoot = await resolveSourceRoot();
  if (!(await sourceExists(sourceRoot))) {
    if (args.includes("--if-present") && discoveredAutomatically) {
      process.stdout.write("SOURCE_UNAVAILABLE\n");
      return;
    }
    throw new Error(`No se encontró el repositorio fuente: ${sourceRoot}`);
  }

  const source = await assertSourcePristine(sourceRoot);
  process.stdout.write(`SOURCE_OK ${source.commit} clean\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  sourceCheck(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
