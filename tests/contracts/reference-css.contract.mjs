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

test("preserves React text-node delimiters in dynamic home metadata", async () => {
  const html = await builtIndex();

  for (const metadata of [
    "Televisión<!-- --> · <!-- -->Agosto 2023",
    "Radio<!-- --> · <!-- -->2023",
    "Prensa<!-- --> · <!-- -->2023",
    "Proyectos<!-- --> · <!-- -->12 enero 2026",
    "Proyectos<!-- --> · <!-- -->23 diciembre 2025",
    "Comunidad<!-- --> · <!-- -->12 diciembre 2025",
    "“<!-- -->…se han preocupado por solucionarlo. Seguiremos confiando en ellos.<!-- -->”",
    "“<!-- -->Me han guiado desde el principio… en un proceso largo que ellos han hecho fácil.<!-- -->”",
    "“<!-- -->Su servicio de atención al cliente es realmente destacable.<!-- -->”",
  ]) {
    assert.ok(
      html.includes(metadata),
      `La frontera de texto React debe mantenerse: ${metadata}`,
    );
  }
});
