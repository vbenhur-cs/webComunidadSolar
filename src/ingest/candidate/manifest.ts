import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import type {
  CandidateManifest,
  ChangePlan,
  ValidationResult,
} from "../domain.ts";
import { validateSchema } from "../schema-validator.ts";
import { assertCandidateEligiblePreliminaryValidation } from "../validation/runner.ts";
import {
  assertControllerCandidateStoreOutput,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";

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
} from "./evidence.ts";
import { hashTree } from "./tree-digest.ts";

const changeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/u;
const attemptIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,63})$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const artifactMaximumBytes = 128 * 1024 * 1024;
const artifactMaximumFiles = 10_000;
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

declare const controllerCandidateStoreBrand: unique symbol;
export interface ControllerCandidateStore {
  readonly [controllerCandidateStoreBrand]: true;
}

declare const controllerCandidateStoreTestInitializationBrand: unique symbol;
export interface ControllerCandidateStoreTestInitialization {
  readonly [controllerCandidateStoreTestInitializationBrand]: true;
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
}

/** Private preview state; it never crosses the candidate module boundary. */
interface CandidatePreviewRecord {
  readonly store: ControllerCandidateStore;
  readonly attemptId: string;
  readonly bundlePath: string;
  readonly manifestPath: string;
  readonly configuration: CandidateBundleConfiguration;
  readonly previewCapability: CandidatePreviewTestCapability | undefined;
}

export interface FixedPreviewInvocation {
  /** The fixed controller-local Wrangler executable; never caller supplied. */
  readonly executable: string;
  /** Includes the executable as argv[0] so fixture assertions see exact argv. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface PreviewHandle {
  readonly url: string;
  stop(): Promise<void>;
}

interface PreviewLaunch {
  readonly child: ChildProcess;
  readonly url: string;
}

type CandidatePreviewAdapter = (
  invocation: FixedPreviewInvocation,
) => Promise<PreviewLaunch>;

/** A fixture-only capability; callers can never provide process arguments. */
declare const candidatePreviewTestCapabilityBrand: unique symbol;
export interface CandidatePreviewTestCapability {
  readonly [candidatePreviewTestCapabilityBrand]: true;
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
  readonly artifactSha256: string;
  readonly candidateRef: string;
  readonly bundle: string;
  readonly manifest: string;
}

const controllerCandidateStores = new WeakMap<
  ControllerCandidateStore,
  ArtifactStoreRecord
>();
const controllerCandidateStoreTestInitializations = new WeakMap<
  ControllerCandidateStoreTestInitialization,
  string
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

/** Test-only trusted initialization for an isolated controller repository. */
export async function createControllerCandidateStoreTestInitialization(
  repositoryRoot: string,
): Promise<ControllerCandidateStoreTestInitialization> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La inicialización de store candidato sólo existe en modo de pruebas",
    );
  }
  const root = await controllerRepositoryRoot(repositoryRoot);
  const initialization = Object.freeze(
    {},
  ) as ControllerCandidateStoreTestInitialization;
  controllerCandidateStoreTestInitializations.set(initialization, root);
  return initialization;
}

/**
 * Opens controller-owned persistent candidate state. Production resolves only
 * the trusted controller startup directory; test initialization is opaque.
 */
export async function openControllerCandidateStore(
  testInitialization?: ControllerCandidateStoreTestInitialization,
): Promise<ControllerCandidateStore> {
  if (testInitialization === undefined) {
    return await openStoreAtRoot(process.cwd());
  }
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "El store candidato no acepta inicialización de pruebas",
    );
  }
  const root =
    controllerCandidateStoreTestInitializations.get(testInitialization);
  if (root === undefined) {
    throw new TypeError(
      "La inicialización de store no pertenece al controlador",
    );
  }
  return await openStoreAtRoot(root);
}

/** Releases only in-memory store authority; durable state deliberately remains. */
export async function releaseControllerCandidateStore(
  store: ControllerCandidateStore,
): Promise<void> {
  await assertControllerCandidateStore(store);
  controllerCandidateStores.delete(store);
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
    artifactSha256: "",
    candidateRef: `refs/comunidadsolar/candidates/${plan.changeId}/${attemptId}`,
    bundle: `.artifacts/candidates/${plan.changeId}/${attemptId}/bundle`,
    manifest: `.change-state/${plan.changeId}/candidates/${attemptId}/candidate.json`,
  });
}

function durableCandidateProvenance(
  candidate: CandidateManifest,
): DurableCandidateProvenance {
  const locations = durableCandidateLocations(
    { changeId: candidate.changeId },
    candidate.attemptId,
  );
  return Object.freeze({
    ...locations,
    candidateCommit: candidate.candidateCommit,
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

async function copyRegularFile(
  source: string,
  destination: string,
  remainingBytes: number,
): Promise<CandidateArtifactEntry> {
  const sourceFile = await readStableRegularFile(source, remainingBytes);
  const destinationHandle = await open(
    destination,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    (sourceFile.mode & 0o111) === 0 ? 0o644 : 0o755,
  );
  try {
    let offset = 0;
    while (offset < sourceFile.bytes.byteLength) {
      const written = await destinationHandle.write(
        sourceFile.bytes,
        offset,
        sourceFile.bytes.byteLength - offset,
        null,
      );
      if (written.bytesWritten === 0) {
        throw new TypeError("No se pudo completar la copia del artefacto");
      }
      offset += written.bytesWritten;
    }
  } finally {
    await destinationHandle.close();
  }
  await chmod(destination, (sourceFile.mode & 0o111) === 0 ? 0o644 : 0o755);
  const copied = await readStableRegularFile(destination, remainingBytes);
  if (
    copied.bytes.byteLength !== sourceFile.bytes.byteLength ||
    copied.sha256 !== sourceFile.sha256
  ) {
    throw new TypeError("La copia del artefacto no coincide con su fuente");
  }
  return Object.freeze({
    path: destination,
    sha256: copied.sha256,
    bytes: copied.bytes.byteLength,
  });
}

async function copyArtifactTree(
  sourceRoot: string,
  destinationRoot: string,
  relativePath = "",
  state: { bytes: number; files: number } = { bytes: 0, files: 0 },
): Promise<CandidateArtifactEntry[]> {
  const sourceDirectory =
    relativePath === ""
      ? sourceRoot
      : join(sourceRoot, ...relativePath.split("/"));
  const destinationDirectory =
    relativePath === ""
      ? destinationRoot
      : join(destinationRoot, ...relativePath.split("/"));
  const entry = await lstat(sourceDirectory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError("El dist candidato contiene un directorio inseguro");
  }
  if (relativePath !== "") {
    await mkdir(destinationDirectory, { mode: 0o700 });
  }
  const handle = await opendir(sourceDirectory);
  const names: string[] = [];
  for await (const child of handle) {
    if (!safeName(child.name)) {
      throw new TypeError("El dist candidato contiene una ruta no segura");
    }
    names.push(child.name);
  }
  names.sort(lexicalCompare);
  const files: CandidateArtifactEntry[] = [];
  for (const name of names) {
    const childRelative =
      relativePath === "" ? name : `${relativePath}/${name}`;
    const source = join(sourceRoot, ...childRelative.split("/"));
    const destination = join(destinationRoot, ...childRelative.split("/"));
    if (
      !isWithin(sourceRoot, source) ||
      !isWithin(destinationRoot, destination)
    ) {
      throw new TypeError("El dist candidato escapa su raíz");
    }
    const child = await lstat(source);
    if (child.isSymbolicLink()) {
      throw new TypeError("El dist candidato contiene un enlace simbólico");
    }
    if (child.isDirectory()) {
      files.push(
        ...(await copyArtifactTree(
          sourceRoot,
          destinationRoot,
          childRelative,
          state,
        )),
      );
      continue;
    }
    if (!child.isFile() || child.nlink !== 1) {
      throw new TypeError(
        "El dist candidato contiene un archivo especial o hardlink",
      );
    }
    state.files += 1;
    if (
      state.files > artifactMaximumFiles ||
      child.size > artifactMaximumBytes - state.bytes
    ) {
      throw new TypeError("El dist candidato excede los límites de artefacto");
    }
    const copied = await copyRegularFile(
      source,
      destination,
      artifactMaximumBytes - state.bytes,
    );
    state.bytes += copied.bytes;
    files.push(
      Object.freeze({
        path: childRelative,
        sha256: copied.sha256,
        bytes: copied.bytes,
      }),
    );
  }
  return files;
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
}> {
  const configPath = join(root, ...relativeConfigPath.split("/"));
  const config = strictJsonRecord(
    (await readStableRegularFile(configPath)).bytes,
    "El config aplanado",
  );
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
  return Object.freeze({
    workerRelativePath: relative(root, workerPath).split(sep).join("/"),
    assetsRelativePath: relative(root, assetsPath).split(sep).join("/"),
  });
}

export async function readCandidateBundleConfiguration(
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
      }
    | undefined;
  for (const configPath of configRelativePaths) {
    const verified = await validateFlattenedConfig(
      root,
      configPath,
      plan,
      configPath === primaryConfigRelativePath,
    );
    if (configPath === primaryConfigRelativePath) primary = verified;
  }
  if (primary === undefined) {
    throw new TypeError(
      "El redirect de deploy no conserva un config principal",
    );
  }
  return Object.freeze({
    redirectRelativePath: fixedDeployRedirectPath,
    primaryConfigRelativePath,
    workerRelativePath: primary.workerRelativePath,
    assetsRelativePath: primary.assetsRelativePath,
    configRelativePaths: Object.freeze(configRelativePaths),
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
    await writeControllerFile(destination, source.bytes);
    persisted.push(
      Object.freeze({
        id: validation.id,
        status: "passed" as const,
        evidence: `evidence/preliminary/${fileName}`,
      }),
    );
  }
  return Object.freeze(persisted);
}

async function persistCandidateBuildEvidence(
  evidence: CandidateBoundBuildEvidence,
  evidencePath: string,
): Promise<
  readonly {
    readonly id: string;
    readonly status: "passed";
    readonly evidence: string;
  }[]
> {
  const path = join(evidencePath, "candidate-build.json");
  const bytes = Buffer.from(
    `${canonicalCandidateBuildEvidence(evidence)}\n`,
    "utf8",
  );
  await writeControllerFile(path, bytes);
  const validations = evidence.validations.map((validation) =>
    Object.freeze({
      id: validation.id,
      status: "passed" as const,
      evidence: `evidence/candidate-build.json#${validation.id}`,
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

export async function copyCandidateBundle(
  checkoutPath: string,
  bundlePath: string,
): Promise<readonly CandidateArtifactEntry[]> {
  const sourceDist = join(checkoutPath, "dist");
  const destinationDist = join(bundlePath, "dist");
  const sourceDeploy = join(
    checkoutPath,
    ...fixedDeployRedirectPath.split("/"),
  );
  const destinationDeploy = join(
    bundlePath,
    ...fixedDeployRedirectPath.split("/"),
  );
  const deployParent = dirname(destinationDeploy);
  await Promise.all([
    mkdir(destinationDist, { mode: 0o700 }),
    mkdir(deployParent, { recursive: true, mode: 0o700 }),
  ]);
  const copiedDist = (await copyArtifactTree(sourceDist, destinationDist)).map(
    (file) =>
      Object.freeze({
        ...file,
        path: `dist/${file.path}`,
      }),
  );
  const copiedDeploy = await copyRegularFile(
    sourceDeploy,
    destinationDeploy,
    artifactMaximumBytes -
      copiedDist.reduce((sum, file) => sum + file.bytes, 0),
  );
  return Object.freeze(
    [
      ...copiedDist,
      Object.freeze({
        path: fixedDeployRedirectPath,
        sha256: copiedDeploy.sha256,
        bytes: copiedDeploy.bytes,
      }),
    ].sort((left, right) => lexicalCompare(left.path, right.path)),
  );
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
  const storeRecord = await assertControllerCandidateStore(input.store);
  await assertControllerCandidateStoreOutput(
    input.output,
    input.plan,
    input.attemptId,
    storeRecord.root.path,
  );
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
      directories.bundlePath,
    );
    const copiedArtifacts = capturedBuild.copiedArtifacts;
    const copiedConfiguration = capturedBuild.copiedConfiguration;
    const artifactSha256 = await hashTree(directories.bundlePath);
    const preliminaryValidations = await persistPreliminaryEvidence(
      preliminary,
      directories.evidencePath,
    );
    const buildValidations = await persistCandidateBuildEvidence(
      buildEvidence,
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
        `${canonicalJson(durableCandidateProvenance(manifest))}\n`,
        "utf8",
      ),
    );
    await persistCandidateCommit(candidateCommit, input.plan, input.attemptId);
    candidateRecords.set(
      manifest,
      Object.freeze({
        store: input.store,
        attemptId: input.attemptId,
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
): void {
  exactKeys(
    value,
    [
      "artifactSha256",
      "attemptId",
      "bundle",
      "candidateCommit",
      "candidateRef",
      "changeId",
      "manifest",
      "schemaVersion",
    ],
    "La procedencia durable candidata",
  );
  const expected = durableCandidateProvenance(candidate);
  if (
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    value.attemptId !== attemptId ||
    value.candidateCommit !== candidate.candidateCommit ||
    value.artifactSha256 !== candidate.artifactSha256 ||
    value.candidateRef !== expected.candidateRef ||
    value.bundle !== expected.bundle ||
    value.manifest !== expected.manifest
  ) {
    throw new TypeError("La procedencia durable no coincide con el candidato");
  }
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
): Promise<void> {
  if (
    !candidateCommitPattern.test(candidate.candidateCommit) ||
    !candidateCommitPattern.test(candidate.baselineCommit)
  ) {
    throw new TypeError("El commit durable candidato no es válido");
  }
  const record = await assertControllerCandidateStore(store);
  const locations = durableCandidateLocations(
    { changeId: candidate.changeId },
    candidate.attemptId,
  );
  const [resolved, parent, object] = await Promise.all([
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
      ["cat-file", "-e", `${candidate.candidateCommit}^{commit}`],
      "El commit candidato durable no existe",
    ),
  ]);
  if (
    resolved !== candidate.candidateCommit ||
    parent !== candidate.baselineCommit ||
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
  verifiedDurableProvenance(
    strictJsonRecord(provenanceFile.bytes, "La procedencia durable candidata"),
    manifest,
    input.changeId,
    input.attemptId,
  );
  await assertDurableCandidateStoreCommit(store, manifest);
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
  await assertDurableCandidateStoreCommit(record.store, candidate);
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

function localWranglerPath(): string {
  return resolve(process.cwd(), "node_modules", ".bin", "wrangler");
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
  const executable = localWranglerPath();
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
  const invocation = await fixedPreviewInvocation(candidate);
  const launch = await adapter(invocation);
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

declare const candidateTestInspectionCapabilityBrand: unique symbol;
export interface CandidateTestInspectionCapability {
  readonly [candidateTestInspectionCapabilityBrand]: true;
}

const candidateTestInspectionCapabilities =
  new WeakSet<CandidateTestInspectionCapability>();

/** Mints the sole test-only inspection authority; production cannot mint it. */
export function createCandidateTestInspectionCapability(): CandidateTestInspectionCapability {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La inspección candidata sólo existe en modo de pruebas",
    );
  }
  const capability = Object.freeze({}) as CandidateTestInspectionCapability;
  candidateTestInspectionCapabilities.add(capability);
  return capability;
}

/** Test-only snapshot; it is a copy and cannot mutate preview state. */
export function candidateTestInspection(
  capability: CandidateTestInspectionCapability,
  candidate: CandidateManifest,
): {
  readonly bundlePath: string;
  readonly manifestPath: string;
  readonly previewPid: number | undefined;
} {
  if (
    process.env.INGEST_TEST_MODE !== "true" ||
    !candidateTestInspectionCapabilities.has(capability)
  ) {
    throw new TypeError(
      "La inspección candidata no pertenece al controlador de pruebas",
    );
  }
  const record = candidateRecord(candidate);
  return Object.freeze({
    bundlePath: record.bundlePath,
    manifestPath: record.manifestPath,
    previewPid: candidatePreviewPids.get(candidate),
  });
}
