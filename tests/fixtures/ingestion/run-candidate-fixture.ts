import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { sha256Canonical } from "../../../src/ingest/canonical-json.ts";
import {
  createCandidate,
  createControllerCandidateStoreTestInitialization,
  openControllerCandidateStore,
  releaseControllerCandidateStore,
  verifyCandidateArtifact,
  type ControllerCandidateStore,
} from "../../../src/ingest/candidate/manifest.ts";
import { createCandidateBuildTestCapability } from "../../../src/ingest/candidate/evidence.ts";
import {
  createCandidatePreviewTestCapability,
  startCandidatePreview,
  type PreviewHandle,
} from "../../../src/ingest/candidate/preview.ts";
import type {
  ChangePlan,
  ValidationResult,
} from "../../../src/ingest/domain.ts";
import { preparePlanningPublication } from "../../../src/ingest/planning/plan.ts";
import {
  createControllerPublicationProfile,
  createValidationEvidenceRoot,
  runValidation,
  type CommandInvocation,
  type CommandResult,
  type ValidationEvidenceRoot,
} from "../../../src/ingest/validation/runner.ts";
import {
  removeStagedAgentOutput,
  validateAgentWorkspaceOutput,
  type StagedAgentOutput,
} from "../../../src/ingest/workspaces/policy.ts";
import {
  createAgentWorkspace,
  removeAgentWorkspace,
} from "../../../src/ingest/workspaces/service.ts";

if (process.env.INGEST_TEST_MODE !== "true") {
  throw new TypeError("Esta fixture exige INGEST_TEST_MODE=true");
}

const execFileAsync = promisify((await import("node:child_process")).execFile);
const changeId = "candidate-fixture";
const attemptId = "attempt-000001";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function fixtureRequest() {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    inputKind: "request" as const,
    intent: "Create a verifiable immutable candidate fixture",
    audience: null,
    targetPath: "/candidate-fixture" as const,
    mode: "blocks" as const,
    content: "A local candidate fixture.",
    claims: [],
    references: [],
    assets: [],
    seo: {
      title: "Candidate fixture",
      description: "Temporary controller fixture.",
      index: false,
    },
    privacy: { private: false, area: null },
    allowedExternalLinks: [],
    acceptanceCriteria: ["Candidate is immutable"],
  };
  return { ...unsigned, inputSha256: sha256Canonical(unsigned) };
}

function fixturePlan(
  baselineCommit: string,
  publication: ChangePlan["publication"],
): ChangePlan {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    baselineCommit,
    requestSha256: fixtureRequest().inputSha256,
    selectedMode: "blocks" as const,
    targetPath: "/candidate-fixture" as const,
    overwritesExistingRoute: false,
    files: [
      {
        path: "src/pages/candidate-fixture.astro",
        operation: "create" as const,
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
    publication,
  };
  return { ...unsigned, planSha256: sha256Canonical(unsigned) };
}

function fixtureOutput(plan: ChangePlan): Readonly<Record<string, string>> {
  const route = `---
import GeneratedBlockPage from "../components/blocks/GeneratedBlockPage.astro";
import page from "../content/generated/${plan.changeId}.json";
---
<GeneratedBlockPage {page} />
`;
  return {
    "src/pages/candidate-fixture.astro": route,
    [`src/content/generated/${plan.changeId}.json`]: JSON.stringify({
      schemaVersion: 1,
      changeId: plan.changeId,
      mode: plan.selectedMode,
      route: plan.targetPath,
      metadata: {
        title: "Candidate fixture",
        description: "A temporary immutable candidate.",
        index: false,
      },
      privacy: { private: false, area: null },
      contentSha256: sha256(route),
      blocks: [
        {
          type: "hero",
          eyebrow: "Fixture",
          title: "Immutable candidate",
          lead: "Candidate output is copied exactly.",
          primary: { label: "Contact", href: "/contacto" },
        },
      ],
    }),
  };
}

function passedCommand(command: CommandInvocation): CommandResult {
  return {
    exitCode: 0,
    stdout: "fixture command passed",
    stderr: "",
    timedOut: false,
    aborted: false,
    unsupported: false,
    ...(command.browser === undefined
      ? {}
      : {
          browserProof: {
            ...command.browser,
            evidenceSha256: "f".repeat(64),
          },
        }),
  };
}

async function runFixture(): Promise<void> {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "candidate-fixture-repository-"),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "candidate-fixture-workspace-"),
  );
  const authorityRoot = await mkdtemp(
    join(tmpdir(), "candidate-fixture-input-"),
  );
  let workspace: Awaited<ReturnType<typeof createAgentWorkspace>> | undefined;
  let output: StagedAgentOutput | undefined;
  let evidenceRoot: ValidationEvidenceRoot | undefined;
  let store: ControllerCandidateStore | undefined;
  let preview: PreviewHandle | undefined;
  try {
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--object-format=sha256",
      "--initial-branch=main",
      repositoryRoot,
    ]);
    await git(repositoryRoot, ["config", "user.email", "fixture@example.test"]);
    await git(repositoryRoot, ["config", "user.name", "Fixture Human"]);
    await writeFiles(repositoryRoot, {
      "README.md": "candidate fixture\n",
      ".gitignore": ".artifacts/\n.change-state/\n.wrangler/\ndist/\n",
      "package.json":
        '{"name":"candidate-fixture","version":"1.0.0","private":true}\n',
      "package-lock.json":
        '{"name":"candidate-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"candidate-fixture","version":"1.0.0"}}}\n',
      "src/pages/index.astro": "<main>Home</main>\n",
      "src/pages/contacto.astro": "<main>Contact</main>\n",
      "src/components/blocks/GeneratedBlockPage.astro": "<main>Blocks</main>\n",
      "src/worker.ts": "export default {};\n",
      "drizzle/0000_fixture.sql": "SELECT 1;\n",
      "wrangler.jsonc": JSON.stringify({
        name: "candidate-fixture",
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
            database_name: "candidate-fixture",
            database_id: "00000000-0000-4000-8000-000000000000",
            migrations_dir: "./drizzle",
          },
        ],
        vars: { SITE_INDEXABLE: "false" },
      }),
    });
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baselineCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const wranglerExecutable = join(
      repositoryRoot,
      "node_modules",
      ".bin",
      "wrangler",
    );
    await mkdir(dirname(wranglerExecutable), { recursive: true });
    await writeFile(wranglerExecutable, "#!/bin/sh\nexit 0\n");
    await chmod(wranglerExecutable, 0o700);
    const preparedPublication = await preparePlanningPublication({
      adapter: "local",
      projectRoot: repositoryRoot,
      stateArtifactRoot: join(repositoryRoot, ".change-state", "profile"),
    });
    const plan = fixturePlan(baselineCommit, {
      adapter: preparedPublication.adapter,
      configSha256: preparedPublication.configSha256,
      environment: preparedPublication.environment,
      siteIndexable: preparedPublication.siteIndexable,
    });
    const requestPath = join(authorityRoot, "request.json");
    const planPath = join(authorityRoot, "plan.json");
    const policyPath = join(authorityRoot, "policy.json");
    const resultSchemaPath = join(authorityRoot, "agent-result.schema.json");
    await Promise.all([
      writeFile(requestPath, JSON.stringify(fixtureRequest())),
      writeFile(planPath, JSON.stringify(plan)),
      writeFile(policyPath, '{"allow":"planned-only"}'),
      writeFile(resultSchemaPath, '{"type":"object"}'),
    ]);
    workspace = await createAgentWorkspace({
      repositoryRoot,
      workspaceRoot,
      approvedPlan: plan,
      changeId,
      attemptId,
      baselineCommit,
      requestPath,
      planPath,
      policyPath,
      resultSchemaPath,
    });
    await writeFiles(workspace.path, fixtureOutput(plan));
    output = await validateAgentWorkspaceOutput(workspace, plan);
    evidenceRoot = await createValidationEvidenceRoot(output, plan, attemptId);
    const publicationProfile = await createControllerPublicationProfile(
      output,
      plan,
      attemptId,
      preparedPublication,
    );
    const preliminary: ValidationResult[] = await runValidation(
      { output, plan, attemptId, evidenceRoot, publicationProfile },
      { commands: async (command) => passedCommand(command) },
    );
    const storeInitialization =
      await createControllerCandidateStoreTestInitialization(repositoryRoot);
    store = await openControllerCandidateStore(storeInitialization);
    const build = createCandidateBuildTestCapability({
      files: {
        "dist/_worker.js/index.js":
          "export default { fetch() { return new Response('candidate'); } };\n",
        "dist/index.html": "<main>immutable fixture</main>\n",
        "dist/wrangler.json": JSON.stringify({
          targetEnvironment: plan.publication.environment,
          name: "candidate-fixture",
          main: "_worker.js/index.js",
          assets: { binding: "ASSETS", directory: ".", run_worker_first: true },
          vars: { SITE_INDEXABLE: "false" },
          bindings: ["ASSETS", "DB"],
          d1_databases: [
            {
              binding: "DB",
              database_id: "00000000-0000-4000-8000-000000000000",
              database_name: "candidate-fixture",
              migrations_dir: "drizzle",
            },
          ],
        }),
        ".wrangler/deploy/config.json": JSON.stringify({
          configPath: "../../dist/wrangler.json",
          auxiliaryWorkers: [],
        }),
      },
      validations: [
        { id: "candidate-build", status: "passed", evidence: "fixture" },
      ],
    });
    const previewCapability = createCandidatePreviewTestCapability(async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const http=require('node:http');const server=http.createServer((_,res)=>res.end('ok'));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const port = await new Promise<string>((resolvePort, rejectPort) => {
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          const match = stdout.match(/^(\d+)\n/u);
          if (match?.[1] !== undefined) resolvePort(match[1]);
        });
        child.once("error", rejectPort);
        child.once("exit", (code) => {
          if (code !== 0)
            rejectPort(new Error(`preview fixture exited ${code}`));
        });
      });
      return { child, url: `http://127.0.0.1:${port}` };
    });
    const candidate = await createCandidate({
      output,
      plan,
      attemptId,
      preliminaryValidations: preliminary,
      store,
      buildCapability: build,
      previewCapability,
    });
    await verifyCandidateArtifact(candidate);
    assert.match(candidate.candidateCommit, /^[a-f0-9]{64}$/u);
    assert.match(candidate.artifactSha256, /^[a-f0-9]{64}$/u);
    preview = await startCandidatePreview(candidate);
    const response = await fetch(preview.url);
    assert.equal(response.status, 200);
    await preview.stop();
    preview = undefined;
    process.stdout.write(
      `${JSON.stringify({
        state: "validated",
        candidateCommit: candidate.candidateCommit,
        artifactSha256: candidate.artifactSha256,
        previewStatus: response.status,
      })}\n`,
    );
  } finally {
    await preview?.stop().catch(() => undefined);
    if (store !== undefined) {
      await releaseControllerCandidateStore(store).catch(() => undefined);
    }
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

await runFixture();
