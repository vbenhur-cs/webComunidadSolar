import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(projectRoot, "tests/fixtures/private-access-page");
const astro = join(projectRoot, "node_modules/.bin/astro");
const fixtureAstroCache = join(fixtureRoot, ".astro");
const fixtureNodeModules = join(fixtureRoot, "node_modules");
const fixtureGeneratedCaches = [
  fixtureAstroCache,
  join(fixtureNodeModules, ".astro"),
  join(fixtureNodeModules, ".vite"),
];

test("renders the source-faithful anonymous, denied, and unconfigured private-access branches", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "comunidadsolar-private-access-"),
  );

  try {
    await execFile(
      astro,
      ["build", "--root", fixtureRoot, "--outDir", outputDirectory],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          PRIVATE_ACCESS_FIXTURE_CACHE_DIR: join(outputDirectory, "cache"),
        },
        timeout: 30_000,
      },
    );

    const anonymous = normalize(
      await readFile(join(outputDirectory, "index.html"), "utf8"),
    );
    assert.match(
      anonymous,
      /Identifícate con una cuenta de ChatGPT que utilice el mismo correo que Comunidad Solar tiene registrado para ti\. La web solo recibirá tu identidad y nunca almacenará tu contraseña\./,
    );
    assert.match(
      anonymous,
      /class="button button-primary private-access-button"[^>]*>\s*Identificarme con ChatGPT <span aria-hidden="true">→<\/span>/,
    );
    assert.doesNotMatch(anonymous, /aria-label="Condiciones de acceso"/);

    const denied = normalize(
      await readFile(join(outputDirectory, "denied.html"), "utf8"),
    );
    assert.match(
      denied,
      /class="button button-primary"[^>]*>\s*Solicitar acceso <span aria-hidden="true">→<\/span>/,
    );
    assert.match(
      denied,
      /class="button button-secondary"[^>]*>\s*Cambiar de cuenta <span aria-hidden="true">→<\/span>/,
    );

    const unconfigured = normalize(
      await readFile(join(outputDirectory, "unconfigured.html"), "utf8"),
    );
    assert.match(unconfigured, /El acceso todavía no está activado\./);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await removeFixtureCaches();
    assert.equal(existsSync(outputDirectory), false);
    assert.equal(existsSync(fixtureAstroCache), false);
    assert.equal(existsSync(fixtureNodeModules), false);
  }
});

function normalize(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

async function removeFixtureCaches(): Promise<void> {
  await Promise.all(
    fixtureGeneratedCaches.map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  await rmdir(fixtureNodeModules).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
