import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(projectRoot, "tests/fixtures/manganafer-admin");
const astro = join(projectRoot, "node_modules/.bin/astro");
const fixtureAstroCache = join(fixtureRoot, ".astro");
const fixtureNodeModules = join(fixtureRoot, "node_modules");
const fixtureGeneratedCaches = [
  fixtureAstroCache,
  join(fixtureNodeModules, ".astro"),
  join(fixtureNodeModules, ".vite"),
];

function sourceDate(value: string): string {
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Madrid",
  }).format(new Date(normalized));
}

test("loads the Manganáfer dashboard module only after access is allowed", async () => {
  const page = await readFile(
    join(projectRoot, "src/pages/manganafer/interesados.astro"),
    "utf8",
  );

  assert.equal(
    page.includes(
      'import ManganaferInterestsPage from "../../components/private/ManganaferInterestsPage.astro";',
    ),
    false,
  );
  assert.equal(
    /let ManganaferInterestsPage:\s*\n\s*\| typeof import\("\.\.\/\.\.\/components\/private\/ManganaferInterestsPage\.astro"\)\.default\s*\n\s*\| null = null;/.test(
      page,
    ),
    true,
  );
  assert.equal(
    /if \(decision\.allowed\) \{\s*\n\s+\(\{ default: ManganaferInterestsPage \} =\s*\n\s+await import\("\.\.\/\.\.\/components\/private\/ManganaferInterestsPage\.astro"\)\);/.test(
      page,
    ),
    true,
  );
  assert.equal(
    /const blockedDecision = decision\.allowed \? null : decision;/.test(page),
    true,
  );
  assert.equal(/ManganaferInterestsPage \? \(/.test(page), true);
  assert.equal(/state=\{blockedDecision!\.state\}/.test(page), true);
});

test("renders the empty and populated Manganáfer administration states as SSR", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "comunidadsolar-manganafer-admin-"),
  );

  try {
    await execFile(
      astro,
      ["build", "--root", fixtureRoot, "--outDir", outputDirectory],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          MANGANAFER_ADMIN_FIXTURE_CACHE_DIR: join(outputDirectory, "cache"),
        },
        timeout: 30_000,
      },
    );

    const [emptyHtml, dataHtml] = await Promise.all([
      readFile(join(outputDirectory, "empty.html"), "utf8"),
      readFile(join(outputDirectory, "data.html"), "utf8"),
    ]);

    assert.equal(
      /<main id="contenido-principal" class="manganafer-admin-page" tabindex="-1">/.test(
        emptyHtml,
      ),
      true,
    );
    assert.equal(/class="manganafer-admin-empty"/.test(emptyHtml), true);
    assert.equal(/class="manganafer-admin-table"/.test(emptyHtml), false);

    assert.equal(/class="manganafer-admin-stats"/.test(dataHtml), true);
    assert.equal((dataHtml.match(/<article>/g) ?? []).length, 4);
    assert.equal((dataHtml.match(/<th>/g) ?? []).length, 7);
    assert.equal((dataHtml.match(/manganafer-admin-kind/g) ?? []).length, 4);
    assert.equal(dataHtml.includes(sourceDate("2026-08-23 10:00:00")), true);
    assert.equal(dataHtml.includes("Hogar"), true);
    assert.equal(dataHtml.includes("500–1.000 m²"), true);
    assert.equal(
      /<strong>[^<]+<!-- --> <!-- -->[^<]+<\/strong>/.test(dataHtml),
      true,
    );
    assert.equal(
      /astro-island[^>]+component-export="ManganaferInterestsPage"/.test(
        dataHtml,
      ),
      false,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await removeFixtureCaches();
    assert.equal(existsSync(outputDirectory), false);
    assert.equal(existsSync(fixtureAstroCache), false);
    assert.equal(existsSync(fixtureNodeModules), false);
  }
});

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
