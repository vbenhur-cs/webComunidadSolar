import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { ChangePlan } from "../../src/ingest/domain.ts";
import {
  createValidationEvidenceRoot,
  runValidation,
  type CommandInvocation,
  type CommandResult,
  type ValidationEvidenceRoot,
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
const digest = (source: string | Uint8Array) =>
  createHash("sha256").update(source).digest("hex");
const fixedHash = (character: string) => character.repeat(64);

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

function plan(baselineCommit: string, changes: PlanChanges = {}): ChangePlan {
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
    publication:
      changes.publication ??
      ({
        adapter: "local" as const,
        configSha256: fixedHash("c"),
        environment: null,
        siteIndexable: false,
      } satisfies ChangePlan["publication"]),
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
}

async function withStagedOutput(
  options: StageOptions,
  run: (
    output: StagedAgentOutput,
    approvedPlan: ChangePlan,
    evidenceRoot: ValidationEvidenceRoot,
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
  const evidencePath = await mkdtemp(
    join(tmpdir(), "validation-runner-evidence-"),
  );
  let workspace: Awaited<ReturnType<typeof createAgentWorkspace>> | undefined;
  let output: StagedAgentOutput | undefined;
  try {
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
      "package.json": '{"name":"fixture","version":"1.0.0","private":true}\n',
      "package-lock.json":
        '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n',
    });
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baselineCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const approvedPlan = plan(baselineCommit, options.planChanges);
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
      attemptId: "attempt-000001",
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
    await run(
      output,
      approvedPlan,
      await createValidationEvidenceRoot(evidencePath),
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
      rm(evidencePath, { recursive: true, force: true }),
    ]);
  }
}

function passingResult(): CommandResult {
  return {
    exitCode: 0,
    stdout: "fixture command passed",
    stderr: "",
    timedOut: false,
    aborted: false,
    unsupported: false,
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
    async (output, approvedPlan, evidenceRoot) => {
      const calls: CommandInvocation[] = [];
      const results = await runValidation(
        {
          output,
          plan: approvedPlan,
          attemptId: "attempt-policy",
          evidenceRoot,
        },
        {
          commands: async (command) => {
            calls.push(command);
            return passingResult();
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
  await withStagedOutput({}, async (output, approvedPlan, evidenceRoot) => {
    const results = await runValidation(
      {
        output,
        plan: approvedPlan,
        attemptId: "attempt-success",
        evidenceRoot,
      },
      { commands: async () => passingResult() },
    );
    assert.deepEqual(
      results.map((result) => result.id),
      expectedIds,
    );
    assert.ok(results.every((result) => result.status === "passed"));
    for (const result of results) {
      assert.match(result.evidence ?? "", /attempt-success\/\d{2}-.+\.json$/u);
      assert.match(result.evidenceSha256 ?? "", /^[a-f0-9]{64}$/u);
      const evidence = await readFile(result.evidence!);
      assert.equal(digest(evidence), result.evidenceSha256);
    }
  });
});

test("records bounded sanitized command evidence and skips dependent commands", async () => {
  await withStagedOutput({}, async (output, approvedPlan, evidenceRoot) => {
    const calls: CommandInvocation[] = [];
    const results = await runValidation(
      {
        output,
        plan: approvedPlan,
        attemptId: "attempt-command-failure",
        evidenceRoot,
      },
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
          return passingResult();
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
  });
});

test("rejects forged staging and a mismatched plan before command execution", async () => {
  await withStagedOutput({}, async (output, approvedPlan, evidenceRoot) => {
    const calls: CommandInvocation[] = [];
    const commands = async (command: CommandInvocation) => {
      calls.push(command);
      return passingResult();
    };
    await assert.rejects(
      runValidation(
        {
          output: { ...output },
          plan: approvedPlan,
          attemptId: "attempt-forged",
          evidenceRoot,
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
        {
          output,
          plan: mismatchedPlan,
          attemptId: "attempt-mismatch",
          evidenceRoot,
        },
        { commands },
      ),
      /plan|staging|controlador/iu,
    );
    assert.equal(calls.length, 0);
  });
});

test("hands an injected runner only fixed argv, cwd, timeout and safe local environment", async () => {
  await withStagedOutput({}, async (output, approvedPlan, evidenceRoot) => {
    const calls: CommandInvocation[] = [];
    await runValidation(
      {
        output,
        plan: approvedPlan,
        attemptId: "attempt-authority",
        evidenceRoot,
      },
      {
        commands: async (command) => {
          calls.push(command);
          return passingResult();
        },
      },
    );
    const format = calls.find((command) => command.id === "format");
    assert.ok(format);
    assert.deepEqual(format.argv.slice(1), ["run", "format:check"]);
    assert.equal(format.cwd, output.path);
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
  });
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
        {
          output,
          plan: approvedPlan,
          attemptId: "attempt-cloudflare-profile",
          evidenceRoot,
        },
        {
          commands: async (command) => {
            calls.push(command);
            return passingResult();
          },
        },
      );
      assert.equal(
        results.find((result) => result.id === "build")?.status,
        "failed",
      );
      assert.equal(
        results.find((result) => result.id === "preview")?.status,
        "skipped",
      );
      assert.ok(!calls.some((command) => command.id === "build"));
    },
  );
});

test("attributes route, asset, link, SEO and accessibility defects before build", async (t) => {
  await t.test("route", async () => {
    await withStagedOutput(
      { planChanges: { targetPath: "/two--hyphens" } },
      async (output, approvedPlan, evidenceRoot) => {
        const results = await runValidation(
          {
            output,
            plan: approvedPlan,
            attemptId: "attempt-route",
            evidenceRoot,
          },
          { commands: async () => passingResult() },
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
          {
            output,
            plan: approvedPlan,
            attemptId: "attempt-asset",
            evidenceRoot,
          },
          { commands: async () => passingResult() },
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
          {
            output,
            plan: approvedPlan,
            attemptId: "attempt-link",
            evidenceRoot,
          },
          { commands: async () => passingResult() },
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
          {
            output,
            plan: approvedPlan,
            attemptId: "attempt-seo",
            evidenceRoot,
          },
          { commands: async () => passingResult() },
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
              '<h1>Generada</h1><img src="/generated/missing.png">',
            ),
          }),
      },
      async (output, approvedPlan, evidenceRoot) => {
        const results = await runValidation(
          {
            output,
            plan: approvedPlan,
            attemptId: "attempt-accessibility",
            evidenceRoot,
          },
          { commands: async () => passingResult() },
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
    async (output, approvedPlan, evidenceRoot) => {
      const calls: CommandInvocation[] = [];
      const results = await runValidation(
        {
          output,
          plan: approvedPlan,
          attemptId: "attempt-overwrite",
          evidenceRoot,
        },
        {
          commands: async (command) => {
            calls.push(command);
            return passingResult();
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
