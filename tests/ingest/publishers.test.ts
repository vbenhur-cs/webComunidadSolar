import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import {
  canonicalJson,
  sha256Canonical,
} from "../../src/ingest/canonical-json.ts";
import { candidateApprovalSubject } from "../../src/ingest/dossier-integrity.ts";
import {
  createCandidate,
  createCandidatePromotionTestCapability,
  assertCandidateLocalPublication,
  loadCandidate,
  openControllerCandidateStore,
  releaseControllerCandidateStore,
  type ControllerCandidateStore,
} from "../../src/ingest/candidate/manifest.ts";
import { createCandidateBuildTestCapability } from "../../src/ingest/candidate/evidence.ts";
import {
  createCandidatePreviewTestCapability,
  type PreviewAssertionDescriptor,
} from "../../src/ingest/candidate/preview.ts";
import {
  createCloudflarePublisherTestCapability,
  CloudflarePublisher,
} from "../../src/ingest/publishers/cloudflare.ts";
import {
  createLocalPublisherTestCapability,
  LocalPublisher,
} from "../../src/ingest/publishers/local.ts";
import type { OperatorProfile } from "../../src/ingest/publishers/types.ts";
import {
  approveGate1,
  approveGate2,
} from "../../src/ingest/approvals/service.ts";
import { createFixtureApprovalRun } from "../../src/ingest/approvals/prompt.ts";
import type {
  AttemptRecord,
  CandidateManifest,
  ChangePlan,
  ValidationResult,
} from "../../src/ingest/domain.ts";
import { ingestPaths } from "../../src/ingest/paths.ts";
import { preparePlanningPublication } from "../../src/ingest/planning/plan.ts";
import { createStateStore, writeAtomic } from "../../src/ingest/state-store.ts";
import {
  createControllerPublicationProfile,
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
import { promoteCandidate } from "../../src/ingest/promotion.ts";

process.env.INGEST_TEST_MODE ??= "true";

const execFileAsync = promisify((await import("node:child_process")).execFile);
const changeId = "publisher-candidate";
const attemptId = "attempt-000001";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

type OutputFiles = Readonly<Record<string, string>>;
type CloudflareDryRunDescriptor = Parameters<
  Parameters<typeof createCloudflarePublisherTestCapability>[0]
>[0];

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function writeFiles(root: string, files: OutputFiles): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

function fixtureRequest() {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    inputKind: "request" as const,
    intent: "Publish a verified candidate fixture",
    audience: null,
    targetPath: "/publisher" as const,
    mode: "blocks" as const,
    content: "Local publication fixture.",
    claims: [],
    references: [],
    assets: [],
    seo: { title: "Publisher", description: "Fixture", index: false },
    privacy: { private: false, area: null },
    allowedExternalLinks: [],
    acceptanceCriteria: ["Candidate serves the copied artifact"],
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
    targetPath: "/publisher" as const,
    overwritesExistingRoute: false,
    files: [
      { path: "src/pages/publisher.astro", operation: "create" as const },
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
      { path: `public/generated/${changeId}`, operation: "create" as const },
    ],
    components: ["SiteLayout"],
    islands: [],
    dependencies: [],
    validations: ["output-policy", "build"],
    publication,
  };
  return { ...unsigned, planSha256: sha256Canonical(unsigned) };
}

function fixtureOutput(plan: ChangePlan): OutputFiles {
  const route = `---
import GeneratedBlockPage from "../components/blocks/GeneratedBlockPage.astro";
import page from "../content/generated/${plan.changeId}.json";
---
<GeneratedBlockPage {page} />
`;
  return {
    "src/pages/publisher.astro": route,
    [`src/content/generated/${plan.changeId}.json`]: JSON.stringify({
      schemaVersion: 1,
      changeId: plan.changeId,
      mode: plan.selectedMode,
      route: plan.targetPath,
      metadata: {
        title: "Publisher fixture",
        description: "A verified copied artifact.",
        index: false,
      },
      privacy: { private: false, area: null },
      contentSha256: sha256(route),
      blocks: [
        {
          type: "hero",
          eyebrow: "Fixture",
          title: "Published candidate",
          lead: "Only a sealed copied bundle is served.",
          primary: { label: "Contacto", href: "/contacto" },
        },
      ],
    }),
  };
}

function candidateDestination(plan: ChangePlan) {
  return plan.publication.environment === "preview"
    ? {
        databaseId: "11111111-1111-4111-8111-111111111111",
        databaseName: "publisher-fixture-preview",
      }
    : {
        databaseId: "22222222-2222-4222-8222-222222222222",
        databaseName: "publisher-fixture",
      };
}

function flattenedConfig(
  plan: ChangePlan,
  main: string,
  assetsDirectory: string,
): string {
  const destination = candidateDestination(plan);
  return JSON.stringify({
    targetEnvironment: plan.publication.environment,
    name: "publisher-fixture",
    main,
    assets: {
      binding: "ASSETS",
      directory: assetsDirectory,
      run_worker_first: true,
    },
    vars: { SITE_INDEXABLE: plan.publication.siteIndexable ? "true" : "false" },
    bindings: ["ASSETS", "DB"],
    d1_databases: [
      {
        binding: "DB",
        database_id: destination.databaseId,
        database_name: destination.databaseName,
        migrations_dir: "drizzle",
      },
    ],
  });
}

function candidateBuildFixture(plan: ChangePlan) {
  const config = flattenedConfig(plan, "_worker.js/index.js", ".");
  const nestedConfig = flattenedConfig(plan, "../_worker.js/index.js", "..");
  return {
    files: {
      "dist/_worker.js/index.js":
        "export default { fetch() { return new Response('ok'); } };\n",
      "dist/index.html": "<main>exact candidate bundle</main>\n",
      "dist/wrangler.json": config,
      "dist/.prerender/wrangler.json": nestedConfig,
      "dist/auxiliary/wrangler.json": nestedConfig,
      ".wrangler/deploy/config.json": JSON.stringify({
        configPath: "../../dist/wrangler.json",
        auxiliaryWorkers: ["../../dist/auxiliary/wrangler.json"],
        prerenderWorkerConfigPath: "../../dist/.prerender/wrangler.json",
      }),
    },
    validations: [
      { id: "candidate-build", status: "passed" as const, evidence: "fixture" },
    ],
  };
}

function fixtureOperator(plan: ChangePlan): OperatorProfile {
  const config = flattenedConfig(plan, "_worker.js/index.js", ".");
  const nestedConfig = flattenedConfig(plan, "../_worker.js/index.js", "..");
  const flattenedConfigSha256 = sha256(
    canonicalJson([
      { path: "dist/.prerender/wrangler.json", sha256: sha256(nestedConfig) },
      { path: "dist/auxiliary/wrangler.json", sha256: sha256(nestedConfig) },
      { path: "dist/wrangler.json", sha256: sha256(config) },
    ]),
  );
  const destination = candidateDestination(plan);
  return {
    ...plan.publication,
    flattenedConfigSha256,
    destination: {
      workerName: "publisher-fixture",
      d1: {
        binding: "DB",
        databaseId: destination.databaseId,
        databaseName: destination.databaseName,
      },
    },
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
            evidenceSha256: "e".repeat(64),
          },
        }),
  };
}

async function fixtureWrangler(
  repositoryRoot: string,
  exitCode = 0,
): Promise<void> {
  const executable = join(repositoryRoot, "node_modules", ".bin", "wrangler");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, `#!/bin/sh\nexit ${exitCode.toString()}\n`);
  await chmod(executable, 0o700);
}

async function waitForPort(child: ReturnType<typeof spawn>): Promise<string> {
  return await new Promise<string>((resolvePort, rejectPort) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/^(\d+)\n/u);
      if (match?.[1] !== undefined) resolvePort(match[1]);
    });
    child.once("error", rejectPort);
    child.once("exit", (code) => {
      if (code !== 0) rejectPort(new Error(`fixture preview exited ${code}`));
    });
  });
}

interface PublisherFixture {
  readonly repositoryRoot: string;
  readonly candidate: CandidateManifest;
  readonly plan: ChangePlan;
  readonly operator: OperatorProfile;
  readonly previewInvocations: PreviewAssertionDescriptor[];
  readonly previewPids: number[];
  reloadCandidate(): Promise<CandidateManifest>;
}

/** Test-only fixture setup; candidate production APIs receive no root input. */
async function openFixtureCandidateStore(
  repositoryRoot: string,
): Promise<ControllerCandidateStore> {
  const previous = process.cwd();
  process.chdir(repositoryRoot);
  try {
    return await openControllerCandidateStore();
  } finally {
    process.chdir(previous);
  }
}

function fixtureCandidateBundlePath(repositoryRoot: string): string {
  return join(
    repositoryRoot,
    ".artifacts",
    "candidates",
    changeId,
    attemptId,
    "bundle",
  );
}

function fixturePromotionLeaseRaceMarker(repositoryRoot: string): string {
  return join(
    repositoryRoot,
    ".change-state",
    changeId,
    "candidates",
    attemptId,
    "promotion-lease-race.test",
  );
}

function fixturePromotionLeaseRaceAcknowledgement(
  repositoryRoot: string,
): string {
  return join(
    repositoryRoot,
    ".change-state",
    changeId,
    "candidates",
    attemptId,
    "promotion-lease-race-ack.test",
  );
}

async function waitForLeaseRaceReady(
  path: string,
  operation: Promise<unknown>,
): Promise<void> {
  let operationFailure: unknown;
  void operation.catch((error: unknown) => {
    operationFailure = error;
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (operationFailure !== undefined) throw operationFailure;
    try {
      if ((await readFile(path, "utf8")) === "ready\n") return;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 10);
    });
  }
  // Never let the fixture cleanup race a still-running promotion: that would
  // hide the real timeout behind a worktree-removal error.
  await operation.catch(() => undefined);
  throw new Error("promotion lease race did not become ready");
}

interface PublisherFixtureOptions {
  readonly adapter?: "local" | "cloudflare";
  readonly environment?: string;
  readonly approvalAuthority?: "fixture" | "controller";
  readonly wranglerExitCode?: 0 | 1;
}

/**
 * This test helper drives the real interactive production branch. It is local
 * to this test file: neither the controller nor the approval service accepts
 * a test prompt/capability for controller-production approvals.
 */
async function withInteractiveControllerAnswer<T>(
  answer: string,
  operation: () => Promise<T>,
): Promise<T> {
  const inputTty = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  const outputTty = Object.getOwnPropertyDescriptor(stdout, "isTTY");
  const outputWrite = Object.getOwnPropertyDescriptor(stdout, "write");
  const originalWrite = stdout.write.bind(stdout);
  let delivered = false;
  Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(stdout, "write", {
    configurable: true,
    value: ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const written = Reflect.apply(originalWrite, stdout, [chunk, ...args]);
      const text =
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      if (!delivered && text.includes("Escriba ")) {
        delivered = true;
        setImmediate(() => stdin.emit("data", `${answer}\n`));
      }
      return written;
    }) as typeof stdout.write,
    writable: true,
  });
  try {
    return await operation();
  } finally {
    if (inputTty === undefined) delete (stdin as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(stdin, "isTTY", inputTty);
    if (outputTty === undefined) delete (stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(stdout, "isTTY", outputTty);
    if (outputWrite === undefined) delete (stdout as { write?: unknown }).write;
    else Object.defineProperty(stdout, "write", outputWrite);
  }
}

async function persistPublisherState(
  repositoryRoot: string,
  plan: ChangePlan,
  candidate: CandidateManifest,
): Promise<void> {
  const stateRoot = join(repositoryRoot, ".change-state");
  const paths = await ingestPaths(changeId, { stateRoot });
  const attempt: AttemptRecord = {
    schemaVersion: 1,
    changeId,
    attemptId,
    status: "validated",
    resumeState: null,
    adapter: plan.publication.adapter,
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:01:00.000Z",
    requestSha256: plan.requestSha256,
    planSha256: plan.planSha256,
    baselineCommit: plan.baselineCommit,
    generatedFiles: [...candidate.files],
    logs: { stdout: null, stderr: null, finalMessage: null },
    validations: candidate.validations
      .filter((validation) =>
        validation.evidence.startsWith("evidence/preliminary/"),
      )
      .map((validation) => {
        if (typeof validation.evidenceSha256 !== "string") {
          throw new TypeError(
            "La fixture no recibió hash de evidencia candidata",
          );
        }
        return {
          id: validation.id,
          status: "passed" as const,
          evidence: `candidates/${attemptId}/${validation.evidence}`,
          evidenceSha256: validation.evidenceSha256,
        };
      }),
    failure: null,
  };
  await Promise.all([
    writeFile(paths.request, canonicalJson(fixtureRequest())),
    writeFile(paths.plan, canonicalJson(plan)),
    writeFile(paths.candidate, canonicalJson(candidate)),
    writeFile(
      join(paths.attemptsDir, `${attemptId}.json`),
      canonicalJson(attempt),
    ),
  ]);

  const state = createStateStore({ stateRoot });
  await state.transition(changeId, {
    type: "received",
    to: "received",
    payload: {},
  });
  await state.transition(changeId, {
    type: "normalized",
    to: "normalized",
    payload: {},
  });
  await state.transition(changeId, {
    type: "planned",
    to: "planned",
    payload: {},
  });
  await state.transition(changeId, {
    type: "gate1-approved",
    to: "gate1_approved",
    payload: {},
  });
  await state.transition(changeId, {
    type: "generated",
    to: "generated",
    payload: {},
  });
  await state.transition(changeId, {
    type: "validated",
    to: "validated",
    payload: {},
  });
}

async function forgeFixtureApprovalIssuerAndEnvironment(
  repositoryRoot: string,
): Promise<void> {
  const paths = await ingestPaths(changeId, {
    stateRoot: join(repositoryRoot, ".change-state"),
  });
  for (const gate of [1, 2] as const) {
    const path = join(paths.approvalsDir, `gate-${gate}.json`);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    const forged = {
      ...record,
      actor: "controller-human",
      environment: "production",
    };
    await writeFile(path, canonicalJson(forged));
    await writeFile(
      join(paths.approvalsDir, `gate-${gate}.provenance.json`),
      canonicalJson({
        schemaVersion: 1,
        issuer: "controller",
        environment: "production",
        approvalSha256: sha256Canonical(forged),
        signature: "0".repeat(64),
      }),
    );
  }
}

async function withPublisherFixture(
  options: PublisherFixtureOptions,
  run: (fixture: PublisherFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "publisher-fixture-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const workspaceRoot = await mkdtemp(join(tmpdir(), "publisher-workspace-"));
  const authorityRoot = await mkdtemp(join(tmpdir(), "publisher-authority-"));
  let fixture: Awaited<ReturnType<typeof createFixtureApprovalRun>> | undefined;
  let workspace: Awaited<ReturnType<typeof createAgentWorkspace>> | undefined;
  let output: StagedAgentOutput | undefined;
  let evidenceRoot: ValidationEvidenceRoot | undefined;
  let store: ControllerCandidateStore | undefined;
  try {
    await execFileAsync("git", [
      "init",
      "--bare",
      "--quiet",
      "--object-format=sha256",
      "--initial-branch=main",
      origin,
    ]);
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--object-format=sha256",
      "--initial-branch=main",
      seed,
    ]);
    await git(seed, ["config", "user.email", "fixture@example.test"]);
    await git(seed, ["config", "user.name", "Fixture Human"]);
    await writeFiles(seed, {
      "README.md": "publisher fixture\n",
      ".gitignore":
        ".artifacts/\n.change-state/\n.wrangler/\ndist/\nnode_modules/\n",
      "package.json":
        '{"name":"publisher-fixture","version":"1.0.0","private":true}\n',
      "package-lock.json":
        '{"name":"publisher-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"publisher-fixture","version":"1.0.0"}}}\n',
      "src/pages/index.astro": "<main>Inicio</main>\n",
      "src/pages/contacto.astro": "<main>Contacto</main>\n",
      "src/components/blocks/GeneratedBlockPage.astro": "<main>Blocks</main>\n",
      "src/worker.ts": "export default {};\n",
      "drizzle/0000_fixture.sql": "SELECT 1;\n",
      "wrangler.jsonc": JSON.stringify({
        name: "publisher-fixture",
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
            database_name: "publisher-fixture",
            database_id: "22222222-2222-4222-8222-222222222222",
            migrations_dir: "./drizzle",
          },
        ],
        vars: { SITE_INDEXABLE: "false" },
        env: {
          preview: {
            d1_databases: [
              {
                binding: "DB",
                database_name: "publisher-fixture-preview",
                database_id: "11111111-1111-4111-8111-111111111111",
                migrations_dir: "./drizzle",
              },
            ],
            vars: { SITE_INDEXABLE: "false" },
          },
        },
      }),
    });
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "--quiet", "-m", "fixture baseline"]);
    await git(seed, ["remote", "add", "origin", origin]);
    await git(seed, ["push", "--quiet", "origin", "main"]);

    fixture = await createFixtureApprovalRun({ fixtureSourceRoot: origin });
    const repositoryRoot = fixture.repositoryRoot;
    const stateRoot = fixture.stateRoot;
    const baselineCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const adapter = options.adapter ?? "local";
    const publication = await preparePlanningPublication({
      adapter,
      projectRoot: repositoryRoot,
      stateArtifactRoot: join(stateRoot, "profile"),
      ...(adapter === "cloudflare"
        ? { environment: options.environment ?? "preview" }
        : {}),
    });
    const plan = fixturePlan(baselineCommit, publication);
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
      publication,
    );
    const validations: ValidationResult[] = await runValidation(
      { output, plan, attemptId, evidenceRoot, publicationProfile },
      { commands: async (command) => passedCommand(command) },
    );
    store = await openFixtureCandidateStore(repositoryRoot);
    await fixtureWrangler(repositoryRoot, options.wranglerExitCode ?? 0);
    const previewInvocations: PreviewAssertionDescriptor[] = [];
    const previewPids: number[] = [];
    const preview = createCandidatePreviewTestCapability(async (descriptor) => {
      previewInvocations.push(descriptor);
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const http=require('node:http');const server=http.createServer((_,res)=>res.end('<main>exact candidate bundle</main>\\n'));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const port = await waitForPort(child);
      if (child.pid !== undefined) previewPids.push(child.pid);
      return { child, url: `http://127.0.0.1:${port}` };
    });
    const candidate = await createCandidate({
      output,
      plan,
      attemptId,
      preliminaryValidations: validations,
      store,
      buildCapability: createCandidateBuildTestCapability(
        candidateBuildFixture(plan),
      ),
      previewCapability: preview,
    });
    await persistPublisherState(repositoryRoot, plan, candidate);
    if (options.approvalAuthority === "controller") {
      await withInteractiveControllerAnswer(
        plan.planSha256.slice(0, 12),
        async () =>
          await approveGate1({
            plan,
            actor: "fixture-human",
            stateRoot,
            repositoryRoot,
          }),
      );
      await withInteractiveControllerAnswer(
        candidateApprovalSubject(candidate).slice(0, 12),
        async () =>
          await approveGate2({
            plan,
            candidate,
            actor: "fixture-human",
            stateRoot,
            repositoryRoot,
          }),
      );
    } else {
      const gate1Prompt = await fixture.createPrompt({
        isTTY: true,
        answer: plan.planSha256.slice(0, 12),
      });
      await approveGate1(
        { plan, actor: "fixture-human", stateRoot, repositoryRoot },
        gate1Prompt,
      );
      const gate2Prompt = await fixture.createPrompt({
        isTTY: true,
        answer: candidateApprovalSubject(candidate).slice(0, 12),
      });
      await approveGate2(
        { plan, candidate, actor: "fixture-human", stateRoot, repositoryRoot },
        gate2Prompt,
      );
    }
    const state = createStateStore({ stateRoot });
    await state.transition(changeId, {
      type: "gate2-approved",
      to: "gate2_approved",
      payload: {},
    });
    await run({
      repositoryRoot,
      candidate,
      plan,
      operator: fixtureOperator(plan),
      previewInvocations,
      previewPids,
      async reloadCandidate() {
        if (store === undefined) {
          throw new TypeError("El store fixture ya fue liberado");
        }
        return await loadCandidate({ store, changeId, attemptId });
      },
    });
  } finally {
    if (store !== undefined) {
      await releaseControllerCandidateStore(store).catch(() => undefined);
    }
    if (output !== undefined) {
      await removeStagedAgentOutput(output).catch(() => undefined);
    }
    if (workspace !== undefined) {
      await removeAgentWorkspace(workspace).catch(() => undefined);
    }
    await fixture?.dispose().catch(() => undefined);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(authorityRoot, { recursive: true, force: true }),
      ...(evidenceRoot === undefined
        ? []
        : [rm(evidenceRoot.path, { recursive: true, force: true })]),
    ]);
  }
}

test("exposes the gated local and Cloudflare publishers", () => {
  assert.equal(typeof LocalPublisher, "function");
  assert.equal(typeof CloudflarePublisher, "function");
});

test("test-only publisher capabilities cannot be minted or used outside test mode", async () => {
  const prior = process.env.INGEST_TEST_MODE;
  const capability = createCloudflarePublisherTestCapability(
    async () => undefined,
  );
  try {
    delete process.env.INGEST_TEST_MODE;
    assert.throws(
      () => createLocalPublisherTestCapability(),
      /modo de pruebas/i,
    );
    assert.throws(
      () => createCloudflarePublisherTestCapability(async () => undefined),
      /modo de pruebas/i,
    );
    await assert.rejects(
      new CloudflarePublisher().inspectDryRun(
        {
          candidate: {
            buildProfile: {
              adapter: "cloudflare",
              configSha256: "a".repeat(64),
              environment: "preview",
              siteIndexable: false,
            },
          } as CandidateManifest,
          operator: {
            adapter: "cloudflare",
            configSha256: "a".repeat(64),
            environment: "preview",
            siteIndexable: false,
            flattenedConfigSha256: "b".repeat(64),
            destination: {
              workerName: "fixture-worker",
              d1: {
                binding: "DB",
                databaseId: "11111111-1111-4111-8111-111111111111",
                databaseName: "fixture-database",
              },
            },
          },
        },
        capability,
      ),
      /modo de pruebas/i,
    );
  } finally {
    if (prior === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = prior;
  }
});

test("refuses an unsealed candidate before it can start a local preview", async () => {
  const candidate = {
    schemaVersion: 1,
    changeId: "publisher-candidate",
    attemptId: "attempt-000001",
    requestSha256: "a".repeat(64),
    planSha256: "b".repeat(64),
    baselineCommit: "c".repeat(64),
    candidateCommit: "d".repeat(64),
    artifactSha256: "e".repeat(64),
    buildProfile: {
      adapter: "local",
      configSha256: "f".repeat(64),
      environment: null,
      siteIndexable: false,
    },
    routes: ["/publisher"],
    files: ["src/pages/publisher.astro"],
    validations: [{ id: "build", status: "passed", evidence: "build" }],
    artifacts: [],
    preview: { command: "wrangler dev", url: "http://127.0.0.1:8788" },
    knownDifferences: [],
  } as CandidateManifest;

  await assert.rejects(
    new LocalPublisher().publish({
      candidate,
      operator: {
        adapter: "local",
        configSha256: candidate.buildProfile.configSha256,
        environment: null,
        siteIndexable: false,
        flattenedConfigSha256: "a".repeat(64),
        destination: {
          workerName: "fixture-worker",
          d1: {
            binding: "DB",
            databaseId: "11111111-1111-4111-8111-111111111111",
            databaseName: "fixture-database",
          },
        },
      },
    }),
    /candidato|controlador|store/i,
  );
});

test("publishes the exact verified local bundle and stops its preview group", async () => {
  await withPublisherFixture({}, async (fixture) => {
    const result = await new LocalPublisher().publish({
      candidate: fixture.candidate,
      operator: fixture.operator,
      testCapability: createLocalPublisherTestCapability(),
    });

    assert.deepEqual(result, {
      status: "published",
      publisher: "local",
      changeId,
      candidateCommit: fixture.candidate.candidateCommit,
      artifactSha256: fixture.candidate.artifactSha256,
      dryRun: false,
    });
    assert.equal(fixture.previewInvocations.length, 1);
    assert.deepEqual(fixture.previewInvocations[0], {
      publisher: "local",
      candidateCommit: fixture.candidate.candidateCommit,
      artifactSha256: fixture.candidate.artifactSha256,
      sealedBundle: true,
      fixedLocalArguments: true,
      localOnly: true,
    });
    assert.deepEqual(Object.keys(fixture.previewInvocations[0] ?? {}).sort(), [
      "artifactSha256",
      "candidateCommit",
      "fixedLocalArguments",
      "localOnly",
      "publisher",
      "sealedBundle",
    ]);
    for (const pid of fixture.previewPids) {
      assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i);
    }
  });
});

test("controller approval provenance survives a durable candidate reload", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const reloaded = await fixture.reloadCandidate();
      await assert.doesNotReject(
        assertCandidateLocalPublication(reloaded, undefined, fixture.operator),
      );

      assert.equal(fixture.previewInvocations.length, 0);
    },
  );
});

test("candidate reload rejects durable provenance with a substituted Git tree", async () => {
  await withPublisherFixture({}, async (fixture) => {
    const provenancePath = join(
      fixture.repositoryRoot,
      ".change-state",
      changeId,
      "candidates",
      attemptId,
      "candidate-provenance.json",
    );
    const provenance = JSON.parse(
      await readFile(provenancePath, "utf8"),
    ) as object;
    await writeFile(
      provenancePath,
      canonicalJson({ ...provenance, candidateTree: "f".repeat(64) }),
    );

    await assert.rejects(
      fixture.reloadCandidate(),
      /árbol|tree|procedencia|provenencia/i,
    );
  });
});

test("missing approval provenance fails closed before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    await rm(
      join(
        fixture.repositoryRoot,
        ".change-state",
        changeId,
        "approvals",
        "gate-1.provenance.json",
      ),
    );

    await assert.rejects(
      new LocalPublisher().publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      }),
      /procedencia|aprobaci[oó]n/i,
    );

    assert.equal(fixture.previewInvocations.length, 0);
  });
});

test("refuses a missing Gate 2 before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    await rm(
      join(
        fixture.repositoryRoot,
        ".change-state",
        changeId,
        "approvals",
        "gate-2.json",
      ),
    );
    await git(fixture.repositoryRoot, [
      "update-ref",
      "-d",
      `refs/comunidadsolar/candidates/${changeId}/${attemptId}`,
    ]);
    await assert.rejects(
      new LocalPublisher().publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      }),
      /Gate 2|aprobaci[oó]n/i,
    );
    assert.equal(fixture.previewInvocations.length, 0);
  });
});

test("refuses a changed candidate artifact before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    await writeFile(
      join(
        fixtureCandidateBundlePath(fixture.repositoryRoot),
        "dist",
        "index.html",
      ),
      "changed after approval\n",
    );
    await assert.rejects(
      new LocalPublisher().publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      }),
      /digest|artefacto/i,
    );
    assert.equal(fixture.previewInvocations.length, 0);
  });
});

test("refuses a forged durable candidate before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    const stateCandidate = join(
      fixture.repositoryRoot,
      ".change-state",
      changeId,
      "candidate.json",
    );
    const persisted = JSON.parse(
      await readFile(stateCandidate, "utf8"),
    ) as object;
    await writeFile(
      stateCandidate,
      canonicalJson({ ...persisted, artifactSha256: "f".repeat(64) }),
    );

    await assert.rejects(
      new LocalPublisher().publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      }),
      /schema attempt|validations|solicitud|plan|intento|evidencia|candidato/i,
    );
    assert.equal(fixture.previewInvocations.length, 0);
  });
});

test("refuses a mismatched Gate 2 before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    const gate2Path = join(
      fixture.repositoryRoot,
      ".change-state",
      changeId,
      "approvals",
      "gate-2.json",
    );
    const gate2 = JSON.parse(await readFile(gate2Path, "utf8")) as object;
    await writeFile(
      gate2Path,
      canonicalJson({ ...gate2, artifactSha256: "f".repeat(64) }),
    );

    await assert.rejects(
      new LocalPublisher().publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      }),
      /hash aprobado|candidato actual/i,
    );
    assert.equal(fixture.previewInvocations.length, 0);
  });
});

test("refuses a failed durable validation before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    const attemptPath = join(
      fixture.repositoryRoot,
      ".change-state",
      changeId,
      "attempts",
      `${attemptId}.json`,
    );
    const attempt = JSON.parse(await readFile(attemptPath, "utf8")) as {
      validations: Array<Record<string, unknown>>;
    };
    await writeFile(
      attemptPath,
      canonicalJson({
        ...attempt,
        validations: attempt.validations.map((validation) => ({
          ...validation,
          status: "failed",
        })),
      }),
    );

    await assert.rejects(
      new LocalPublisher().publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      }),
      /schema attempt|validations|solicitud|plan|intento|evidencia|candidato/i,
    );
    assert.equal(fixture.previewInvocations.length, 0);
  });
});

test("refuses missing sealed candidate evidence before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    await rm(
      join(
        fixture.repositoryRoot,
        ".change-state",
        changeId,
        "candidates",
        attemptId,
        "evidence",
        "candidate-build.json",
      ),
    );
    await git(fixture.repositoryRoot, [
      "update-ref",
      "-d",
      `refs/comunidadsolar/candidates/${changeId}/${attemptId}`,
    ]);

    await assert.rejects(
      new LocalPublisher().publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      }),
      /evidencia/i,
    );

    assert.equal(fixture.previewInvocations.length, 0);
  });
});

test("refuses mutated sealed candidate evidence before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    await writeFile(
      join(
        fixture.repositoryRoot,
        ".change-state",
        changeId,
        "candidates",
        attemptId,
        "evidence",
        "candidate-build.json",
      ),
      "mutated candidate evidence\n",
    );

    const outcome = await new LocalPublisher()
      .publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      })
      .then(
        () => "published" as const,
        () => "rejected" as const,
      );

    assert.equal(fixture.previewInvocations.length, 0);
    assert.equal(outcome, "rejected");
  });
});

test("refuses substituted attempt evidence labels before starting the local preview", async () => {
  await withPublisherFixture({}, async (fixture) => {
    const attemptPath = join(
      fixture.repositoryRoot,
      ".change-state",
      changeId,
      "attempts",
      `${attemptId}.json`,
    );
    const attempt = JSON.parse(await readFile(attemptPath, "utf8")) as {
      validations: Array<Record<string, unknown>>;
    };
    await writeFile(
      attemptPath,
      canonicalJson({
        ...attempt,
        validations: attempt.validations.map((validation) => ({
          ...validation,
          evidence: "evidence/substituted.json",
        })),
      }),
    );

    const outcome = await new LocalPublisher()
      .publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
        testCapability: createLocalPublisherTestCapability(),
      })
      .then(
        () => "published" as const,
        () => "rejected" as const,
      );

    assert.equal(fixture.previewInvocations.length, 0);
    assert.equal(outcome, "rejected");
  });
});

test("test approvals can never start a Cloudflare dry run", async () => {
  await withPublisherFixture({ adapter: "cloudflare" }, async (fixture) => {
    let observerCalls = 0;
    await assert.rejects(
      new CloudflarePublisher(
        createCloudflarePublisherTestCapability(async () => {
          observerCalls += 1;
        }),
      ).publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
      }),
      /aprobaciones.*prueba|test approval/i,
    );
    assert.equal(observerCalls, 0);
  });
});

test("forging test Gate issuer and environment JSON cannot mint Cloudflare authority", async () => {
  await withPublisherFixture({ adapter: "cloudflare" }, async (fixture) => {
    await forgeFixtureApprovalIssuerAndEnvironment(fixture.repositoryRoot);
    let observerCalls = 0;
    const outcome = await new CloudflarePublisher(
      createCloudflarePublisherTestCapability(async () => {
        observerCalls += 1;
      }),
    )
      .publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
      })
      .then(
        () => "published" as const,
        () => "rejected" as const,
      );

    assert.equal(observerCalls, 0);
    assert.equal(outcome, "rejected");
  });
});

test("forging test Gate issuer and environment JSON cannot mint protected-main authority", async () => {
  await withPublisherFixture({}, async (fixture) => {
    await forgeFixtureApprovalIssuerAndEnvironment(fixture.repositoryRoot);

    const outcome = await promoteCandidate({
      candidate: fixture.candidate,
    }).then(
      () => "published" as const,
      () => "rejected" as const,
    );

    assert.equal(
      await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
      fixture.candidate.baselineCommit,
    );
    assert.equal(outcome, "rejected");
  });
});

test("Cloudflare dry-run inspection reports the fixed verified invocation semantics", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      let descriptor: CloudflareDryRunDescriptor | undefined;
      const description = await new CloudflarePublisher().inspectDryRun(
        {
          candidate: fixture.candidate,
          operator: fixture.operator,
        },
        createCloudflarePublisherTestCapability(async (current) => {
          descriptor = current;
        }),
      );

      assert.deepEqual(description, {
        publisher: "cloudflare",
        dryRun: true,
        changeId,
        artifactSha256: fixture.candidate.artifactSha256,
        sealedRedirect: true,
        fixedDeployArguments: true,
        targetEnvironmentBound: true,
      });
      assert.deepEqual(descriptor, description);
    },
  );
});

test("Cloudflare observer receives only a sanitized dry-run descriptor", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      let descriptor: Record<string, unknown> | undefined;
      await new CloudflarePublisher().inspectDryRun(
        {
          candidate: fixture.candidate,
          operator: fixture.operator,
        },
        createCloudflarePublisherTestCapability(async (current) => {
          descriptor = current as unknown as Record<string, unknown>;
        }),
      );

      assert.ok(descriptor !== undefined);
      for (const unsafe of [
        "argv",
        "bundle",
        "cwd",
        "env",
        "executable",
        "root",
      ]) {
        assert.equal(Object.hasOwn(descriptor, unsafe), false);
      }
    },
  );
});

test("Cloudflare rejects a different operator profile before its dry-run observer", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      let observerCalls = 0;
      const publisher = new CloudflarePublisher(
        createCloudflarePublisherTestCapability(async () => {
          observerCalls += 1;
        }),
      );
      await assert.rejects(
        publisher.publish({
          candidate: fixture.candidate,
          operator: {
            ...fixture.operator,
            configSha256: "f".repeat(64),
          },
        }),
        /operador.*perfil/i,
      );
      await assert.rejects(
        publisher.publish({
          candidate: fixture.candidate,
          operator: {
            ...fixture.operator,
            environment: "other-environment",
          },
        }),
        /operador.*perfil/i,
      );
      await assert.rejects(
        publisher.publish({
          candidate: fixture.candidate,
          operator: {
            ...fixture.operator,
            flattenedConfigSha256: "e".repeat(64),
          },
        }),
        /operador.*perfil/i,
      );
      assert.equal(observerCalls, 0);
    },
  );
});

test("Cloudflare rejects same binding names with a different Worker or D1 destination", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      let observerCalls = 0;
      const publisher = new CloudflarePublisher(
        createCloudflarePublisherTestCapability(async () => {
          observerCalls += 1;
        }),
      );
      const destinations: readonly OperatorProfile["destination"][] = [
        {
          workerName: "different-worker",
          d1: {
            binding: "DB",
            databaseId: "11111111-1111-4111-8111-111111111111",
            databaseName: "publisher-fixture-preview",
          },
        },
        {
          workerName: "publisher-fixture",
          d1: {
            binding: "DB",
            databaseId: "33333333-3333-4333-8333-333333333333",
            databaseName: "publisher-fixture-preview",
          },
        },
      ];
      for (const destination of destinations) {
        await assert.rejects(
          publisher.publish({
            candidate: fixture.candidate,
            operator: {
              ...fixture.operator,
              destination,
            },
          }),
          /operador.*perfil|destino/i,
        );
      }
      assert.equal(observerCalls, 0);
    },
  );
});

test("LocalPublisher rejects a Cloudflare profile before its preview", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      await assert.rejects(
        new LocalPublisher().publish({
          candidate: fixture.candidate,
          operator: fixture.operator,
        }),
        /operador local.*perfil/i,
      );
      assert.equal(fixture.previewInvocations.length, 0);
    },
  );
});

test("Cloudflare rejects a changed deploy redirect before its dry-run observer", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      await writeFile(
        join(
          fixtureCandidateBundlePath(fixture.repositoryRoot),
          ".wrangler",
          "deploy",
          "config.json",
        ),
        JSON.stringify({ configPath: "../../outside.json" }),
      );
      let observerCalls = 0;
      const publisher = new CloudflarePublisher(
        createCloudflarePublisherTestCapability(async () => {
          observerCalls += 1;
        }),
      );

      await assert.rejects(
        publisher.publish({
          candidate: fixture.candidate,
          operator: fixture.operator,
        }),
        /digest|artefacto/i,
      );
      assert.equal(observerCalls, 0);
    },
  );
});

test("Cloudflare refuses execute input without a future trusted CLI capability", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      await assert.rejects(
        new CloudflarePublisher().publish({
          candidate: fixture.candidate,
          operator: fixture.operator,
        }),
        /capability Cloudflare confiable/i,
      );
      await assert.rejects(
        new CloudflarePublisher().publish({
          candidate: fixture.candidate,
          operator: fixture.operator,
          execute: true,
        } as unknown as Parameters<CloudflarePublisher["publish"]>[0]),
        /execute/i,
      );
    },
  );
});

test("Cloudflare runs only a fixed local dry-run through an opaque test capability", async () => {
  await withPublisherFixture(
    { adapter: "cloudflare", approvalAuthority: "controller" },
    async (fixture) => {
      let descriptor: CloudflareDryRunDescriptor | undefined;
      const publisher = new CloudflarePublisher(
        createCloudflarePublisherTestCapability(async (current) => {
          descriptor = current;
        }),
      );
      const result = await publisher.publish({
        candidate: fixture.candidate,
        operator: fixture.operator,
      });

      assert.deepEqual(result, {
        status: "published",
        publisher: "cloudflare",
        changeId,
        candidateCommit: fixture.candidate.candidateCommit,
        artifactSha256: fixture.candidate.artifactSha256,
        dryRun: true,
      });
      assert.deepEqual(descriptor, {
        publisher: "cloudflare",
        dryRun: true,
        changeId,
        artifactSha256: fixture.candidate.artifactSha256,
        sealedRedirect: true,
        fixedDeployArguments: true,
        targetEnvironmentBound: true,
      });
    },
  );
});

test("a failed fixed Cloudflare dry-run records a recoverable event", async () => {
  await withPublisherFixture(
    {
      adapter: "cloudflare",
      approvalAuthority: "controller",
      wranglerExitCode: 1,
    },
    async (fixture) => {
      await assert.rejects(
        new CloudflarePublisher(
          createCloudflarePublisherTestCapability(async () => undefined),
        ).publish({
          candidate: fixture.candidate,
          operator: fixture.operator,
        }),
        /dry-run/i,
      );
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /cloudflare/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("test approvals can never fast-forward protected main", async () => {
  await withPublisherFixture({}, async (fixture) => {
    await assert.rejects(
      promoteCandidate({ candidate: fixture.candidate }),
      /aprobaciones.*prueba|test approval/i,
    );
    assert.equal(
      await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
      fixture.candidate.baselineCommit,
    );
  });
});

test("a lease barrier token cannot reach its stage without controller approvals", async () => {
  await withPublisherFixture({}, async (fixture) => {
    const testCapability = createCandidatePromotionTestCapability(
      "protected-main-reattach-before-lease",
    );
    await assert.rejects(
      promoteCandidate({ candidate: fixture.candidate, testCapability }),
      /aprobaciones.*prueba|test approval/i,
    );
    assert.equal(
      await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
      fixture.candidate.baselineCommit,
    );
    await assert.rejects(
      readFile(fixturePromotionLeaseRaceMarker(fixture.repositoryRoot), "utf8"),
      /ENOENT/u,
    );
    await assert.rejects(
      readFile(
        fixturePromotionLeaseRaceAcknowledgement(fixture.repositoryRoot),
        "utf8",
      ),
      /ENOENT/u,
    );
  });
});

test("a promotion failure token cannot be minted or used outside test mode", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const testCapability =
        createCandidatePromotionTestCapability("dossier-write");
      const previous = process.env.INGEST_TEST_MODE;
      process.env.INGEST_TEST_MODE = "false";
      try {
        assert.throws(
          () => createCandidatePromotionTestCapability("dossier-write"),
          /modo de pruebas/i,
        );
        await assert.rejects(
          promoteCandidate({ candidate: fixture.candidate, testCapability }),
          /modo de pruebas/i,
        );
        assert.equal(
          await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
          fixture.candidate.baselineCommit,
        );
        const event = await readFile(
          join(
            fixture.repositoryRoot,
            ".change-state",
            changeId,
            "candidates",
            attemptId,
            "publication-events.ndjson",
          ),
          "utf8",
        );
        assert.match(event, /promotion/u);
        assert.match(event, /recoverable-failure/u);
      } finally {
        if (previous === undefined) {
          delete process.env.INGEST_TEST_MODE;
        } else {
          process.env.INGEST_TEST_MODE = previous;
        }
      }
    },
  );
});

test("promotion fast-forwards candidate A then commits only a sanitized dossier B", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const result = await promoteCandidate({ candidate: fixture.candidate });
      assert.equal(result.candidateCommit, fixture.candidate.candidateCommit);
      assert.equal(
        await git(fixture.repositoryRoot, [
          "rev-parse",
          `${result.dossierCommit}^`,
        ]),
        fixture.candidate.candidateCommit,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        result.dossierCommit,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["status", "--porcelain=v1"]),
        "",
      );
      assert.deepEqual(
        (await git(fixture.repositoryRoot, ["log", "--format=%H", "-3"])).split(
          "\n",
        ),
        [
          result.dossierCommit,
          fixture.candidate.candidateCommit,
          fixture.candidate.baselineCommit,
        ],
      );
      assert.deepEqual(
        (
          await git(fixture.repositoryRoot, [
            "diff",
            "--name-only",
            `${fixture.candidate.candidateCommit}..${result.dossierCommit}`,
          ])
        )
          .split("\n")
          .filter(Boolean),
        [
          `changes/${changeId}/approvals/gate-1.json`,
          `changes/${changeId}/approvals/gate-2.json`,
          `changes/${changeId}/attempts/${attemptId}.json`,
          `changes/${changeId}/candidate-manifest.json`,
          `changes/${changeId}/candidate.json`,
          `changes/${changeId}/plan.json`,
          `changes/${changeId}/request.json`,
        ],
      );
      const dossier = await readFile(
        join(fixture.repositoryRoot, "changes", changeId, "candidate.json"),
        "utf8",
      );
      const dossierRequest = await readFile(
        join(fixture.repositoryRoot, "changes", changeId, "request.json"),
        "utf8",
      );
      assert.equal(dossier.includes(fixture.repositoryRoot), false);
      assert.equal(dossier.includes(".artifacts/"), false);
      assert.equal(dossier.includes('"url"'), false);
      assert.equal(dossierRequest.includes('"seo"'), false);
      assert.equal(dossierRequest.includes("Publisher"), false);
    },
  );
});

test("dossier destination preflight leaves main at baseline when changes is a regular file", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      await appendFile(
        join(fixture.repositoryRoot, ".git", "info", "exclude"),
        "changes\n",
      );
      await writeFile(join(fixture.repositoryRoot, "changes"), "blocked\n");

      const outcome = await promoteCandidate({
        candidate: fixture.candidate,
      }).then(
        () => "published" as const,
        () => "rejected" as const,
      );

      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      assert.equal(outcome, "rejected");
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("transactional dossier preparation leaves main at baseline when changes is ignored", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      await appendFile(
        join(fixture.repositoryRoot, ".git", "info", "exclude"),
        "changes/\n",
      );

      const outcome = await promoteCandidate({
        candidate: fixture.candidate,
      }).then(
        () => "published" as const,
        () => "rejected" as const,
      );

      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      assert.equal(outcome, "rejected");
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("transactional dossier preparation leaves main at baseline when private dossier writing fails", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const testCapability =
        createCandidatePromotionTestCapability("dossier-write");
      const outcome = await promoteCandidate({
        candidate: fixture.candidate,
        testCapability,
      }).then(
        () => "published" as const,
        () => "rejected" as const,
      );

      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      assert.equal(outcome, "rejected");
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("transactional dossier preparation leaves main at baseline when dossier commit fails", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      await git(fixture.repositoryRoot, ["config", "commit.gpgSign", "true"]);
      await git(fixture.repositoryRoot, [
        "config",
        "gpg.program",
        "/usr/bin/false",
      ]);

      const outcome = await promoteCandidate({
        candidate: fixture.candidate,
      }).then(
        () => "published" as const,
        () => "rejected" as const,
      );

      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      assert.equal(outcome, "rejected");
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("a failed final protected-main fast-forward leaves main at its baseline", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const mainLock = join(
        fixture.repositoryRoot,
        ".git",
        "refs",
        "heads",
        "main.lock",
      );
      await writeFile(mainLock, "fixture lock\n", { flag: "wx" });
      try {
        const outcome = await promoteCandidate({
          candidate: fixture.candidate,
        }).then(
          () => "published" as const,
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /lease|main\.lock|main/i);
            return "rejected" as const;
          },
        );

        assert.equal(
          await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
          fixture.candidate.baselineCommit,
        );
        assert.equal(outcome, "rejected");
        const event = await readFile(
          join(
            fixture.repositoryRoot,
            ".change-state",
            changeId,
            "candidates",
            attemptId,
            "publication-events.ndjson",
          ),
          "utf8",
        );
        assert.match(event, /promotion/u);
        assert.match(event, /recoverable-failure/u);
        assert.equal(event.includes("published"), false);
      } finally {
        await rm(mainLock, { force: true });
      }
    },
  );
});

test("a concurrent advance after the final check loses the protected-main lease without dirtying the controller checkout", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const testCapability = createCandidatePromotionTestCapability(
        "protected-main-concurrent-advance",
      );
      const promotion = promoteCandidate({
        candidate: fixture.candidate,
        testCapability,
      });
      const marker = fixturePromotionLeaseRaceMarker(fixture.repositoryRoot);
      await waitForLeaseRaceReady(marker, promotion);
      await git(fixture.repositoryRoot, [
        "update-ref",
        "refs/heads/main",
        fixture.candidate.candidateCommit,
        fixture.candidate.baselineCommit,
      ]);
      await writeAtomic(
        fixturePromotionLeaseRaceAcknowledgement(fixture.repositoryRoot),
        Buffer.from("advanced\n", "utf8"),
      );
      const outcome = await promotion.then(
        () => "published" as const,
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /lease|baseline|main|ref/i);
          return "rejected" as const;
        },
      );

      assert.equal(outcome, "rejected");
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.candidateCommit,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
        "refs/heads/main",
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["status", "--porcelain=v1"]),
        "",
      );
      assert.equal(
        await git(fixture.repositoryRoot, [
          "diff",
          "--cached",
          "--name-status",
        ]),
        "",
      );
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("a main reattachment immediately before the lease cannot publish B outside the CAS", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const testCapability = createCandidatePromotionTestCapability(
        "protected-main-reattach-before-lease",
      );
      const promotion = promoteCandidate({
        candidate: fixture.candidate,
        testCapability,
      });
      const marker = fixturePromotionLeaseRaceMarker(fixture.repositoryRoot);
      await waitForLeaseRaceReady(marker, promotion);
      assert.equal(
        await git(fixture.repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
        "refs/heads/main",
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      await git(fixture.repositoryRoot, ["checkout", "--quiet", "main"]);
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "refs/heads/main"]),
        fixture.candidate.baselineCommit,
      );
      await writeAtomic(
        fixturePromotionLeaseRaceAcknowledgement(fixture.repositoryRoot),
        Buffer.from("advanced\n", "utf8"),
      );

      const result = await promotion;
      assert.equal(result.reconciliation, "complete");
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        result.dossierCommit,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
        "refs/heads/main",
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["status", "--porcelain=v1"]),
        "",
      );
      assert.deepEqual(
        (await git(fixture.repositoryRoot, ["log", "--format=%H", "-3"])).split(
          "\n",
        ),
        [
          result.dossierCommit,
          fixture.candidate.candidateCommit,
          fixture.candidate.baselineCommit,
        ],
      );
    },
  );
});

test("the concurrent-advance test barrier rejects an acknowledgement without a lease change", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const testCapability = createCandidatePromotionTestCapability(
        "protected-main-concurrent-advance",
      );
      const promotion = promoteCandidate({
        candidate: fixture.candidate,
        testCapability,
      });
      const marker = fixturePromotionLeaseRaceMarker(fixture.repositoryRoot);
      await waitForLeaseRaceReady(marker, promotion);
      await writeAtomic(
        fixturePromotionLeaseRaceAcknowledgement(fixture.repositoryRoot),
        Buffer.from("advanced\n", "utf8"),
      );

      const outcome = await promotion.then(
        () => "published" as const,
        () => "rejected" as const,
      );

      assert.equal(outcome, "rejected");
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
        "refs/heads/main",
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["status", "--porcelain=v1"]),
        "",
      );
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("a staged concurrent deletion survives a lost protected-main lease", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const testCapability = createCandidatePromotionTestCapability(
        "protected-main-concurrent-advance",
      );
      const promotion = promoteCandidate({
        candidate: fixture.candidate,
        testCapability,
      });
      const marker = fixturePromotionLeaseRaceMarker(fixture.repositoryRoot);
      await waitForLeaseRaceReady(marker, promotion);
      await git(fixture.repositoryRoot, [
        "update-ref",
        "refs/heads/main",
        fixture.candidate.candidateCommit,
        fixture.candidate.baselineCommit,
      ]);
      await git(fixture.repositoryRoot, [
        "read-tree",
        "-m",
        "-u",
        fixture.candidate.baselineCommit,
        fixture.candidate.candidateCommit,
      ]);
      await rm(join(fixture.repositoryRoot, "README.md"));
      await git(fixture.repositoryRoot, ["add", "README.md"]);
      await writeAtomic(
        fixturePromotionLeaseRaceAcknowledgement(fixture.repositoryRoot),
        Buffer.from("advanced\n", "utf8"),
      );

      const outcome = await promotion.then(
        () => "published" as const,
        () => "rejected" as const,
      );

      assert.equal(outcome, "rejected");
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.candidateCommit,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
        "refs/heads/main",
      );
      assert.match(
        await git(fixture.repositoryRoot, ["status", "--porcelain=v1"]),
        /D\s+README\.md/u,
      );
      assert.match(
        await git(fixture.repositoryRoot, [
          "diff",
          "--cached",
          "--name-status",
        ]),
        /D\s+README\.md/u,
      );
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("a staged concurrent deletion after the CAS stays published but reconciliation-pending", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      const testCapability = createCandidatePromotionTestCapability(
        "protected-main-reconcile-dirty",
      );
      const promotion = promoteCandidate({
        candidate: fixture.candidate,
        testCapability,
      });
      const marker = fixturePromotionLeaseRaceMarker(fixture.repositoryRoot);
      await waitForLeaseRaceReady(marker, promotion);
      await git(fixture.repositoryRoot, [
        "read-tree",
        "-m",
        "-u",
        fixture.candidate.baselineCommit,
        fixture.candidate.candidateCommit,
      ]);
      await rm(join(fixture.repositoryRoot, "README.md"));
      await git(fixture.repositoryRoot, ["add", "README.md"]);
      await writeAtomic(
        fixturePromotionLeaseRaceAcknowledgement(fixture.repositoryRoot),
        Buffer.from("advanced\n", "utf8"),
      );

      const result = await promotion;
      assert.equal(result.reconciliation, "pending");
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "refs/heads/main"]),
        result.dossierCommit,
      );
      assert.match(
        await git(fixture.repositoryRoot, ["status", "--porcelain=v1"]),
        /D\s+README\.md/u,
      );
      assert.match(
        await git(fixture.repositoryRoot, [
          "diff",
          "--cached",
          "--name-status",
        ]),
        /D\s+README\.md/u,
      );
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /published-reconciliation-pending/u);
      assert.equal(event.includes("recoverable-failure"), false);
      assert.equal(event.includes(fixture.repositoryRoot), false);
      assert.equal(event.includes("retry"), false);
      const pendingEvent = JSON.parse(event) as Record<string, unknown>;
      assert.deepEqual(Object.keys(pendingEvent).sort(), [
        "at",
        "schemaVersion",
        "stage",
        "status",
      ]);
      assert.equal(pendingEvent.schemaVersion, 1);
      assert.equal(pendingEvent.stage, "promotion");
      assert.equal(pendingEvent.status, "published-reconciliation-pending");
    },
  );
});

test("promotion rejects staged deletion and type changes before main can move", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      await rm(join(fixture.repositoryRoot, "src", "pages", "index.astro"));
      await rm(join(fixture.repositoryRoot, "README.md"));
      await symlink(
        "src/pages/contacto.astro",
        join(fixture.repositoryRoot, "README.md"),
      );
      await git(fixture.repositoryRoot, ["add", "-A"]);
      const status = await git(fixture.repositoryRoot, [
        "status",
        "--porcelain=v1",
      ]);
      assert.match(status, /D\s+src\/pages\/index\.astro/u);
      assert.match(status, /T\s+README\.md/u);

      const outcome = await promoteCandidate({
        candidate: fixture.candidate,
      }).then(
        () => "published" as const,
        () => "rejected" as const,
      );

      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      assert.equal(outcome, "rejected");
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("promotion rejects an advanced main without rebasing the candidate", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      await git(fixture.repositoryRoot, [
        "config",
        "user.email",
        "fixture@example.test",
      ]);
      await git(fixture.repositoryRoot, [
        "config",
        "user.name",
        "Fixture Human",
      ]);
      await writeFile(
        join(fixture.repositoryRoot, "advanced.txt"),
        "advanced\n",
      );
      await git(fixture.repositoryRoot, ["add", "advanced.txt"]);
      await git(fixture.repositoryRoot, [
        "commit",
        "--quiet",
        "-m",
        "advance main",
      ]);
      const advanced = await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]);

      await assert.rejects(
        promoteCandidate({ candidate: fixture.candidate }),
        /baseline|limpio|main/i,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        advanced,
      );
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});

test("promotion records a failed candidate Git verification", async () => {
  await withPublisherFixture(
    { approvalAuthority: "controller" },
    async (fixture) => {
      await git(fixture.repositoryRoot, [
        "update-ref",
        "-d",
        `refs/comunidadsolar/candidates/${changeId}/${attemptId}`,
      ]);

      await assert.rejects(
        promoteCandidate({ candidate: fixture.candidate }),
        /ref|commit|durable/i,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.candidate.baselineCommit,
      );
      const event = await readFile(
        join(
          fixture.repositoryRoot,
          ".change-state",
          changeId,
          "candidates",
          attemptId,
          "publication-events.ndjson",
        ),
        "utf8",
      );
      assert.match(event, /promotion/u);
      assert.match(event, /recoverable-failure/u);
      assert.equal(event.includes("published"), false);
    },
  );
});
