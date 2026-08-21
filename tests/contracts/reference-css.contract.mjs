import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function cssFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await cssFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".css")) files.push(child);
  }
  return files.sort();
}

async function builtIndex() {
  return readFile(join(process.cwd(), "dist", "client", "index.html"), "utf8");
}

test("emits Tailwind utilities together with the frozen custom CSS", async () => {
  const files = await cssFiles(join(process.cwd(), "dist", "client"));
  const css = (
    await Promise.all(files.map((file) => readFile(file, "utf8")))
  ).join("\n");

  assert.match(css, /\.hidden\{display:none\}/);
  assert.match(css, /\.site-header\{/);
});

test("emits the absolute author and icon metadata from the document layout", async () => {
  const html = await builtIndex();

  assert.match(html, /<link rel="author" href="https:\/\/comunidadsolar\.es">/);
  assert.match(
    html,
    /<link rel="icon" href="https:\/\/comunidadsolar\.es\/comunidad-solar-logo\.svg">/,
  );
  assert.match(
    html,
    /<link rel="shortcut icon" href="https:\/\/comunidadsolar\.es\/comunidad-solar-logo\.svg">/,
  );
});
