import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import {
  createSanitizedCandidateDossier,
  type SanitizedDossierFile,
} from "../dossier.ts";
import type {
  ApprovalRecord,
  AttemptRecord,
  CandidateManifest,
  ChangePlan,
  NormalizedRequest,
  ValidationResult,
} from "../domain.ts";
import {
  verifyApproval,
  verifyPersistedApprovalProvenance,
} from "../approvals/service.ts";
import { assertNormalizedRequest } from "../importers/common.ts";
import { ingestPaths } from "../paths.ts";
import { validateSchema } from "../schema-validator.ts";
import { createStateStore, writeAtomic } from "../state-store.ts";
import {
  assertCandidateEligiblePreliminaryValidation,
  PRELIMINARY_STAGED_VALIDATION_SCOPE,
} from "../validation/runner.ts";
import type { StagedAgentOutput } from "../workspaces/policy.ts";

import {
  captureCandidateBuildArtifacts,
  createCandidateCommit,
  persistCandidateCommit,
  removeCandidateCommit,
  runCandidateBoundBuild,
  type CandidateCommit,
} from "./commit.ts";
import {
  canonicalCandidateBuildEvidence,
  type CandidateBuildTestCapability,
  type CandidateBoundBuildEvidence,
  type PersistedCandidateBuildEvidence,
} from "./evidence.ts";
import { hashTree } from "./tree-digest.ts";

const changeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/u;
const attemptIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,63})$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const artifactMaximumBytes = 128 * 1024 * 1024;
const fixedDeployRedirectPath = ".wrangler/deploy/config.json";
const fixedWorkerRelativePath = "dist/_worker.js/index.js";
const candidateCommitPattern = /^[a-f0-9]{40,64}$/u;
const gitExecutable = "/usr/bin/git";
const fixedGitArguments = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
]);
const fixedGitEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
const promotionGitEnvironment = Object.freeze({
  ...fixedGitEnvironment,
  GIT_AUTHOR_NAME: "Comunidad Solar Publication",
  GIT_AUTHOR_EMAIL: "publication@comunidadsolar.invalid",
  GIT_COMMITTER_NAME: "Comunidad Solar Publication",
  GIT_COMMITTER_EMAIL: "publication@comunidadsolar.invalid",
});

declare const controllerCandidateStoreBrand: unique symbol;
export interface ControllerCandidateStore {
  readonly [controllerCandidateStoreBrand]: true;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface ArtifactStoreRecord {
  readonly root: DirectoryIdentity;
  readonly artifactRoot: DirectoryIdentity;
  readonly stateRoot: DirectoryIdentity;
}

export interface CandidateArtifactEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface CandidateBundleConfiguration {
  readonly redirectRelativePath: string;
  readonly primaryConfigRelativePath: string;
  readonly workerRelativePath: string;
  readonly assetsRelativePath: string;
  readonly configRelativePaths: readonly string[];
  /** Hash of the exact verified flattened-config bytes and paths. */
  readonly flattenedConfigSha256: string;
  readonly destination: CandidatePublishDestination;
}

/** Semantic destination only; no config, bundle, checkout or root path leaks. */
export interface CandidatePublishDestination {
  readonly workerName: string;
  readonly d1: {
    readonly binding: "DB";
    readonly databaseId: string;
    readonly databaseName: string;
  };
}

/** Narrow external profile compared with the sealed flattened config. */
export interface CandidateOperatorProfile {
  readonly adapter: ChangePlan["publication"]["adapter"];
  readonly configSha256: string;
  readonly environment: string | null;
  readonly siteIndexable: boolean;
  readonly flattenedConfigSha256: string;
  readonly destination: CandidatePublishDestination;
}

/** Private preview state; it never crosses the candidate module boundary. */
interface CandidatePreviewRecord {
  readonly store: ControllerCandidateStore;
  readonly attemptId: string;
  readonly candidateTree: string;
  readonly bundlePath: string;
  readonly manifestPath: string;
  readonly configuration: CandidateBundleConfiguration;
  readonly previewCapability: CandidatePreviewTestCapability | undefined;
}

/** Private process invocation; it never crosses the candidate module boundary. */
interface FixedPreviewInvocation {
  /** The fixed controller-local Wrangler executable; never caller supplied. */
  readonly executable: string;
  /** Includes the executable as argv[0] so fixture assertions see exact argv. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Semantic preview assertion only; it deliberately contains no process details. */
export interface PreviewAssertionDescriptor {
  readonly publisher: "local";
  readonly candidateCommit: string;
  readonly artifactSha256: string;
  readonly sealedBundle: true;
  readonly fixedLocalArguments: true;
  readonly localOnly: true;
}

/** Internal shape delivered only through the opaque test-only observer. */
interface FixedCloudflareInvocation {
  /** The sealed controller-local Wrangler executable; never caller supplied. */
  readonly executable: string;
  /** Includes argv[0]; deploy arguments are fixed by this module. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Safe observer payload; it intentionally has no executable, argv, cwd or env. */
export interface CloudflareDryRunAssertionDescriptor {
  readonly publisher: "cloudflare";
  readonly dryRun: true;
  readonly changeId: string;
  readonly artifactSha256: string;
  readonly sealedRedirect: true;
  readonly fixedDeployArguments: true;
  readonly targetEnvironmentBound: true;
}

export interface PreviewHandle {
  readonly url: string;
  stop(): Promise<void>;
}

/** Predefined failure/race stages for contained transaction fixture coverage. */
export type CandidatePromotionFailureStage =
  | "dossier-write"
  | "dossier-add"
  | "dossier-commit"
  | "protected-main-fast-forward"
  /** Test-only lease barriers; they cannot mutate Git. */
  | "protected-main-concurrent-advance"
  | "protected-main-reattach-before-lease"
  | "protected-main-reconcile-dirty";

interface PreviewLaunch {
  readonly child: ChildProcess;
  readonly url: string;
}

type CandidatePreviewAdapter = (
  descriptor: PreviewAssertionDescriptor,
) => Promise<PreviewLaunch>;

/** A fixture-only capability; callers can never provide process arguments. */
declare const candidatePreviewTestCapabilityBrand: unique symbol;
export interface CandidatePreviewTestCapability {
  readonly [candidatePreviewTestCapabilityBrand]: true;
}

declare const candidateCloudflareDryRunTestCapabilityBrand: unique symbol;
/** A fixture-only observer for a fixed dry-run; it never receives process control. */
export interface CandidateCloudflareDryRunTestCapability {
  readonly [candidateCloudflareDryRunTestCapabilityBrand]: true;
}

declare const candidateLocalPublicationTestCapabilityBrand: unique symbol;
/** A fixture-only capability which can authorize a contained local preview. */
export interface CandidateLocalPublicationTestCapability {
  readonly [candidateLocalPublicationTestCapabilityBrand]: true;
}

declare const candidatePromotionTestCapabilityBrand: unique symbol;
/** A fixture-only failure token; it can never authorize or alter promotion. */
export interface CandidatePromotionTestCapability {
  readonly [candidatePromotionTestCapabilityBrand]: true;
}

export interface CandidateCreationInput {
  readonly output: StagedAgentOutput;
  readonly plan: ChangePlan;
  readonly attemptId: string;
  /** Exact frozen array minted by Task 9; copied or supplied evidence rejects. */
  readonly preliminaryValidations: readonly ValidationResult[];
  /** Opaque durable controller state; callers never select a bundle path. */
  readonly store: ControllerCandidateStore;
  /** Opaque fixture/controller capability; a missing production adapter fails closed. */
  readonly buildCapability?: CandidateBuildTestCapability;
  /** Optional opaque fixture preview capability retained privately with the candidate. */
  readonly previewCapability?: CandidatePreviewTestCapability;
}

/**
 * Reopens persistent candidate state from an opaque controller-owned store
 * plus safe identity. It accepts neither a staged output, plan, repository
 * path, nor artifact path.
 */
export interface CandidateLoadInput {
  readonly store: ControllerCandidateStore;
  readonly changeId: string;
  readonly attemptId: string;
}

interface DurableCandidateProvenance {
  readonly schemaVersion: 1;
  readonly changeId: string;
  readonly attemptId: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly artifactSha256: string;
  readonly candidateRef: string;
  readonly bundle: string;
  readonly manifest: string;
}

const controllerCandidateStores = new WeakMap<
  ControllerCandidateStore,
  ArtifactStoreRecord
>();
const candidateRecords = new WeakMap<
  CandidateManifest,
  CandidatePreviewRecord
>();
const candidatePreviewPids = new WeakMap<CandidateManifest, number>();
const candidatePreviewCapabilities = new WeakMap<
  CandidatePreviewTestCapability,
  CandidatePreviewAdapter
>();
const candidateCloudflareDryRunTestCapabilities = new WeakMap<
  CandidateCloudflareDryRunTestCapability,
  (descriptor: CloudflareDryRunAssertionDescriptor) => Promise<void>
>();
const candidateLocalPublicationTestCapabilities =
  new WeakSet<CandidateLocalPublicationTestCapability>();
const candidatePromotionTestCapabilities = new WeakMap<
  CandidatePromotionTestCapability,
  CandidatePromotionFailureStage
>();

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return (
    remainder === "" ||
    (!isAbsolute(remainder) &&
      remainder !== ".." &&
      !remainder.startsWith(`..${sep}`))
  );
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  return candidate !== root && isWithin(root, candidate);
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function safeRedirectPath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "")
  );
}

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function directoryIdentity(
  path: string,
  entry: {
    readonly dev: number;
    readonly ino: number;
  },
): DirectoryIdentity {
  return Object.freeze({ path, device: entry.dev, inode: entry.ino });
}

async function assertDirectory(identity: DirectoryIdentity): Promise<void> {
  const entry = await lstat(identity.path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.dev !== identity.device ||
    entry.ino !== identity.inode ||
    (await realpath(identity.path)) !== identity.path
  ) {
    throw new TypeError("La identidad del estado candidato cambió");
  }
}

function controllerCandidateStoreRecord(
  store: ControllerCandidateStore,
): ArtifactStoreRecord {
  const record = controllerCandidateStores.get(store);
  if (record === undefined) {
    throw new TypeError("El store candidato no pertenece al controlador");
  }
  return record;
}

async function assertControllerCandidateStore(
  store: ControllerCandidateStore,
): Promise<ArtifactStoreRecord> {
  const record = controllerCandidateStoreRecord(store);
  await Promise.all([
    assertDirectory(record.root),
    assertDirectory(record.artifactRoot),
    assertDirectory(record.stateRoot),
  ]);
  if (
    !isStrictlyWithin(record.root.path, record.artifactRoot.path) ||
    !isStrictlyWithin(record.root.path, record.stateRoot.path)
  ) {
    throw new TypeError("El store candidato escapa su estado controlador");
  }
  return record;
}

function collectGit(
  child: ChildProcess,
  stream: "stdout" | "stderr",
): Buffer[] {
  const chunks: Buffer[] = [];
  child[stream]?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return chunks;
}

async function gitExitCode(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

async function runStoreGit(
  root: string,
  arguments_: readonly string[],
  failure: string,
): Promise<string> {
  const child = spawn(
    gitExecutable,
    [...fixedGitArguments, "-C", root, ...arguments_],
    {
      env: fixedGitEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = collectGit(child, "stdout");
  const errors = collectGit(child, "stderr");
  if ((await gitExitCode(child)) !== 0) {
    const detail = Buffer.concat(errors).toString("utf8").trim();
    throw new TypeError(detail === "" ? failure : `${failure}: ${detail}`);
  }
  return Buffer.concat(output).toString("utf8").trim();
}

async function runStorePromotionGit(
  root: string,
  arguments_: readonly string[],
  failure: string,
): Promise<string> {
  const child = spawn(
    gitExecutable,
    [...fixedGitArguments, "-C", root, ...arguments_],
    {
      env: promotionGitEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = collectGit(child, "stdout");
  const errors = collectGit(child, "stderr");
  if ((await gitExitCode(child)) !== 0) {
    const detail = Buffer.concat(errors).toString("utf8").trim();
    throw new TypeError(detail === "" ? failure : `${failure}: ${detail}`);
  }
  return Buffer.concat(output).toString("utf8").trim();
}

/** Reads a fixed Git blob exactly; used only to verify a private dossier B. */
async function readStoreGitBytes(
  root: string,
  arguments_: readonly string[],
  failure: string,
): Promise<Buffer> {
  const child = spawn(
    gitExecutable,
    [...fixedGitArguments, "-C", root, ...arguments_],
    {
      env: fixedGitEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = collectGit(child, "stdout");
  const errors = collectGit(child, "stderr");
  if ((await gitExitCode(child)) !== 0) {
    const detail = Buffer.concat(errors).toString("utf8").trim();
    throw new TypeError(detail === "" ? failure : `${failure}: ${detail}`);
  }
  return Buffer.concat(output);
}

async function controllerRepositoryRoot(rootInput: string): Promise<string> {
  const rootPath = await realpath(rootInput);
  const entry = await lstat(rootPath);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError("El repositorio controlador candidato no es seguro");
  }
  const topLevel = await runStoreGit(
    rootPath,
    ["rev-parse", "--show-toplevel"],
    "No se pudo abrir el repositorio controlador candidato",
  );
  if (topLevel !== rootPath) {
    throw new TypeError("El store candidato exige la raíz Git controladora");
  }
  return rootPath;
}

async function openStoreAtRoot(
  rootInput: string,
): Promise<ControllerCandidateStore> {
  const rootPath = await controllerRepositoryRoot(rootInput);
  const artifactPath = join(rootPath, ".artifacts");
  const statePath = join(rootPath, ".change-state");
  await Promise.all([
    mkdir(artifactPath, { mode: 0o700, recursive: true }),
    mkdir(statePath, { mode: 0o700, recursive: true }),
  ]);
  const [rootEntry, artifactEntry, stateEntry] = await Promise.all([
    lstat(rootPath),
    lstat(artifactPath),
    lstat(statePath),
  ]);
  const [canonicalArtifactPath, canonicalStatePath] = await Promise.all([
    realpath(artifactPath),
    realpath(statePath),
  ]);
  if (
    canonicalArtifactPath !== artifactPath ||
    canonicalStatePath !== statePath ||
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    artifactEntry.isSymbolicLink() ||
    !artifactEntry.isDirectory() ||
    stateEntry.isSymbolicLink() ||
    !stateEntry.isDirectory() ||
    !isStrictlyWithin(rootPath, artifactPath) ||
    !isStrictlyWithin(rootPath, statePath)
  ) {
    throw new TypeError("No se pudo crear un estado candidato durable");
  }
  const store = Object.freeze({}) as ControllerCandidateStore;
  controllerCandidateStores.set(
    store,
    Object.freeze({
      root: directoryIdentity(rootPath, rootEntry),
      artifactRoot: directoryIdentity(artifactPath, artifactEntry),
      stateRoot: directoryIdentity(statePath, stateEntry),
    }),
  );
  return store;
}

/**
 * Opens controller-owned persistent candidate state from the trusted
 * controller startup directory. It deliberately accepts no repository path
 * or test initialization capability.
 */
export async function openControllerCandidateStore(): Promise<ControllerCandidateStore> {
  return await openStoreAtRoot(process.cwd());
}

/** Releases only in-memory store authority; durable state deliberately remains. */
export async function releaseControllerCandidateStore(
  store: ControllerCandidateStore,
): Promise<void> {
  await assertControllerCandidateStore(store);
  controllerCandidateStores.delete(store);
}

/**
 * Returns only a one-way store/repository binding for sealed controller
 * operations. It deliberately cannot reveal the controller repository path.
 */
export async function controllerCandidateStoreRepositoryFingerprint(
  store: ControllerCandidateStore,
): Promise<string> {
  const record = await assertControllerCandidateStore(store);
  return createHash("sha256").update(record.root.path).digest("hex");
}

async function createChildDirectory(
  parent: string,
  segment: string,
  allowExisting: boolean,
): Promise<string> {
  if (!safeName(segment)) {
    throw new TypeError("El estado candidato recibió un segmento no seguro");
  }
  const path = join(parent, segment);
  if (!isStrictlyWithin(parent, path)) {
    throw new TypeError("El estado candidato escapa de su raíz");
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (
      !allowExisting ||
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const entry = await lstat(path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(path)) !== path
  ) {
    throw new TypeError("El estado candidato contiene un directorio inseguro");
  }
  return path;
}

async function candidateDirectories(
  store: ControllerCandidateStore,
  plan: ChangePlan,
  attemptId: string,
): Promise<{
  readonly artifactCandidatePath: string;
  readonly bundlePath: string;
  readonly stateCandidatePath: string;
  readonly evidencePath: string;
}> {
  const record = await assertControllerCandidateStore(store);
  if (
    !changeIdPattern.test(plan.changeId) ||
    !attemptIdPattern.test(attemptId)
  ) {
    throw new TypeError("El cambio o intento candidato no es seguro");
  }
  const candidatesPath = await createChildDirectory(
    record.artifactRoot.path,
    "candidates",
    true,
  );
  const changeArtifactPath = await createChildDirectory(
    candidatesPath,
    plan.changeId,
    true,
  );
  const artifactCandidatePath = await createChildDirectory(
    changeArtifactPath,
    attemptId,
    false,
  );
  const bundlePath = await createChildDirectory(
    artifactCandidatePath,
    "bundle",
    false,
  );
  const changeStatePath = await createChildDirectory(
    record.stateRoot.path,
    plan.changeId,
    true,
  );
  const candidateStateRoot = await createChildDirectory(
    changeStatePath,
    "candidates",
    true,
  );
  const stateCandidatePath = await createChildDirectory(
    candidateStateRoot,
    attemptId,
    false,
  );
  const evidencePath = await createChildDirectory(
    stateCandidatePath,
    "evidence",
    false,
  );
  return Object.freeze({
    artifactCandidatePath,
    bundlePath,
    stateCandidatePath,
    evidencePath,
  });
}

function durableCandidateLocations(
  plan: Pick<ChangePlan, "changeId">,
  attemptId: string,
): DurableCandidateProvenance {
  if (
    !changeIdPattern.test(plan.changeId) ||
    !attemptIdPattern.test(attemptId)
  ) {
    throw new TypeError("El cambio o intento candidato no es seguro");
  }
  return Object.freeze({
    schemaVersion: 1,
    changeId: plan.changeId,
    attemptId,
    candidateCommit: "",
    candidateTree: "",
    artifactSha256: "",
    candidateRef: `refs/comunidadsolar/candidates/${plan.changeId}/${attemptId}`,
    bundle: `.artifacts/candidates/${plan.changeId}/${attemptId}/bundle`,
    manifest: `.change-state/${plan.changeId}/candidates/${attemptId}/candidate.json`,
  });
}

function durableCandidateProvenance(
  candidate: CandidateManifest,
  candidateTree: string,
): DurableCandidateProvenance {
  const locations = durableCandidateLocations(
    { changeId: candidate.changeId },
    candidate.attemptId,
  );
  return Object.freeze({
    ...locations,
    candidateCommit: candidate.candidateCommit,
    candidateTree,
    artifactSha256: candidate.artifactSha256,
  });
}

async function existingChildDirectory(
  parent: string,
  segment: string,
): Promise<string> {
  if (!safeName(segment)) {
    throw new TypeError("El estado candidato recibió un segmento no seguro");
  }
  const path = join(parent, segment);
  if (!isStrictlyWithin(parent, path)) {
    throw new TypeError("El estado candidato escapa de su raíz");
  }
  const entry = await lstat(path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(path)) !== path
  ) {
    throw new TypeError("El estado candidato contiene un directorio inseguro");
  }
  return path;
}

async function durableCandidatePaths(
  store: ControllerCandidateStore,
  plan: Pick<ChangePlan, "changeId">,
  attemptId: string,
): Promise<{
  readonly bundlePath: string;
  readonly manifestPath: string;
  readonly provenancePath: string;
}> {
  const record = await assertControllerCandidateStore(store);
  durableCandidateLocations(plan, attemptId);
  const artifactCandidates = await existingChildDirectory(
    record.artifactRoot.path,
    "candidates",
  );
  const artifactChange = await existingChildDirectory(
    artifactCandidates,
    plan.changeId,
  );
  const artifactAttempt = await existingChildDirectory(
    artifactChange,
    attemptId,
  );
  const bundlePath = await existingChildDirectory(artifactAttempt, "bundle");
  const stateChange = await existingChildDirectory(
    record.stateRoot.path,
    plan.changeId,
  );
  const stateCandidates = await existingChildDirectory(
    stateChange,
    "candidates",
  );
  const stateAttempt = await existingChildDirectory(stateCandidates, attemptId);
  const manifestPath = join(stateAttempt, "candidate.json");
  const provenancePath = join(stateAttempt, "candidate-provenance.json");
  for (const path of [manifestPath, provenancePath]) {
    if (!isStrictlyWithin(stateAttempt, path)) {
      throw new TypeError("El manifiesto candidato escapa su estado");
    }
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw new TypeError("El manifiesto candidato no es seguro");
    }
  }
  return Object.freeze({ bundlePath, manifestPath, provenancePath });
}

interface StableFile {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mode: number;
}

async function readStableRegularFile(
  path: string,
  maximumBytes = artifactMaximumBytes,
): Promise<StableFile> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes) {
      throw new TypeError(
        "El artefacto candidato no es un archivo regular seguro",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new TypeError("El artefacto candidato cambió durante la lectura");
    }
    return Object.freeze({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: before.mode,
    });
  } finally {
    await handle.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
    ? (value as Record<string, unknown>)
    : null;
}

function assertNoDuplicateJsonKeys(source: string): void {
  let index = 0;
  const whitespace = new Set([" ", "\n", "\r", "\t"]);
  const skipWhitespace = () => {
    while (index < source.length && whitespace.has(source[index]!)) index += 1;
  };
  const string = (): string => {
    if (source[index] !== '"') throw new TypeError("JSON estricto inválido");
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index]!;
      index += 1;
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          throw new TypeError("JSON estricto inválido");
        }
      }
      if (character.charCodeAt(0) < 0x20) {
        throw new TypeError("JSON estricto inválido");
      }
      if (character !== "\\") continue;
      const escape = source[index];
      index += 1;
      if (escape === "u") {
        const code = source.slice(index, index + 4);
        if (!/^[0-9a-f]{4}$/iu.test(code)) {
          throw new TypeError("JSON estricto inválido");
        }
        index += 4;
      } else if (
        !['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape ?? "")
      ) {
        throw new TypeError("JSON estricto inválido");
      }
    }
    throw new TypeError("JSON estricto inválido");
  };
  const primitive = () => {
    const start = index;
    while (
      index < source.length &&
      !whitespace.has(source[index]!) &&
      ![",", "]", "}"].includes(source[index]!)
    ) {
      index += 1;
    }
    if (index === start) throw new TypeError("JSON estricto inválido");
  };
  const value = (): void => {
    skipWhitespace();
    if (source[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const key = string();
        if (keys.has(key)) {
          throw new TypeError("JSON estricto contiene una clave duplicada");
        }
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ":")
          throw new TypeError("JSON estricto inválido");
        index += 1;
        value();
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        if (source[index] !== ",")
          throw new TypeError("JSON estricto inválido");
        index += 1;
      }
    }
    if (source[index] === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        value();
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        if (source[index] !== ",")
          throw new TypeError("JSON estricto inválido");
        index += 1;
      }
    }
    if (source[index] === '"') {
      string();
      return;
    }
    primitive();
  };
  value();
  skipWhitespace();
  if (index !== source.length) throw new TypeError("JSON estricto inválido");
}

function strictJsonRecord(
  bytes: Buffer,
  label: string,
): Record<string, unknown> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} no contiene UTF-8 estricto`);
  }
  try {
    assertNoDuplicateJsonKeys(source);
    const value = JSON.parse(source) as unknown;
    const record = asRecord(value);
    if (record === null) throw new TypeError("not object");
    return record;
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message.startsWith(label))
      throw error;
    throw new TypeError(`${label} no contiene JSON estricto`);
  }
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort(lexicalCompare);
  const expected = [...allowed].sort(lexicalCompare);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} contiene campos no permitidos`);
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} requiere ${key} como string no vacío`);
  }
  return value;
}

function safeBinding(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);
}

function safeWorkerName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/u.test(value);
}

function safeDatabaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function sameDestination(
  left: CandidatePublishDestination,
  right: CandidatePublishDestination,
): boolean {
  return (
    left.workerName === right.workerName &&
    left.d1.binding === right.d1.binding &&
    left.d1.databaseId === right.d1.databaseId &&
    left.d1.databaseName === right.d1.databaseName
  );
}

async function resolveFlattenedConfigPath(
  root: string,
  redirectPath: string,
  value: string,
): Promise<string> {
  if (!safeRedirectPath(value)) {
    throw new TypeError(
      "El redirect de deploy contiene una ruta de config insegura",
    );
  }
  const resolved = resolve(dirname(redirectPath), value);
  if (!isStrictlyWithin(root, resolved)) {
    throw new TypeError("El redirect de deploy escapa del bundle candidato");
  }
  const canonical = await realpath(resolved);
  if (!isStrictlyWithin(root, canonical)) {
    throw new TypeError("El redirect de deploy escapa del bundle candidato");
  }
  const relativePath = relative(root, canonical).split(sep).join("/");
  if (
    !safeRelativePath(relativePath) ||
    !relativePath.startsWith("dist/") ||
    (!relativePath.endsWith("/wrangler.json") &&
      relativePath !== "dist/wrangler.json")
  ) {
    throw new TypeError(
      "El redirect de deploy debe apuntar a un wrangler.json aplanado bajo dist",
    );
  }
  const entry = await lstat(canonical);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new TypeError("El config aplanado no es un archivo regular seguro");
  }
  return relativePath;
}

function redirectPaths(record: Record<string, unknown>): {
  readonly primary: string;
  readonly auxiliary: readonly string[];
  readonly prerender: string | undefined;
} {
  const allowed = new Set([
    "configPath",
    "auxiliaryWorkers",
    "prerenderWorkerConfigPath",
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    !("configPath" in record) ||
    !("auxiliaryWorkers" in record)
  ) {
    throw new TypeError("El redirect de deploy contiene campos no permitidos");
  }
  const primary = requiredString(record, "configPath", "El redirect de deploy");
  if (!Array.isArray(record.auxiliaryWorkers)) {
    throw new TypeError(
      "El redirect de deploy requiere auxiliaryWorkers como array",
    );
  }
  const auxiliary = record.auxiliaryWorkers.map((value) => {
    if (typeof value === "string") return value;
    const worker = asRecord(value);
    if (worker === null) {
      throw new TypeError(
        "El redirect de deploy contiene un worker auxiliar inválido",
      );
    }
    exactKeys(worker, ["configPath"], "El worker auxiliar");
    return requiredString(worker, "configPath", "El worker auxiliar");
  });
  const prerender = record.prerenderWorkerConfigPath;
  if (prerender !== undefined && typeof prerender !== "string") {
    throw new TypeError(
      "El redirect de deploy contiene prerenderWorkerConfigPath inválido",
    );
  }
  return Object.freeze({
    primary,
    auxiliary: Object.freeze(auxiliary),
    prerender,
  });
}

async function validateFlattenedConfig(
  root: string,
  relativeConfigPath: string,
  plan: Pick<ChangePlan, "publication">,
  isPrimary: boolean,
): Promise<{
  readonly workerRelativePath: string;
  readonly assetsRelativePath: string;
  readonly configSha256: string;
  readonly destination: CandidatePublishDestination;
}> {
  const configPath = join(root, ...relativeConfigPath.split("/"));
  const configFile = await readStableRegularFile(configPath);
  const config = strictJsonRecord(configFile.bytes, "El config aplanado");
  const targetEnvironment = config.targetEnvironment;
  if (targetEnvironment !== plan.publication.environment) {
    throw new TypeError(
      "El targetEnvironment del build no coincide con el perfil",
    );
  }
  const main = requiredString(config, "main", "El config aplanado");
  if (!safeRedirectPath(main)) {
    throw new TypeError("El config aplanado contiene main inseguro");
  }
  const workerPath = resolve(dirname(configPath), main);
  const expectedWorker = resolve(root, ...fixedWorkerRelativePath.split("/"));
  const distPath = resolve(root, "dist");
  if (
    !isStrictlyWithin(distPath, workerPath) ||
    (isPrimary && workerPath !== expectedWorker)
  ) {
    throw new TypeError("El config aplanado no usa el worker candidato fijado");
  }
  const worker = await lstat(workerPath);
  if (worker.isSymbolicLink() || !worker.isFile() || worker.nlink !== 1) {
    throw new TypeError("El worker candidato no es un archivo regular seguro");
  }
  const assets = asRecord(config.assets);
  if (assets === null)
    throw new TypeError("El config aplanado requiere assets");
  exactKeys(assets, ["binding", "directory", "run_worker_first"], "assets");
  const binding = requiredString(assets, "binding", "assets");
  const directory = requiredString(assets, "directory", "assets");
  if (
    binding !== "ASSETS" ||
    assets.run_worker_first !== true ||
    !safeRedirectPath(directory)
  ) {
    throw new TypeError("El config aplanado contiene assets inválido");
  }
  const assetsPath = resolve(dirname(configPath), directory);
  if (assetsPath !== distPath) {
    throw new TypeError(
      "El destino de assets no coincide con dist del perfil aprobado",
    );
  }
  const assetsEntry = await lstat(assetsPath);
  if (assetsEntry.isSymbolicLink() || !assetsEntry.isDirectory()) {
    throw new TypeError("El destino de assets no es un directorio seguro");
  }
  const vars = asRecord(config.vars);
  if (
    vars === null ||
    Object.keys(vars).length !== 1 ||
    vars.SITE_INDEXABLE !== (plan.publication.siteIndexable ? "true" : "false")
  ) {
    throw new TypeError("La indexabilidad del build no coincide con el perfil");
  }
  if (!Array.isArray(config.bindings) || config.bindings.length === 0) {
    throw new TypeError("El config aplanado requiere bindings explícitos");
  }
  const bindings = new Set<string>();
  for (const candidate of config.bindings) {
    if (
      typeof candidate !== "string" ||
      !safeBinding(candidate) ||
      bindings.has(candidate)
    ) {
      throw new TypeError("El config aplanado contiene bindings inválidos");
    }
    bindings.add(candidate);
  }
  if (bindings.size !== 2 || !bindings.has(binding) || !bindings.has("DB")) {
    throw new TypeError(
      "Los bindings del build no coinciden con el perfil aprobado",
    );
  }
  const workerName = requiredString(config, "name", "El config aplanado");
  if (!safeWorkerName(workerName)) {
    throw new TypeError("El config aplanado no tiene un Worker permitido");
  }
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new TypeError("El config aplanado requiere un destino D1 único");
  }
  const database = asRecord(config.d1_databases[0]);
  if (database === null) {
    throw new TypeError("El config aplanado tiene un destino D1 inválido");
  }
  exactKeys(
    database,
    ["binding", "database_id", "database_name", "migrations_dir"],
    "El destino D1 aplanado",
  );
  const databaseBinding = requiredString(
    database,
    "binding",
    "El destino D1 aplanado",
  );
  const databaseId = requiredString(
    database,
    "database_id",
    "El destino D1 aplanado",
  );
  const databaseName = requiredString(
    database,
    "database_name",
    "El destino D1 aplanado",
  );
  const migrationsDirectory = requiredString(
    database,
    "migrations_dir",
    "El destino D1 aplanado",
  );
  if (
    databaseBinding !== "DB" ||
    !safeDatabaseId(databaseId) ||
    !safeWorkerName(databaseName) ||
    !safeRedirectPath(migrationsDirectory)
  ) {
    throw new TypeError("El config aplanado tiene un destino D1 inválido");
  }
  return Object.freeze({
    workerRelativePath: relative(root, workerPath).split(sep).join("/"),
    assetsRelativePath: relative(root, assetsPath).split(sep).join("/"),
    configSha256: configFile.sha256,
    destination: Object.freeze({
      workerName,
      d1: Object.freeze({
        binding: "DB" as const,
        databaseId,
        databaseName,
      }),
    }),
  });
}

async function readCandidateBundleConfiguration(
  rootInput: string,
  plan: Pick<ChangePlan, "publication">,
): Promise<CandidateBundleConfiguration> {
  const root = await realpath(rootInput);
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new TypeError("La raíz del bundle candidato no es segura");
  }
  const redirectPath = join(root, ...fixedDeployRedirectPath.split("/"));
  const redirect = strictJsonRecord(
    (await readStableRegularFile(redirectPath)).bytes,
    "El redirect de deploy",
  );
  const declared = redirectPaths(redirect);
  const primaryConfigRelativePath = await resolveFlattenedConfigPath(
    root,
    redirectPath,
    declared.primary,
  );
  const configRelativePaths = [
    primaryConfigRelativePath,
    ...(await Promise.all(
      declared.auxiliary.map(
        async (value) =>
          await resolveFlattenedConfigPath(root, redirectPath, value),
      ),
    )),
    ...(declared.prerender === undefined
      ? []
      : [
          await resolveFlattenedConfigPath(
            root,
            redirectPath,
            declared.prerender,
          ),
        ]),
  ].sort(lexicalCompare);
  if (new Set(configRelativePaths).size !== configRelativePaths.length) {
    throw new TypeError("El redirect de deploy repite configs aplanados");
  }
  let primary:
    | {
        readonly workerRelativePath: string;
        readonly assetsRelativePath: string;
        readonly configSha256: string;
        readonly destination: CandidatePublishDestination;
      }
    | undefined;
  const verifiedConfigurations: Array<{
    readonly path: string;
    readonly sha256: string;
    readonly destination: CandidatePublishDestination;
  }> = [];
  for (const configPath of configRelativePaths) {
    const verified = await validateFlattenedConfig(
      root,
      configPath,
      plan,
      configPath === primaryConfigRelativePath,
    );
    verifiedConfigurations.push(
      Object.freeze({
        path: configPath,
        sha256: verified.configSha256,
        destination: verified.destination,
      }),
    );
    if (configPath === primaryConfigRelativePath) primary = verified;
  }
  if (primary === undefined) {
    throw new TypeError(
      "El redirect de deploy no conserva un config principal",
    );
  }
  if (
    verifiedConfigurations.some(
      (configuration) =>
        !sameDestination(configuration.destination, primary.destination),
    )
  ) {
    throw new TypeError(
      "Los configs aplanados no comparten el destino Cloudflare sellado",
    );
  }
  return Object.freeze({
    redirectRelativePath: fixedDeployRedirectPath,
    primaryConfigRelativePath,
    workerRelativePath: primary.workerRelativePath,
    assetsRelativePath: primary.assetsRelativePath,
    configRelativePaths: Object.freeze(configRelativePaths),
    flattenedConfigSha256: createHash("sha256")
      .update(
        canonicalJson(
          verifiedConfigurations.map((configuration) => ({
            path: configuration.path,
            sha256: configuration.sha256,
          })),
        ),
        "utf8",
      )
      .digest("hex"),
    destination: primary.destination,
  });
}

async function writeControllerFile(
  path: string,
  bytes: Buffer,
): Promise<string> {
  await writeFile(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const actual = await readStableRegularFile(path, bytes.byteLength);
  const expected = createHash("sha256").update(bytes).digest("hex");
  if (
    actual.sha256 !== expected ||
    actual.bytes.byteLength !== bytes.byteLength
  ) {
    throw new TypeError("El estado candidato cambió durante la escritura");
  }
  return actual.sha256;
}

async function persistPreliminaryEvidence(
  validations: readonly ValidationResult[],
  evidencePath: string,
): Promise<
  readonly {
    readonly id: string;
    readonly status: "passed";
    readonly evidence: string;
    readonly evidenceSha256: string;
  }[]
> {
  const preliminaryPath = await createChildDirectory(
    evidencePath,
    "preliminary",
    false,
  );
  const identifiers = new Set<string>();
  const persisted: Array<{
    readonly id: string;
    readonly status: "passed";
    readonly evidence: string;
    readonly evidenceSha256: string;
  }> = [];
  for (const validation of validations) {
    if (
      validation.status !== "passed" ||
      validation.evidence === null ||
      validation.evidenceSha256 === null ||
      !sha256Pattern.test(validation.evidenceSha256) ||
      !attemptIdPattern.test(validation.id) ||
      identifiers.has(validation.id)
    ) {
      throw new TypeError("La evidencia preliminar no es candidata elegible");
    }
    identifiers.add(validation.id);
    const source = await readStableRegularFile(validation.evidence);
    if (source.sha256 !== validation.evidenceSha256) {
      throw new TypeError(
        "La evidencia preliminar cambió antes de persistirse",
      );
    }
    const fileName = `${validation.id}.json`;
    const destination = join(preliminaryPath, fileName);
    const evidenceSha256 = await writeControllerFile(destination, source.bytes);
    persisted.push(
      Object.freeze({
        id: validation.id,
        status: "passed" as const,
        evidence: `evidence/preliminary/${fileName}`,
        evidenceSha256,
      }),
    );
  }
  return Object.freeze(persisted);
}

async function persistCandidateBuildEvidence(
  evidence: CandidateBoundBuildEvidence,
  artifactSha256: string,
  evidencePath: string,
): Promise<
  readonly {
    readonly id: string;
    readonly status: "passed";
    readonly evidence: string;
    readonly evidenceSha256: string;
  }[]
> {
  const path = join(evidencePath, "candidate-build.json");
  const persisted: PersistedCandidateBuildEvidence = Object.freeze({
    ...evidence,
    artifactSha256,
  });
  const bytes = Buffer.from(
    `${canonicalCandidateBuildEvidence(persisted)}\n`,
    "utf8",
  );
  const evidenceSha256 = await writeControllerFile(path, bytes);
  const validations = persisted.validations.map((validation) =>
    Object.freeze({
      id: validation.id,
      status: "passed" as const,
      evidence: `evidence/candidate-build.json#${validation.id}`,
      evidenceSha256,
    }),
  );
  if (
    new Set(validations.map((validation) => validation.id)).size !==
    validations.length
  ) {
    throw new TypeError("El build candidato repite IDs de validación");
  }
  return Object.freeze(validations);
}

function artifactManifestPaths(
  plan: ChangePlan,
  attemptId: string,
  files: readonly CandidateArtifactEntry[],
): CandidateManifest["artifacts"] {
  return Object.freeze(
    files.map((file) =>
      Object.freeze({
        path: `.artifacts/candidates/${plan.changeId}/${attemptId}/bundle/${file.path}`,
        sha256: file.sha256,
        bytes: file.bytes,
      }),
    ),
  ) as CandidateManifest["artifacts"];
}

function frozenCandidateManifest(value: CandidateManifest): CandidateManifest {
  return Object.freeze({
    ...value,
    buildProfile: Object.freeze({ ...value.buildProfile }),
    routes: Object.freeze([...value.routes]),
    files: Object.freeze([...value.files]),
    validations: Object.freeze(
      value.validations.map((validation) => Object.freeze({ ...validation })),
    ),
    artifacts: Object.freeze(
      value.artifacts.map((artifact) => Object.freeze({ ...artifact })),
    ),
    preview: Object.freeze({ ...value.preview }),
    knownDifferences: Object.freeze(
      value.knownDifferences.map((difference) =>
        Object.freeze({ ...difference }),
      ),
    ),
  }) as CandidateManifest;
}

function candidateRecord(candidate: CandidateManifest): CandidatePreviewRecord {
  const record = candidateRecords.get(candidate);
  if (record === undefined) {
    throw new TypeError("El candidato no pertenece a este controlador");
  }
  return record;
}

/**
 * Builds candidate commit A, runs its bound build capability, validates the
 * generated deploy redirect/profile, then copies only the exact verified bundle
 * into private controller state.
 */
export async function createCandidate(
  input: CandidateCreationInput,
): Promise<CandidateManifest> {
  if (!attemptIdPattern.test(input.attemptId)) {
    throw new TypeError("El intento candidato no es seguro");
  }
  if (!changeIdPattern.test(input.plan.changeId)) {
    throw new TypeError("El plan candidato no es seguro");
  }
  await assertControllerCandidateStore(input.store);
  const preliminary = await assertCandidateEligiblePreliminaryValidation(
    input.preliminaryValidations,
    input.output,
    input.plan,
    input.attemptId,
  );
  let candidateCommit: CandidateCommit | undefined;
  let artifactCandidatePath: string | undefined;
  let stateCandidatePath: string | undefined;
  try {
    candidateCommit = await createCandidateCommit(
      input.output,
      input.plan,
      input.attemptId,
      input.store,
    );
    const buildEvidence = await runCandidateBoundBuild(
      candidateCommit,
      input.plan,
      input.attemptId,
      input.buildCapability,
    );
    if (
      buildEvidence.candidateCommit !== candidateCommit.candidateCommit ||
      buildEvidence.candidateTree !== candidateCommit.candidateTree ||
      buildEvidence.planSha256 !== input.plan.planSha256 ||
      buildEvidence.attemptId !== input.attemptId
    ) {
      throw new TypeError(
        "La evidencia de build no está ligada al commit candidato",
      );
    }
    const directories = await candidateDirectories(
      input.store,
      input.plan,
      input.attemptId,
    );
    artifactCandidatePath = directories.artifactCandidatePath;
    stateCandidatePath = directories.stateCandidatePath;
    const capturedBuild = await captureCandidateBuildArtifacts(
      candidateCommit,
      input.plan,
      input.attemptId,
    );
    const copiedArtifacts = capturedBuild.copiedArtifacts;
    const copiedConfiguration = await readCandidateBundleConfiguration(
      directories.bundlePath,
      input.plan,
    );
    const artifactSha256 = await hashTree(directories.bundlePath);
    const preliminaryValidations = await persistPreliminaryEvidence(
      preliminary,
      directories.evidencePath,
    );
    const buildValidations = await persistCandidateBuildEvidence(
      buildEvidence,
      artifactSha256,
      directories.evidencePath,
    );
    const validations = [...preliminaryValidations, ...buildValidations];
    if (
      new Set(validations.map((validation) => validation.id)).size !==
        validations.length ||
      validations.some((validation) => validation.status !== "passed")
    ) {
      throw new TypeError(
        "El candidato sólo admite validaciones aprobadas y distintas",
      );
    }
    const buildProfile = Object.freeze({ ...input.plan.publication });
    if (canonicalJson(buildProfile) !== canonicalJson(input.plan.publication)) {
      throw new TypeError(
        "El perfil de build candidato no coincide byte a byte",
      );
    }
    const manifest = frozenCandidateManifest(
      validateSchema<CandidateManifest>("candidate", {
        schemaVersion: 1,
        changeId: input.plan.changeId,
        attemptId: input.attemptId,
        requestSha256: input.plan.requestSha256,
        planSha256: input.plan.planSha256,
        baselineCommit: input.plan.baselineCommit,
        candidateCommit: candidateCommit.candidateCommit,
        artifactSha256,
        buildProfile,
        routes: [input.plan.targetPath],
        files: [...input.output.files],
        validations,
        artifacts: artifactManifestPaths(
          input.plan,
          input.attemptId,
          copiedArtifacts,
        ),
        preview: {
          command:
            "wrangler dev dist/_worker.js/index.js --no-bundle --assets dist --config dist/wrangler.json --local",
          url: "http://127.0.0.1",
        },
        knownDifferences: [],
      }),
    );
    const manifestPath = join(directories.stateCandidatePath, "candidate.json");
    await writeControllerFile(
      manifestPath,
      Buffer.from(`${canonicalJson(manifest)}\n`, "utf8"),
    );
    await writeControllerFile(
      join(directories.stateCandidatePath, "candidate-provenance.json"),
      Buffer.from(
        `${canonicalJson(
          durableCandidateProvenance(manifest, candidateCommit.candidateTree),
        )}\n`,
        "utf8",
      ),
    );
    await persistCandidateCommit(candidateCommit, input.plan, input.attemptId);
    candidateRecords.set(
      manifest,
      Object.freeze({
        store: input.store,
        attemptId: input.attemptId,
        candidateTree: candidateCommit.candidateTree,
        bundlePath: directories.bundlePath,
        manifestPath,
        configuration: copiedConfiguration,
        previewCapability: input.previewCapability,
      }),
    );
    return manifest;
  } catch (error: unknown) {
    if (artifactCandidatePath !== undefined) {
      await rm(artifactCandidatePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    if (stateCandidatePath !== undefined) {
      await rm(stateCandidatePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (candidateCommit !== undefined) {
      await removeCandidateCommit(candidateCommit).catch(() => undefined);
    }
  }
}

function verifiedDurableProvenance(
  value: Record<string, unknown>,
  candidate: CandidateManifest,
  changeId: string,
  attemptId: string,
): string {
  exactKeys(
    value,
    [
      "artifactSha256",
      "attemptId",
      "bundle",
      "candidateCommit",
      "candidateTree",
      "candidateRef",
      "changeId",
      "manifest",
      "schemaVersion",
    ],
    "La procedencia durable candidata",
  );
  const locations = durableCandidateLocations({ changeId }, attemptId);
  if (
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    value.attemptId !== attemptId ||
    value.candidateCommit !== candidate.candidateCommit ||
    value.artifactSha256 !== candidate.artifactSha256 ||
    typeof value.candidateTree !== "string" ||
    !candidateCommitPattern.test(value.candidateTree) ||
    value.candidateRef !== locations.candidateRef ||
    value.bundle !== locations.bundle ||
    value.manifest !== locations.manifest
  ) {
    throw new TypeError("La procedencia durable no coincide con el candidato");
  }
  return value.candidateTree;
}

async function verifyPersistedArtifactEntries(
  candidate: CandidateManifest,
  bundlePath: string,
): Promise<void> {
  const prefix = `.artifacts/candidates/${candidate.changeId}/${candidate.attemptId}/bundle/`;
  const entries = new Set<string>();
  if (candidate.artifacts.length === 0) {
    throw new TypeError("El manifiesto candidato no contiene artefactos");
  }
  for (const artifact of candidate.artifacts) {
    if (
      !artifact.path.startsWith(prefix) ||
      !safeRelativePath(artifact.path.slice(prefix.length)) ||
      !sha256Pattern.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      entries.has(artifact.path)
    ) {
      throw new TypeError(
        "El manifiesto candidato contiene artefactos inseguros",
      );
    }
    entries.add(artifact.path);
    const path = join(
      bundlePath,
      ...artifact.path.slice(prefix.length).split("/"),
    );
    if (!isStrictlyWithin(bundlePath, path)) {
      throw new TypeError("El artefacto durable escapa su bundle");
    }
    const file = await readStableRegularFile(path, artifactMaximumBytes);
    if (
      file.sha256 !== artifact.sha256 ||
      file.bytes.byteLength !== artifact.bytes
    ) {
      throw new TypeError("El artefacto durable no coincide con su manifiesto");
    }
  }
}

async function assertDurableCandidateStoreCommit(
  store: ControllerCandidateStore,
  candidate: CandidateManifest,
  candidateTree: string,
): Promise<void> {
  if (
    !candidateCommitPattern.test(candidate.candidateCommit) ||
    !candidateCommitPattern.test(candidate.baselineCommit) ||
    !candidateCommitPattern.test(candidateTree)
  ) {
    throw new TypeError("El commit durable candidato no es válido");
  }
  const record = await assertControllerCandidateStore(store);
  const locations = durableCandidateLocations(
    { changeId: candidate.changeId },
    candidate.attemptId,
  );
  const [resolved, parent, tree, object] = await Promise.all([
    runStoreGit(
      record.root.path,
      ["rev-parse", "--verify", "--quiet", locations.candidateRef],
      "No se pudo resolver la ref candidata durable",
    ),
    runStoreGit(
      record.root.path,
      ["rev-parse", `${candidate.candidateCommit}^`],
      "No se pudo leer el padre durable del candidato",
    ),
    runStoreGit(
      record.root.path,
      ["rev-parse", `${candidate.candidateCommit}^{tree}`],
      "No se pudo leer el árbol durable del candidato",
    ),
    runStoreGit(
      record.root.path,
      ["cat-file", "-e", `${candidate.candidateCommit}^{commit}`],
      "El commit candidato durable no existe",
    ),
  ]);
  if (
    resolved !== candidate.candidateCommit ||
    parent !== candidate.baselineCommit ||
    tree !== candidateTree ||
    object !== ""
  ) {
    throw new TypeError(
      "El commit candidato durable no conserva su procedencia",
    );
  }
}

/**
 * Reopens persistent state through only a controller-owned store and safe
 * identity. It deliberately accepts no staged output, plan, repository, or
 * checkout path.
 */
export async function loadCandidate(
  input: CandidateLoadInput,
): Promise<CandidateManifest> {
  if (
    !changeIdPattern.test(input.changeId) ||
    !attemptIdPattern.test(input.attemptId)
  ) {
    throw new TypeError("El cambio o intento candidato no es seguro");
  }
  const store = input.store;
  await assertControllerCandidateStore(store);
  const paths = await durableCandidatePaths(
    store,
    { changeId: input.changeId },
    input.attemptId,
  );
  const [manifestFile, provenanceFile] = await Promise.all([
    readStableRegularFile(paths.manifestPath),
    readStableRegularFile(paths.provenancePath),
  ]);
  const manifest = frozenCandidateManifest(
    validateSchema<CandidateManifest>(
      "candidate",
      strictJsonRecord(manifestFile.bytes, "El manifiesto candidato"),
    ),
  );
  if (
    manifest.changeId !== input.changeId ||
    manifest.attemptId !== input.attemptId
  ) {
    throw new TypeError(
      "El manifiesto durable no coincide con la identidad candidata",
    );
  }
  const candidateTree = verifiedDurableProvenance(
    strictJsonRecord(provenanceFile.bytes, "La procedencia durable candidata"),
    manifest,
    input.changeId,
    input.attemptId,
  );
  await assertDurableCandidateStoreCommit(store, manifest, candidateTree);
  const configuration = await readCandidateBundleConfiguration(
    paths.bundlePath,
    { publication: manifest.buildProfile },
  );
  await verifyPersistedArtifactEntries(manifest, paths.bundlePath);
  if ((await hashTree(paths.bundlePath)) !== manifest.artifactSha256) {
    throw new TypeError("El digest no coincide con el artefacto candidato");
  }
  candidateRecords.set(
    manifest,
    Object.freeze({
      store,
      attemptId: input.attemptId,
      candidateTree,
      bundlePath: paths.bundlePath,
      manifestPath: paths.manifestPath,
      configuration,
      previewCapability: undefined,
    }),
  );
  return manifest;
}

/** Rehashes the exact private bundle before any Gate 2 or preview consumer. */
export async function verifyCandidateArtifact(
  candidate: CandidateManifest,
): Promise<void> {
  const record = candidateRecord(candidate);
  await assertControllerCandidateStore(record.store);
  await assertDurableCandidateStoreCommit(
    record.store,
    candidate,
    record.candidateTree,
  );
  const digest = await hashTree(record.bundlePath);
  if (digest !== candidate.artifactSha256) {
    throw new TypeError("El digest no coincide con el artefacto candidato");
  }
  const configuration = await readCandidateBundleConfiguration(
    record.bundlePath,
    {
      publication: candidate.buildProfile,
    },
  );
  if (canonicalJson(configuration) !== canonicalJson(record.configuration)) {
    throw new TypeError(
      "La configuración candidata no coincide con su registro",
    );
  }
  await verifyPersistedArtifactEntries(candidate, record.bundlePath);
}

function assertOperatorProfileShape(
  operator: CandidateOperatorProfile,
): CandidateOperatorProfile {
  const value = asRecord(operator);
  if (value === null) {
    throw new TypeError("El perfil operador no tiene una forma permitida");
  }
  exactKeys(
    value,
    [
      "adapter",
      "configSha256",
      "destination",
      "environment",
      "flattenedConfigSha256",
      "siteIndexable",
    ],
    "El perfil operador",
  );
  const destination = asRecord(value.destination);
  const d1 = destination === null ? null : asRecord(destination.d1);
  if (
    destination === null ||
    d1 === null ||
    (value.adapter !== "local" && value.adapter !== "cloudflare") ||
    typeof value.configSha256 !== "string" ||
    !sha256Pattern.test(value.configSha256) ||
    (value.environment !== null && typeof value.environment !== "string") ||
    typeof value.siteIndexable !== "boolean" ||
    typeof value.flattenedConfigSha256 !== "string" ||
    !sha256Pattern.test(value.flattenedConfigSha256)
  ) {
    throw new TypeError("El perfil operador no tiene una forma permitida");
  }
  exactKeys(destination, ["d1", "workerName"], "El destino operador");
  exactKeys(d1, ["binding", "databaseId", "databaseName"], "El D1 operador");
  if (
    !safeWorkerName(
      typeof destination.workerName === "string" ? destination.workerName : "",
    ) ||
    d1.binding !== "DB" ||
    !safeDatabaseId(typeof d1.databaseId === "string" ? d1.databaseId : "") ||
    !safeWorkerName(typeof d1.databaseName === "string" ? d1.databaseName : "")
  ) {
    throw new TypeError("El destino operador no tiene una forma permitida");
  }
  return operator;
}

function operatorMatchesCandidate(
  operator: CandidateOperatorProfile,
  candidate: CandidateManifest,
  configuration: CandidateBundleConfiguration,
): boolean {
  return (
    operator.adapter === candidate.buildProfile.adapter &&
    operator.configSha256 === candidate.buildProfile.configSha256 &&
    operator.environment === candidate.buildProfile.environment &&
    operator.siteIndexable === candidate.buildProfile.siteIndexable &&
    operator.flattenedConfigSha256 === configuration.flattenedConfigSha256 &&
    sameDestination(operator.destination, configuration.destination)
  );
}

async function assertCandidateOperatorProfile(
  candidate: CandidateManifest,
  operator: CandidateOperatorProfile,
): Promise<void> {
  const checked = assertOperatorProfileShape(operator);
  const record = candidateRecord(candidate);
  if (!operatorMatchesCandidate(checked, candidate, record.configuration)) {
    throw new TypeError(
      "El operador no coincide con el perfil y destino candidato sellados",
    );
  }
}

interface CandidatePublicationState {
  readonly request: NormalizedRequest;
  readonly plan: ChangePlan;
  readonly gate1: ApprovalRecord;
  readonly gate2: ApprovalRecord;
  readonly attempt: AttemptRecord;
  readonly gate1Provenance: Awaited<
    ReturnType<typeof verifyPersistedApprovalProvenance>
  >;
  readonly gate2Provenance: Awaited<
    ReturnType<typeof verifyPersistedApprovalProvenance>
  >;
}

async function sealedCandidateEvidenceRoot(
  record: CandidatePreviewRecord,
): Promise<string> {
  const root = dirname(record.manifestPath);
  const evidence = join(root, "evidence");
  if (!isStrictlyWithin(root, evidence)) {
    throw new TypeError("La evidencia candidata escapa el estado sellado");
  }
  try {
    const entry = await lstat(evidence);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (await realpath(evidence)) !== evidence
    ) {
      throw new TypeError(
        "La evidencia candidata no tiene un directorio seguro",
      );
    }
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Falta el directorio de evidencia candidata sellada");
  }
  return root;
}

async function sealedCandidateEvidenceFile(
  root: string,
  relativePath: string,
): Promise<StableFile> {
  if (!safeRelativePath(relativePath)) {
    throw new TypeError("La evidencia candidata tiene una ruta no permitida");
  }
  const path = join(root, ...relativePath.split("/"));
  if (!isStrictlyWithin(root, path)) {
    throw new TypeError("La evidencia candidata escapa el estado sellado");
  }
  try {
    return await readStableRegularFile(path);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Falta un archivo de evidencia candidata sellada");
  }
}

function candidateEvidenceSha256(
  validation: CandidateManifest["validations"][number],
): string {
  if (
    typeof validation.evidenceSha256 !== "string" ||
    !sha256Pattern.test(validation.evidenceSha256)
  ) {
    throw new TypeError("La evidencia candidata no tiene un hash sellado");
  }
  return validation.evidenceSha256;
}

function matchedAttemptValidation(
  validations: ReadonlyMap<string, ValidationResult>,
  candidate: CandidateManifest,
  validation: CandidateManifest["validations"][number],
): ValidationResult {
  const attempt = validations.get(validation.id);
  const expectedPath = `candidates/${candidate.attemptId}/${validation.evidence}`;
  const evidenceSha256 = candidateEvidenceSha256(validation);
  if (
    attempt === undefined ||
    attempt.status !== "passed" ||
    attempt.evidence !== expectedPath ||
    attempt.evidenceSha256 !== evidenceSha256
  ) {
    throw new TypeError(
      "La evidencia de intento no coincide con la evidencia candidata sellada",
    );
  }
  return attempt;
}

function verifyPreliminaryEvidenceBinding(
  bytes: Buffer,
  candidate: CandidateManifest,
  validation: CandidateManifest["validations"][number],
): void {
  const value = strictJsonRecord(bytes, "La evidencia preliminar candidata");
  const preliminary = asRecord(value.preliminary);
  if (
    value.schemaVersion !== 2 ||
    value.attemptId !== candidate.attemptId ||
    value.id !== validation.id ||
    value.status !== "passed" ||
    preliminary === null ||
    preliminary.scope !== PRELIMINARY_STAGED_VALIDATION_SCOPE ||
    preliminary.planSha256 !== candidate.planSha256 ||
    preliminary.executionCopy === null ||
    !isRecord(preliminary.approvedOutputSha256)
  ) {
    throw new TypeError(
      "La evidencia preliminar no está ligada al plan e intento candidato",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

function verifyCandidateBuildEvidenceBinding(
  bytes: Buffer,
  candidate: CandidateManifest,
  candidateTree: string,
  validations: readonly CandidateManifest["validations"][number][],
): void {
  const value = strictJsonRecord(bytes, "La evidencia de build candidata");
  exactKeys(
    value,
    [
      "artifactSha256",
      "attemptId",
      "candidateCommit",
      "candidateTree",
      "planSha256",
      "validations",
    ],
    "La evidencia de build candidata",
  );
  if (
    value.artifactSha256 !== candidate.artifactSha256 ||
    value.attemptId !== candidate.attemptId ||
    value.candidateCommit !== candidate.candidateCommit ||
    value.candidateTree !== candidateTree ||
    value.planSha256 !== candidate.planSha256 ||
    !Array.isArray(value.validations)
  ) {
    throw new TypeError(
      "La evidencia de build no está ligada al candidato, árbol y artefacto",
    );
  }
  const expectedIds = new Set(validations.map((validation) => validation.id));
  const seen = new Set<string>();
  for (const entry of value.validations) {
    const validation = asRecord(entry);
    if (validation === null) {
      throw new TypeError(
        "La evidencia de build contiene una validación inválida",
      );
    }
    exactKeys(validation, ["evidence", "id", "status"], "La validación build");
    if (
      typeof validation.id !== "string" ||
      !expectedIds.has(validation.id) ||
      seen.has(validation.id) ||
      validation.status !== "passed" ||
      typeof validation.evidence !== "string" ||
      validation.evidence.length === 0
    ) {
      throw new TypeError("La evidencia de build no conserva sus validaciones");
    }
    seen.add(validation.id);
  }
  if (seen.size !== expectedIds.size) {
    throw new TypeError(
      "La evidencia de build no conserva todas sus validaciones",
    );
  }
}

async function verifyCandidatePublicationEvidence(
  candidate: CandidateManifest,
  attempt: AttemptRecord,
): Promise<void> {
  const record = candidateRecord(candidate);
  const evidenceRoot = await sealedCandidateEvidenceRoot(record);
  const attemptValidations = new Map<string, ValidationResult>();
  for (const validation of attempt.validations) {
    if (attemptValidations.has(validation.id)) {
      throw new TypeError("El intento candidato repite una validación");
    }
    attemptValidations.set(validation.id, validation);
  }
  const preliminary: CandidateManifest["validations"] = [];
  const build: CandidateManifest["validations"] = [];
  const identifiers = new Set<string>();
  for (const validation of candidate.validations) {
    if (identifiers.has(validation.id)) {
      throw new TypeError("El candidato repite una evidencia de validación");
    }
    identifiers.add(validation.id);
    if (validation.evidence === `evidence/preliminary/${validation.id}.json`) {
      preliminary.push(validation);
    } else if (
      validation.evidence === `evidence/candidate-build.json#${validation.id}`
    ) {
      build.push(validation);
    } else {
      throw new TypeError("El candidato referencia una evidencia no permitida");
    }
  }
  if (
    preliminary.length === 0 ||
    build.length === 0 ||
    preliminary.length !== attemptValidations.size
  ) {
    throw new TypeError(
      "El candidato no conserva la evidencia durable completa",
    );
  }
  for (const validation of preliminary) {
    matchedAttemptValidation(attemptValidations, candidate, validation);
    const evidence = await sealedCandidateEvidenceFile(
      evidenceRoot,
      validation.evidence,
    );
    if (evidence.sha256 !== candidateEvidenceSha256(validation)) {
      throw new TypeError("El hash de evidencia candidata no coincide");
    }
    verifyPreliminaryEvidenceBinding(evidence.bytes, candidate, validation);
  }
  const buildEvidence = await sealedCandidateEvidenceFile(
    evidenceRoot,
    "evidence/candidate-build.json",
  );
  for (const validation of build) {
    if (buildEvidence.sha256 !== candidateEvidenceSha256(validation)) {
      throw new TypeError("El hash de evidencia build candidata no coincide");
    }
  }
  verifyCandidateBuildEvidenceBinding(
    buildEvidence.bytes,
    candidate,
    record.candidateTree,
    build,
  );
}

async function readCandidateControllerJson(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    return strictJsonRecord((await readStableRegularFile(path)).bytes, label);
  } catch (error: unknown) {
    if (missingPath(error)) {
      throw new TypeError(`Falta ${label}`);
    }
    throw error;
  }
}

async function candidatePublicationState(
  candidate: CandidateManifest,
): Promise<CandidatePublicationState> {
  const record = candidateRecord(candidate);
  const store = await assertControllerCandidateStore(record.store);
  const paths = await ingestPaths(candidate.changeId, {
    stateRoot: store.stateRoot.path,
  });
  const [
    requestValue,
    planValue,
    persistedCandidate,
    attemptValue,
    gate1Value,
    gate2Value,
  ] = await Promise.all([
    readCandidateControllerJson(paths.request, "La solicitud durable"),
    readCandidateControllerJson(paths.plan, "El plan durable"),
    readCandidateControllerJson(paths.candidate, "El candidato durable"),
    readCandidateControllerJson(
      join(paths.attemptsDir, `${candidate.attemptId}.json`),
      "El intento durable",
    ),
    readCandidateControllerJson(
      join(paths.approvalsDir, "gate-1.json"),
      "La aprobación Gate 1",
    ),
    readCandidateControllerJson(
      join(paths.approvalsDir, "gate-2.json"),
      "La aprobación Gate 2",
    ),
  ]);
  const request = assertNormalizedRequest(requestValue) as NormalizedRequest;
  const plan = validateSchema<ChangePlan>("change-plan", planValue);
  const persisted = validateSchema<CandidateManifest>(
    "candidate",
    persistedCandidate,
  );
  const attempt = validateSchema<AttemptRecord>("attempt", attemptValue);
  const gate1 = validateSchema<ApprovalRecord>("approval", gate1Value);
  const gate2 = validateSchema<ApprovalRecord>("approval", gate2Value);
  if (
    request.changeId !== candidate.changeId ||
    request.inputSha256 !== candidate.requestSha256 ||
    plan.changeId !== candidate.changeId ||
    plan.requestSha256 !== candidate.requestSha256 ||
    plan.planSha256 !== candidate.planSha256 ||
    plan.baselineCommit !== candidate.baselineCommit ||
    canonicalJson(plan.publication) !== canonicalJson(candidate.buildProfile) ||
    canonicalJson(persisted) !== canonicalJson(candidate) ||
    attempt.changeId !== candidate.changeId ||
    attempt.attemptId !== candidate.attemptId ||
    attempt.status !== "validated" ||
    attempt.requestSha256 !== candidate.requestSha256 ||
    attempt.planSha256 !== candidate.planSha256 ||
    attempt.baselineCommit !== candidate.baselineCommit ||
    attempt.validations.length === 0 ||
    attempt.validations.some((validation) => validation.status !== "passed") ||
    candidate.validations.length === 0 ||
    candidate.validations.some((validation) => validation.status !== "passed")
  ) {
    throw new TypeError(
      "El journal candidato no conserva solicitud, plan, intento y evidencia aprobados",
    );
  }
  await verifyCandidatePublicationEvidence(candidate, attempt);
  const state = createStateStore({ stateRoot: store.stateRoot.path });
  const [change, journal] = await Promise.all([
    state.readChange(candidate.changeId),
    state.verifyJournal(candidate.changeId),
  ]);
  if (
    change.state !== "gate2_approved" ||
    change.currentAttemptId !== candidate.attemptId ||
    journal.length === 0 ||
    journal.at(-1)?.to !== "gate2_approved"
  ) {
    throw new TypeError("El journal candidato no llegó a Gate 2 aprobado");
  }
  verifyApproval(gate1, plan, candidate.baselineCommit);
  verifyApproval(gate2, candidate, candidate.baselineCommit);
  const [gate1Provenance, gate2Provenance] = await Promise.all([
    verifyPersistedApprovalProvenance(gate1, {
      stateRoot: store.stateRoot.path,
    }),
    verifyPersistedApprovalProvenance(gate2, {
      stateRoot: store.stateRoot.path,
    }),
  ]);
  if (
    gate1.environment !== gate2.environment ||
    gate1Provenance.environment !== gate1.environment ||
    gate2Provenance.environment !== gate2.environment ||
    gate1Provenance.issuer !== gate2Provenance.issuer
  ) {
    throw new TypeError("Los Gates candidato no comparten procedencia");
  }
  return Object.freeze({
    request,
    plan,
    gate1,
    gate2,
    attempt,
    gate1Provenance,
    gate2Provenance,
  });
}

async function assertCandidateMainBaseline(
  candidate: CandidateManifest,
): Promise<void> {
  const record = candidateRecord(candidate);
  const store = await assertControllerCandidateStore(record.store);
  const [headRef, main, head, status] = await Promise.all([
    runStoreGit(
      store.root.path,
      ["symbolic-ref", "--quiet", "HEAD"],
      "El checkout controlador no está en main",
    ),
    runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      "No se pudo verificar main del controlador",
    ),
    runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "No se pudo verificar HEAD del controlador",
    ),
    runStoreGit(
      store.root.path,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "No se pudo verificar la limpieza del controlador",
    ),
  ]);
  if (
    headRef !== "refs/heads/main" ||
    main !== candidate.baselineCommit ||
    head !== candidate.baselineCommit ||
    status !== ""
  ) {
    throw new TypeError(
      "El checkout controlador no está limpio en el baseline del candidato",
    );
  }
}

function localTestApprovalAllowed(
  capability: CandidateLocalPublicationTestCapability | undefined,
): boolean {
  return (
    process.env.INGEST_TEST_MODE === "true" &&
    capability !== undefined &&
    candidateLocalPublicationTestCapabilities.has(capability)
  );
}

async function assertCandidatePublication(
  candidate: CandidateManifest,
  operation: "local" | "cloudflare" | "promotion",
  testCapability?: CandidateLocalPublicationTestCapability,
  operator?: CandidateOperatorProfile,
): Promise<void> {
  const publication = await candidatePublicationState(candidate);
  const controllerProduction =
    publication.gate1Provenance.issuer === "controller" &&
    publication.gate2Provenance.issuer === "controller" &&
    publication.gate1Provenance.environment === "production" &&
    publication.gate2Provenance.environment === "production";
  const fixtureTest =
    publication.gate1Provenance.issuer === "fixture" &&
    publication.gate2Provenance.issuer === "fixture" &&
    publication.gate1Provenance.environment === "test" &&
    publication.gate2Provenance.environment === "test";
  if (
    !controllerProduction &&
    (operation !== "local" ||
      !fixtureTest ||
      !localTestApprovalAllowed(testCapability))
  ) {
    throw new TypeError(
      "Las aprobaciones de prueba no autorizan Cloudflare, promoción ni main",
    );
  }
  await verifyCandidateArtifact(candidate);
  if (operator !== undefined) {
    await assertCandidateOperatorProfile(candidate, operator);
  }
  await assertCandidateMainBaseline(candidate);
}

/**
 * Revalidates all durable gates before a contained local fixture preview.
 * Test approvals can pass only through the opaque test capability below.
 */
export async function assertCandidateLocalPublication(
  candidate: CandidateManifest,
  testCapability?: CandidateLocalPublicationTestCapability,
  operator?: CandidateOperatorProfile,
): Promise<void> {
  await assertCandidatePublication(
    candidate,
    "local",
    testCapability,
    operator,
  );
}

/** Revalidates all durable gates before a Cloudflare operation. */
export async function assertCandidateCloudflarePublication(
  candidate: CandidateManifest,
  operator?: CandidateOperatorProfile,
): Promise<void> {
  await assertCandidatePublication(
    candidate,
    "cloudflare",
    undefined,
    operator,
  );
}

/** Revalidates all durable gates before a protected main fast-forward. */
export async function assertCandidatePromotion(
  candidate: CandidateManifest,
): Promise<void> {
  await assertCandidatePublication(candidate, "promotion");
}

/** Mints a fixture-only capability; production can never authorize test Gates. */
export function createCandidateLocalPublicationTestCapability(): CandidateLocalPublicationTestCapability {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La capability de publicación local sólo existe en modo de pruebas",
    );
  }
  const capability = Object.freeze(
    {},
  ) as CandidateLocalPublicationTestCapability;
  candidateLocalPublicationTestCapabilities.add(capability);
  return capability;
}

/** Mints a fixture-only token which can only abort one predefined stage. */
export function createCandidatePromotionTestCapability(
  stage: CandidatePromotionFailureStage,
): CandidatePromotionTestCapability {
  if (
    process.env.INGEST_TEST_MODE !== "true" ||
    (stage !== "dossier-write" &&
      stage !== "dossier-add" &&
      stage !== "dossier-commit" &&
      stage !== "protected-main-fast-forward" &&
      stage !== "protected-main-concurrent-advance" &&
      stage !== "protected-main-reattach-before-lease" &&
      stage !== "protected-main-reconcile-dirty")
  ) {
    throw new TypeError(
      "La inspección de promoción sólo existe en modo de pruebas",
    );
  }
  const capability = Object.freeze({}) as CandidatePromotionTestCapability;
  candidatePromotionTestCapabilities.set(capability, stage);
  return capability;
}

function candidatePromotionTestStage(
  capability: CandidatePromotionTestCapability | undefined,
): CandidatePromotionFailureStage | undefined {
  if (capability === undefined) return undefined;
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La inspección de promoción sólo existe en modo de pruebas",
    );
  }
  const configuredStage = candidatePromotionTestCapabilities.get(capability);
  if (configuredStage === undefined) {
    throw new TypeError(
      "La capability de promoción no pertenece al controlador",
    );
  }
  return configuredStage;
}

function induceCandidatePromotionTestFailure(
  capability: CandidatePromotionTestCapability | undefined,
  stage: CandidatePromotionFailureStage,
): void {
  const configuredStage = candidatePromotionTestStage(capability);
  if (configuredStage === stage) {
    throw new TypeError(`La fixture solicitó fallo de promoción: ${stage}`);
  }
}

function missingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const promotionLeaseRaceMarkerName = "promotion-lease-race.test";
const promotionLeaseRaceAcknowledgementName = "promotion-lease-race-ack.test";
const promotionLeaseRaceReady = Buffer.from("ready\n", "utf8");
const promotionLeaseRaceAdvanced = Buffer.from("advanced\n", "utf8");

interface CandidatePromotionLeaseRaceFiles {
  readonly marker: string;
  readonly acknowledgement: string;
}

async function candidatePromotionLeaseRaceFiles(
  candidate: CandidateManifest,
): Promise<CandidatePromotionLeaseRaceFiles> {
  const record = candidateRecord(candidate);
  const store = await assertControllerCandidateStore(record.store);
  const directory = dirname(record.manifestPath);
  const marker = join(directory, promotionLeaseRaceMarkerName);
  const acknowledgement = join(
    directory,
    promotionLeaseRaceAcknowledgementName,
  );
  if (
    !isStrictlyWithin(store.stateRoot.path, directory) ||
    !isStrictlyWithin(directory, marker) ||
    !isStrictlyWithin(directory, acknowledgement)
  ) {
    throw new TypeError("La barrera de lease escapa el estado candidato");
  }
  const entry = await lstat(directory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new TypeError("El estado de lease candidato no es seguro");
  }
  return Object.freeze({ marker, acknowledgement });
}

async function assertCandidatePromotionLeaseRaceAdvanced(
  candidate: CandidateManifest,
  expectedMain: string,
): Promise<void> {
  const record = candidateRecord(candidate);
  const store = await assertControllerCandidateStore(record.store);
  const main = await runStoreGit(
    store.root.path,
    ["rev-parse", "--verify", "refs/heads/main^{commit}"],
    "No se pudo verificar main tras la carrera de lease",
  );
  if (main !== expectedMain) {
    throw new TypeError(
      "La barrera de lease no observó el ref protegido esperado",
    );
  }
}

type CandidatePromotionLeaseBarrierStage =
  | "protected-main-concurrent-advance"
  | "protected-main-reattach-before-lease"
  | "protected-main-reconcile-dirty";

/**
 * A private test barrier only. The opaque token can pause for an independently
 * acting fixture; it never receives or executes Git input.
 */
async function awaitCandidatePromotionLeaseRace(
  capability: CandidatePromotionTestCapability | undefined,
  candidate: CandidateManifest,
  stage: CandidatePromotionLeaseBarrierStage,
  expectedMain: string,
): Promise<void> {
  if (candidatePromotionTestStage(capability) !== stage) {
    return;
  }
  const files = await candidatePromotionLeaseRaceFiles(candidate);
  try {
    await Promise.all([
      rm(files.marker, { force: true }),
      rm(files.acknowledgement, { force: true }),
    ]);
    await writeAtomic(files.marker, promotionLeaseRaceReady);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      let bytes: Buffer;
      try {
        bytes = (await readStableRegularFile(files.acknowledgement, 64)).bytes;
      } catch (error: unknown) {
        if (missingPath(error)) {
          await new Promise<void>((resolveWait) => {
            setTimeout(resolveWait, 10);
          });
          continue;
        }
        throw error;
      }
      if (bytes.equals(promotionLeaseRaceAdvanced)) {
        await assertCandidatePromotionLeaseRaceAdvanced(
          candidate,
          expectedMain,
        );
        return;
      }
      throw new TypeError("La barrera de lease recibió una señal no permitida");
    }
    throw new TypeError(
      "La carrera de lease candidato excedió el tiempo límite",
    );
  } finally {
    await Promise.all([
      rm(files.marker, { force: true }),
      rm(files.acknowledgement, { force: true }),
    ]).catch(() => undefined);
  }
}

async function candidatePublicationEventsPath(
  candidate: CandidateManifest,
): Promise<string> {
  const record = candidateRecord(candidate);
  const store = await assertControllerCandidateStore(record.store);
  const directory = dirname(record.manifestPath);
  const path = join(directory, "publication-events.ndjson");
  if (
    !isStrictlyWithin(store.stateRoot.path, directory) ||
    !isStrictlyWithin(directory, path)
  ) {
    throw new TypeError("El evento de publicación escapa el estado candidato");
  }
  const entry = await lstat(directory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new TypeError("El estado de publicación candidato no es seguro");
  }
  return path;
}

async function verifiedPublicationEvents(path: string): Promise<string> {
  try {
    const source = (await readStableRegularFile(path)).bytes.toString("utf8");
    if (source.length === 0 || !source.endsWith("\n")) {
      throw new TypeError("El registro de publicación está truncado");
    }
    for (const line of source.slice(0, -1).split("\n")) {
      const event = strictJsonRecord(
        Buffer.from(line, "utf8"),
        "El evento de publicación",
      );
      exactKeys(
        event,
        ["at", "schemaVersion", "stage", "status"],
        "El evento de publicación",
      );
      if (
        event.schemaVersion !== 1 ||
        (event.status !== "recoverable-failure" &&
          event.status !== "published-reconciliation-pending") ||
        typeof event.at !== "string" ||
        !Number.isFinite(Date.parse(event.at)) ||
        (event.stage !== "local" &&
          event.stage !== "cloudflare" &&
          event.stage !== "promotion") ||
        (event.status === "published-reconciliation-pending" &&
          event.stage !== "promotion")
      ) {
        throw new TypeError("El evento de publicación no es canónico");
      }
    }
    return source;
  } catch (error: unknown) {
    if (missingPath(error)) return "";
    throw error;
  }
}

type CandidatePublicationEventStatus =
  "recoverable-failure" | "published-reconciliation-pending";

async function recordCandidatePublicationEvent(
  candidate: CandidateManifest,
  stage: "local" | "cloudflare" | "promotion",
  status: CandidatePublicationEventStatus,
): Promise<void> {
  const path = await candidatePublicationEventsPath(candidate);
  const previous = await verifiedPublicationEvents(path);
  const event = canonicalJson({
    schemaVersion: 1,
    at: new Date().toISOString(),
    stage,
    status,
  });
  await writeAtomic(path, Buffer.from(`${previous}${event}\n`, "utf8"));
}

/** Records a recoverable, path-free failure; it never marks a candidate published. */
export async function recordCandidatePublicationFailure(
  candidate: CandidateManifest,
  stage: "local" | "cloudflare" | "promotion",
): Promise<void> {
  await recordCandidatePublicationEvent(
    candidate,
    stage,
    "recoverable-failure",
  );
}

/** Records that main is published while local checkout reconciliation is pending. */
async function recordCandidatePromotionReconciliationPending(
  candidate: CandidateManifest,
): Promise<void> {
  await recordCandidatePublicationEvent(
    candidate,
    "promotion",
    "published-reconciliation-pending",
  );
}

export interface CandidatePromotionResult {
  readonly candidateCommit: string;
  readonly dossierCommit: string;
  /** Main was atomically published; local checkout state is either clean or pending. */
  readonly reconciliation: "complete" | "pending";
}

function expectedDossierPaths(candidate: CandidateManifest): readonly string[] {
  return Object.freeze([
    "approvals/gate-1.json",
    "approvals/gate-2.json",
    `attempts/${candidate.attemptId}.json`,
    "candidate.json",
    "plan.json",
    "request.json",
  ]);
}

/** Checks the fixed dossier destination inside a private trusted worktree. */
async function assertDossierDestinationAvailable(
  root: string,
  candidate: CandidateManifest,
): Promise<void> {
  const changes = join(root, "changes");
  const destination = join(changes, candidate.changeId);
  if (
    !isStrictlyWithin(root, changes) ||
    !isStrictlyWithin(changes, destination)
  ) {
    throw new TypeError(
      "El destino de expediente escapa el checkout controlador",
    );
  }
  let changesEntry: Awaited<ReturnType<typeof lstat>>;
  try {
    changesEntry = await lstat(changes);
  } catch (error: unknown) {
    if (missingPath(error)) return;
    throw error;
  }
  if (
    changesEntry.isSymbolicLink() ||
    !changesEntry.isDirectory() ||
    (await realpath(changes)) !== changes
  ) {
    throw new TypeError("El directorio de expedientes no está disponible");
  }
  try {
    await lstat(destination);
  } catch (error: unknown) {
    if (missingPath(error)) return;
    throw error;
  }
  throw new TypeError("El destino de expediente candidato ya está ocupado");
}

interface PreparedCandidateDossier {
  readonly files: readonly SanitizedDossierFile[];
  readonly expectedPaths: readonly string[];
}

async function prepareCandidateDossier(
  candidate: CandidateManifest,
): Promise<PreparedCandidateDossier> {
  const publication = await candidatePublicationState(candidate);
  const dossier = createSanitizedCandidateDossier({
    request: publication.request,
    plan: publication.plan,
    gate1: publication.gate1,
    gate2: publication.gate2,
    attempt: publication.attempt,
    candidate,
  });
  const expected = [...expectedDossierPaths(candidate)].sort(lexicalCompare);
  const supplied = dossier.files.map((file) => file.path).sort(lexicalCompare);
  if (
    supplied.length !== expected.length ||
    supplied.some((path, index) => path !== expected[index])
  ) {
    throw new TypeError("El expediente candidato no tiene una forma permitida");
  }
  return Object.freeze({
    files: dossier.files,
    expectedPaths: Object.freeze(expected),
  });
}

async function writeCandidateDossier(
  root: string,
  candidate: CandidateManifest,
  dossier: PreparedCandidateDossier,
): Promise<readonly string[]> {
  await assertDossierDestinationAvailable(root, candidate);
  const changes = await createChildDirectory(root, "changes", true);
  const destination = await createChildDirectory(
    changes,
    candidate.changeId,
    false,
  );
  const approvals = await createChildDirectory(destination, "approvals", false);
  const attempts = await createChildDirectory(destination, "attempts", false);
  const targets = new Map<string, string>([
    ["request.json", join(destination, "request.json")],
    ["plan.json", join(destination, "plan.json")],
    ["candidate.json", join(destination, "candidate.json")],
    ["approvals/gate-1.json", join(approvals, "gate-1.json")],
    ["approvals/gate-2.json", join(approvals, "gate-2.json")],
    [
      `attempts/${candidate.attemptId}.json`,
      join(attempts, `${candidate.attemptId}.json`),
    ],
  ]);
  const written: string[] = [];
  for (const file of dossier.files) {
    const target = targets.get(file.path);
    if (
      target === undefined ||
      !isStrictlyWithin(destination, target) ||
      !safeRelativePath(file.path)
    ) {
      throw new TypeError(
        "El expediente candidato intenta escribir una ruta insegura",
      );
    }
    await writeControllerFile(target, Buffer.from(file.contents, "utf8"));
    written.push(`changes/${candidate.changeId}/${file.path}`);
  }
  return Object.freeze(written.sort(lexicalCompare));
}

async function assertCachedDossier(
  root: string,
  expected: readonly string[],
): Promise<void> {
  const cached = (
    await runStoreGit(
      root,
      ["diff", "--cached", "--name-status", "--no-renames"],
      "No se pudo verificar el expediente preparado",
    )
  )
    .split("\n")
    .filter(Boolean)
    .sort(lexicalCompare);
  const expectedCached = expected
    .map((path) => `A\t${path}`)
    .sort(lexicalCompare);
  if (
    cached.length !== expectedCached.length ||
    cached.some((path, index) => path !== expectedCached[index])
  ) {
    throw new TypeError(
      "El commit de expediente contiene archivos no permitidos",
    );
  }
  const [unstaged, untracked] = await Promise.all([
    runStoreGit(
      root,
      ["diff", "--name-status", "--no-renames"],
      "No se pudo verificar el worktree de expediente",
    ),
    runStoreGit(
      root,
      ["ls-files", "--others", "--exclude-standard"],
      "No se pudo verificar archivos no rastreados del expediente",
    ),
  ]);
  if (unstaged !== "" || untracked !== "") {
    throw new TypeError("El worktree de expediente no está limpio");
  }
}

async function assertDossierCommit(
  root: string,
  candidate: CandidateManifest,
  dossierCommit: string,
  dossier: PreparedCandidateDossier,
): Promise<void> {
  const [head, parent, status, changed] = await Promise.all([
    runStoreGit(
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "No se pudo verificar el commit de expediente",
    ),
    runStoreGit(
      root,
      ["rev-parse", "--verify", "HEAD^"],
      "No se pudo verificar el padre del expediente",
    ),
    runStoreGit(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "No se pudo verificar la limpieza del expediente",
    ),
    runStoreGit(
      root,
      [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "--no-renames",
        "-r",
        dossierCommit,
      ],
      "No se pudo verificar el diff del expediente",
    ),
  ]);
  const expected = dossier.expectedPaths
    .map((path) => `A\tchanges/${candidate.changeId}/${path}`)
    .sort(lexicalCompare);
  const actual = changed.split("\n").filter(Boolean).sort(lexicalCompare);
  if (
    head !== dossierCommit ||
    parent !== candidate.candidateCommit ||
    status !== "" ||
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  ) {
    throw new TypeError(
      "El expediente privado no contiene exclusivamente el dossier aprobado",
    );
  }
  for (const file of dossier.files) {
    const blob = await readStoreGitBytes(
      root,
      ["show", `${dossierCommit}:changes/${candidate.changeId}/${file.path}`],
      "No se pudo verificar el contenido del expediente",
    );
    if (!blob.equals(Buffer.from(file.contents, "utf8"))) {
      throw new TypeError("El expediente privado cambió durante el commit");
    }
  }
}

interface PrivateDossierWorktree {
  readonly root: string;
}

async function createPrivateDossierRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-dossier-"));
  const [entry, canonicalRoot, canonicalTemporaryRoot] = await Promise.all([
    lstat(root),
    realpath(root),
    realpath(tmpdir()),
  ]);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    !isStrictlyWithin(canonicalTemporaryRoot, canonicalRoot)
  ) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw new TypeError("No se pudo crear el worktree privado de expediente");
  }
  return canonicalRoot;
}

async function createPrivateDossierWorktree(
  store: ArtifactStoreRecord,
  candidate: CandidateManifest,
): Promise<PrivateDossierWorktree> {
  const root = await createPrivateDossierRoot();
  try {
    await runStorePromotionGit(
      store.root.path,
      ["worktree", "add", "--detach", root, candidate.candidateCommit],
      "No se pudo crear el worktree privado de expediente",
    );
    const [topLevel, head, status] = await Promise.all([
      runStoreGit(
        root,
        ["rev-parse", "--show-toplevel"],
        "No se pudo verificar el worktree privado de expediente",
      ),
      runStoreGit(
        root,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "No se pudo verificar el candidato en el worktree privado",
      ),
      runStoreGit(
        root,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        "No se pudo verificar la limpieza del worktree privado",
      ),
    ]);
    if (
      topLevel !== root ||
      head !== candidate.candidateCommit ||
      status !== ""
    ) {
      throw new TypeError(
        "El worktree privado no está fijado en el candidato A",
      );
    }
    return Object.freeze({ root });
  } catch (error: unknown) {
    await runStorePromotionGit(
      store.root.path,
      ["worktree", "remove", "--force", root],
      "No se pudo retirar el worktree privado de expediente",
    ).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function removePrivateDossierWorktree(
  store: ArtifactStoreRecord,
  worktree: PrivateDossierWorktree,
): Promise<void> {
  await runStorePromotionGit(
    store.root.path,
    ["worktree", "remove", "--force", worktree.root],
    "No se pudo retirar el worktree privado de expediente",
  );
}

/** The only pre-publication mutation of refs/heads/main: an explicit CAS. */
async function advanceProtectedMainWithLease(
  store: ArtifactStoreRecord,
  candidate: CandidateManifest,
  dossierCommit: string,
): Promise<void> {
  await runStorePromotionGit(
    store.root.path,
    ["update-ref", "refs/heads/main", dossierCommit, candidate.baselineCommit],
    "No se pudo adquirir el lease baseline de main para el expediente",
  );
}

/** Verifies reconciliation left attached main, HEAD, index and worktree at B. */
async function assertControllerMainAtDossier(
  store: ArtifactStoreRecord,
  candidate: CandidateManifest,
  dossierCommit: string,
): Promise<void> {
  const [headRef, main, head, parent, status] = await Promise.all([
    runStoreGit(
      store.root.path,
      ["symbolic-ref", "--quiet", "HEAD"],
      "No se pudo verificar HEAD tras adquirir el lease",
    ),
    runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      "No se pudo verificar main tras adquirir el lease",
    ),
    runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "No se pudo verificar HEAD tras adquirir el lease",
    ),
    runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "HEAD^"],
      "No se pudo verificar el padre de main tras adquirir el lease",
    ),
    runStoreGit(
      store.root.path,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "No se pudo verificar la limpieza de main tras adquirir el lease",
    ),
  ]);
  if (
    headRef !== "refs/heads/main" ||
    main !== dossierCommit ||
    head !== dossierCommit ||
    parent !== candidate.candidateCommit ||
    status !== ""
  ) {
    throw new TypeError(
      "El lease protegido no dejó main limpio en la cadena A a B",
    );
  }
}

/**
 * After CAS, transition from the known clean baseline to B with non-forced
 * detached checkouts only. B was already published by the CAS; these local
 * operations cannot publish it. If concurrent work or a ref race prevents
 * reconciliation, preserve it and report pending instead of rolling back.
 */
async function publishedControllerReconciliation(
  store: ArtifactStoreRecord,
  candidate: CandidateManifest,
  dossierCommit: string,
): Promise<"complete" | "pending"> {
  try {
    const mainBefore = await runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      "No se pudo verificar main publicado antes de reconciliar",
    );
    if (mainBefore !== dossierCommit) return "pending";
    await runStorePromotionGit(
      store.root.path,
      ["checkout", "--detach", "--quiet", candidate.baselineCommit],
      "No se pudo volver al baseline para reconciliar main publicado",
    );
    await runStorePromotionGit(
      store.root.path,
      ["checkout", "--detach", "--quiet", dossierCommit],
      "No se pudo avanzar el checkout a main publicado",
    );
    const mainAfter = await runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      "No se pudo revalidar main publicado antes de reenganchar HEAD",
    );
    if (mainAfter !== dossierCommit) return "pending";
    await runStorePromotionGit(
      store.root.path,
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      "No se pudo reenganchar HEAD al main publicado",
    );
    await assertControllerMainAtDossier(store, candidate, dossierCommit);
    return "complete";
  } catch {
    return "pending";
  }
}

/** A non-forced lost-lease recovery preserves concurrent work. */
async function restoreControllerMainCheckout(
  store: ArtifactStoreRecord,
  candidate: CandidateManifest,
): Promise<void> {
  const mainBefore = await runStoreGit(
    store.root.path,
    ["rev-parse", "--verify", "refs/heads/main^{commit}"],
    "No se pudo leer main tras perder el lease",
  );
  await runStorePromotionGit(
    store.root.path,
    ["checkout", "--detach", "--quiet", candidate.baselineCommit],
    "No se pudo preparar la recuperación sin descartar cambios",
  );
  await runStorePromotionGit(
    store.root.path,
    ["checkout", "--detach", "--quiet", mainBefore],
    "No se pudo seguir main tras perder el lease sin descartar cambios",
  );
  const mainAfter = await runStoreGit(
    store.root.path,
    ["rev-parse", "--verify", "refs/heads/main^{commit}"],
    "No se pudo revalidar main tras perder el lease",
  );
  if (mainAfter !== mainBefore) {
    throw new TypeError("main cambió durante la recuperación del lease");
  }
  await runStorePromotionGit(
    store.root.path,
    ["symbolic-ref", "HEAD", "refs/heads/main"],
    "No se pudo reenganchar el checkout controlador sin descartar cambios",
  );
  const [headRef, main, head] = await Promise.all([
    runStoreGit(
      store.root.path,
      ["symbolic-ref", "--quiet", "HEAD"],
      "No se pudo verificar HEAD tras restaurar main",
    ),
    runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      "No se pudo verificar main tras restaurar el checkout",
    ),
    runStoreGit(
      store.root.path,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "No se pudo verificar HEAD tras restaurar el checkout",
    ),
  ]);
  if (headRef !== "refs/heads/main" || main !== head) {
    throw new TypeError("El checkout controlador no volvió a seguir main");
  }
}

/**
 * Commits fixed sanitized dossier B in an isolated worktree based on candidate
 * A, verifies the complete B, then atomically leases protected main from the
 * baseline to B. Protected main is therefore never left at A alone.
 */
export async function promoteCandidateWithDossier(
  candidate: CandidateManifest,
  testCapability?: CandidatePromotionTestCapability,
): Promise<CandidatePromotionResult> {
  await assertCandidatePromotion(candidate);
  const record = candidateRecord(candidate);
  const store = await assertControllerCandidateStore(record.store);
  await verifyCandidateArtifact(candidate);
  await assertCandidateMainBaseline(candidate);
  const dossier = await prepareCandidateDossier(candidate);
  const worktree = await createPrivateDossierWorktree(store, candidate);
  let leaseAttempted = false;
  let mainPublished = false;
  try {
    induceCandidatePromotionTestFailure(testCapability, "dossier-write");
    const files = await writeCandidateDossier(
      worktree.root,
      candidate,
      dossier,
    );
    induceCandidatePromotionTestFailure(testCapability, "dossier-add");
    await runStorePromotionGit(
      worktree.root,
      ["add", "--", `changes/${candidate.changeId}`],
      "No se pudo preparar el expediente candidato",
    );
    await assertCachedDossier(worktree.root, files);
    induceCandidatePromotionTestFailure(testCapability, "dossier-commit");
    await runStorePromotionGit(
      worktree.root,
      ["commit", "--no-verify", "-m", `docs: dossier ${candidate.changeId}`],
      "No se pudo confirmar el expediente candidato",
    );
    const dossierCommit = await runStoreGit(
      worktree.root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "No se pudo verificar el commit privado de expediente",
    );
    await assertDossierCommit(worktree.root, candidate, dossierCommit, dossier);

    // B remains private until the fixed ref CAS below. No controller checkout
    // operation occurs before it, so only the lease can publish B.
    await assertCandidateMainBaseline(candidate);
    induceCandidatePromotionTestFailure(
      testCapability,
      "protected-main-fast-forward",
    );
    await awaitCandidatePromotionLeaseRace(
      testCapability,
      candidate,
      "protected-main-reattach-before-lease",
      candidate.baselineCommit,
    );
    await awaitCandidatePromotionLeaseRace(
      testCapability,
      candidate,
      "protected-main-concurrent-advance",
      candidate.candidateCommit,
    );
    leaseAttempted = true;
    await advanceProtectedMainWithLease(store, candidate, dossierCommit);
    mainPublished = true;
    let reconciliation: "complete" | "pending" = "pending";
    try {
      await awaitCandidatePromotionLeaseRace(
        testCapability,
        candidate,
        "protected-main-reconcile-dirty",
        dossierCommit,
      );
      reconciliation = await publishedControllerReconciliation(
        store,
        candidate,
        dossierCommit,
      );
    } catch {
      // B is already protected-main history. Never turn a later local error
      // into a recoverable unpublished result or overwrite concurrent work.
      reconciliation = "pending";
    }
    if (reconciliation === "pending") {
      await recordCandidatePromotionReconciliationPending(candidate).catch(
        () => undefined,
      );
    }
    return Object.freeze({
      candidateCommit: candidate.candidateCommit,
      dossierCommit,
      reconciliation,
    });
  } finally {
    if (leaseAttempted && !mainPublished) {
      await restoreControllerMainCheckout(store, candidate).catch(
        () => undefined,
      );
    }
    await removePrivateDossierWorktree(store, worktree).catch(() => undefined);
  }
}

/**
 * Mints a test controller seam. Production has no preview adapter until the
 * separately reviewed Task 12 integration supplies one, so it fails closed.
 */
export function createCandidatePreviewTestCapability(
  adapter: CandidatePreviewAdapter,
): CandidatePreviewTestCapability {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La capability de preview candidato sólo existe en modo de pruebas",
    );
  }
  if (typeof adapter !== "function") {
    throw new TypeError("El adaptador de preview candidato no es válido");
  }
  const capability = Object.freeze({}) as CandidatePreviewTestCapability;
  candidatePreviewCapabilities.set(capability, adapter);
  return capability;
}

function previewAssertion(
  candidate: CandidateManifest,
): PreviewAssertionDescriptor {
  return Object.freeze({
    publisher: "local",
    candidateCommit: candidate.candidateCommit,
    artifactSha256: candidate.artifactSha256,
    sealedBundle: true,
    fixedLocalArguments: true,
    localOnly: true,
  });
}

async function localWranglerPath(
  store: ControllerCandidateStore,
): Promise<string> {
  const record = await assertControllerCandidateStore(store);
  const root = record.root.path;
  const nodeModules = join(root, "node_modules");
  const bin = join(nodeModules, ".bin");
  const executable = join(bin, "wrangler");
  if (
    !isStrictlyWithin(root, nodeModules) ||
    !isStrictlyWithin(root, bin) ||
    !isStrictlyWithin(root, executable)
  ) {
    throw new TypeError("El ejecutable de preview escapa el store controlador");
  }
  const [nodeModulesEntry, binEntry, executableEntry] = await Promise.all([
    lstat(nodeModules),
    lstat(bin),
    lstat(executable),
  ]);
  if (
    nodeModulesEntry.isSymbolicLink() ||
    !nodeModulesEntry.isDirectory() ||
    binEntry.isSymbolicLink() ||
    !binEntry.isDirectory() ||
    executableEntry.isSymbolicLink() ||
    !executableEntry.isFile() ||
    executableEntry.nlink !== 1 ||
    (await realpath(nodeModules)) !== nodeModules ||
    (await realpath(bin)) !== bin ||
    (await realpath(executable)) !== executable
  ) {
    throw new TypeError(
      "El ejecutable de preview no pertenece al store seguro",
    );
  }
  await access(executable, constants.X_OK);
  await assertControllerCandidateStore(store);
  return executable;
}

function fixedPreviewEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: "/tmp",
    LANG: "C",
    LC_ALL: "C",
    CI: "true",
    NO_COLOR: "1",
  });
}

async function fixedPreviewInvocation(
  candidate: CandidateManifest,
): Promise<FixedPreviewInvocation> {
  await verifyCandidateArtifact(candidate);
  const record = candidateRecord(candidate);
  const worker = join(record.bundlePath, "dist", "_worker.js", "index.js");
  const assets = join(
    record.bundlePath,
    ...record.configuration.assetsRelativePath.split("/"),
  );
  const config = join(
    record.bundlePath,
    ...record.configuration.primaryConfigRelativePath.split("/"),
  );
  for (const path of [worker, assets, config]) {
    if (!isStrictlyWithin(record.bundlePath, path)) {
      throw new TypeError("El preview candidato escapa el bundle verificado");
    }
  }
  const executable = await localWranglerPath(record.store);
  return Object.freeze({
    executable,
    argv: Object.freeze([
      executable,
      "dev",
      worker,
      "--no-bundle",
      "--assets",
      assets,
      "--config",
      config,
      "--local",
    ]),
    cwd: record.bundlePath,
    env: fixedPreviewEnvironment(),
  });
}

function fixedCloudflareEnvironment(
  environment: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...fixedPreviewEnvironment(),
    CLOUDFLARE_ENV: environment,
  });
}

async function fixedCloudflareDryRunInvocation(
  candidate: CandidateManifest,
): Promise<FixedCloudflareInvocation> {
  await verifyCandidateArtifact(candidate);
  if (
    candidate.buildProfile.adapter !== "cloudflare" ||
    typeof candidate.buildProfile.environment !== "string" ||
    candidate.buildProfile.environment.length === 0
  ) {
    throw new TypeError(
      "El candidato no tiene un perfil Cloudflare publicable",
    );
  }
  const record = candidateRecord(candidate);
  const executable = await localWranglerPath(record.store);
  return Object.freeze({
    executable,
    argv: Object.freeze([
      executable,
      "deploy",
      "--no-bundle",
      "--strict",
      "--message",
      `candidate:${candidate.changeId}:${candidate.artifactSha256}`,
      "--dry-run",
    ]),
    cwd: record.bundlePath,
    env: fixedCloudflareEnvironment(candidate.buildProfile.environment),
  });
}

function cloudflareDryRunAssertion(
  candidate: CandidateManifest,
): CloudflareDryRunAssertionDescriptor {
  return Object.freeze({
    publisher: "cloudflare",
    dryRun: true,
    changeId: candidate.changeId,
    artifactSha256: candidate.artifactSha256,
    sealedRedirect: true,
    fixedDeployArguments: true,
    targetEnvironmentBound: true,
  });
}

/** Mints a test-only observer for the already fixed, non-executing dry-run. */
export function createCandidateCloudflareDryRunTestCapability(
  observer: (descriptor: CloudflareDryRunAssertionDescriptor) => Promise<void>,
): CandidateCloudflareDryRunTestCapability {
  if (
    process.env.INGEST_TEST_MODE !== "true" ||
    typeof observer !== "function"
  ) {
    throw new TypeError(
      "La inspección Cloudflare sólo existe en modo de pruebas",
    );
  }
  const capability = Object.freeze(
    {},
  ) as CandidateCloudflareDryRunTestCapability;
  candidateCloudflareDryRunTestCapabilities.set(capability, observer);
  return capability;
}

/**
 * Inspects only a reverified fixed dry-run. It never starts Wrangler and the
 * observer receives semantic assertions, never process control or paths.
 */
export async function inspectCandidateCloudflareDryRun(
  candidate: CandidateManifest,
  capability: CandidateCloudflareDryRunTestCapability,
  operator: CandidateOperatorProfile,
): Promise<void> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La inspección Cloudflare sólo existe en modo de pruebas",
    );
  }
  const observer = candidateCloudflareDryRunTestCapabilities.get(capability);
  if (observer === undefined) {
    throw new TypeError("La capability Cloudflare no pertenece al controlador");
  }
  await assertCandidateCloudflarePublication(candidate, operator);
  await fixedCloudflareDryRunInvocation(candidate);
  await observer(cloudflareDryRunAssertion(candidate));
}

async function runFixedCloudflareDryRun(
  invocation: FixedCloudflareInvocation,
): Promise<void> {
  const child = spawn(invocation.executable, invocation.argv.slice(1), {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: false,
    stdio: "ignore",
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminateTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 1_000);
  }, 5_000);
  const exitCode = await gitExitCode(child).finally(() => {
    clearTimeout(terminateTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  });
  if (timedOut || exitCode !== 0) {
    throw new TypeError(
      "El dry-run Cloudflare fijado no terminó correctamente",
    );
  }
}

/**
 * Runs only the exact local dry-run invocation after a second sealed
 * verification. This path is test-only until Task 12 supplies a trusted CLI
 * capability for real operations.
 */
export async function runCandidateCloudflareDryRun(
  candidate: CandidateManifest,
  capability: CandidateCloudflareDryRunTestCapability,
  operator: CandidateOperatorProfile,
): Promise<void> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("El dry-run Cloudflare sólo existe en modo de pruebas");
  }
  const observer = candidateCloudflareDryRunTestCapabilities.get(capability);
  if (observer === undefined) {
    throw new TypeError("La capability Cloudflare no pertenece al controlador");
  }
  await assertCandidateCloudflarePublication(candidate, operator);
  await observer(cloudflareDryRunAssertion(candidate));
  await assertCandidateCloudflarePublication(candidate, operator);
  await runFixedCloudflareDryRun(
    await fixedCloudflareDryRunInvocation(candidate),
  );
}

function localPreviewUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("El preview candidato no devolvió una URL válida");
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("El preview candidato debe escuchar sólo en local");
  }
  return parsed.toString();
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 25);
    });
  }
  return true;
}

async function stopProcessGroup(pid: number): Promise<void> {
  if (!processGroupExists(pid)) return;
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, 1_500)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, 1_500))) {
    throw new TypeError("No se pudo detener el grupo de preview candidato");
  }
}

/**
 * Starts only a reverified copied bundle. The private candidate record is
 * frozen and no exported callback can substitute its cwd/configuration.
 */
export async function startCandidatePreview(
  candidate: CandidateManifest,
): Promise<PreviewHandle> {
  await verifyCandidateArtifact(candidate);
  const record = candidateRecord(candidate);
  if (candidatePreviewPids.has(candidate)) {
    throw new TypeError("El candidato ya tiene un preview en ejecución");
  }
  if (record.previewCapability === undefined) {
    throw new TypeError(
      "No existe una capability de preview candidato confiable",
    );
  }
  const adapter = candidatePreviewCapabilities.get(record.previewCapability);
  if (adapter === undefined) {
    throw new TypeError("La capability de preview no pertenece al controlador");
  }
  await fixedPreviewInvocation(candidate);
  const launch = await adapter(previewAssertion(candidate));
  const launchPid = launch.child.pid;
  if (
    typeof launchPid !== "number" ||
    !Number.isSafeInteger(launchPid) ||
    launchPid <= 0 ||
    launch.child.exitCode !== null
  ) {
    if (
      typeof launchPid === "number" &&
      Number.isSafeInteger(launchPid) &&
      launchPid > 0
    ) {
      await stopProcessGroup(launchPid).catch(() => undefined);
    }
    throw new TypeError("El preview candidato no creó un proceso válido");
  }
  const pid = launchPid;
  let url: string;
  try {
    url = localPreviewUrl(launch.url);
  } catch (error: unknown) {
    await stopProcessGroup(pid).catch(() => undefined);
    throw error;
  }
  candidatePreviewPids.set(candidate, pid);

  let stopped = false;
  return Object.freeze({
    url,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        await stopProcessGroup(pid);
      } finally {
        candidatePreviewPids.delete(candidate);
      }
    },
  });
}
