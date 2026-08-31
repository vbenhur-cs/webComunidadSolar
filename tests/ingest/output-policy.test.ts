import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  APPROVED_BLOCK_TYPES,
  validateBlockPage,
  type BlockPageDefinition,
} from "../../src/content/block-catalog.ts";
import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { ChangePlan } from "../../src/ingest/domain.ts";
import {
  validateAstroSource,
  validateOutputPolicy,
} from "../../src/ingest/validation/output-policy.ts";
import {
  removeStagedAgentOutput,
  validateAgentWorkspaceOutput,
  type StagedAgentOutput,
} from "../../src/ingest/workspaces/policy.ts";
import {
  createAgentWorkspace,
  removeAgentWorkspace,
} from "../../src/ingest/workspaces/service.ts";

process.env.INGEST_TEST_MODE ??= "true";

const execFileAsync = promisify(execFile);
const changeId = "policy-output";
const routePath = "src/pages/generated.astro";
const contentPath = `src/content/generated/${changeId}.json`;
const stylesheetPath = `src/styles/generated/${changeId}.css`;
const componentsPath = `src/components/generated/${changeId}`;
const assetsPath = `public/generated/${changeId}`;
const hash = (character: string) => character.repeat(64);
const generatedPlanFiles = [
  { path: routePath, operation: "create" as const },
  { path: componentsPath, operation: "create" as const },
  { path: contentPath, operation: "create" as const },
  { path: stylesheetPath, operation: "create" as const },
  { path: assetsPath, operation: "create" as const },
];

const blocks = [
  {
    type: "hero" as const,
    eyebrow: "Energía compartida",
    title: "Una página segura",
    lead: "Contenido estructurado y auditable.",
    primary: { label: "Saber más", href: "/contacto" },
  },
  {
    type: "feature" as const,
    title: "Ventajas",
    items: [{ title: "Clara", copy: "Sin HTML arbitrario." }],
  },
  {
    type: "cta" as const,
    title: "Participa",
    copy: "Da el siguiente paso.",
    action: { label: "Contactar", href: "mailto:hola@example.test" },
  },
  {
    type: "steps" as const,
    title: "Cómo funciona",
    steps: [{ title: "Primero", copy: "Revisamos el plan." }],
  },
  {
    type: "faq" as const,
    title: "Preguntas",
    items: [{ question: "¿Es seguro?", answer: "La salida se valida." }],
  },
  {
    type: "trust" as const,
    title: "Confianza",
    items: [{ label: "Trazable", detail: "Cada archivo tiene hash." }],
  },
];

const blockRoute = `---
import GeneratedBlockPage from "../components/blocks/GeneratedBlockPage.astro";
import page from "../content/generated/${changeId}.json";
---
<GeneratedBlockPage {page} />
`;

const freeformRoute = `---
import SiteLayout from "../layouts/SiteLayout.astro";
import "../styles/generated/${changeId}.css";
---
<SiteLayout page="inicio" meta={{ title: "Generada", canonical: "/generated" }}>
  <main><h1>Generada</h1><a href="/contacto">Contacto</a></main>
</SiteLayout>
`;

const hybridRoute = `---
import SiteLayout from "../layouts/SiteLayout.astro";
import { CoverageFinder } from "../components/islands/CoverageFinder";
import "../styles/generated/${changeId}.css";
---
<SiteLayout page="inicio" meta={{ title: "Generada", canonical: "/generated" }}>
  <main><h1>Generada</h1><CoverageFinder client:visible /></main>
</SiteLayout>
`;

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function request() {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    inputKind: "request" as const,
    intent: "Generate a policy fixture",
    audience: null,
    targetPath: "/generated" as const,
    mode: "blocks" as const,
    content: "safe fixture",
    claims: [],
    references: [],
    assets: [],
    seo: { title: "Generada", description: "Fixture", index: false },
    privacy: { private: false, area: null },
    allowedExternalLinks: [],
    acceptanceCriteria: ["The page passes output policy"],
  };
  return { ...unsigned, inputSha256: sha256Canonical(unsigned) };
}

function plan(
  baselineCommit: string,
  selectedMode: ChangePlan["selectedMode"],
  changes: Partial<Omit<ChangePlan, "planSha256">> = {},
): ChangePlan {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    baselineCommit,
    requestSha256: request().inputSha256,
    selectedMode,
    targetPath: "/generated" as const,
    overwritesExistingRoute: false,
    files: generatedPlanFiles,
    components: ["SiteLayout"],
    islands: selectedMode === "hybrid" ? ["CoverageFinder"] : [],
    dependencies: [],
    validations: ["npm run check"],
    publication: {
      adapter: "local" as const,
      configSha256: hash("c"),
      environment: null,
      siteIndexable: false,
    },
    ...changes,
  };
  return { ...unsigned, planSha256: sha256Canonical(unsigned) };
}

function generatedContent(
  selectedMode: ChangePlan["selectedMode"],
  routeSource: string,
): BlockPageDefinition | Record<string, unknown> {
  const common = {
    schemaVersion: 1 as const,
    changeId,
    mode: selectedMode,
    route: "/generated" as const,
    metadata: {
      title: "Generada",
      description: "Fixture",
      index: false,
    },
    privacy: { private: false, area: null },
    contentSha256: sha256(routeSource),
  };
  return selectedMode === "blocks" ? { ...common, blocks } : common;
}

interface StageOptions {
  mode?: ChangePlan["selectedMode"];
  baselineFiles?: Readonly<Record<string, string>>;
  outputFiles: Readonly<Record<string, string>>;
  planChanges?: Partial<Omit<ChangePlan, "planSha256">>;
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, source, "utf8");
  }
}

async function withStagedOutput(
  options: StageOptions,
  run: (
    staged: StagedAgentOutput,
    approvedPlan: ChangePlan,
    repositoryRoot: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "output-policy-repo-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "output-policy-work-"));
  const authorityRoot = await mkdtemp(join(tmpdir(), "output-policy-input-"));
  let workspace: Awaited<ReturnType<typeof createAgentWorkspace>> | undefined;
  let staged: StagedAgentOutput | undefined;
  try {
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--initial-branch=main",
      root,
    ]);
    await git(root, ["config", "user.email", "fixture@example.test"]);
    await git(root, ["config", "user.name", "Fixture Human"]);
    await writeFiles(root, {
      "README.md": "fixture\n",
      "package.json": '{"name":"fixture","version":"1.0.0","private":true}\n',
      "package-lock.json":
        '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n',
      ...options.baselineFiles,
    });
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baselineCommit = await git(root, ["rev-parse", "HEAD"]);
    const approvedPlan = plan(
      baselineCommit,
      options.mode ?? "blocks",
      options.planChanges,
    );
    const requestPath = join(authorityRoot, "request.json");
    const planPath = join(authorityRoot, "plan.json");
    const policyPath = join(authorityRoot, "policy.json");
    const resultSchemaPath = join(authorityRoot, "agent-result.schema.json");
    await Promise.all([
      writeFile(requestPath, JSON.stringify(request()), "utf8"),
      writeFile(planPath, JSON.stringify(approvedPlan), "utf8"),
      writeFile(policyPath, '{"allow":"planned-only"}', "utf8"),
      writeFile(resultSchemaPath, '{"type":"object"}', "utf8"),
    ]);
    workspace = await createAgentWorkspace({
      repositoryRoot: root,
      workspaceRoot,
      approvedPlan,
      changeId,
      attemptId: "attempt-000001",
      baselineCommit,
      requestPath,
      planPath,
      policyPath,
      resultSchemaPath,
    });
    await writeFiles(workspace.path, options.outputFiles);
    staged = await validateAgentWorkspaceOutput(workspace, approvedPlan);
    await run(staged, approvedPlan, root);
  } finally {
    if (staged !== undefined) {
      await removeStagedAgentOutput(staged).catch(() => undefined);
    }
    if (workspace !== undefined) {
      await removeAgentWorkspace(workspace).catch(() => undefined);
    }
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(authorityRoot, { recursive: true, force: true }),
    ]);
  }
}

test("blocks accepts only the six approved closed block types", () => {
  assert.deepEqual(APPROVED_BLOCK_TYPES, [
    "hero",
    "feature",
    "cta",
    "steps",
    "faq",
    "trust",
  ]);
  assert.equal(
    validateBlockPage(generatedContent("blocks", blockRoute)).blocks.length,
    6,
  );
  assert.throws(
    () =>
      validateBlockPage({
        ...generatedContent("blocks", blockRoute),
        blocks: [{ type: "html", html: "<script>alert(1)</script>" }],
      }),
    /no aprobado|schema|válid/iu,
  );
  assert.throws(
    () =>
      validateBlockPage({
        ...generatedContent("blocks", blockRoute),
        blocks: [
          {
            type: "cta",
            title: "Unsafe",
            copy: "Unsafe",
            action: { label: "Open", href: "javascript:alert(1)" },
          },
        ],
      }),
    /enlace|protocol|schema|válid/iu,
  );
});

const sourcePlan = plan(hash("a"), "freeform");
for (const [name, source, expectedCode] of [
  ["inline script", "<script>alert(1)</script>", "script.inline"],
  ["event handler", '<img onerror="alert(1)">', "astro.event-handler"],
  [
    "Next import",
    '---\nimport Link from "next/link"\n---\n<Link />',
    "import.forbidden",
  ],
  [
    "Vinext import",
    '---\nimport x from "vinext"\n---\n<div>{x}</div>',
    "import.forbidden",
  ],
  [
    "client node import",
    '---\nimport fs from "node:fs"\n---\n<div>{fs}</div>',
    "import.forbidden",
  ],
  ["unsafe protocol", '<a href="javascript:alert(1)">x</a>', "link.unsafe"],
  ["unsafe image source", '<img src="javascript:alert(1)">', "link.unsafe"],
  [
    "protocol smuggling",
    '<a href=" java\nscript:alert(1)">x</a>',
    "link.unsafe",
  ],
  ["event attribute casing", '<img ONLoad="alert(1)">', "astro.event-handler"],
  ["attribute spread", "<img {...Astro.props.attributes}>", "astro.spread"],
  [
    "raw HTML directive",
    "<div set:html={Astro.props.html} />",
    "astro.raw-html",
  ],
  [
    "iframe without an allowlist",
    '<iframe src="https://example.test/embed"></iframe>',
    "iframe.forbidden",
  ],
  [
    "root traversal import",
    '---\nimport x from "../../../outside.ts"\n---\n<div>{x}</div>',
    "import.traversal",
  ],
  ["unapproved island", "<Unapproved client:load />", "island.unapproved"],
  [
    "secret",
    '---\nconst API_KEY = "fixture-secret-value"\n---\n<div />',
    "secret.detected",
  ],
] as const) {
  test(`rejects Astro source containing ${name}`, async () => {
    const violations = await validateAstroSource(source, sourcePlan, routePath);
    assert.ok(violations.some((violation) => violation.code === expectedCode));
  });
}

test("accepts a parsed freeform source with required layout, stylesheet and safe links", async () => {
  assert.deepEqual(
    await validateAstroSource(freeformRoute, sourcePlan, routePath),
    [],
  );
});

for (const [mode, route] of [
  ["blocks", blockRoute],
  ["freeform", freeformRoute],
  ["hybrid", hybridRoute],
] as const) {
  test(`accepts controller-staged ${mode} output`, async () => {
    await withStagedOutput(
      {
        mode,
        outputFiles: {
          [routePath]: route,
          [contentPath]: JSON.stringify(generatedContent(mode, route)),
          ...(mode === "blocks"
            ? {}
            : { [stylesheetPath]: ".generated-page { display: block; }\n" }),
        },
      },
      async (staged, approvedPlan) => {
        assert.deepEqual(
          await validateOutputPolicy(staged.path, staged, approvedPlan),
          [],
        );
      },
    );
  });
}

test("rejects forged staging objects and a mismatched staging path", async () => {
  await withStagedOutput(
    {
      outputFiles: {
        [routePath]: blockRoute,
        [contentPath]: JSON.stringify(generatedContent("blocks", blockRoute)),
      },
    },
    async (staged, approvedPlan) => {
      await assert.rejects(
        () => validateOutputPolicy(staged.path, { ...staged }, approvedPlan),
        /controlador|staging.*pertenece/iu,
      );
      await assert.rejects(
        () => validateOutputPolicy(dirname(staged.path), staged, approvedPlan),
        /path|staging/iu,
      );
      const substitutedPlan = plan(approvedPlan.baselineCommit, "blocks", {
        files: [{ path: "astro.config.mjs", operation: "create" }],
      });
      substitutedPlan.planSha256 = approvedPlan.planSha256;
      await assert.rejects(
        () => validateOutputPolicy(staged.path, staged, substitutedPlan),
        /plan|staging|controlador/iu,
      );
    },
  );
});

test("detects a staged byte change against the controller inventory", async () => {
  await withStagedOutput(
    {
      outputFiles: {
        [routePath]: blockRoute,
        [contentPath]: JSON.stringify(generatedContent("blocks", blockRoute)),
      },
    },
    async (staged, approvedPlan) => {
      await writeFile(
        join(staged.path, routePath),
        "<h1>tampered</h1>",
        "utf8",
      );
      const violations = await validateOutputPolicy(
        staged.path,
        staged,
        approvedPlan,
      );
      assert.ok(
        violations.some((violation) => violation.code === "inventory.hash"),
      );
    },
  );
});

test("rejects a planned config path outside generated output roots", async () => {
  await withStagedOutput(
    {
      outputFiles: { "astro.config.mjs": "export default {};\n" },
      planChanges: {
        files: [{ path: "astro.config.mjs", operation: "create" }],
      },
    },
    async (staged, approvedPlan) => {
      const violations = await validateOutputPolicy(
        staged.path,
        staged,
        approvedPlan,
      );
      assert.ok(
        violations.some((violation) => violation.code === "path.forbidden"),
      );
    },
  );
});

test("validates only staged inventory and does not scan hostile unchanged baseline files", async () => {
  await withStagedOutput(
    {
      baselineFiles: {
        "src/pages/legacy.astro": '<script>alert("legacy")</script>\n',
      },
      outputFiles: {
        [routePath]: blockRoute,
        [contentPath]: JSON.stringify(generatedContent("blocks", blockRoute)),
      },
    },
    async (staged, approvedPlan) => {
      assert.equal(staged.files.includes("src/pages/legacy.astro"), false);
      assert.deepEqual(
        await validateOutputPolicy(staged.path, staged, approvedPlan),
        [],
      );
    },
  );
});

test("accepts only the exact approved package and lock dependency diff from baseline", async () => {
  const dependencyFiles = [
    { path: "package.json", operation: "modify" as const },
    { path: "package-lock.json", operation: "modify" as const },
  ];
  await withStagedOutput(
    {
      outputFiles: {
        [routePath]: blockRoute,
        [contentPath]: JSON.stringify(generatedContent("blocks", blockRoute)),
        "package.json":
          '{"name":"fixture","version":"1.0.0","private":true,"dependencies":{"example":"1.2.3"}}\n',
        "package-lock.json":
          '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0","dependencies":{"example":"1.2.3"}},"node_modules/example":{"version":"1.2.3"}}}\n',
      },
      planChanges: {
        files: [...generatedPlanFiles, ...dependencyFiles],
        dependencies: ["example@1.2.3"],
      },
    },
    async (staged, approvedPlan, repositoryRoot) => {
      await writeFile(
        join(repositoryRoot, "package.json"),
        '{"dependencies":{"attacker":"9.9.9"}}\n',
        "utf8",
      );
      assert.deepEqual(
        await validateOutputPolicy(staged.path, staged, approvedPlan),
        [],
      );
      assert.match(
        await readFile(join(staged.path, "package.json"), "utf8"),
        /example/u,
      );
    },
  );

  await withStagedOutput(
    {
      outputFiles: {
        [routePath]: blockRoute,
        [contentPath]: JSON.stringify(generatedContent("blocks", blockRoute)),
        "package.json":
          '{"name":"fixture","version":"1.0.0","private":true,"dependencies":{"example":"1.2.3","evil":"9.9.9"}}\n',
        "package-lock.json":
          '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0","dependencies":{"example":"1.2.3","evil":"9.9.9"}},"node_modules/example":{"version":"1.2.3"},"node_modules/evil":{"version":"9.9.9"}}}\n',
      },
      planChanges: {
        files: [...generatedPlanFiles, ...dependencyFiles],
        dependencies: ["example@1.2.3"],
      },
    },
    async (staged, approvedPlan) => {
      const violations = await validateOutputPolicy(
        staged.path,
        staged,
        approvedPlan,
      );
      assert.ok(
        violations.some((violation) => violation.code === "dependency.diff"),
      );
    },
  );

  await withStagedOutput(
    {
      outputFiles: {
        [routePath]: blockRoute,
        [contentPath]: JSON.stringify(generatedContent("blocks", blockRoute)),
        "package.json":
          '{"name":"fixture","version":"1.0.0","private":true,"dependencies":{"example":"1.2.3"}}\n',
        "package-lock.json":
          '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0","dependencies":{"example":"1.2.3"}},"node_modules/example":{"version":"1.2.3","resolved":"file:../../outside.tgz"}}}\n',
      },
      planChanges: {
        files: [...generatedPlanFiles, ...dependencyFiles],
        dependencies: ["example@1.2.3"],
      },
    },
    async (staged, approvedPlan) => {
      const violations = await validateOutputPolicy(
        staged.path,
        staged,
        approvedPlan,
      );
      assert.ok(
        violations.some((violation) => violation.code === "dependency.diff"),
      );
    },
  );
});
