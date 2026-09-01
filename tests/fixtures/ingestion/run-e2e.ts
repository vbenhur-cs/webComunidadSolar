import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import {
  createFixtureApprovalRun,
  type FixtureApprovalPrompt,
} from "../../../src/ingest/approvals/prompt.ts";
import {
  approveGate1,
  approveGate2,
} from "../../../src/ingest/approvals/service.ts";
import { createCandidateBuildTestCapability } from "../../../src/ingest/candidate/evidence.ts";
import {
  createCandidatePreviewTestCapability,
  loadCandidate,
  openControllerCandidateStore,
  releaseControllerCandidateStore,
  verifyCandidateArtifact,
  verifyCandidateEvidence,
} from "../../../src/ingest/candidate/manifest.ts";
import { canonicalJson } from "../../../src/ingest/canonical-json.ts";
import {
  candidateApprovalSubject,
  candidateDossierCommitment,
  sanitizedDossierSha256,
} from "../../../src/ingest/dossier-integrity.ts";
import {
  openIngestionControllerForTest,
  type IngestionController,
} from "../../../src/ingest/controller.ts";
import { createSanitizedCandidateDossier } from "../../../src/ingest/dossier.ts";
import {
  fixedGitArgs,
  fixedGitExecutable,
  sanitizedGitEnv,
} from "../../../src/ingest/git-env.ts";
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
const recordableChangeIds: ReadonlySet<string> = new Set(
  matrix.map((entry) => entry.changeId),
);
const recordableDossierFiles = Object.freeze([
  "approvals/gate-1.json",
  "approvals/gate-2.json",
  "attempts/attempt-000001.json",
  "candidate-manifest.json",
  "candidate.json",
  "plan.json",
  "request.json",
]);

interface MainSnapshot {
  readonly main: string;
  readonly head: string;
}

interface RecordableMainSnapshot extends MainSnapshot {
  /** Exact untracked dossier files accepted between the three planned records. */
  readonly untracked: readonly string[];
}

function isRecordableMainSnapshot(
  snapshot: MainSnapshot | RecordableMainSnapshot,
): snapshot is RecordableMainSnapshot {
  return (
    "untracked" in snapshot &&
    Array.isArray(snapshot.untracked) &&
    snapshot.untracked.every((path) => typeof path === "string")
  );
}

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

/**
 * Rechecks the same closed matrix used by the CLI parser. This is intentionally
 * separate from argument parsing because callers can invoke runFixtureE2e()
 * directly; validation must happen before touching the environment, Git, a
 * clone, or the optional recording path.
 */
function assertFixtureInvocation(
  invocation: FixtureInvocation,
): FixtureInvocation {
  if (
    invocation === null ||
    typeof invocation !== "object" ||
    Array.isArray(invocation) ||
    Object.getPrototypeOf(invocation) !== Object.prototype
  ) {
    throw new TypeError(
      "La invocación fixture no pertenece a la matriz cerrada",
    );
  }
  const keys = Object.keys(invocation).sort();
  const expectedKeys = ["changeId", "fixture", "mode", "record"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof invocation.record !== "boolean"
  ) {
    throw new TypeError("La invocación fixture debe tener una forma exacta");
  }
  const matched = matrix.find(
    (entry) =>
      entry.fixture === invocation.fixture &&
      entry.mode === invocation.mode &&
      entry.changeId === invocation.changeId,
  );
  if (matched === undefined) {
    throw new TypeError(
      "La combinación fixture no pertenece a la matriz cerrada",
    );
  }
  return Object.freeze({ ...matched, record: invocation.record });
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

/** Fixture-only generation dependencies with no repository/process authority. */
export function createFixtureControllerRuntime(plan: ChangePlan) {
  return Object.freeze({
    candidateBuildCapability: createCandidateBuildTestCapability(
      buildFixture(plan),
    ),
    validationOptions: {
      commands: async (command: CommandInvocation) => passingCommand(command),
    },
    now: fixedNow,
  });
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

/**
 * Fixture approvals are issued only by the fixture service.  The production
 * controller never receives a test prompt or a programmatic approval route.
 */
async function approveFixtureGate1(input: {
  readonly repositoryRoot: string;
  readonly plan: ChangePlan;
  readonly prompt: FixtureApprovalPrompt;
}): Promise<void> {
  const paths = await ingestPaths(input.plan.changeId, {
    projectRoot: input.repositoryRoot,
  });
  const approval = await approveGate1(
    {
      ...paths,
      plan: input.plan,
      actor: "test-human",
      repositoryRoot: input.repositoryRoot,
      now: fixedNow,
    },
    input.prompt,
  );
  await createStateStore({ projectRoot: input.repositoryRoot }).transition(
    input.plan.changeId,
    {
      type: "gate1-approved",
      to: "gate1_approved",
      payload: { gate: approval.gate, subjectSha256: approval.subjectSha256 },
    },
  );
}

async function approveFixtureGate2(input: {
  readonly repositoryRoot: string;
  readonly plan: ChangePlan;
  readonly candidate: CandidateManifest;
  readonly prompt: FixtureApprovalPrompt;
}): Promise<void> {
  const paths = await ingestPaths(input.candidate.changeId, {
    projectRoot: input.repositoryRoot,
  });
  const attempt = validateSchema<AttemptRecord>(
    "attempt",
    JSON.parse(
      await trustedText(
        join(paths.attemptsDir, `${input.candidate.attemptId}.json`),
        "El intento fixture",
      ),
    ),
  );
  await verifyCandidateArtifact(input.candidate);
  await verifyCandidateEvidence(input.candidate, attempt);
  const approval = await approveGate2(
    {
      ...paths,
      plan: input.plan,
      candidate: input.candidate,
      actor: "test-human",
      repositoryRoot: input.repositoryRoot,
      now: fixedNow,
    },
    input.prompt,
  );
  await createStateStore({ projectRoot: input.repositoryRoot }).transition(
    input.candidate.changeId,
    {
      type: "gate2-approved",
      to: "gate2_approved",
      payload: { gate: approval.gate, subjectSha256: approval.subjectSha256 },
    },
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return (
    value === "" ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith("../"))
  );
}

async function runFixtureGit(
  root: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await execFileAsync(
    fixedGitExecutable,
    fixedGitArgs(["-C", root, ...args]),
    {
      encoding: "utf8",
      env: sanitizedGitEnv(),
    },
  );
}

async function runFixtureGitInput(
  root: string,
  args: readonly string[],
  input: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = spawn(fixedGitExecutable, fixedGitArgs(["-C", root, ...args]), {
    env: sanitizedGitEnv(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const completed = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  child.stdin?.end(input, "utf8");
  if ((await completed) !== 0) {
    throw new TypeError("El sello anotado fixture no pudo crearse");
  }
  return Object.freeze({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  });
}

function fixtureTagObject(input: {
  readonly changeId: string;
  readonly candidateCommit: string;
  readonly sealedCandidateSha256: string;
  readonly sanitizedProjectionSha256: string;
  readonly gate2SubjectSha256: string;
  readonly dossierSha256: string;
}): string {
  const seal = {
    schemaVersion: 1,
    changeId: input.changeId,
    candidateCommit: input.candidateCommit,
    sealedCandidateSha256: input.sealedCandidateSha256,
    sanitizedProjectionSha256: input.sanitizedProjectionSha256,
    gate2SubjectSha256: input.gate2SubjectSha256,
    dossierSha256: input.dossierSha256,
  };
  return [
    `object ${input.candidateCommit}`,
    "type commit",
    `tag ingestion-fixture/${input.changeId}`,
    "tagger Comunidad Solar Fixture <fixture@comunidadsolar.invalid> 1788220800 +0000",
    "",
    canonicalJson(seal),
    "",
  ].join("\n");
}

async function trustedDirectory(path: string, label: string): Promise<string> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError(`${label} no es un directorio seguro`);
  }
  const physical = await realpath(path);
  if (physical !== resolve(path)) {
    throw new TypeError(`${label} no resuelve su directorio exacto`);
  }
  return physical;
}

async function trustedChildDirectory(
  parent: string,
  name: string,
  label: string,
): Promise<string> {
  if (!/^(?!\.{1,2}$)[A-Za-z0-9.][A-Za-z0-9._-]*$/u.test(name)) {
    throw new TypeError(`${label} tiene un segmento no permitido`);
  }
  const target = resolve(parent, name);
  if (!isWithin(parent, target)) {
    throw new TypeError(`${label} escapa su directorio padre`);
  }
  try {
    await trustedDirectory(target, label);
  } catch (error: unknown) {
    if (!isMissingPath(error)) throw error;
    await mkdir(target, { mode: 0o700 });
    await trustedDirectory(target, label);
  }
  return target;
}

async function trustedText(path: string, label: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new TypeError(`${label} no es un archivo regular seguro`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new TypeError(`${label} cambió durante la lectura`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function safeDossierPath(path: string): boolean {
  return /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(
    path,
  );
}

async function writeStagedDossierFile(
  root: string,
  file: { readonly path: string; readonly contents: string },
): Promise<void> {
  if (!safeDossierPath(file.path)) {
    throw new TypeError("El dossier fixture tiene una ruta no permitida");
  }
  const segments = file.path.split("/");
  const basename = segments.pop();
  if (basename === undefined) {
    throw new TypeError("El dossier fixture no tiene nombre de archivo");
  }
  let parent = root;
  for (const segment of segments) {
    parent = await trustedChildDirectory(parent, segment, "El dossier fixture");
  }
  const target = resolve(parent, basename);
  if (!isWithin(root, target)) {
    throw new TypeError("El dossier fixture escapa su staging");
  }
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(file.contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function collectStagedDossierFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = resolve(directory, entry.name);
    if (!isWithin(root, target)) {
      throw new TypeError("El staging del dossier escapa su raíz");
    }
    if (entry.isDirectory()) {
      await trustedDirectory(target, "El staging del dossier");
      files.push(...(await collectStagedDossierFiles(root, target)));
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new TypeError(
        "El staging del dossier contiene una ruta no permitida",
      );
    }
    await trustedText(target, "El archivo del dossier fixture");
    files.push(relative(root, target));
  }
  return files.sort();
}

async function verifyStagedDossier(
  root: string,
  dossier: ReturnType<typeof createSanitizedCandidateDossier>,
): Promise<void> {
  const expected = new Map(
    dossier.files.map((file) => [file.path, file.contents]),
  );
  const actual = await collectStagedDossierFiles(root);
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  ) {
    throw new TypeError(
      "El dossier fixture no contiene exactamente sus hechos",
    );
  }
  for (const [path, contents] of expected) {
    const target = resolve(root, ...path.split("/"));
    if (
      !isWithin(root, target) ||
      (await trustedText(target, "El dossier fixture")) !== contents
    ) {
      throw new TypeError("El dossier fixture no coincide con sus hechos");
    }
  }
}

async function resolvedCommit(root: string, ref: string): Promise<string> {
  const result = await runFixtureGit(root, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]).catch(() => {
    throw new TypeError("La referencia fixture no resuelve un commit");
  });
  const commit = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new TypeError(
      "La referencia fixture no resuelve una identidad válida",
    );
  }
  return commit;
}

async function assertTagAbsent(root: string, tag: string): Promise<void> {
  const result = await runFixtureGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    tag,
  ]);
  if (result.stdout.trim() !== "") {
    throw new TypeError("La etiqueta fixture ya existe");
  }
}

async function assertChangesUsable(root: string): Promise<string> {
  const ignored = await runFixtureGit(root, [
    "check-ignore",
    "--quiet",
    "--",
    "changes",
  ]).then(
    () => true,
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      ) {
        return false;
      }
      throw error;
    },
  );
  if (ignored) {
    throw new TypeError("El directorio changes ignora evidencia fixture");
  }
  return await trustedChildDirectory(
    root,
    "changes",
    "La raíz de dossiers fixture",
  );
}

async function removeTrustedDirectory(
  parent: string,
  target: string,
): Promise<void> {
  if (!isWithin(parent, target)) {
    throw new TypeError("La limpieza fixture escapa su raíz");
  }
  try {
    await trustedDirectory(target, "La limpieza fixture");
  } catch (error: unknown) {
    if (isMissingPath(error)) return;
    throw error;
  }
  await rm(target, { recursive: true, force: false });
}

async function assertMainUnchanged(
  root: string,
  before: { readonly main: string; readonly head: string },
): Promise<void> {
  const [main, head] = await Promise.all([
    runFixtureGit(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]),
    runFixtureGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
  ]);
  if (
    main.stdout.trim() !== before.main ||
    head.stdout.trim() !== before.head
  ) {
    throw new TypeError("El registro fixture no puede modificar main");
  }
}

async function cleanMain(root: string): Promise<MainSnapshot> {
  const [main, head, status] = await Promise.all([
    runFixtureGit(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]),
    runFixtureGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    runFixtureGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (status.stdout !== "" || main.stdout.trim() !== head.stdout.trim()) {
    throw new TypeError("El clon fixture debe iniciar limpio en main");
  }
  return Object.freeze({ main: main.stdout.trim(), head: head.stdout.trim() });
}

function recordableDossierPath(path: string): boolean {
  const segments = path.split("/");
  if (
    segments.length < 3 ||
    segments[0] !== "changes" ||
    segments[1] === undefined ||
    !recordableChangeIds.has(segments[1])
  ) {
    return false;
  }
  return safeDossierPath(segments.slice(2).join("/"));
}

async function assertRecordDirectoriesTrusted(root: string): Promise<void> {
  const changes = join(root, "changes");
  try {
    await trustedDirectory(changes, "La raíz de dossiers fixture");
  } catch (error: unknown) {
    if (isMissingPath(error)) return;
    throw error;
  }
  const entries = await readdir(changes, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".ingestion-fixture-staging" ||
      !recordableChangeIds.has(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      throw new TypeError(
        "El registro fixture sólo admite dossiers cerrados sin enlaces",
      );
    }
    const dossier = join(changes, entry.name);
    await trustedDirectory(dossier, "El dossier fixture previo");
    const files = await collectStagedDossierFiles(dossier);
    if (
      files.length !== recordableDossierFiles.length ||
      files.some((path, index) => path !== recordableDossierFiles[index])
    ) {
      throw new TypeError(
        "El registro fixture sólo admite dossiers cerrados completos",
      );
    }
  }
}

/**
 * Record mode permits only untracked files from already completed members of
 * the fixed matrix. It remains strict for index changes, tracked edits,
 * staging leftovers, arbitrary change IDs, and symlinks.
 */
async function recordableMain(root: string): Promise<RecordableMainSnapshot> {
  const [main, head, status] = await Promise.all([
    runFixtureGit(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]),
    runFixtureGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    runFixtureGit(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
    ]),
  ]);
  if (main.stdout.trim() !== head.stdout.trim()) {
    throw new TypeError("El registro fixture exige main protegido en HEAD");
  }
  const untracked = status.stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      if (!entry.startsWith("?? ")) {
        throw new TypeError("El registro fixture no admite cambios preparados");
      }
      const path = entry.slice(3);
      if (!recordableDossierPath(path)) {
        throw new TypeError(
          "El registro fixture no admite suciedad fuera de sus dossiers",
        );
      }
      return path;
    })
    .sort();
  if (new Set(untracked).size !== untracked.length) {
    throw new TypeError(
      "El registro fixture contiene rutas de dossier repetidas",
    );
  }
  await assertRecordDirectoriesTrusted(root);
  return Object.freeze({
    main: main.stdout.trim(),
    head: head.stdout.trim(),
    untracked: Object.freeze(untracked),
  });
}

/** Test-only inspection of the same preflight used by the non-executed recorder. */
export async function inspectFixtureRecordWorkspace(
  root: string,
): Promise<{ readonly untracked: readonly string[] }> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("La inspección fixture exige INGEST_TEST_MODE=true");
  }
  const physicalRoot = await realpath(root);
  const snapshot = await recordableMain(
    await trustedDirectory(physicalRoot, "La raíz fixture de inspección"),
  );
  return Object.freeze({ untracked: snapshot.untracked });
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
  const checkedInvocation = assertFixtureInvocation(invocation);
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("El runner fixture exige INGEST_TEST_MODE=true");
  }
  const sourceRoot = process.cwd();
  const sourceBefore = checkedInvocation.record
    ? await recordableMain(sourceRoot)
    : await cleanMain(sourceRoot);
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
    const input = await fixtureInput(checkedInvocation, inputs);
    process.chdir(clone);
    process.env.INGEST_COMMAND_AGENT_CONFIG = JSON.stringify({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./e2e-command-agent.mjs", import.meta.url)),
      ],
    });

    await withController({}, async (controller) => {
      await controller.receiveRequest(input);
      await controller.plan(checkedInvocation.changeId);
    });
    const plan = await readPlan(clone, checkedInvocation.changeId);
    const gate1Prompt = await approvalRun.createPrompt({
      isTTY: true,
      answer: plan.planSha256.slice(0, 12),
    });
    await approveFixtureGate1({
      repositoryRoot: clone,
      plan,
      prompt: gate1Prompt,
    });
    const preview = previewCapability();
    const candidate = await withController(
      {
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
        const generated = await controller.generate({
          changeId: checkedInvocation.changeId,
          adapter: "command",
        });
        if (generated.kind !== "success")
          throw new TypeError("Gate 1 fixture no permitió generar");
        const validated = await controller.validate(checkedInvocation.changeId);
        if (validated.kind !== "success")
          throw new TypeError("El candidato fixture no se validó");
        store = await openControllerCandidateStore();
        const candidate = await loadCandidate({
          store,
          changeId: checkedInvocation.changeId,
          attemptId: "attempt-000001",
        });
        const gate2Prompt = await approvalRun.createPrompt({
          isTTY: true,
          answer: candidateApprovalSubject(candidate).slice(0, 12),
        });
        await approveFixtureGate2({
          repositoryRoot: clone,
          plan,
          candidate,
          prompt: gate2Prompt,
        });
        await installFixtureWrangler(clone);
        const local = await controller.publishLocal({
          changeId: checkedInvocation.changeId,
          operator: operatorProfile(plan),
        });
        if (local.kind !== "success") {
          throw new TypeError("El preview local fixture no respondió");
        }
        const finalState = await createStateStore({
          projectRoot: clone,
        }).readChange(checkedInvocation.changeId);
        if (finalState.state !== "gate2_approved") {
          throw new TypeError(
            "El fixture no puede marcar published el estado durable",
          );
        }
        return candidate;
      },
    );
    if (checkedInvocation.record) {
      if (!isRecordableMainSnapshot(sourceBefore)) {
        throw new TypeError(
          "El registro fixture perdió su precondición durable",
        );
      }
      await recordFixtureEvidence(
        sourceRoot,
        clone,
        checkedInvocation,
        candidate,
        sourceBefore,
      );
    }
    return Object.freeze({
      changeId: checkedInvocation.changeId,
      mode: checkedInvocation.mode,
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
  sourceBefore: RecordableMainSnapshot,
): Promise<void> {
  const before = await recordableMain(sourceRoot);
  if (
    before.main !== sourceBefore.main ||
    before.head !== sourceBefore.head ||
    canonicalJson(before.untracked) !== canonicalJson(sourceBefore.untracked)
  ) {
    throw new TypeError(
      "La fuente principal cambió antes de registrar evidencia",
    );
  }
  const paths = await ingestPaths(candidate.changeId, { projectRoot: clone });
  const files = await Promise.all([
    trustedText(paths.request, "La solicitud fixture"),
    trustedText(paths.plan, "El plan fixture"),
    trustedText(join(paths.approvalsDir, "gate-1.json"), "Gate 1 fixture"),
    trustedText(join(paths.approvalsDir, "gate-2.json"), "Gate 2 fixture"),
    trustedText(
      join(paths.attemptsDir, `${candidate.attemptId}.json`),
      "El intento fixture",
    ),
    trustedText(paths.candidate, "El candidato fixture"),
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
  if (
    candidate.changeId !== invocation.changeId ||
    persistedCandidate.changeId !== invocation.changeId ||
    candidate.attemptId !== persistedCandidate.attemptId ||
    candidate.candidateCommit !== persistedCandidate.candidateCommit
  ) {
    throw new TypeError("El candidato fixture no coincide con su invocación");
  }
  const request = validateSchema<NormalizedRequest>(
    "normalized-request",
    JSON.parse(files[0]),
  );
  const plan = validateSchema<ChangePlan>("change-plan", JSON.parse(files[1]));
  const gate1 = validateSchema<ApprovalRecord>(
    "approval",
    JSON.parse(files[2]),
  );
  const gate2 = validateSchema<ApprovalRecord>(
    "approval",
    JSON.parse(files[3]),
  );
  const attempt = validateSchema<AttemptRecord>(
    "attempt",
    JSON.parse(files[4]),
  );
  const candidateCommitment = candidateDossierCommitment(persistedCandidate);
  if (
    gate2.gate !== 2 ||
    gate2.changeId !== persistedCandidate.changeId ||
    gate2.candidateCommit !== persistedCandidate.candidateCommit ||
    gate2.artifactSha256 !== persistedCandidate.artifactSha256 ||
    gate2.subjectSha256 !== candidateCommitment.approvalSubjectSha256
  ) {
    throw new TypeError("Gate 2 no sella el candidato fixture completo");
  }
  const dossier = createSanitizedCandidateDossier({
    request,
    plan,
    gate1,
    gate2,
    attempt,
    candidate: persistedCandidate,
  });
  const ref = `refs/comunidadsolar/candidates/${candidate.changeId}/${candidate.attemptId}`;
  const tag = `refs/tags/ingestion-fixture/${invocation.changeId}`;
  const transferRef = `refs/comunidadsolar/fixture-record/${candidate.changeId}/${candidate.attemptId}`;
  const candidateCommit = await resolvedCommit(clone, ref);
  if (candidateCommit !== candidate.candidateCommit) {
    throw new TypeError("La referencia fixture no coincide con el candidato");
  }
  const tagSeal = Object.freeze({
    changeId: invocation.changeId,
    candidateCommit,
    sealedCandidateSha256: candidateCommitment.sealedCandidateSha256,
    sanitizedProjectionSha256: candidateCommitment.sanitizedProjectionSha256,
    gate2SubjectSha256: gate2.subjectSha256,
    dossierSha256: sanitizedDossierSha256(dossier.files),
  });
  await assertTagAbsent(sourceRoot, tag);
  const destinationParent = await assertChangesUsable(sourceRoot);
  const destination = resolve(destinationParent, invocation.changeId);
  if (!isWithin(destinationParent, destination)) {
    throw new TypeError("El destino del dossier fixture no es seguro");
  }
  try {
    await lstat(destination);
    throw new TypeError("El dossier fixture ya existe");
  } catch (error: unknown) {
    if (!isMissingPath(error)) throw error;
  }
  const stagingParent = await trustedChildDirectory(
    destinationParent,
    ".ingestion-fixture-staging",
    "El staging de dossier fixture",
  );
  const staging = await trustedChildDirectory(
    stagingParent,
    `dossier-${randomUUID()}`,
    "El staging de dossier fixture",
  );
  let stagingPresent = true;
  let stagingParentPresent = true;
  let dossierPublished = false;
  let tagCreated = false;
  let tagObject: string | undefined;
  let transferFetched = false;
  try {
    await runFixtureGit(sourceRoot, [
      "fetch",
      "--no-tags",
      clone,
      `${ref}:${transferRef}`,
    ]);
    transferFetched = true;
    if ((await resolvedCommit(sourceRoot, transferRef)) !== candidateCommit) {
      throw new TypeError(
        "La transferencia fixture no conserva el commit candidato",
      );
    }
    for (const file of dossier.files) {
      await writeStagedDossierFile(staging, file);
    }
    await verifyStagedDossier(staging, dossier);
    await rename(staging, destination);
    stagingPresent = false;
    dossierPublished = true;
    await verifyStagedDossier(destination, dossier);
    await removeTrustedDirectory(destinationParent, stagingParent);
    stagingParentPresent = false;
    await assertMainUnchanged(sourceRoot, sourceBefore);
    const createdTag = await runFixtureGitInput(
      sourceRoot,
      ["mktag"],
      fixtureTagObject(tagSeal),
    );
    tagObject = createdTag.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(tagObject)) {
      throw new TypeError("El sello anotado fixture no tiene identidad válida");
    }
    await runFixtureGit(sourceRoot, [
      "update-ref",
      tag,
      tagObject,
      "0".repeat(tagObject.length),
    ]);
    tagCreated = true;
    if ((await resolvedCommit(sourceRoot, tag)) !== candidateCommit) {
      throw new TypeError("La etiqueta fixture no coincide con el candidato");
    }
    await assertMainUnchanged(sourceRoot, sourceBefore);
    const after = await recordableMain(sourceRoot);
    const expectedUntracked = [
      ...sourceBefore.untracked,
      ...dossier.files.map(
        (file) => `changes/${invocation.changeId}/${file.path}`,
      ),
    ].sort();
    if (
      after.main !== sourceBefore.main ||
      after.head !== sourceBefore.head ||
      canonicalJson(after.untracked) !== canonicalJson(expectedUntracked)
    ) {
      throw new TypeError(
        "El registro fixture no dejó exactamente su dossier durable",
      );
    }
  } catch (error: unknown) {
    const cleanup: unknown[] = [];
    if (tagCreated && tagObject !== undefined) {
      await runFixtureGit(sourceRoot, [
        "update-ref",
        "-d",
        tag,
        tagObject,
      ]).catch((cleanupError: unknown) => cleanup.push(cleanupError));
    }
    if (dossierPublished) {
      await removeTrustedDirectory(destinationParent, destination).catch(
        (cleanupError: unknown) => cleanup.push(cleanupError),
      );
    }
    if (stagingPresent) {
      await removeTrustedDirectory(stagingParent, staging).catch(
        (cleanupError: unknown) => cleanup.push(cleanupError),
      );
    }
    if (stagingParentPresent) {
      await removeTrustedDirectory(destinationParent, stagingParent).catch(
        (cleanupError: unknown) => cleanup.push(cleanupError),
      );
    }
    if (cleanup.length > 0) {
      throw new AggregateError(
        [error, ...cleanup],
        "El registro fixture no pudo limpiar su fallo",
      );
    }
    throw error;
  } finally {
    if (transferFetched) {
      await runFixtureGit(sourceRoot, [
        "update-ref",
        "-d",
        transferRef,
        candidateCommit,
      ]).catch(() => undefined);
    }
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
