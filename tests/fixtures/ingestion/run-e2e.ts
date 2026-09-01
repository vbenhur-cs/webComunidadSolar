import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import { createFixtureApprovalRun } from "../../../src/ingest/approvals/prompt.ts";
import { createCandidateBuildTestCapability } from "../../../src/ingest/candidate/evidence.ts";
import {
  createCandidatePreviewTestCapability,
  loadCandidate,
  openControllerCandidateStore,
  releaseControllerCandidateStore,
} from "../../../src/ingest/candidate/manifest.ts";
import {
  canonicalJson,
  sha256Canonical,
} from "../../../src/ingest/canonical-json.ts";
import {
  openIngestionControllerForTest,
  type IngestionController,
} from "../../../src/ingest/controller.ts";
import { createSanitizedCandidateDossier } from "../../../src/ingest/dossier.ts";
import type {
  ApprovalRecord,
  AttemptRecord,
  CandidateManifest,
  ChangePlan,
  NormalizedRequest,
} from "../../../src/ingest/domain.ts";
import { ingestPaths } from "../../../src/ingest/paths.ts";
import { createLocalPublisherTestCapability } from "../../../src/ingest/publishers/local.ts";
import type { OperatorProfile } from "../../../src/ingest/publishers/types.ts";
import { validateSchema } from "../../../src/ingest/schema-validator.ts";
import { createStateStore } from "../../../src/ingest/state-store.ts";
import type {
  CommandInvocation,
  CommandResult,
} from "../../../src/ingest/validation/runner.ts";

const execFileAsync = promisify(execFile);
const fixedNow = () => new Date("2026-09-01T00:00:00.000Z");

const matrix = Object.freeze([
  Object.freeze({
    fixture: "detailed-request" as const,
    mode: "blocks" as const,
    changeId: "fixture-request-blocks",
  }),
  Object.freeze({
    fixture: "detailed-request" as const,
    mode: "hybrid" as const,
    changeId: "fixture-request-hybrid",
  }),
  Object.freeze({
    fixture: "supplied-page" as const,
    mode: "freeform" as const,
    changeId: "fixture-page-freeform",
  }),
]);

export interface FixtureInvocation {
  readonly fixture: "detailed-request" | "supplied-page";
  readonly mode: "blocks" | "hybrid" | "freeform";
  readonly changeId: string;
  readonly record: boolean;
}

export interface FixtureE2eResult {
  readonly changeId: string;
  readonly mode: FixtureInvocation["mode"];
  readonly candidate: {
    readonly artifactSha256: string;
    readonly candidateCommit: string;
  };
  readonly local: "success";
  readonly cloudflareDryRun: "not-applicable-local-profile";
  readonly published: false;
}

function parsed(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      fixture: { type: "string" },
      mode: { type: "string" },
      "change-id": { type: "string" },
      record: { type: "boolean" },
    },
  });
}

function hasRepeatedFixtureOption(argv: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const argument of argv) {
    const match = /^--(fixture|mode|change-id|record)(?:=|$)/u.exec(argument);
    if (match?.[1] === undefined) continue;
    const count = (counts.get(match[1]) ?? 0) + 1;
    if (count > 1) return true;
    counts.set(match[1], count);
  }
  return false;
}

/** Parse the closed fixture matrix before cloning, Git, or process work. */
export function parseFixtureInvocation(
  argv: readonly string[],
): FixtureInvocation {
  if (hasRepeatedFixtureOption(argv)) {
    throw new TypeError(
      "Las opciones fixture deben aparecer exactamente una vez",
    );
  }
  let values: ReturnType<typeof parsed>["values"];
  try {
    values = parsed(argv).values;
  } catch {
    throw new TypeError(
      "Las opciones fixture deben ser exactamente las documentadas",
    );
  }
  const fixture = values.fixture;
  const mode = values.mode;
  const changeId = values["change-id"];
  if (
    typeof fixture !== "string" ||
    typeof mode !== "string" ||
    typeof changeId !== "string" ||
    (values.record !== undefined && typeof values.record !== "boolean")
  ) {
    throw new TypeError("La matriz fixture exige fixture, mode y change-id");
  }
  const matched = matrix.find(
    (entry) =>
      entry.fixture === fixture &&
      entry.mode === mode &&
      entry.changeId === changeId,
  );
  if (matched === undefined) {
    throw new TypeError(
      "La combinación fixture no pertenece a la matriz cerrada",
    );
  }
  return Object.freeze({
    fixture: matched.fixture,
    mode: matched.mode,
    changeId: matched.changeId,
    record: values.record === true,
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateDestination(plan: ChangePlan) {
  return {
    databaseId: "00000000-0000-4000-8000-000000000000",
    databaseName: "fixture-candidate",
    workerName: "fixture-candidate",
    environment: plan.publication.environment,
  };
}

function flattenedConfig(
  plan: ChangePlan,
  main: string,
  assetsDirectory: string,
): string {
  const destination = candidateDestination(plan);
  return JSON.stringify({
    targetEnvironment: destination.environment,
    name: destination.workerName,
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

function buildFixture(plan: ChangePlan) {
  const config = flattenedConfig(plan, "_worker.js/index.js", ".");
  const nested = flattenedConfig(plan, "../_worker.js/index.js", "..");
  return {
    files: {
      "dist/_worker.js/index.js":
        "export default { fetch() { return new Response('fixture'); } };\n",
      "dist/index.html": "<main>fixture candidate</main>\n",
      "dist/wrangler.json": config,
      "dist/.prerender/wrangler.json": nested,
      "dist/auxiliary/wrangler.json": nested,
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

function operatorProfile(plan: ChangePlan): OperatorProfile {
  const config = flattenedConfig(plan, "_worker.js/index.js", ".");
  const nested = flattenedConfig(plan, "../_worker.js/index.js", "..");
  const destination = candidateDestination(plan);
  return Object.freeze({
    ...plan.publication,
    flattenedConfigSha256: hash(
      canonicalJson([
        { path: "dist/.prerender/wrangler.json", sha256: hash(nested) },
        { path: "dist/auxiliary/wrangler.json", sha256: hash(nested) },
        { path: "dist/wrangler.json", sha256: hash(config) },
      ]),
    ),
    destination: {
      workerName: destination.workerName,
      d1: {
        binding: "DB" as const,
        databaseId: destination.databaseId,
        databaseName: destination.databaseName,
      },
    },
  });
}

function passingCommand(command: CommandInvocation): CommandResult {
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

async function installFixtureWrangler(repositoryRoot: string): Promise<void> {
  const executable = join(repositoryRoot, "node_modules", ".bin", "wrangler");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
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
      if (code !== 0)
        rejectPort(new Error("El preview fixture terminó antes de escuchar"));
    });
  });
}

function previewCapability() {
  return createCandidatePreviewTestCapability(async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          "const http = require('node:http');",
          "const server = http.createServer((_request, response) => { response.statusCode = 200; response.end('fixture'); });",
          "server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\\n`));",
        ].join("\n"),
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const port = await waitForPort(child);
    return { child, url: `http://127.0.0.1:${port}` };
  });
}

async function fixtureInput(
  invocation: FixtureInvocation,
  temporary: string,
): Promise<{
  readonly kind: "request" | "page";
  readonly source: string;
  readonly metadata?: string;
}> {
  const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));
  if (invocation.fixture === "detailed-request") {
    const source = await readFile(
      join(fixtureRoot, "detailed-request", "request.yaml"),
      "utf8",
    );
    const request = source
      .replace(/^changeId: .*$/mu, `changeId: ${invocation.changeId}`)
      .replace(/^mode: .*$/mu, `mode: ${invocation.mode}`);
    const path = join(temporary, "request.yaml");
    await writeFile(path, request, "utf8");
    return { kind: "request", source: path };
  }
  const source = join(fixtureRoot, "supplied-page");
  const page = join(temporary, "supplied-page");
  await cp(source, page, { recursive: true, dereference: false });
  const metadataSource = await readFile(
    join(fixtureRoot, "page-meta.yaml"),
    "utf8",
  );
  const metadata = join(temporary, "page-meta.yaml");
  await writeFile(
    metadata,
    `${metadataSource.replace(/^changeId: .*$/mu, `changeId: ${invocation.changeId}`)}mode: ${invocation.mode}\n`,
    "utf8",
  );
  return { kind: "page", source: page, metadata };
}

async function readPlan(
  repositoryRoot: string,
  changeId: string,
): Promise<ChangePlan> {
  const source = await readFile(
    join(repositoryRoot, ".change-state", changeId, "plan.json"),
    "utf8",
  );
  return JSON.parse(source) as ChangePlan;
}

async function cleanMain(
  root: string,
): Promise<{ readonly main: string; readonly head: string }> {
  const [main, head, status] = await Promise.all([
    execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--verify", "refs/heads/main^{commit}"],
      { encoding: "utf8" },
    ),
    execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8" },
    ),
    execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" },
    ),
  ]);
  if (status.stdout !== "" || main.stdout.trim() !== head.stdout.trim()) {
    throw new TypeError("El clon fixture debe iniciar limpio en main");
  }
  return Object.freeze({ main: main.stdout.trim(), head: head.stdout.trim() });
}

async function withController<T>(
  runtime: Parameters<typeof openIngestionControllerForTest>[0],
  operation: (controller: IngestionController) => Promise<T>,
): Promise<T> {
  const controller = await openIngestionControllerForTest(runtime);
  try {
    return await operation(controller);
  } finally {
    await controller.dispose();
  }
}

/**
 * Runs one non-recorded fixture pipeline in an owned no-hardlink clone. Its
 * only publication attempt is the contained LocalPublisher; it never changes
 * protected main and never contacts an external Cloudflare endpoint.
 */
export async function runFixtureE2e(
  invocation: FixtureInvocation,
): Promise<FixtureE2eResult> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("El runner fixture exige INGEST_TEST_MODE=true");
  }
  const sourceRoot = process.cwd();
  const sourceBefore = await cleanMain(sourceRoot);
  const inputs = await mkdtemp(
    join(tmpdir(), "comunidadsolar-ingestion-input-"),
  );
  const approvalRun = await createFixtureApprovalRun({
    fixtureSourceRoot: sourceRoot,
  });
  const clone = approvalRun.repositoryRoot;
  const previousCwd = process.cwd();
  const previousCommandConfig = process.env.INGEST_COMMAND_AGENT_CONFIG;
  let store:
    Awaited<ReturnType<typeof openControllerCandidateStore>> | undefined;
  try {
    await cleanMain(clone);
    const input = await fixtureInput(invocation, inputs);
    process.chdir(clone);
    process.env.INGEST_COMMAND_AGENT_CONFIG = JSON.stringify({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./e2e-command-agent.mjs", import.meta.url)),
      ],
    });

    await withController({}, async (controller) => {
      await controller.receiveRequest(input);
      await controller.plan(invocation.changeId);
    });
    const plan = await readPlan(clone, invocation.changeId);
    const gate1Prompt = await approvalRun.createPrompt({
      isTTY: true,
      answer: plan.planSha256.slice(0, 12),
    });
    const preview = previewCapability();
    const candidate = await withController(
      {
        approvalPrompt: gate1Prompt,
        candidateBuildCapability: createCandidateBuildTestCapability(
          buildFixture(plan),
        ),
        candidatePreviewCapability: preview,
        localPublicationCapability: createLocalPublisherTestCapability(),
        validationOptions: {
          commands: async (command) => passingCommand(command),
        },
        now: fixedNow,
      },
      async (controller) => {
        await controller.approve({
          changeId: invocation.changeId,
          gate: 1,
          actor: "test-human",
        });
        const generated = await controller.generate({
          changeId: invocation.changeId,
          adapter: "command",
        });
        if (generated.kind !== "success")
          throw new TypeError("Gate 1 fixture no permitió generar");
        const validated = await controller.validate(invocation.changeId);
        if (validated.kind !== "success")
          throw new TypeError("El candidato fixture no se validó");
        store = await openControllerCandidateStore();
        const candidate = await loadCandidate({
          store,
          changeId: invocation.changeId,
          attemptId: "attempt-000001",
        });
        const gate2Prompt = await approvalRun.createPrompt({
          isTTY: true,
          answer: sha256Canonical(candidate).slice(0, 12),
        });
        const approved = await controller.approve({
          changeId: invocation.changeId,
          gate: 2,
          actor: "test-human",
          approvalPrompt: gate2Prompt,
        });
        if (approved.kind !== "success")
          throw new TypeError("Gate 2 fixture no se aprobó");
        await installFixtureWrangler(clone);
        const local = await controller.publishLocal({
          changeId: invocation.changeId,
          operator: operatorProfile(plan),
        });
        if (local.kind !== "success") {
          throw new TypeError("El preview local fixture no respondió");
        }
        const finalState = await createStateStore({
          projectRoot: clone,
        }).readChange(invocation.changeId);
        if (finalState.state !== "gate2_approved") {
          throw new TypeError(
            "El fixture no puede marcar published el estado durable",
          );
        }
        return candidate;
      },
    );
    if (invocation.record) {
      await recordFixtureEvidence(
        sourceRoot,
        clone,
        invocation,
        candidate,
        sourceBefore,
      );
    }
    return Object.freeze({
      changeId: invocation.changeId,
      mode: invocation.mode,
      candidate: {
        artifactSha256: candidate.artifactSha256,
        candidateCommit: candidate.candidateCommit,
      },
      local: "success" as const,
      cloudflareDryRun: "not-applicable-local-profile" as const,
      published: false as const,
    });
  } finally {
    if (store !== undefined)
      await releaseControllerCandidateStore(store).catch(() => undefined);
    if (previousCommandConfig === undefined)
      delete process.env.INGEST_COMMAND_AGENT_CONFIG;
    else process.env.INGEST_COMMAND_AGENT_CONFIG = previousCommandConfig;
    process.chdir(previousCwd);
    await approvalRun.dispose();
    await rm(inputs, { recursive: true, force: true });
  }
}

async function recordFixtureEvidence(
  sourceRoot: string,
  clone: string,
  invocation: FixtureInvocation,
  candidate: CandidateManifest,
  sourceBefore: { readonly main: string; readonly head: string },
): Promise<void> {
  const before = await cleanMain(sourceRoot);
  if (before.main !== sourceBefore.main || before.head !== sourceBefore.head) {
    throw new TypeError(
      "La fuente principal cambió antes de registrar evidencia",
    );
  }
  const paths = await ingestPaths(candidate.changeId, { projectRoot: clone });
  const files = await Promise.all([
    readFile(paths.request, "utf8"),
    readFile(paths.plan, "utf8"),
    readFile(join(paths.approvalsDir, "gate-1.json"), "utf8"),
    readFile(join(paths.approvalsDir, "gate-2.json"), "utf8"),
    readFile(join(paths.attemptsDir, `${candidate.attemptId}.json`), "utf8"),
    readFile(paths.candidate, "utf8"),
  ]);
  const persistedCandidate = validateSchema<CandidateManifest>(
    "candidate",
    JSON.parse(files[5]),
  );
  if (canonicalJson(persistedCandidate) !== canonicalJson(candidate)) {
    throw new TypeError(
      "El candidato durable no coincide con el candidato que se va a registrar",
    );
  }
  const dossier = createSanitizedCandidateDossier({
    request: validateSchema<NormalizedRequest>(
      "normalized-request",
      JSON.parse(files[0]),
    ),
    plan: validateSchema<ChangePlan>("change-plan", JSON.parse(files[1])),
    gate1: validateSchema<ApprovalRecord>("approval", JSON.parse(files[2])),
    gate2: validateSchema<ApprovalRecord>("approval", JSON.parse(files[3])),
    attempt: validateSchema<AttemptRecord>("attempt", JSON.parse(files[4])),
    candidate: persistedCandidate,
  });
  const ready = await cleanMain(sourceRoot);
  if (ready.main !== sourceBefore.main || ready.head !== sourceBefore.head) {
    throw new TypeError(
      "La fuente principal cambió antes de etiquetar la evidencia",
    );
  }
  const ref = `refs/comunidadsolar/candidates/${candidate.changeId}/${candidate.attemptId}`;
  const tag = `refs/tags/ingestion-fixture/${invocation.changeId}`;
  await execFileAsync(
    "git",
    ["-C", sourceRoot, "fetch", "--no-tags", clone, `${ref}:${tag}`],
    { encoding: "utf8" },
  );
  const destination = join(
    sourceRoot,
    ".artifacts",
    "ingestion-fixtures",
    invocation.changeId,
  );
  await mkdir(destination, { recursive: true });
  await Promise.all(
    dossier.files.map(async (file) => {
      const target = join(destination, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, "utf8");
    }),
  );
  const after = await cleanMain(sourceRoot);
  if (after.main !== sourceBefore.main || after.head !== sourceBefore.head) {
    throw new TypeError("El registro fixture no puede modificar main");
  }
}

async function main(): Promise<void> {
  const invocation = parseFixtureInvocation(process.argv.slice(2));
  const result = await runFixtureE2e(invocation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
