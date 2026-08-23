import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  allianceFacts,
  documentCategories,
  executiveSummary,
  financialMetrics,
  growthEngines,
  milestoneAgenda,
  publishedMaterials,
  roadmapPhases,
  teamUpdates,
} from "../../src/content/partner-data.ts";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(projectRoot, "tests/fixtures/partner-dashboard");
const astro = join(projectRoot, "node_modules/.bin/astro");
const fixtureAstroCache = join(fixtureRoot, ".astro");
const fixtureNodeModules = join(fixtureRoot, "node_modules");
const fixtureGeneratedCaches = [
  fixtureAstroCache,
  join(fixtureNodeModules, ".astro"),
  join(fixtureNodeModules, ".vite"),
];

function count(value: string, expression: RegExp): number {
  return value.match(expression)?.length ?? 0;
}

test("renders every server-only partner dashboard section without a dashboard island", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "comunidadsolar-partner-dashboard-"),
  );

  try {
    await execFile(
      astro,
      ["build", "--root", fixtureRoot, "--outDir", outputDirectory],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          PARTNER_DASHBOARD_FIXTURE_CACHE_DIR: join(outputDirectory, "cache"),
        },
        timeout: 30_000,
      },
    );

    const html = await readFile(join(outputDirectory, "index.html"), "utf8");
    assert.equal(
      /<main id="contenido-principal" class="partner-page"/.test(html),
      true,
      "El dashboard debe conservar su contenedor principal",
    );
    assert.equal(
      /class="partner-account-card"/.test(html),
      true,
      "El dashboard debe conservar la tarjeta de cuenta",
    );
    assert.equal(
      /href="mailto:[^"]+"/.test(html),
      true,
      "El dashboard debe conservar su contacto por correo",
    );
    assert.equal(
      /Corte · <!-- -->[^<]+<\/time>/.test(html),
      true,
      "La frontera texto estático/dato dinámico debe conservar el SSR de React",
    );
    assert.equal(count(html, /class="partner-summary-grid"/g), 1);
    assert.equal(count(html, /class="partner-agenda-list"/g), 1);
    assert.equal(count(html, /class="partner-roadmap-grid"/g), 1);
    assert.equal(count(html, /class="partner-metric-grid"/g), 1);
    assert.equal(count(html, /class="partner-alliance-grid"/g), 1);
    assert.equal(count(html, /class="partner-engine-list"/g), 1);
    assert.equal(count(html, /class="partner-team-grid"/g), 1);
    assert.equal(count(html, /class="partner-material-list"/g), 1);
    assert.equal(count(html, /class="partner-document-categories"/g), 1);
    assert.equal(
      count(html, /class="partner-status partner-status-/g),
      executiveSummary.length + milestoneAgenda.length + roadmapPhases.length,
    );
    assert.ok(financialMetrics.length > 0);
    assert.ok(allianceFacts.length > 0);
    assert.ok(growthEngines.length > 0);
    assert.ok(teamUpdates.length > 0);
    assert.ok(publishedMaterials.length > 0);
    assert.ok(documentCategories.length > 0);
    assert.equal(
      /astro-island[^>]+component-export="PartnerDashboard"/.test(html),
      false,
      "El dashboard debe permanecer en SSR sin isla React propia",
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await removeFixtureCaches();
    assert.equal(existsSync(outputDirectory), false);
    assert.equal(existsSync(fixtureAstroCache), false);
    assert.equal(existsSync(fixtureNodeModules), false);
  }
});

test("loads the partner dashboard module only after socios access is allowed", async () => {
  const page = await readFile(
    join(projectRoot, "src/pages/socios.astro"),
    "utf8",
  );
  const decisionOffset = page.indexOf("const decision = resolvePrivateAccess(");
  const dashboardOffset = page.indexOf(
    'await import("../components/private/PartnerDashboard.astro")',
  );

  assert.equal(
    /import PartnerDashboard from/.test(page),
    false,
    "El dashboard no debe cargarse estáticamente antes de resolver el acceso",
  );
  assert.ok(
    decisionOffset >= 0,
    "La página debe resolver el acceso explícitamente",
  );
  assert.ok(
    dashboardOffset > decisionOffset,
    "La carga del dashboard debe ocurrir después de la decisión de acceso",
  );
  assert.equal(
    /if \(decision\.allowed\) \{[\s\S]*?await import\("\.\.\/components\/private\/PartnerDashboard\.astro"\)[\s\S]*?\}/.test(
      page,
    ),
    true,
    "Solo la rama permitida debe cargar el módulo del dashboard",
  );
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
