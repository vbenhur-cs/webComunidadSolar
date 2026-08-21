import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function collectTests(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTests(path)));
    else if (/\.test\.(?:ts|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const requested = process.argv.slice(2);
const discovered = await collectTests("tests");
const files = (
  requested.length > 0
    ? requested
    : discovered.filter((file) => !file.split(/[\\/]/).includes("integration"))
).sort();
if (files.length === 0) throw new Error("No unit test files found");
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const child = spawn(tsx, ["--test", ...files], {
  stdio: "inherit",
  shell: false,
});
const code = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (value) => resolve(value ?? 1));
});
process.exitCode = code;
