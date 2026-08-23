import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { NormalizedRequest } from "../../src/ingest/domain.ts";
import { importPage } from "../../src/ingest/importers/page.ts";
import { importRequest } from "../../src/ingest/importers/request.ts";
import {
  createChangePlan,
  preparePlanningPublication,
  type PlanningContext,
} from "../../src/ingest/planning/plan.ts";
import { renderPlanMarkdown } from "../../src/ingest/planning/markdown.ts";
import {
  outputPaths,
  routeExists,
} from "../../src/ingest/planning/route-impact.ts";
import { selectMode } from "../../src/ingest/planning/mode.ts";
import { validateSchema } from "../../src/ingest/schema-validator.ts";

const root = process.cwd();
const fixtures = join(root, "tests", "fixtures", "ingestion");
const hash = (character: string) => character.repeat(64);

const forgedContext = {
  baselineCommit: "b".repeat(40),
  sourceManifestPath: join(root, "parity", "source-manifest.json"),
  publication: {
    adapter: "local",
    configSha256: hash("c"),
    environment: null,
    siteIndexable: false,
  },
};

async function trustedContext(): Promise<PlanningContext> {
  const artifactRoot = join(root, ".change-state", "planning-test-local");
  await rm(artifactRoot, { recursive: true, force: true });
  try {
    return {
      ...forgedContext,
      publication: await preparePlanningPublication({
        adapter: "local",
        projectRoot: root,
        stateArtifactRoot: artifactRoot,
      }),
    };
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

function request(
  overrides: Partial<NormalizedRequest> = {},
): NormalizedRequest {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId: "nueva-pagina-autoconsumo",
    inputKind: "request" as const,
    intent: "Explicar el autoconsumo compartido",
    audience: null,
    targetPath: "/autoconsumo-compartido" as const,
    mode: "auto" as const,
    content: "Compartir energía reduce la factura.",
    claims: ["Ahorro local verificable"],
    references: ["https://example.test/referencia"],
    assets: [],
    seo: { title: "Autoconsumo compartido", description: null, index: true },
    privacy: { private: false, area: null },
    allowedExternalLinks: ["https://example.test"],
    acceptanceCriteria: ["La ruta responde 200"],
    ...overrides,
  };
  const withoutHash = { ...unsigned } as typeof unsigned & {
    inputSha256?: string;
  };
  delete withoutHash.inputSha256;
  return { ...withoutHash, inputSha256: sha256Canonical(withoutHash) };
}

function pageRequest(
  overrides: Partial<NormalizedRequest> = {},
): NormalizedRequest {
  return request({ inputKind: "page", ...overrides });
}

function assertCompleteMarkdown(markdown: string, planSha256: string): void {
  for (const heading of [
    "Resumen de entrada",
    "Ruta y overwrite",
    "Modo de composición",
    "Archivos previstos",
    "Componentes reutilizados y nuevos",
    "Islas",
    "Assets",
    "Claims, enlaces e integraciones",
    "Impacto SEO, privacidad y navegación",
    "Dependencias",
    "Riesgos",
    "Matriz de aceptación",
  ]) {
    assert.match(markdown, new RegExp(`## ${heading}`, "u"));
  }
  assert.match(markdown, new RegExp(planSha256, "u"));
  assert.match(markdown, /\| Criterio \| Validación \| Evidencia \|/u);
}

test("auto chooses blocks for a textual request", () => {
  assert.equal(selectMode(request({ mode: "auto" })), "blocks");
});

test("auto chooses hybrid for a supplied page using site chrome", () => {
  assert.equal(
    selectMode(
      pageRequest({
        mode: "auto",
        content: '<header class="site-header">',
      }),
    ),
    "hybrid",
  );
});

test("auto classifies a markup-bearing textual request with page semantics", () => {
  assert.equal(
    selectMode(
      request({
        mode: "auto",
        content: '<main class="site-root">contenido</main>',
      }),
    ),
    "hybrid",
  );
  assert.equal(
    selectMode(request({ mode: "auto", content: "<main>contenido</main>" })),
    "freeform",
  );
});

test("auto recognizes comments doctypes and JSX fragments as markup", () => {
  for (const content of [
    "<!-- página aportada -->",
    "<!doctype html>",
    "<>contenido</>",
  ]) {
    assert.equal(selectMode(request({ mode: "auto", content })), "freeform");
  }
  assert.equal(
    selectMode(request({ mode: "auto", content: "<incomplete" })),
    "freeform",
  );
  assert.equal(
    selectMode(request({ mode: "auto", content: "1 < 2" })),
    "blocks",
  );
});

test("explicit mode wins over automatic mode detection", () => {
  assert.equal(
    selectMode(pageRequest({ mode: "freeform", content: "<SiteLayout />" })),
    "freeform",
  );
});

test("marks an existing route as an explicit overwrite", async () => {
  const plan = createChangePlan(
    request({ targetPath: "/baterias" }),
    await trustedContext(),
  );

  assert.equal(plan.overwritesExistingRoute, true);
  assert.ok(plan.validations.includes("existing-route-visual-parity"));
  assert.deepEqual(plan.files[0], {
    path: "src/pages/baterias.astro",
    operation: "modify",
  });
});

test("only known renderable manifest route kinds authorize overwrites", () => {
  assert.equal(
    routeExists("/baterias", [{ path: "/baterias", kind: "page" }]),
    true,
  );
  assert.equal(
    routeExists("/baterias", [{ path: "/baterias", kind: "private-page" }]),
    true,
  );
  for (const kind of [
    undefined,
    "Page",
    "api",
    "asset",
    "gone",
    "redirect",
    "unknown",
  ]) {
    assert.equal(
      routeExists("/baterias", [{ path: "/baterias", kind }]),
      false,
      kind,
    );
  }
});

test("always plans the five safe generated outputs without directory expansion", () => {
  const paths = outputPaths(request(), "blocks");
  assert.deepEqual(paths, {
    route: "src/pages/autoconsumo-compartido.astro",
    componentsDir: "src/components/generated/nueva-pagina-autoconsumo",
    content: "src/content/generated/nueva-pagina-autoconsumo.json",
    stylesheet: "src/styles/generated/nueva-pagina-autoconsumo.css",
    assetsDir: "public/generated/nueva-pagina-autoconsumo",
  });
  assert.throws(
    () =>
      outputPaths(
        request({ targetPath: "/../escape" as `/${string}` }),
        "blocks",
      ),
    /schema|ruta/i,
  );
});

test("produces a closed hash-bound JSON plan and complete Markdown for a request fixture", async () => {
  const fixture = await importRequest(
    join(fixtures, "detailed-request", "request.json"),
  );
  const plan = createChangePlan(fixture, await trustedContext());
  const { planSha256, ...unsigned } = plan;

  assert.deepEqual(validateSchema("change-plan", plan), plan);
  assert.equal(planSha256.length, 64);
  assert.equal(plan.requestSha256, fixture.inputSha256);
  assert.equal(plan.planSha256, sha256Canonical(unsigned));
  assert.equal(plan.dependencies.length, 0);
  assert.equal(plan.files.length, 5);

  const markdown = renderPlanMarkdown(plan, fixture);
  assertCompleteMarkdown(markdown, plan.planSha256);
  assert.match(markdown, /La ruta responde 200/u);
});

test("plans the supplied page fixture deterministically without writing site routes", async () => {
  const before = await readFile(
    join(root, "src", "pages", "index.astro"),
    "utf8",
  );
  const fixture = await importPage(
    join(fixtures, "supplied-page"),
    join(fixtures, "page-meta.yaml"),
  );
  const context = await trustedContext();
  const first = createChangePlan(fixture, context);
  const second = createChangePlan(fixture, context);

  assert.equal(first.selectedMode, "freeform");
  assert.equal(first.planSha256, second.planSha256);
  assert.equal(first.overwritesExistingRoute, false);
  assert.equal(first.files[0]?.operation, "create");
  assert.deepEqual(validateSchema("change-plan", first), first);
  const markdown = renderPlanMarkdown(first, fixture);
  assertCompleteMarkdown(markdown, first.planSha256);
  assert.match(markdown, /La ruta aporta una estructura principal accesible/u);
  assert.match(markdown, /solar\.svg/u);
  assert.equal(
    await readFile(join(root, "src", "pages", "index.astro"), "utf8"),
    before,
  );
});

test("neutralizes CR and LF in every untrusted Markdown interpolation context", async () => {
  const fixture = request({
    intent: "entrada\r## injected",
    claims: ["claim\n## injected"],
    references: ["https://example.test/\r## injected"],
    allowedExternalLinks: ["https://example.test/\n## injected"],
    assets: [
      {
        path: "asset\r## injected",
        mediaType: "text/plain\n## injected",
        sha256: "a".repeat(64),
      },
    ],
    seo: { title: "SEO\r## injected", description: null, index: true },
    acceptanceCriteria: ["criterio\n## injected"],
  });
  const plan = createChangePlan(fixture, await trustedContext());
  const markdown = renderPlanMarkdown(plan, fixture);

  assert.doesNotMatch(markdown, /\r|^## injected$/mu);
});

test("binds plans only to real Phase 3 local and Cloudflare profiles", async () => {
  const local = await trustedContext();
  assert.doesNotThrow(() => createChangePlan(request(), local));
  assert.throws(
    () => createChangePlan(request(), forgedContext as PlanningContext),
    /perfil de publicaci[oó]n preparado/i,
  );

  const cloudRoot = await mkdtemp(join(tmpdir(), "planning-cloudflare-"));
  try {
    await mkdir(join(cloudRoot, "dist", "server"), { recursive: true });
    await mkdir(join(cloudRoot, "drizzle"), { recursive: true });
    await writeFile(
      join(cloudRoot, "wrangler.jsonc"),
      JSON.stringify({
        name: "comunidad-solar-preview",
        main: "./dist/server/entry.mjs",
        compatibility_date: "2026-08-21",
        compatibility_flags: ["nodejs_compat"],
        assets: {
          binding: "ASSETS",
          directory: "./dist",
          run_worker_first: true,
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "comunidad-solar-preview",
            database_id: "11111111-2222-4333-8444-555555555555",
            migrations_dir: "./drizzle",
          },
        ],
        vars: { SITE_INDEXABLE: "true" },
        env: { preview: { vars: { SITE_INDEXABLE: "false" } } },
      }),
      "utf8",
    );
    const cloudflare = await preparePlanningPublication({
      adapter: "cloudflare",
      projectRoot: cloudRoot,
      environment: "preview",
      stateArtifactRoot: join(cloudRoot, ".change-state", "profiles"),
    });
    const plan = createChangePlan(request(), {
      ...forgedContext,
      publication: cloudflare,
    });
    assert.deepEqual(plan.publication, cloudflare);
    assert.match(plan.publication.configSha256, /^[a-f0-9]{64}$/u);
    assert.equal(plan.publication.environment, "preview");
    assert.equal(plan.publication.siteIndexable, false);
  } finally {
    await rm(cloudRoot, { recursive: true, force: true });
  }
});

test("prepares a non-deployable local profile only under change state", async () => {
  const artifactRoot = join(root, ".change-state", "planning-test-local");
  await rm(artifactRoot, { recursive: true, force: true });
  try {
    const publication = await preparePlanningPublication({
      adapter: "local",
      projectRoot: root,
      stateArtifactRoot: artifactRoot,
    });

    assert.deepEqual(
      { ...publication, configSha256: publication.configSha256.length },
      {
        adapter: "local",
        configSha256: 64,
        environment: null,
        siteIndexable: false,
      },
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
