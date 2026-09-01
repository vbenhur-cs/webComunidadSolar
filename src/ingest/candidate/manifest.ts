import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import type {
  CandidateManifest,
  ChangePlan,
  ValidationResult,
} from "../domain.ts";
import { validateSchema } from "../schema-validator.ts";
import { assertCandidateEligiblePreliminaryValidation } from "../validation/runner.ts";
import type { StagedAgentOutput } from "../workspaces/policy.ts";

import {
  createCandidateCommit,
  removeCandidateCommit,
  withCandidateCommitCheckout,
  type CandidateCommit,
} from "./commit.ts";
import {
  canonicalCandidateBuildEvidence,
  runCandidateBoundBuild,
  type CandidateBuildTestCapability,
  type CandidateBoundBuildEvidence,
} from "./evidence.ts";
import { hashTree } from "./tree-digest.ts";
import type { CandidatePreviewTestCapability } from "./preview.ts";

const changeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/u;
const attemptIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,63})$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const artifactMaximumBytes = 128 * 1024 * 1024;
const artifactMaximumFiles = 10_000;
const fixedDeployRedirectPath = ".wrangler/deploy/config.json";
const fixedWorkerRelativePath = "dist/_worker.js/index.js";

declare const candidateArtifactStoreBrand: unique symbol;
export interface CandidateArtifactStore {
  readonly [candidateArtifactStoreBrand]: true;
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

interface ArtifactEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface BundleConfiguration {
  readonly redirectRelativePath: string;
  readonly primaryConfigRelativePath: string;
  readonly workerRelativePath: string;
  readonly assetsRelativePath: string;
  readonly configRelativePaths: readonly string[];
}

/** @internal Private record consumed only by the Task 10 preview controller. */
export interface CandidatePreviewRecord {
  readonly store: CandidateArtifactStore;
  readonly bundlePath: string;
  readonly manifestPath: string;
  readonly configuration: BundleConfiguration;
  readonly previewCapability: CandidatePreviewTestCapability | undefined;
  previewPid: number | undefined;
}

export interface CandidateCreationInput {
  readonly output: StagedAgentOutput;
  readonly plan: ChangePlan;
  readonly attemptId: string;
  /** Exact frozen array minted by Task 9; copied or supplied evidence rejects. */
  readonly preliminaryValidations: readonly ValidationResult[];
  /** Opaque controller artifact state; callers never select a bundle path. */
  readonly artifactStore: CandidateArtifactStore;
  /** Opaque fixture/controller capability; a missing production adapter fails closed. */
  readonly buildCapability?: CandidateBuildTestCapability;
  /** Optional opaque fixture preview capability retained privately with the candidate. */
  readonly previewCapability?: CandidatePreviewTestCapability;
}

const artifactStores = new WeakMap<
  CandidateArtifactStore,
  ArtifactStoreRecord
>();
const candidateRecords = new WeakMap<
  CandidateManifest,
  CandidatePreviewRecord
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

function artifactStoreRecord(
  store: CandidateArtifactStore,
): ArtifactStoreRecord {
  const record = artifactStores.get(store);
  if (record === undefined) {
    throw new TypeError("El store de artefactos no pertenece al controlador");
  }
  return record;
}

async function assertArtifactStore(
  store: CandidateArtifactStore,
): Promise<ArtifactStoreRecord> {
  const record = artifactStoreRecord(store);
  await Promise.all([
    assertDirectory(record.root),
    assertDirectory(record.artifactRoot),
    assertDirectory(record.stateRoot),
  ]);
  if (
    !isStrictlyWithin(record.root.path, record.artifactRoot.path) ||
    !isStrictlyWithin(record.root.path, record.stateRoot.path)
  ) {
    throw new TypeError("El store de artefactos escapa su estado controlador");
  }
  return record;
}

/** Creates a private controller state root; no caller supplies a filesystem path. */
export async function createCandidateArtifactStore(): Promise<CandidateArtifactStore> {
  let rootPath: string | undefined;
  try {
    rootPath = await realpath(
      await mkdtemp(join(tmpdir(), "comunidadsolar-candidate-state-")),
    );
    const artifactPath = join(rootPath, ".artifacts");
    const statePath = join(rootPath, ".change-state");
    await Promise.all([
      mkdir(artifactPath, { mode: 0o700 }),
      mkdir(statePath, { mode: 0o700 }),
    ]);
    const [rootEntry, artifactEntry, stateEntry] = await Promise.all([
      lstat(rootPath),
      lstat(artifactPath),
      lstat(statePath),
    ]);
    const canonicalArtifactPath = await realpath(artifactPath);
    const canonicalStatePath = await realpath(statePath);
    if (
      canonicalArtifactPath !== artifactPath ||
      canonicalStatePath !== statePath ||
      rootEntry.isSymbolicLink() ||
      !rootEntry.isDirectory() ||
      artifactEntry.isSymbolicLink() ||
      !artifactEntry.isDirectory() ||
      stateEntry.isSymbolicLink() ||
      !stateEntry.isDirectory()
    ) {
      throw new TypeError("No se pudo crear un estado candidato privado");
    }
    const store = Object.freeze({}) as CandidateArtifactStore;
    artifactStores.set(
      store,
      Object.freeze({
        root: directoryIdentity(rootPath, rootEntry),
        artifactRoot: directoryIdentity(artifactPath, artifactEntry),
        stateRoot: directoryIdentity(statePath, stateEntry),
      }),
    );
    return store;
  } catch (error: unknown) {
    if (rootPath !== undefined) {
      await rm(rootPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

export async function removeCandidateArtifactStore(
  store: CandidateArtifactStore,
): Promise<void> {
  const record = await assertArtifactStore(store);
  await rm(record.root.path, { recursive: true, force: false });
  artifactStores.delete(store);
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
  store: CandidateArtifactStore,
  plan: ChangePlan,
  attemptId: string,
): Promise<{
  readonly artifactCandidatePath: string;
  readonly bundlePath: string;
  readonly stateCandidatePath: string;
  readonly evidencePath: string;
}> {
  const record = await assertArtifactStore(store);
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
): Promise<ArtifactEntry> {
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
): Promise<ArtifactEntry[]> {
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
  const files: ArtifactEntry[] = [];
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

async function readBundleConfiguration(
  rootInput: string,
  plan: Pick<ChangePlan, "publication">,
): Promise<BundleConfiguration> {
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

async function copyCandidateArtifacts(
  checkoutPath: string,
  bundlePath: string,
): Promise<readonly ArtifactEntry[]> {
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
  files: readonly ArtifactEntry[],
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
  await assertArtifactStore(input.artifactStore);
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
    let sourceConfiguration: BundleConfiguration | undefined;
    await withCandidateCommitCheckout(
      candidateCommit,
      input.plan,
      input.attemptId,
      async (checkoutPath) => {
        sourceConfiguration = await readBundleConfiguration(
          checkoutPath,
          input.plan,
        );
      },
    );
    if (sourceConfiguration === undefined) {
      throw new TypeError(
        "El build candidato no produjo una configuración de deploy",
      );
    }
    const directories = await candidateDirectories(
      input.artifactStore,
      input.plan,
      input.attemptId,
    );
    artifactCandidatePath = directories.artifactCandidatePath;
    stateCandidatePath = directories.stateCandidatePath;
    let copiedArtifacts: readonly ArtifactEntry[] | undefined;
    await withCandidateCommitCheckout(
      candidateCommit,
      input.plan,
      input.attemptId,
      async (checkoutPath) => {
        copiedArtifacts = await copyCandidateArtifacts(
          checkoutPath,
          directories.bundlePath,
        );
      },
    );
    if (copiedArtifacts === undefined) {
      throw new TypeError("No se pudo copiar el bundle candidato");
    }
    const copiedConfiguration = await readBundleConfiguration(
      directories.bundlePath,
      input.plan,
    );
    if (
      canonicalJson(copiedConfiguration) !== canonicalJson(sourceConfiguration)
    ) {
      throw new TypeError(
        "La configuración copiada no coincide con el build candidato",
      );
    }
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
    candidateRecords.set(manifest, {
      store: input.artifactStore,
      bundlePath: directories.bundlePath,
      manifestPath,
      configuration: copiedConfiguration,
      previewCapability: input.previewCapability,
      previewPid: undefined,
    });
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

/** Rehashes the exact private bundle before any Gate 2 or preview consumer. */
export async function verifyCandidateArtifact(
  candidate: CandidateManifest,
): Promise<void> {
  const record = candidateRecord(candidate);
  await assertArtifactStore(record.store);
  const digest = await hashTree(record.bundlePath);
  if (digest !== candidate.artifactSha256) {
    throw new TypeError("El digest no coincide con el artefacto candidato");
  }
  await readBundleConfiguration(record.bundlePath, {
    publication: candidate.buildProfile,
  });
}

/** @internal Preview consumes the private record without exposing a bundle path. */
export function candidateRecordForPreview(
  candidate: CandidateManifest,
): CandidatePreviewRecord {
  return candidateRecord(candidate);
}

/** @internal Records the child pid only for controller cleanup and test inspection. */
export function setCandidatePreviewPid(
  candidate: CandidateManifest,
  pid: number | undefined,
): void {
  candidateRecord(candidate).previewPid = pid;
}

/** Test-only inspection; production callers never receive artifact paths. */
export function candidateTestInspection(candidate: CandidateManifest): {
  readonly bundlePath: string;
  readonly previewPid: number | undefined;
} {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La inspección candidata sólo existe en modo de pruebas",
    );
  }
  const record = candidateRecord(candidate);
  return Object.freeze({
    bundlePath: record.bundlePath,
    previewPid: record.previewPid,
  });
}
