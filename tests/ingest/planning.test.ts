import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
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
import { outputPaths } from "../../src/ingest/planning/route-impact.ts";
import { selectMode } from "../../src/ingest/planning/mode.ts";
import { validateSchema } from "../../src/ingest/schema-validator.ts";

const root = process.cwd();
const fixtures = join(root, "tests", "fixtures", "ingestion");
const hash = (character: string) => character.repeat(64);

const context: PlanningContext = {
  baselineCommit: "b".repeat(40),
  sourceManifestPath: join(root, "parity", "source-manifest.json"),
  publication: {
    adapter: "local",
    configSha256: hash("c"),
    environment: null,
    siteIndexable: false,
  },
};

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

test("explicit mode wins over automatic mode detection", () => {
  assert.equal(
    selectMode(pageRequest({ mode: "freeform", content: "<SiteLayout />" })),
    "freeform",
  );
});

test("marks an existing route as an explicit overwrite", () => {
  const plan = createChangePlan(request({ targetPath: "/baterias" }), context);

  assert.equal(plan.overwritesExistingRoute, true);
  assert.ok(plan.validations.includes("existing-route-visual-parity"));
  assert.deepEqual(plan.files[0], {
    path: "src/pages/baterias.astro",
    operation: "modify",
  });
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
  const plan = createChangePlan(fixture, context);
  const { planSha256, ...unsigned } = plan;

  assert.deepEqual(validateSchema("change-plan", plan), plan);
  assert.equal(planSha256.length, 64);
  assert.equal(plan.requestSha256, fixture.inputSha256);
  assert.equal(plan.planSha256, sha256Canonical(unsigned));
  assert.equal(plan.dependencies.length, 0);
  assert.equal(plan.files.length, 5);

  const markdown = renderPlanMarkdown(plan, fixture);
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
  assert.match(markdown, new RegExp(plan.planSha256, "u"));
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
  const first = createChangePlan(fixture, context);
  const second = createChangePlan(fixture, context);

  assert.equal(first.selectedMode, "freeform");
  assert.equal(first.planSha256, second.planSha256);
  assert.equal(first.overwritesExistingRoute, false);
  assert.equal(first.files[0]?.operation, "create");
  assert.equal(
    await readFile(join(root, "src", "pages", "index.astro"), "utf8"),
    before,
  );
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
