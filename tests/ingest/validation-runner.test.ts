import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { ChangePlan } from "../../src/ingest/domain.ts";
import {
  preparePlanningPublication,
  type PreparedPlanningPublication,
} from "../../src/ingest/planning/plan.ts";
import {
  createControllerPublicationProfile,
  createValidationEvidenceRoot,
  PRELIMINARY_STAGED_VALIDATION_SCOPE,
  runValidation,
  type CommandInvocation,
  type CommandResult,
  type ControllerPublicationProfile,
  type ValidationEvidenceRoot,
  type ValidationInput,
} from "../../src/ingest/validation/runner.ts";
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
const changeId = "validation-output";
const stagingAttemptId = "attempt-000001";
const digest = (source: string | Uint8Array) =>
  createHash("sha256").update(source).digest("hex");
const fixedHash = (character: string) => character.repeat(64);
const validPngHeader = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1,
]);
const controllerPublicationConfig = `${JSON.stringify({
  name: "validation-fixture",
  main: "./src/worker.ts",
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
      database_name: "validation-fixture",
      database_id: "00000000-0000-4000-8000-000000000000",
      migrations_dir: "./drizzle",
    },
  ],
  vars: { SITE_INDEXABLE: "false" },
})}\n`;
const cloudflareControllerPublicationConfig = `${JSON.stringify({
  name: "validation-fixture",
  main: "./src/worker.ts",
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
      database_name: "validation-fixture",
      database_id: "11111111-2222-4333-8444-555555555555",
      migrations_dir: "./drizzle",
    },
  ],
  vars: { SITE_INDEXABLE: "true" },
  env: { preview: { vars: { SITE_INDEXABLE: "false" } } },
})}\n`;

const expectedIds = [
  "output-policy",
  "routes",
  "assets",
  "imports-dependencies-secrets",
  "links",
  "seo",
  "accessibility",
  "npm-ci",
  "format",
  "lint",
  "check",
  "unit-tests",
  "build",
  "integration-tests",
  "http-tests",
  "preview",
  "e2e",
  "route-smoke",
  "console-errors",
  "axe",
  "capture-desktop",
  "capture-tablet",
  "capture-mobile",
] as const;

type OutputFiles = Readonly<Record<string, string | Uint8Array>>;

function routePath(plan: ChangePlan): string {
  return plan.targetPath === "/"
    ? "src/pages/index.astro"
    : `src/pages${plan.targetPath}.astro`;
}

function contentPath(plan: ChangePlan): string {
  return `src/content/generated/${plan.changeId}.json`;
}

function stylesheetPath(plan: ChangePlan): string {
  return `src/styles/generated/${plan.changeId}.css`;
}

function assetsPath(plan: ChangePlan): string {
  return `public/generated/${plan.changeId}`;
}

function request() {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    inputKind: "request" as const,
    intent: "Validate generated output",
    audience: null,
    targetPath: "/generated" as const,
    mode: "blocks" as const,
    content: "Fixture content",
    claims: [],
    references: [],
    assets: [],
    seo: { title: "Generated", description: "Fixture", index: false },
    privacy: { private: false, area: null },
    allowedExternalLinks: [],
    acceptanceCriteria: ["Validation has deterministic evidence"],
  };
  return { ...unsigned, inputSha256: sha256Canonical(unsigned) };
}

interface PlanChanges {
  readonly targetPath?: `/${string}`;
  readonly selectedMode?: ChangePlan["selectedMode"];
  readonly overwritesExistingRoute?: boolean;
  readonly publication?: ChangePlan["publication"];
}

function planWithPublication(
  baselineCommit: string,
  publication: ChangePlan["publication"],
  changes: PlanChanges = {},
): ChangePlan {
  const targetPath = changes.targetPath ?? "/generated";
  const selectedMode = changes.selectedMode ?? "blocks";
  const route =
    targetPath === "/"
      ? "src/pages/index.astro"
      : `src/pages${targetPath}.astro`;
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    baselineCommit,
    requestSha256: request().inputSha256,
    selectedMode,
    targetPath,
    overwritesExistingRoute: changes.overwritesExistingRoute ?? false,
    files: [
      {
        path: route,
        operation: changes.overwritesExistingRoute
          ? ("modify" as const)
          : ("create" as const),
      },
      {
        path: `src/components/generated/${changeId}`,
        operation: "create" as const,
      },
      {
        path: `src/content/generated/${changeId}.json`,
        operation: "create" as const,
      },
      {
        path: `src/styles/generated/${changeId}.css`,
        operation: "create" as const,
      },
      {
        path: `public/generated/${changeId}`,
        operation: "create" as const,
      },
    ],
    components: ["SiteLayout"],
    islands: [],
    dependencies: [],
    validations: ["output-policy", "build"],
    publication: changes.publication ?? publication,
  };
  return { ...unsigned, planSha256: sha256Canonical(unsigned) };
}

const blocks = [
  {
    type: "hero" as const,
    eyebrow: "Energía compartida",
    title: "Una salida validada",
    lead: "Contenido cerrado y comprobable.",
    primary: { label: "Conocer más", href: "/contacto" },
  },
  {
    type: "cta" as const,
    title: "Participa",
    copy: "Solicita información.",
    action: { label: "Escribir", href: "mailto:hola@example.test" },
  },
];

function blockRoute(currentPlan: ChangePlan): string {
  return `---
import GeneratedBlockPage from "../components/blocks/GeneratedBlockPage.astro";
import page from "../content/generated/${currentPlan.changeId}.json";
---
<GeneratedBlockPage {page} />
`;
}

function freeformRoute(
  currentPlan: ChangePlan,
  body: string = '<h1>Generada</h1><a href="/contacto">Contacto</a>',
): string {
  return `---
import SiteLayout from "../layouts/SiteLayout.astro";
import "../styles/generated/${currentPlan.changeId}.css";
---
<SiteLayout page="inicio"><main class="generated-${currentPlan.changeId}">${body}</main></SiteLayout>
`;
}

function content(
  currentPlan: ChangePlan,
  route: string,
  metadata: { title: string | null; description: string | null } = {
    title: "Página generada",
    description: "Una página generada que conserva evidencia.",
  },
): string {
  return JSON.stringify({
    schemaVersion: 1,
    changeId: currentPlan.changeId,
    mode: currentPlan.selectedMode,
    route: currentPlan.targetPath,
    metadata: { ...metadata, index: false },
    privacy: { private: false, area: null },
    contentSha256: digest(route),
    ...(currentPlan.selectedMode === "blocks" ? { blocks } : {}),
  });
}

function validOutput(
  currentPlan: ChangePlan,
  changes: {
    readonly route?: string;
    readonly metadata?: { title: string | null; description: string | null };
    readonly extra?: OutputFiles;
  } = {},
): OutputFiles {
  const route =
    changes.route ??
    (currentPlan.selectedMode === "blocks"
      ? blockRoute(currentPlan)
      : freeformRoute(currentPlan));
  const files: Record<string, string | Uint8Array> = {
    [routePath(currentPlan)]: route,
    [contentPath(currentPlan)]: content(currentPlan, route, changes.metadata),
  };
  if (currentPlan.selectedMode !== "blocks") {
    files[stylesheetPath(currentPlan)] =
      `.generated-${currentPlan.changeId} { color: green; }\n`;
  }
  return { ...files, ...changes.extra };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function writeFiles(root: string, files: OutputFiles): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, source);
  }
}

interface StageOptions {
  readonly planChanges?: PlanChanges;
  readonly output?: (approvedPlan: ChangePlan) => OutputFiles;
  readonly packageJson?: string;
  readonly publicationAdapter?: "local" | "cloudflare";
  readonly publicationConfig?: string;
}

function validationInput(
  output: StagedAgentOutput,
  approvedPlan: ChangePlan,
  evidenceRoot: ValidationEvidenceRoot,
  publicationProfile: ControllerPublicationProfile | undefined,
): ValidationInput {
  return {
    output,
    plan: approvedPlan,
    attemptId: stagingAttemptId,
    evidenceRoot,
    ...(publicationProfile === undefined ? {} : { publicationProfile }),
  };
}

async function withStagedOutput(
  options: StageOptions,
  run: (
    output: StagedAgentOutput,
    approvedPlan: ChangePlan,
    evidenceRoot: ValidationEvidenceRoot,
    publicationProfile: ControllerPublicationProfile | undefined,
    preparedPublication: PreparedPlanningPublication,
    repositoryRoot: string,
  ) => Promise<void>,
): Promise<void> {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "validation-runner-repo-"),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "validation-runner-work-"),
  );
  const authorityRoot = await mkdtemp(
    join(tmpdir(), "validation-runner-input-"),
  );
  let workspace: Awaited<ReturnType<typeof createAgentWorkspace>> | undefined;
  let output: StagedAgentOutput | undefined;
  let evidenceRoot: ValidationEvidenceRoot | undefined;
  try {
    const publicationAdapter = options.publicationAdapter ?? "local";
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--initial-branch=main",
      repositoryRoot,
    ]);
    await git(repositoryRoot, ["config", "user.email", "fixture@example.test"]);
    await git(repositoryRoot, ["config", "user.name", "Fixture Human"]);
    await writeFiles(repositoryRoot, {
      "README.md": "fixture\n",
      "src/pages/index.astro": "<main>Inicio</main>\n",
      "src/pages/contacto.astro": "<main>Contacto</main>\n",
      "src/worker.ts": "export default {};\n",
      "dist/.gitkeep": "\n",
      "drizzle/0000_fixture.sql": "SELECT 1;\n",
      "public/guide.pdf": "fixture guide\n",
      "wrangler.jsonc":
        options.publicationConfig ??
        (publicationAdapter === "cloudflare"
          ? cloudflareControllerPublicationConfig
          : controllerPublicationConfig),
      "package.json":
        options.packageJson ??
        '{"name":"fixture","version":"1.0.0","private":true}\n',
      "package-lock.json":
        '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n',
    });
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baselineCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const preparedPublication = await preparePlanningPublication({
      adapter: publicationAdapter,
      projectRoot: repositoryRoot,
      ...(publicationAdapter === "cloudflare"
        ? { environment: "preview" }
        : {}),
      stateArtifactRoot: join(
        repositoryRoot,
        ".change-state",
        "validation-profile",
      ),
    });
    const approvedPlan = planWithPublication(
      baselineCommit,
      preparedPublication,
      options.planChanges,
    );
    const requestPath = join(authorityRoot, "request.json");
    const planPath = join(authorityRoot, "plan.json");
    const policyPath = join(authorityRoot, "policy.json");
    const resultSchemaPath = join(authorityRoot, "agent-result.schema.json");
    await Promise.all([
      writeFile(requestPath, JSON.stringify(request())),
      writeFile(planPath, JSON.stringify(approvedPlan)),
      writeFile(policyPath, '{"allow":"planned-only"}'),
      writeFile(resultSchemaPath, '{"type":"object"}'),
    ]);
    workspace = await createAgentWorkspace({
      repositoryRoot,
      workspaceRoot,
      approvedPlan,
      changeId,
      attemptId: stagingAttemptId,
      baselineCommit,
      requestPath,
      planPath,
      policyPath,
      resultSchemaPath,
    });
    await writeFiles(
      workspace.path,
      options.output?.(approvedPlan) ?? validOutput(approvedPlan),
    );
    output = await validateAgentWorkspaceOutput(workspace, approvedPlan);
    evidenceRoot = await createValidationEvidenceRoot(
      output,
      approvedPlan,
      stagingAttemptId,
    );
    const publicationProfile =
      approvedPlan.publication.configSha256 === preparedPublication.configSha256
        ? await createControllerPublicationProfile(
            output,
            approvedPlan,
            stagingAttemptId,
            preparedPublication,
          )
        : undefined;
    await run(
      output,
      approvedPlan,
      evidenceRoot,
      publicationProfile,
      preparedPublication,
      repositoryRoot,
    );
  } finally {
    if (output !== undefined) {
      await removeStagedAgentOutput(output).catch(() => undefined);
    }
    if (workspace !== undefined) {
      await removeAgentWorkspace(workspace).catch(() => undefined);
    }
    await Promise.all([
      rm(repositoryRoot, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(authorityRoot, { recursive: true, force: true }),
      ...(evidenceRoot === undefined
        ? []
        : [rm(evidenceRoot.path, { recursive: true, force: true })]),
    ]);
  }
}

function passingResult(command?: CommandInvocation): CommandResult {
  return {
    exitCode: 0,
    stdout: "fixture command passed",
    stderr: "",
    timedOut: false,
    aborted: false,
    unsupported: false,
    ...(command?.browser === undefined
      ? {}
      : {
          browserProof: {
            ...command.browser,
            evidenceSha256: fixedHash("e"),
          },
        }),
  };
}

test("never runs a command after an output-policy violation", async () => {
  await withStagedOutput(
    {
      output: (approvedPlan) => {
        const route = `${blockRoute(approvedPlan)}<script>alert(1)</script>`;
        return validOutput(approvedPlan, { route });
      },
    },
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const calls: CommandInvocation[] = [];
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            calls.push(command);
            return passingResult(command);
          },
        },
      );
      assert.equal(results[0]?.id, "output-policy");
      assert.equal(results[0]?.status, "failed");
      assert.equal(calls.length, 0);
      assert.ok(
        results.slice(1).every((result) => result.status === "skipped"),
      );
    },
  );
});

test("records a digest of actual evidence for every successful validator in fixed order", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        { commands: async (command) => passingResult(command) },
      );
      assert.deepEqual(
        results.map((result) => result.id),
        expectedIds,
      );
      assert.ok(results.every((result) => result.status === "passed"));
      for (const result of results) {
        assert.match(result.evidence ?? "", /attempt-000001\/\d{2}-.+\.json$/u);
        assert.match(result.evidenceSha256 ?? "", /^[a-f0-9]{64}$/u);
        const evidence = await readFile(result.evidence!);
        assert.equal(digest(evidence), result.evidenceSha256);
        const record = JSON.parse(evidence.toString("utf8")) as {
          preliminary: {
            scope: string;
            approvedOutputSha256: Record<string, string>;
            executionCopy: { sha256: string } | null;
            publicationProfile: {
              sourceSha256: string;
              generatedSha256: string;
            } | null;
          };
        };
        assert.equal(
          record.preliminary.scope,
          PRELIMINARY_STAGED_VALIDATION_SCOPE,
        );
        assert.deepEqual(
          record.preliminary.approvedOutputSha256,
          output.sha256,
        );
        assert.match(
          record.preliminary.executionCopy?.sha256 ?? "",
          /^[a-f0-9]{64}$/u,
        );
        if (result.id === "npm-ci") {
          assert.equal(
            record.preliminary.publicationProfile?.sourceSha256,
            approvedPlan.publication.configSha256,
          );
          assert.match(
            record.preliminary.publicationProfile?.generatedSha256 ?? "",
            /^[a-f0-9]{64}$/u,
          );
        }
      }
    },
  );
});

test("records bounded sanitized command evidence and skips dependent commands", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const calls: CommandInvocation[] = [];
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            calls.push(command);
            if (command.id === "format") {
              return {
                exitCode: 1,
                stdout: `API_KEY=not-for-evidence\n${"x".repeat(100_000)}`,
                stderr: "failure\u0000details",
                timedOut: false,
                aborted: false,
                unsupported: false,
              };
            }
            return passingResult(command);
          },
        },
      );
      const format = results.find((result) => result.id === "format");
      assert.equal(format?.status, "failed");
      const evidence = await readFile(format!.evidence!, "utf8");
      assert.ok(evidence.length < 20_000);
      assert.ok(!evidence.includes("not-for-evidence"));
      assert.ok(
        results
          .slice(results.indexOf(format!) + 1)
          .every((result) => result.status === "skipped"),
      );
      assert.deepEqual(
        calls.map((command) => command.id),
        ["npm-ci", "format"],
      );
    },
  );
});

test("rejects forged staging and a mismatched plan before command execution", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const calls: CommandInvocation[] = [];
      const commands = async (command: CommandInvocation) => {
        calls.push(command);
        return passingResult(command);
      };
      await assert.rejects(
        runValidation(
          {
            ...validationInput(
              output,
              approvedPlan,
              evidenceRoot,
              publicationProfile,
            ),
            output: { ...output },
          },
          { commands },
        ),
        /staging|controlador/iu,
      );
      const mismatchedPlan = {
        ...approvedPlan,
        changeId: "other-change",
        planSha256: fixedHash("d"),
      };
      await assert.rejects(
        runValidation(
          validationInput(
            output,
            mismatchedPlan,
            evidenceRoot,
            publicationProfile,
          ),
          { commands },
        ),
        /plan|staging|controlador/iu,
      );
      assert.equal(calls.length, 0);
    },
  );
});

test("hands an injected runner only fixed argv, cwd, timeout and safe local environment", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const calls: CommandInvocation[] = [];
      let materializedConfig: string | undefined;
      await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            calls.push(command);
            if (command.id === "format") {
              materializedConfig = await readFile(
                join(command.cwd, "wrangler.jsonc"),
                "utf8",
              );
            }
            return passingResult(command);
          },
        },
      );
      const format = calls.find((command) => command.id === "format");
      assert.ok(format);
      assert.deepEqual(format.argv.slice(1), ["run", "format:check"]);
      assert.notEqual(format.cwd, output.path);
      assert.equal(format.timeoutMs, 600_000);
      assert.deepEqual(format.env, {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: "/tmp",
        LANG: "C",
        LC_ALL: "C",
        CI: "true",
        NO_COLOR: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      });
      assert.ok(!Object.hasOwn(format.env, "CLOUDFLARE_CONFIG_PATH"));
      assert.ok(materializedConfig);
      const materialized = JSON.parse(materializedConfig) as {
        main: string;
        assets: { directory: string };
        d1_databases: Array<{ migrations_dir: string }>;
      };
      assert.equal(materialized.main, "./src/worker.ts");
      assert.equal(materialized.assets.directory, "./dist");
      assert.equal(materialized.d1_databases[0]?.migrations_dir, "./drizzle");
    },
  );
});

test("fails the build validator explicitly when a Cloudflare profile is unavailable", async () => {
  await withStagedOutput(
    {
      planChanges: {
        publication: {
          adapter: "cloudflare",
          configSha256: fixedHash("f"),
          environment: "preview",
          siteIndexable: false,
        },
      },
    },
    async (output, approvedPlan, evidenceRoot) => {
      const calls: CommandInvocation[] = [];
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, undefined),
        {
          commands: async (command) => {
            calls.push(command);
            return passingResult(command);
          },
        },
      );
      assert.equal(
        results.find((result) => result.id === "npm-ci")?.status,
        "failed",
      );
      assert.equal(
        results.find((result) => result.id === "preview")?.status,
        "skipped",
      );
      assert.ok(!calls.some((command) => command.id === "npm-ci"));
    },
  );
});

test("attributes route, asset, link, SEO and accessibility defects before build", async (t) => {
  await t.test("route", async () => {
    await withStagedOutput(
      { planChanges: { targetPath: "/two--hyphens" } },
      async (output, approvedPlan, evidenceRoot) => {
        const results = await runValidation(
          validationInput(output, approvedPlan, evidenceRoot, undefined),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "routes")?.status,
          "failed",
        );
        assert.equal(
          results.find((result) => result.id === "build")?.status,
          "skipped",
        );
      },
    );
  });

  await t.test("asset", async () => {
    await withStagedOutput(
      {
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            extra: {
              [`${assetsPath(approvedPlan)}/zero.png`]: Buffer.from([
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0,
                0, 0, 0, 0, 0, 0, 0,
              ]),
            },
          }),
      },
      async (output, approvedPlan, evidenceRoot) => {
        const results = await runValidation(
          validationInput(output, approvedPlan, evidenceRoot, undefined),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "assets")?.status,
          "failed",
        );
        assert.equal(
          results.find((result) => result.id === "build")?.status,
          "skipped",
        );
      },
    );
  });

  await t.test("link", async () => {
    await withStagedOutput(
      {
        planChanges: { selectedMode: "freeform" },
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            route: freeformRoute(
              approvedPlan,
              '<h1>Generada</h1><a href="#missing">Sin destino</a>',
            ),
          }),
      },
      async (output, approvedPlan, evidenceRoot) => {
        const results = await runValidation(
          validationInput(output, approvedPlan, evidenceRoot, undefined),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "links")?.status,
          "failed",
        );
        assert.equal(
          results.find((result) => result.id === "build")?.status,
          "skipped",
        );
      },
    );
  });

  await t.test("SEO", async () => {
    await withStagedOutput(
      {
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            metadata: { title: null, description: "A valid description" },
          }),
      },
      async (output, approvedPlan, evidenceRoot) => {
        const results = await runValidation(
          validationInput(output, approvedPlan, evidenceRoot, undefined),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "seo")?.status,
          "failed",
        );
        assert.equal(
          results.find((result) => result.id === "build")?.status,
          "skipped",
        );
      },
    );
  });

  await t.test("accessibility", async () => {
    await withStagedOutput(
      {
        planChanges: { selectedMode: "freeform" },
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            route: freeformRoute(
              approvedPlan,
              '<h1>Generada</h1><img src="/guide.pdf">',
            ),
          }),
      },
      async (output, approvedPlan, evidenceRoot) => {
        const results = await runValidation(
          validationInput(output, approvedPlan, evidenceRoot, undefined),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "accessibility")?.status,
          "failed",
        );
        assert.equal(
          results.find((result) => result.id === "build")?.status,
          "skipped",
        );
      },
    );
  });
});

test("runs HTML and visual comparison only for an overwrite", async () => {
  await withStagedOutput(
    { planChanges: { overwritesExistingRoute: true } },
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const calls: CommandInvocation[] = [];
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            calls.push(command);
            return passingResult(command);
          },
        },
      );
      assert.equal(results.at(-1)?.id, "html-visual-comparison");
      assert.ok(
        calls.some((command) => command.id === "html-visual-comparison"),
      );
    },
  );
});

test("never uses the mutable staged input as a command cwd", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const calls: CommandInvocation[] = [];
      await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            calls.push(command);
            return passingResult(command);
          },
        },
      );
      assert.ok(calls.length > 0);
      assert.ok(calls.every((command) => command.cwd !== output.path));
    },
  );
});

test("requires the staged output attempt that minted its evidence", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      await assert.rejects(
        runValidation(
          {
            ...validationInput(
              output,
              approvedPlan,
              evidenceRoot,
              publicationProfile,
            ),
            attemptId: "attempt-from-another-workspace",
          },
          { commands: async (command) => passingResult(command) },
        ),
        /intento|attempt|staging/iu,
      );
    },
  );
});

test("rejects forged or reused evidence and a profile from another attempt before commands", async () => {
  await withStagedOutput(
    {},
    async (
      output,
      approvedPlan,
      evidenceRoot,
      publicationProfile,
      preparedPublication,
    ) => {
      await assert.rejects(
        createControllerPublicationProfile(
          output,
          approvedPlan,
          "attempt-from-another-workspace",
          preparedPublication,
        ),
        /intento|attempt|staging/iu,
      );
      const calls: CommandInvocation[] = [];
      const commands = async (command: CommandInvocation) => {
        calls.push(command);
        return passingResult(command);
      };
      const input = validationInput(
        output,
        approvedPlan,
        evidenceRoot,
        publicationProfile,
      );
      await assert.rejects(
        runValidation(
          { ...input, evidenceRoot: { path: evidenceRoot.path } },
          { commands },
        ),
        /evidencia|controlador/iu,
      );
      assert.equal(calls.length, 0);
      await runValidation(input, { commands });
      const completedCalls = calls.length;
      await assert.rejects(
        runValidation(input, { commands }),
        /reutilizada|reuso|evidencia/iu,
      );
      assert.equal(calls.length, completedCalls);
    },
  );
});

test("binds publication profiles to the prepared project and original digest", async (t) => {
  await t.test(
    "rejects a same-digest profile prepared for another project",
    async () => {
      await withStagedOutput({}, async (output, approvedPlan) => {
        const foreignRoot = await mkdtemp(
          join(tmpdir(), "validation-runner-foreign-profile-"),
        );
        try {
          await writeFiles(foreignRoot, {
            "src/worker.ts": "export default {};\n",
            "dist/.gitkeep": "\n",
            "drizzle/0000_fixture.sql": "SELECT 1;\n",
            "wrangler.jsonc": controllerPublicationConfig,
          });
          const foreignPublication = await preparePlanningPublication({
            adapter: "local",
            projectRoot: foreignRoot,
            stateArtifactRoot: join(
              foreignRoot,
              ".change-state",
              "validation-profile",
            ),
          });
          assert.equal(
            foreignPublication.configSha256,
            approvedPlan.publication.configSha256,
          );
          await assert.rejects(
            createControllerPublicationProfile(
              output,
              approvedPlan,
              stagingAttemptId,
              foreignPublication,
            ),
            /proyecto.*staging/iu,
          );
        } finally {
          await rm(foreignRoot, { recursive: true, force: true });
        }
      });
    },
  );

  await t.test("rejects a changed or malformed source artifact", async () => {
    await withStagedOutput(
      {},
      async (
        output,
        approvedPlan,
        _evidenceRoot,
        _profile,
        publication,
        root,
      ) => {
        const artifactRoot = join(root, ".change-state", "validation-profile");
        const profileName = (await readdir(artifactRoot)).find((name) =>
          name.startsWith("cloudflare-"),
        );
        assert.ok(profileName);
        await writeFile(
          join(artifactRoot, profileName),
          '{"main":"../../../../outside.mjs"}\n',
          "utf8",
        );
        await assert.rejects(
          createControllerPublicationProfile(
            output,
            approvedPlan,
            stagingAttemptId,
            publication,
          ),
          /cambi[oó].*planificaci[oó]n/iu,
        );
      },
    );
  });
});

test("rejects malformed and escaping operational path fields before profile mint", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "validation-runner-unsafe-profile-"),
  );
  try {
    const configPath = join(root, "wrangler.jsonc");
    const base = JSON.parse(controllerPublicationConfig) as {
      main: string;
      assets: { directory: string };
      d1_databases: Array<{ migrations_dir: string }>;
    };
    const cases: Array<{
      readonly label: string;
      readonly config: () => Record<string, unknown>;
      readonly expected: RegExp;
    }> = [
      {
        label: "main outside project",
        config: () => ({ ...base, main: "../outside.mjs" }),
        expected: /main|fuera/iu,
      },
      {
        label: "assets outside project",
        config: () => ({
          ...base,
          assets: { ...base.assets, directory: "../outside" },
        }),
        expected: /assets|fuera/iu,
      },
      {
        label: "migrations outside project",
        config: () => ({
          ...base,
          d1_databases: [
            {
              ...base.d1_databases[0],
              migrations_dir: "../outside",
            },
          ],
        }),
        expected: /migration|fuera/iu,
      },
      {
        label: "malformed assets",
        config: () => ({ ...base, assets: { binding: "ASSETS" } }),
        expected: /assets/iu,
      },
    ];
    for (const current of cases) {
      await writeFile(
        configPath,
        `${JSON.stringify(current.config())}\n`,
        "utf8",
      );
      await assert.rejects(
        preparePlanningPublication({
          adapter: "local",
          projectRoot: root,
          stateArtifactRoot: join(root, ".change-state", current.label),
        }),
        current.expected,
        current.label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails a browser stage when a zero-exit runner has no route proof", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) =>
            command.id === "e2e" ? passingResult() : passingResult(command),
        },
      );
      assert.equal(
        results.find((result) => result.id === "e2e")?.status,
        "failed",
      );
    },
  );
});

test("rejects browser evidence for a route other than the approved target", async () => {
  await withStagedOutput(
    {},
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            if (command.id === "e2e") {
              return {
                ...passingResult(command),
                browserProof: {
                  check: "e2e",
                  targetPath: "/another-route",
                  evidenceSha256: fixedHash("b"),
                },
              } as CommandResult;
            }
            return passingResult(command);
          },
        },
      );
      assert.equal(
        results.find((result) => result.id === "e2e")?.status,
        "failed",
      );
    },
  );
});

test("resolves internal generated links against known clean routes", async () => {
  await withStagedOutput(
    {
      planChanges: { selectedMode: "freeform" },
      output: (approvedPlan) =>
        validOutput(approvedPlan, {
          route: freeformRoute(
            approvedPlan,
            '<h1>Generada</h1><a href="/definitely-missing">No existe</a>',
          ),
        }),
    },
    async (output, approvedPlan, evidenceRoot) => {
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, undefined),
        { commands: async (command) => passingResult(command) },
      );
      assert.equal(
        results.find((result) => result.id === "links")?.status,
        "failed",
      );
    },
  );
});

test("keeps raw command construction and execution private", async () => {
  const source = await readFile(
    new URL("../../src/ingest/validation/commands.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /export\s+(?:async\s+)?function\s+(?:controllerCommand|runControllerCommand)\b/u,
  );
});

test("keeps default process termination bounded to a detached process group", async () => {
  const source = await readFile(
    new URL("../../src/ingest/validation/runner.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /detached:\s*process\.platform\s*!==\s*"win32"/u);
  assert.match(source, /process\.kill\(-child\.pid, signal\)/u);
  assert.match(source, /signalProcessGroup\(child!, "SIGTERM"\)/u);
  assert.match(source, /signalProcessGroup\(child!, "SIGKILL"\)/u);
  assert.match(source, /processTerminationSettleMs/u);
});

function isSameOrWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
  );
}

test("materializes a relocatable publication config without execution-copy escapes", async () => {
  await withStagedOutput(
    {},
    async (
      output,
      approvedPlan,
      evidenceRoot,
      publicationProfile,
      _preparedPublication,
      repositoryRoot,
    ) => {
      const artifactRoot = join(
        repositoryRoot,
        ".change-state",
        "validation-profile",
      );
      const profileName = (await readdir(artifactRoot)).find((name) =>
        name.startsWith("cloudflare-"),
      );
      assert.ok(profileName);
      const source = await readFile(join(artifactRoot, profileName), "utf8");
      assert.match(source, /"main":"\.\.\/\.\.\/src\/worker\.ts"/u);
      assert.match(source, /"directory":"\.\.\/\.\.\/dist"/u);
      assert.match(source, /"migrations_dir":"\.\.\/\.\.\/drizzle"/u);
      let executionCopy = "";
      let materialized: Record<string, unknown> | undefined;
      await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            if (command.id === "format") {
              executionCopy = command.cwd;
              materialized = JSON.parse(
                await readFile(join(command.cwd, "wrangler.jsonc"), "utf8"),
              ) as Record<string, unknown>;
            }
            return passingResult(command);
          },
        },
      );
      assert.ok(materialized);
      const assets = materialized.assets as Record<string, unknown>;
      const database = (
        materialized.d1_databases as Record<string, unknown>[]
      )[0];
      for (const value of [
        materialized.main,
        assets.directory,
        database?.migrations_dir,
      ]) {
        assert.equal(typeof value, "string");
        if (typeof value !== "string") {
          throw new TypeError("El perfil materializado no contiene un path");
        }
        assert.ok(
          isSameOrWithin(executionCopy, resolve(executionCopy, value)),
          `${String(value)} escaped the execution copy`,
        );
      }
    },
  );
});

test("rebases the selected Cloudflare profile into the execution copy", async () => {
  await withStagedOutput(
    { publicationAdapter: "cloudflare" },
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      let build: CommandInvocation | undefined;
      let materialized: Record<string, unknown> | undefined;
      await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          commands: async (command) => {
            if (command.id === "build") {
              build = command;
              materialized = JSON.parse(
                await readFile(join(command.cwd, "wrangler.jsonc"), "utf8"),
              ) as Record<string, unknown>;
            }
            return passingResult(command);
          },
        },
      );
      assert.ok(build);
      assert.equal(build.env.CLOUDFLARE_ENV, "preview");
      assert.equal(
        build.env.CLOUDFLARE_CONFIG_PATH,
        join(build.cwd, "wrangler.jsonc"),
      );
      assert.ok(materialized);
      const assets = materialized.assets as Record<string, unknown>;
      const baseDatabase = (
        materialized.d1_databases as Record<string, unknown>[]
      )[0];
      const environments = materialized.env as Record<
        string,
        Record<string, unknown>
      >;
      const previewDatabase = (
        environments.preview?.d1_databases as Record<string, unknown>[]
      )?.[0];
      for (const value of [
        materialized.main,
        assets.directory,
        baseDatabase?.migrations_dir,
        previewDatabase?.migrations_dir,
      ]) {
        assert.equal(typeof value, "string");
        if (typeof value !== "string") {
          throw new TypeError("El perfil Cloudflare no contiene un path");
        }
        assert.ok(isSameOrWithin(build.cwd, resolve(build.cwd, value)));
      }
      assert.deepEqual(environments.preview?.vars, { SITE_INDEXABLE: "false" });
    },
  );
});

test("resolves known public assets and rejects missing same-origin asset links", async (t) => {
  await t.test("accepts a public asset with query and fragment", async () => {
    await withStagedOutput(
      {
        planChanges: { selectedMode: "freeform" },
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            route: freeformRoute(
              approvedPlan,
              '<h1>Generada</h1><a href="/guide.pdf?download=1#section">Guía</a>',
            ),
          }),
      },
      async (output, approvedPlan, evidenceRoot, publicationProfile) => {
        const results = await runValidation(
          validationInput(
            output,
            approvedPlan,
            evidenceRoot,
            publicationProfile,
          ),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "links")?.status,
          "passed",
        );
      },
    );
  });

  await t.test("accepts a generated public asset", async () => {
    await withStagedOutput(
      {
        planChanges: { selectedMode: "freeform" },
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            route: freeformRoute(
              approvedPlan,
              `<h1>Generada</h1><img src="/generated/${approvedPlan.changeId}/valid.png" alt="Válida">`,
            ),
            extra: {
              [`${assetsPath(approvedPlan)}/valid.png`]: validPngHeader,
            },
          }),
      },
      async (output, approvedPlan, evidenceRoot, publicationProfile) => {
        const results = await runValidation(
          validationInput(
            output,
            approvedPlan,
            evidenceRoot,
            publicationProfile,
          ),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "links")?.status,
          "passed",
        );
      },
    );
  });

  await t.test("rejects a missing extension target", async () => {
    await withStagedOutput(
      {
        planChanges: { selectedMode: "freeform" },
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            route: freeformRoute(
              approvedPlan,
              '<h1>Generada</h1><a href="/definitely-missing.html?x=1#fragment">No existe</a>',
            ),
          }),
      },
      async (output, approvedPlan, evidenceRoot, publicationProfile) => {
        const results = await runValidation(
          validationInput(
            output,
            approvedPlan,
            evidenceRoot,
            publicationProfile,
          ),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "links")?.status,
          "failed",
        );
      },
    );
  });

  await t.test("rejects a missing internal src asset", async () => {
    await withStagedOutput(
      {
        planChanges: { selectedMode: "freeform" },
        output: (approvedPlan) =>
          validOutput(approvedPlan, {
            route: freeformRoute(
              approvedPlan,
              '<h1>Generada</h1><img src="/definitely-missing.png" alt="No existe">',
            ),
          }),
      },
      async (output, approvedPlan, evidenceRoot, publicationProfile) => {
        const results = await runValidation(
          validationInput(
            output,
            approvedPlan,
            evidenceRoot,
            publicationProfile,
          ),
          { commands: async (command) => passingResult(command) },
        );
        assert.equal(
          results.find((result) => result.id === "links")?.status,
          "failed",
        );
      },
    );
  });
});

test("terminates a pipe-holding descendant after its npm leader exits", async (t) => {
  if (process.platform === "win32") {
    t.skip("la regresión de grupo de procesos usa el shell POSIX fijo");
    return;
  }
  const runnerModule =
    (await import("../../src/ingest/validation/runner.ts")) as unknown as {
      createValidationTimeoutTestCapability?: () => unknown;
    };
  assert.equal(
    typeof runnerModule.createValidationTimeoutTestCapability,
    "function",
    "a fixed opaque test timing capability is required for the bounded timeout regression",
  );
  const createTimeoutTestCapability =
    runnerModule.createValidationTimeoutTestCapability;
  if (createTimeoutTestCapability === undefined) return;
  const timeoutTestController = createTimeoutTestCapability();

  await withStagedOutput(
    {
      packageJson: `${JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        private: true,
        scripts: {
          "format:check":
            'sh -c \'sleep 4 & printf \\"child=%s\\\\n\\" \\"$!\\" >&2\'',
        },
      })}\n`,
    },
    async (output, approvedPlan, evidenceRoot, publicationProfile) => {
      const started = performance.now();
      const results = await runValidation(
        validationInput(output, approvedPlan, evidenceRoot, publicationProfile),
        {
          testController: timeoutTestController,
        } as unknown as Parameters<typeof runValidation>[1],
      );
      const format = results.find((result) => result.id === "format");
      assert.equal(format?.status, "failed");
      assert.ok(performance.now() - started < 3_000);
      const evidence = JSON.parse(
        await readFile(format!.evidence!, "utf8"),
      ) as {
        details: { result: { stderr: string; timedOut: boolean } };
      };
      assert.equal(evidence.details.result.timedOut, true);
      const pid = Number(
        /child="?(\d+)/u.exec(evidence.details.result.stderr)?.[1],
      );
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      await new Promise<void>((done) => setTimeout(done, 100));
      assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    },
  );
});
