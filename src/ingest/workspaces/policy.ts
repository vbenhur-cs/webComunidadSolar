import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import type { ChangePlan } from "../domain.ts";
import {
  AGENT_ACCEPTED_OUTPUT_MAX_BYTES,
  AGENT_ACCEPTED_OUTPUT_MAX_FILES,
  AGENT_IO_CHUNK_BYTES,
  AGENT_WORKSPACE_ENTRY_MAX_COUNT,
  AGENT_WORKSPACE_FILE_MAX_BYTES,
  AGENT_WORKSPACE_FILE_MAX_COUNT,
  AGENT_WORKSPACE_TOTAL_MAX_BYTES,
} from "../limits.ts";
import {
  assertTrustedRepositoriesUnchanged,
  assertWorkspaceInputs,
  workspaceManifest,
  type AgentWorkspace,
  type ManifestEntry,
} from "./service.ts";

const gitExecutable = "/usr/bin/git";
const tarExecutable = "/usr/bin/tar";
const privateInputDirectory = ".agent-input";
const privateOutputDirectory = ".agent-output";
const packageManifests = Object.freeze(["package.json", "package-lock.json"]);
const fixedEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});
const fixedGitEnvironment = Object.freeze({
  ...fixedEnvironment,
  GIT_CONFIG: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
const fixedGitArguments = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
]);

export interface StagedAgentOutput {
  readonly path: string;
  readonly files: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
}

interface StagedOutputRecord {
  readonly root: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly baselineCommit: string;
  readonly attemptId: string;
  readonly changeId: string;
  readonly planSha256: string;
  readonly planCanonical: string;
  readonly rootIdentity: { readonly device: number; readonly inode: number };
  readonly pathIdentity: { readonly device: number; readonly inode: number };
}

const stagedOutputRecords = new WeakMap<
  StagedAgentOutput,
  StagedOutputRecord
>();

/** Opaque, controller-minted copy used only as a command execution directory. */
export interface ControllerExecutionCopy {
  readonly path: string;
}

export interface ControllerExecutionIntegrity {
  readonly outputSha256: Readonly<Record<string, string>>;
  readonly sha256: string;
}

interface ExecutionCopyRecord {
  readonly root: string;
  readonly path: string;
  readonly output: StagedAgentOutput;
  readonly attemptId: string;
  readonly planCanonical: string;
  readonly outputSha256: Readonly<Record<string, string>>;
  readonly rootIdentity: { readonly device: number; readonly inode: number };
  readonly pathIdentity: { readonly device: number; readonly inode: number };
}

const executionCopyRecords = new WeakMap<
  ControllerExecutionCopy,
  ExecutionCopyRecord
>();

/**
 * Opaque controller checkout used only while creating one candidate commit.
 * Its Git path and source repository never leave the controller capability.
 */
declare const controllerCandidateCheckoutBrand: unique symbol;
export interface ControllerCandidateCheckout {
  readonly [controllerCandidateCheckoutBrand]: true;
}

interface CandidateCheckoutRecord {
  readonly root: string;
  readonly path: string;
  readonly output: StagedAgentOutput;
  readonly attemptId: string;
  readonly planCanonical: string;
  readonly baselineCommit: string;
  readonly outputSha256: Readonly<Record<string, string>>;
  readonly rootIdentity: { readonly device: number; readonly inode: number };
  readonly pathIdentity: { readonly device: number; readonly inode: number };
}

const candidateCheckoutRecords = new WeakMap<
  ControllerCandidateCheckout,
  CandidateCheckoutRecord
>();

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isSameOrWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

async function createControllerStaging(
  workspacePath: string,
  repositoryRoot: string,
  baselineCommit: string,
  attemptId: string,
  changeId: string,
  planSha256: string,
  planCanonical: string,
): Promise<StagedOutputRecord> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "comunidadsolar-agent-staging-")),
  );
  try {
    const path = await realpath(await mkdtemp(join(root, "output-")));
    const canonicalWorkspace = await realpath(workspacePath);
    if (
      isSameOrWithin(root, canonicalWorkspace) ||
      isSameOrWithin(canonicalWorkspace, root)
    ) {
      throw new TypeError(
        "El staging controlador debe estar separado del workspace del agente",
      );
    }
    const [rootEntry, pathEntry] = await Promise.all([
      lstat(root),
      lstat(path),
    ]);
    return Object.freeze({
      root,
      path,
      repositoryRoot,
      baselineCommit,
      attemptId,
      changeId,
      planSha256,
      planCanonical,
      rootIdentity: Object.freeze({
        device: rootEntry.dev,
        inode: rootEntry.ino,
      }),
      pathIdentity: Object.freeze({
        device: pathEntry.dev,
        inode: pathEntry.ino,
      }),
    });
  } catch (error: unknown) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function stagedOutputRecord(output: StagedAgentOutput): StagedOutputRecord {
  const record = stagedOutputRecords.get(output);
  if (!record) {
    throw new TypeError("El staging no pertenece a este controlador");
  }
  return record;
}

async function assertStagedOutputLocation(
  record: StagedOutputRecord,
): Promise<void> {
  const [rootEntry, pathEntry] = await Promise.all([
    lstat(record.root),
    lstat(record.path),
  ]);
  if (
    dirname(record.path) !== record.root ||
    (await realpath(record.root)) !== record.root ||
    (await realpath(record.path)) !== record.path ||
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    rootEntry.dev !== record.rootIdentity.device ||
    rootEntry.ino !== record.rootIdentity.inode ||
    pathEntry.isSymbolicLink() ||
    !pathEntry.isDirectory() ||
    pathEntry.dev !== record.pathIdentity.device ||
    pathEntry.ino !== record.pathIdentity.inode
  ) {
    throw new TypeError("La identidad canónica del staging cambió");
  }
}

function validateRelativePath(path: string): void {
  const segments = path.split(/[\\/]/u);
  if (
    path === "" ||
    isAbsolute(path) ||
    path.includes("\\") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0"),
    )
  ) {
    throw new TypeError("El plan contiene un path de salida no seguro");
  }
}

function collect(child: ChildProcess, stream: "stdout" | "stderr"): Buffer[] {
  const chunks: Buffer[] = [];
  child[stream]?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return chunks;
}

async function exitCode(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

async function exportBaseline(
  repositoryRoot: string,
  baselineCommit: string,
  destination: string,
): Promise<void> {
  const archive = spawn(
    gitExecutable,
    [
      ...fixedGitArguments,
      "-C",
      repositoryRoot,
      "archive",
      "--format=tar",
      baselineCommit,
    ],
    {
      env: fixedGitEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const extract = spawn(tarExecutable, ["-xf", "-", "-C", destination], {
    env: fixedEnvironment,
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const archiveError = collect(archive, "stderr");
  const extractError = collect(extract, "stderr");
  extract.stdin?.on("error", () => undefined);
  archive.stdout?.pipe(extract.stdin!);
  const [archiveCode, extractCode] = await Promise.all([
    exitCode(archive),
    exitCode(extract),
  ]);
  if (archiveCode !== 0 || extractCode !== 0) {
    const details = Buffer.concat([...archiveError, ...extractError])
      .toString("utf8")
      .trim();
    throw new TypeError(`No se pudo exportar el staging limpio: ${details}`);
  }
}

function forbiddenExportSegment(segment: string): boolean {
  return (
    segment === ".git" ||
    segment === ".change-state" ||
    segment === privateInputDirectory ||
    segment === privateOutputDirectory ||
    segment === ".agent-worktrees" ||
    segment === ".agent-quarantine" ||
    segment === ".artifacts" ||
    segment === ".source-work" ||
    segment === ".wrangler" ||
    segment === ".env" ||
    segment.startsWith(".env.") ||
    segment === ".dev.vars" ||
    segment === ".npmrc" ||
    segment === "wrangler.toml" ||
    segment === "wrangler.json" ||
    segment === "wrangler.jsonc"
  );
}

async function stripOperationalFiles(
  root: string,
  current = "",
): Promise<void> {
  const directory = current === "" ? root : join(root, ...current.split("/"));
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const path = join(directory, name);
    if (forbiddenExportSegment(name)) {
      await rm(path, { recursive: true, force: false });
      continue;
    }
    const entry = await lstat(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await stripOperationalFiles(
        root,
        current === "" ? name : `${current}/${name}`,
      );
    }
  }
}

async function captureManifest(
  root: string,
): Promise<ReadonlyMap<string, ManifestEntry>> {
  const entries = new Map<string, ManifestEntry>();
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  async function regularFileDigest(
    path: string,
  ): Promise<{ bytes: number; sha256: string }> {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1) {
        throw new TypeError("El staging contiene un hardlink inseguro");
      }
      if (entry.size > AGENT_WORKSPACE_FILE_MAX_BYTES) {
        throw new TypeError("El staging excede el límite por archivo");
      }
      if (entry.size > AGENT_WORKSPACE_TOTAL_MAX_BYTES - totalBytes) {
        throw new TypeError("El staging excede el límite total de bytes");
      }
      const digest = createHash("sha256");
      let bytes = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(AGENT_IO_CHUNK_BYTES);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          null,
        );
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (
          bytes > AGENT_WORKSPACE_FILE_MAX_BYTES ||
          bytes > AGENT_WORKSPACE_TOTAL_MAX_BYTES - totalBytes
        ) {
          throw new TypeError("El staging excede el límite total de bytes");
        }
        digest.update(buffer.subarray(0, bytesRead));
      }
      if (bytes !== entry.size) {
        throw new TypeError("El staging cambió durante la lectura");
      }
      return { bytes, sha256: digest.digest("hex") };
    } finally {
      await handle.close();
    }
  }

  async function visit(relativeDirectory: string): Promise<void> {
    const directory =
      relativeDirectory === ""
        ? root
        : join(root, ...relativeDirectory.split("/"));
    const handle = await opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) {
      entryCount += 1;
      if (entryCount > AGENT_WORKSPACE_ENTRY_MAX_COUNT) {
        throw new TypeError(
          "El staging excede el límite de cantidad de entradas",
        );
      }
      names.push(entry.name);
    }
    names.sort();
    for (const name of names) {
      const path =
        relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      validateRelativePath(path);
      if (forbiddenExportSegment(name)) {
        throw new TypeError("El staging contiene estado operativo prohibido");
      }
      const absolute = join(root, ...path.split("/"));
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        throw new TypeError("El staging contiene un enlace simbólico");
      }
      const mode = entry.mode & 0o7777;
      if (entry.isDirectory()) {
        entries.set(path, { kind: "directory", mode, bytes: 0, sha256: null });
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new TypeError("El staging contiene un archivo especial");
      }
      if (entry.nlink !== 1) {
        throw new TypeError("El staging contiene un hardlink inseguro");
      }
      fileCount += 1;
      if (fileCount > AGENT_WORKSPACE_FILE_MAX_COUNT) {
        throw new TypeError(
          "El staging excede el límite de cantidad de archivos",
        );
      }
      const file = await regularFileDigest(absolute);
      totalBytes += file.bytes;
      entries.set(path, {
        kind: "file",
        mode,
        bytes: file.bytes,
        sha256: file.sha256,
      });
    }
  }

  await visit("");
  return entries;
}

function sameEntry(left: ManifestEntry, right: ManifestEntry): boolean {
  return (
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

function assertSameManifest(
  actual: ReadonlyMap<string, ManifestEntry>,
  expected: ReadonlyMap<string, ManifestEntry>,
): void {
  if (actual.size !== expected.size) {
    throw new TypeError("El staging limpio no coincide con el baseline");
  }
  for (const [path, expectedEntry] of expected) {
    const actualEntry = actual.get(path);
    if (!actualEntry || !sameEntry(actualEntry, expectedEntry)) {
      throw new TypeError("El staging limpio no coincide con el baseline");
    }
  }
}

async function assertApprovedPlan(
  workspace: AgentWorkspace,
  plan: ChangePlan,
): Promise<void> {
  if (
    plan.changeId !== workspace.changeId ||
    plan.baselineCommit !== workspace.baselineCommit
  ) {
    throw new TypeError("El plan aprobado no corresponde al workspace");
  }
  for (const file of plan.files) validateRelativePath(file.path);
  let copiedPlan: unknown;
  try {
    copiedPlan = JSON.parse(await readFile(workspace.planPath, "utf8"));
  } catch {
    throw new TypeError(
      "El plan copiado del workspace no contiene JSON válido",
    );
  }
  if (canonicalJson(copiedPlan) !== canonicalJson(plan)) {
    throw new TypeError("El plan aprobado no corresponde al workspace");
  }
}

async function assertPrivateOutputDirectory(
  workspace: AgentWorkspace,
): Promise<void> {
  const outputDirectory = join(workspace.path, privateOutputDirectory);
  try {
    const entry = await lstat(outputDirectory);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (await realpath(outputDirectory)) !== outputDirectory
    ) {
      throw new TypeError(
        "El workspace no conserva un directorio privado de salida seguro",
      );
    }
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(
      "El workspace no conserva un directorio privado de salida seguro",
      { cause: error },
    );
  }
}

function safeDescendant(root: string, path: string): boolean {
  return path.startsWith(`${root}/`);
}

function generatedRoots(plan: ChangePlan): string[] {
  const planned = new Set(plan.files.map((file) => file.path));
  return [
    `src/components/generated/${plan.changeId}`,
    `public/generated/${plan.changeId}`,
  ].filter((root) => planned.has(root));
}

function outputAllowed(path: string, plan: ChangePlan): boolean {
  const planned = new Set(plan.files.map((file) => file.path));
  if (packageManifests.includes(path)) {
    return (
      plan.dependencies.length > 0 &&
      packageManifests.every((manifest) => planned.has(manifest))
    );
  }
  if (planned.has(path)) return true;
  return generatedRoots(plan).some((root) => safeDescendant(root, path));
}

function generatedDirectoryAllowed(path: string, plan: ChangePlan): boolean {
  return generatedRoots(plan).some(
    (root) => path === root || safeDescendant(root, path),
  );
}

function changedOutputFiles(
  current: ReadonlyMap<string, ManifestEntry>,
  baseline: ReadonlyMap<string, ManifestEntry>,
  plan: ChangePlan,
): string[] {
  const changedFiles: string[] = [];
  const changedDirectories: Array<{ path: string; created: boolean }> = [];

  for (const [path, baselineEntry] of baseline) {
    const currentEntry = current.get(path);
    if (!currentEntry) {
      throw new TypeError(`El path ${path} del baseline fue eliminado`);
    }
    if (currentEntry.kind !== baselineEntry.kind) {
      throw new TypeError(`El tipo del path ${path} cambió en el workspace`);
    }
    if (!sameEntry(currentEntry, baselineEntry)) {
      if (currentEntry.kind === "file") changedFiles.push(path);
      else changedDirectories.push({ path, created: false });
    }
  }

  for (const [path, entry] of current) {
    if (baseline.has(path)) continue;
    if (entry.kind === "file") changedFiles.push(path);
    else changedDirectories.push({ path, created: true });
  }

  const uniqueFiles = [...new Set(changedFiles)].sort();
  if (uniqueFiles.length > AGENT_ACCEPTED_OUTPUT_MAX_FILES) {
    throw new TypeError(
      "La salida aceptada excede el límite de cantidad de archivos",
    );
  }
  let acceptedBytes = 0;
  for (const path of uniqueFiles) {
    if (!outputAllowed(path, plan)) {
      throw new TypeError(
        `El path ${path} no aprobado fue modificado por el agente`,
      );
    }
    const entry = current.get(path);
    if (!entry || entry.kind !== "file") {
      throw new TypeError(
        "El inventario aceptado no contiene un archivo regular",
      );
    }
    acceptedBytes += entry.bytes;
    if (acceptedBytes > AGENT_ACCEPTED_OUTPUT_MAX_BYTES) {
      throw new TypeError("La salida aceptada excede el límite total de bytes");
    }
  }
  for (const directory of changedDirectories) {
    const supportsAcceptedFile = uniqueFiles.some((path) =>
      safeDescendant(directory.path, path),
    );
    if (
      (!directory.created || !supportsAcceptedFile) &&
      !generatedDirectoryAllowed(directory.path, plan)
    ) {
      throw new TypeError(
        `El directorio ${directory.path} no aprobado cambió en el workspace`,
      );
    }
  }
  return uniqueFiles;
}

async function regularFileDigest(
  path: string,
  maximumBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new TypeError("La salida aceptada no es un archivo regular seguro");
    }
    if (entry.size > maximumBytes) {
      throw new TypeError("La salida aceptada excede el límite permitido");
    }
    const digest = createHash("sha256");
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(AGENT_IO_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maximumBytes) {
        throw new TypeError("La salida aceptada excede el límite permitido");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (bytes !== entry.size) {
      throw new TypeError("La salida aceptada cambió durante la lectura");
    }
    return { bytes, sha256: digest.digest("hex") };
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("La salida aceptada no es un archivo regular seguro", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function copyAcceptedFile(
  sourceRoot: string,
  stagingPath: string,
  path: string,
  expected: ManifestEntry,
  remainingBytes: number,
): Promise<string> {
  const source = join(sourceRoot, ...path.split("/"));
  const destination = join(stagingPath, ...path.split("/"));
  if (
    expected.kind !== "file" ||
    expected.bytes > AGENT_WORKSPACE_FILE_MAX_BYTES ||
    expected.bytes > remainingBytes
  ) {
    throw new TypeError("La salida aceptada excede el límite permitido");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let destinationExists = true;
  try {
    const entry = await lstat(destination);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw new TypeError("El destino del staging no es un archivo regular");
    }
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
    destinationExists = false;
  }
  const flags = destinationExists
    ? constants.O_WRONLY | constants.O_TRUNC | noFollow
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  try {
    const sourceEntry = await sourceHandle.stat();
    if (
      !sourceEntry.isFile() ||
      sourceEntry.nlink !== 1 ||
      sourceEntry.size !== expected.bytes
    ) {
      throw new TypeError("La salida aceptada cambió durante la copia");
    }
    const destinationHandle = await open(destination, flags, 0o600);
    try {
      const destinationEntry = await destinationHandle.stat();
      if (!destinationEntry.isFile() || destinationEntry.nlink !== 1) {
        throw new TypeError("El destino del staging no es un archivo regular");
      }
      const sourceDigest = createHash("sha256");
      let copiedBytes = 0;
      while (true) {
        const sourceBuffer = Buffer.allocUnsafe(AGENT_IO_CHUNK_BYTES);
        const { bytesRead } = await sourceHandle.read(
          sourceBuffer,
          0,
          sourceBuffer.byteLength,
          null,
        );
        if (bytesRead === 0) break;
        copiedBytes += bytesRead;
        if (
          copiedBytes > expected.bytes ||
          copiedBytes > remainingBytes ||
          copiedBytes > AGENT_WORKSPACE_FILE_MAX_BYTES
        ) {
          throw new TypeError("La salida aceptada excede el límite permitido");
        }
        const copiedBuffer = Buffer.from(sourceBuffer.subarray(0, bytesRead));
        sourceDigest.update(copiedBuffer);
        let written = 0;
        while (written < copiedBuffer.byteLength) {
          const result = await destinationHandle.write(
            copiedBuffer,
            written,
            copiedBuffer.byteLength - written,
            null,
          );
          if (result.bytesWritten === 0) {
            throw new TypeError("No se pudo completar la copia al staging");
          }
          written += result.bytesWritten;
        }
      }
      if (copiedBytes !== expected.bytes) {
        throw new TypeError("La salida aceptada cambió durante la copia");
      }
      const acceptedHash = sourceDigest.digest("hex");
      if (acceptedHash !== expected.sha256) {
        throw new TypeError("La salida aceptada cambió durante la copia");
      }
      const copied = await regularFileDigest(destination, expected.bytes);
      if (copied.bytes !== expected.bytes || copied.sha256 !== acceptedHash) {
        throw new TypeError(
          "El hash del staging no coincide con la salida aceptada",
        );
      }
      return acceptedHash;
    } finally {
      await destinationHandle.close();
    }
  } finally {
    await sourceHandle.close();
  }
}

export async function validateAgentWorkspaceOutput(
  workspace: AgentWorkspace,
  plan: ChangePlan,
): Promise<StagedAgentOutput> {
  await assertWorkspaceInputs(workspace);
  await assertPrivateOutputDirectory(workspace);
  await assertApprovedPlan(workspace, plan);
  const current = await workspaceManifest(workspace);
  const files = changedOutputFiles(current, workspace.baselineManifest, plan);
  let staging: StagedOutputRecord | undefined;
  try {
    staging = await createControllerStaging(
      workspace.path,
      workspace.repositoryRoot,
      workspace.baselineCommit,
      workspace.attemptId,
      plan.changeId,
      plan.planSha256,
      canonicalJson(plan),
    );
    const stagingPath = staging.path;
    await exportBaseline(
      workspace.repositoryRoot,
      workspace.baselineCommit,
      stagingPath,
    );
    await stripOperationalFiles(stagingPath);
    assertSameManifest(
      await captureManifest(stagingPath),
      workspace.baselineManifest,
    );
    const hashes = new Map<string, string>();
    let copiedBytes = 0;
    for (const path of files) {
      const expected = current.get(path);
      if (!expected || expected.kind !== "file") {
        throw new TypeError("El inventario aceptado cambió durante el handoff");
      }
      hashes.set(
        path,
        await copyAcceptedFile(
          workspace.path,
          stagingPath,
          path,
          expected,
          AGENT_ACCEPTED_OUTPUT_MAX_BYTES - copiedBytes,
        ),
      );
      copiedBytes += expected.bytes;
    }
    await assertWorkspaceInputs(workspace);
    await assertPrivateOutputDirectory(workspace);
    await assertTrustedRepositoriesUnchanged(workspace);
    const output: StagedAgentOutput = Object.freeze({
      path: stagingPath,
      files: Object.freeze([...files]),
      sha256: Object.freeze(Object.fromEntries(hashes)),
    });
    stagedOutputRecords.set(output, staging);
    return output;
  } catch (error: unknown) {
    if (staging !== undefined) {
      await rm(staging.root, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function assertControllerStagedOutputForAttempt(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string | undefined,
): Promise<void> {
  const record = stagedOutputRecord(output);
  if (
    output.path !== record.path ||
    plan.changeId !== record.changeId ||
    plan.baselineCommit !== record.baselineCommit ||
    plan.planSha256 !== record.planSha256 ||
    canonicalJson(plan) !== record.planCanonical
  ) {
    throw new TypeError(
      "El path o plan no coincide con el staging controlador",
    );
  }
  if (attemptId !== undefined && attemptId !== record.attemptId) {
    throw new TypeError("El intento no coincide con el staging controlador");
  }
  await assertStagedOutputLocation(record);
}

/** Proves that a staging handoff was minted by this controller instance. */
export async function assertControllerStagedOutput(
  output: StagedAgentOutput,
  plan: ChangePlan,
): Promise<void> {
  await assertControllerStagedOutputForAttempt(output, plan, undefined);
}

/** Binds one minted staged output to its exact plan and workspace attempt. */
export async function assertControllerStagedOutputAttempt(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<void> {
  await assertControllerStagedOutputForAttempt(output, plan, attemptId);
}

/**
 * Binds a Phase 3 controller profile source to the exact repository that
 * minted this staged output without exposing repository authority to callers.
 */
export async function assertControllerStagedRepository(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
  repositoryRoot: string,
): Promise<void> {
  await assertControllerStagedOutputAttempt(output, plan, attemptId);
  const record = stagedOutputRecord(output);
  if (record.repositoryRoot !== repositoryRoot) {
    throw new TypeError(
      "El proyecto del perfil no coincide con el staging del controlador",
    );
  }
}

function exactOutputPaths(output: StagedAgentOutput): readonly string[] {
  const paths = [...output.files].sort();
  if (
    paths.length !== output.files.length ||
    new Set(paths).size !== paths.length ||
    Object.keys(output.sha256).sort().join("\0") !== paths.join("\0")
  ) {
    throw new TypeError("El inventario del staging no conserva forma exacta");
  }
  for (const path of paths) {
    validateRelativePath(path);
    if (!/^[a-f0-9]{64}$/u.test(output.sha256[path] ?? "")) {
      throw new TypeError(
        "El inventario del staging contiene un hash inválido",
      );
    }
  }
  return Object.freeze(paths);
}

async function verifiedStagedOutputHashes(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<Readonly<Record<string, string>>> {
  await assertControllerStagedOutputAttempt(output, plan, attemptId);
  const hashes: Record<string, string> = {};
  let remainingBytes = AGENT_ACCEPTED_OUTPUT_MAX_BYTES;
  for (const path of exactOutputPaths(output)) {
    const expected = output.sha256[path]!;
    const file = await regularFileDigest(
      join(output.path, ...path.split("/")),
      remainingBytes,
    );
    if (file.sha256 !== expected || file.bytes > remainingBytes) {
      throw new TypeError(
        "El archivo de staging ya no coincide con su inventario aprobado",
      );
    }
    remainingBytes -= file.bytes;
    hashes[path] = file.sha256;
  }
  await assertControllerStagedOutputAttempt(output, plan, attemptId);
  return Object.freeze(hashes);
}

function outputHashesDigest(hashes: Readonly<Record<string, string>>): string {
  const digest = createHash("sha256");
  for (const path of Object.keys(hashes).sort()) {
    digest.update(path, "utf8");
    digest.update("\0", "utf8");
    digest.update(hashes[path]!, "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

function executionCopyRecord(
  copy: ControllerExecutionCopy,
): ExecutionCopyRecord {
  const record = executionCopyRecords.get(copy);
  if (record === undefined || copy.path !== record.path) {
    throw new TypeError("La copia de ejecución no pertenece al controlador");
  }
  return record;
}

async function assertExecutionCopyLocation(
  record: ExecutionCopyRecord,
): Promise<void> {
  const [rootEntry, pathEntry] = await Promise.all([
    lstat(record.root),
    lstat(record.path),
  ]);
  if (
    dirname(record.path) !== record.root ||
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    rootEntry.dev !== record.rootIdentity.device ||
    rootEntry.ino !== record.rootIdentity.inode ||
    pathEntry.isSymbolicLink() ||
    !pathEntry.isDirectory() ||
    pathEntry.dev !== record.pathIdentity.device ||
    pathEntry.ino !== record.pathIdentity.inode ||
    (await realpath(record.root)) !== record.root ||
    (await realpath(record.path)) !== record.path
  ) {
    throw new TypeError("La identidad de la copia de ejecución cambió");
  }
}

/**
 * Re-materializes the trusted Git baseline plus the rechecked approved output.
 * The mutable staged input is never returned as an execution directory.
 */
export async function createControllerExecutionCopy(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<ControllerExecutionCopy> {
  const staging = stagedOutputRecord(output);
  const approvedHashes = await verifiedStagedOutputHashes(
    output,
    plan,
    attemptId,
  );
  let root: string | undefined;
  try {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "comunidadsolar-validation-execution-")),
    );
    const path = await realpath(await mkdtemp(join(root, "copy-")));
    await exportBaseline(staging.repositoryRoot, staging.baselineCommit, path);
    await stripOperationalFiles(path);

    let remainingBytes = AGENT_ACCEPTED_OUTPUT_MAX_BYTES;
    for (const relativePath of exactOutputPaths(output)) {
      const expectedHash = approvedHashes[relativePath]!;
      const source = join(output.path, ...relativePath.split("/"));
      const current = await regularFileDigest(source, remainingBytes);
      if (current.sha256 !== expectedHash || current.bytes > remainingBytes) {
        throw new TypeError(
          "La salida de staging cambió antes de la materialización",
        );
      }
      await copyAcceptedFile(
        output.path,
        path,
        relativePath,
        {
          kind: "file",
          mode: 0o600,
          bytes: current.bytes,
          sha256: expectedHash,
        },
        remainingBytes,
      );
      remainingBytes -= current.bytes;
    }
    const recheckedHashes = await verifiedStagedOutputHashes(
      output,
      plan,
      attemptId,
    );
    if (
      outputHashesDigest(recheckedHashes) !== outputHashesDigest(approvedHashes)
    ) {
      throw new TypeError(
        "La salida de staging cambió durante la materialización",
      );
    }
    const [rootEntry, pathEntry] = await Promise.all([
      lstat(root),
      lstat(path),
    ]);
    const copy: ControllerExecutionCopy = Object.freeze({ path });
    executionCopyRecords.set(
      copy,
      Object.freeze({
        root,
        path,
        output,
        attemptId,
        planCanonical: canonicalJson(plan),
        outputSha256: approvedHashes,
        rootIdentity: Object.freeze({
          device: rootEntry.dev,
          inode: rootEntry.ino,
        }),
        pathIdentity: Object.freeze({
          device: pathEntry.dev,
          inode: pathEntry.ino,
        }),
      }),
    );
    await assertControllerExecutionCopy(copy, output, plan, attemptId);
    return copy;
  } catch (error: unknown) {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

/** Rechecks the exact approved bytes in a controller-minted execution copy. */
export async function assertControllerExecutionCopy(
  copy: ControllerExecutionCopy,
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<ControllerExecutionIntegrity> {
  const record = executionCopyRecord(copy);
  if (
    record.output !== output ||
    record.attemptId !== attemptId ||
    record.planCanonical !== canonicalJson(plan)
  ) {
    throw new TypeError(
      "La copia de ejecución no coincide con el output, plan o intento",
    );
  }
  await assertExecutionCopyLocation(record);
  let remainingBytes = AGENT_ACCEPTED_OUTPUT_MAX_BYTES;
  const hashes: Record<string, string> = {};
  for (const relativePath of Object.keys(record.outputSha256).sort()) {
    const expected = record.outputSha256[relativePath]!;
    const file = await regularFileDigest(
      join(record.path, ...relativePath.split("/")),
      remainingBytes,
    );
    if (file.sha256 !== expected || file.bytes > remainingBytes) {
      throw new TypeError(
        "La copia de ejecución ya no coincide con el output aprobado",
      );
    }
    remainingBytes -= file.bytes;
    hashes[relativePath] = file.sha256;
  }
  const immutableHashes = Object.freeze(hashes);
  return Object.freeze({
    outputSha256: immutableHashes,
    sha256: outputHashesDigest(immutableHashes),
  });
}

export async function removeControllerExecutionCopy(
  copy: ControllerExecutionCopy,
): Promise<void> {
  const record = executionCopyRecord(copy);
  await assertExecutionCopyLocation(record);
  await rm(record.root, { recursive: true, force: false });
  executionCopyRecords.delete(copy);
}

async function runFixedGit(
  arguments_: readonly string[],
  failure: string,
): Promise<string> {
  const child = spawn(gitExecutable, [...fixedGitArguments, ...arguments_], {
    env: fixedGitEnvironment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child, "stdout");
  const errors = collect(child, "stderr");
  if ((await exitCode(child)) !== 0) {
    const detail = Buffer.concat(errors).toString("utf8").trim();
    throw new TypeError(detail === "" ? failure : `${failure}: ${detail}`);
  }
  return Buffer.concat(output).toString("utf8").trim();
}

function candidateCheckoutRecord(
  checkout: ControllerCandidateCheckout,
): CandidateCheckoutRecord {
  const record = candidateCheckoutRecords.get(checkout);
  if (record === undefined) {
    throw new TypeError("El checkout candidato no pertenece al controlador");
  }
  return record;
}

async function assertCandidateCheckoutLocation(
  record: CandidateCheckoutRecord,
): Promise<void> {
  const [rootEntry, pathEntry] = await Promise.all([
    lstat(record.root),
    lstat(record.path),
  ]);
  if (
    dirname(record.path) !== record.root ||
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    rootEntry.dev !== record.rootIdentity.device ||
    rootEntry.ino !== record.rootIdentity.inode ||
    pathEntry.isSymbolicLink() ||
    !pathEntry.isDirectory() ||
    pathEntry.dev !== record.pathIdentity.device ||
    pathEntry.ino !== record.pathIdentity.inode ||
    (await realpath(record.root)) !== record.root ||
    (await realpath(record.path)) !== record.path
  ) {
    throw new TypeError("La identidad del checkout candidato cambió");
  }
}

function sameOutputHashMaps(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return outputHashesDigest(left) === outputHashesDigest(right);
}

/**
 * Materializes a Git checkout from the private trusted baseline record and
 * copies only the rechecked staged bytes. The returned object intentionally
 * contains no filesystem path or Git/repository authority.
 */
export async function createControllerCandidateCheckout(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<ControllerCandidateCheckout> {
  const staging = stagedOutputRecord(output);
  const approvedHashes = await verifiedStagedOutputHashes(
    output,
    plan,
    attemptId,
  );
  let root: string | undefined;
  try {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "comunidadsolar-candidate-checkout-")),
    );
    const checkoutPath = join(root, "checkout");
    await runFixedGit(
      [
        "clone",
        "--no-local",
        "--no-checkout",
        "--quiet",
        "--",
        staging.repositoryRoot,
        checkoutPath,
      ],
      "No se pudo clonar el baseline del candidato",
    );
    const canonicalCheckout = await realpath(checkoutPath);
    if (canonicalCheckout !== checkoutPath) {
      throw new TypeError("El checkout candidato no es canónico");
    }
    await runFixedGit(
      [
        "-C",
        canonicalCheckout,
        "checkout",
        "--detach",
        "--quiet",
        plan.baselineCommit,
      ],
      "No se pudo abrir el baseline del candidato",
    );
    const [head, status] = await Promise.all([
      runFixedGit(
        ["-C", canonicalCheckout, "rev-parse", "HEAD"],
        "No se pudo leer el commit candidato",
      ),
      runFixedGit(
        [
          "-C",
          canonicalCheckout,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ],
        "No se pudo comprobar el checkout candidato",
      ),
    ]);
    if (head !== staging.baselineCommit || status !== "") {
      throw new TypeError("El checkout candidato no parte del baseline limpio");
    }

    let remainingBytes = AGENT_ACCEPTED_OUTPUT_MAX_BYTES;
    for (const relativePath of exactOutputPaths(output)) {
      const expectedHash = approvedHashes[relativePath]!;
      const current = await regularFileDigest(
        join(output.path, ...relativePath.split("/")),
        remainingBytes,
      );
      if (current.sha256 !== expectedHash || current.bytes > remainingBytes) {
        throw new TypeError(
          "La salida aprobada cambió antes de crear el candidato",
        );
      }
      await copyAcceptedFile(
        output.path,
        canonicalCheckout,
        relativePath,
        {
          kind: "file",
          mode: 0o600,
          bytes: current.bytes,
          sha256: expectedHash,
        },
        remainingBytes,
      );
      remainingBytes -= current.bytes;
    }
    const recheckedHashes = await verifiedStagedOutputHashes(
      output,
      plan,
      attemptId,
    );
    if (!sameOutputHashMaps(approvedHashes, recheckedHashes)) {
      throw new TypeError(
        "La salida aprobada cambió durante la copia candidata",
      );
    }
    const [rootEntry, pathEntry] = await Promise.all([
      lstat(root),
      lstat(canonicalCheckout),
    ]);
    const checkout = Object.freeze({}) as ControllerCandidateCheckout;
    candidateCheckoutRecords.set(
      checkout,
      Object.freeze({
        root,
        path: canonicalCheckout,
        output,
        attemptId,
        planCanonical: canonicalJson(plan),
        baselineCommit: staging.baselineCommit,
        outputSha256: approvedHashes,
        rootIdentity: Object.freeze({
          device: rootEntry.dev,
          inode: rootEntry.ino,
        }),
        pathIdentity: Object.freeze({
          device: pathEntry.dev,
          inode: pathEntry.ino,
        }),
      }),
    );
    await assertControllerCandidateCheckout(checkout, output, plan, attemptId);
    return checkout;
  } catch (error: unknown) {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

/** Rechecks the bound approved bytes inside the private candidate checkout. */
export async function assertControllerCandidateCheckout(
  checkout: ControllerCandidateCheckout,
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<ControllerExecutionIntegrity> {
  const record = candidateCheckoutRecord(checkout);
  if (
    record.output !== output ||
    record.attemptId !== attemptId ||
    record.planCanonical !== canonicalJson(plan) ||
    record.baselineCommit !== plan.baselineCommit
  ) {
    throw new TypeError(
      "El checkout candidato no coincide con el output, plan o intento",
    );
  }
  await assertCandidateCheckoutLocation(record);
  let remainingBytes = AGENT_ACCEPTED_OUTPUT_MAX_BYTES;
  const hashes: Record<string, string> = {};
  for (const relativePath of Object.keys(record.outputSha256).sort()) {
    const expected = record.outputSha256[relativePath]!;
    const file = await regularFileDigest(
      join(record.path, ...relativePath.split("/")),
      remainingBytes,
    );
    if (file.sha256 !== expected || file.bytes > remainingBytes) {
      throw new TypeError(
        "El checkout candidato ya no coincide con la salida aprobada",
      );
    }
    remainingBytes -= file.bytes;
    hashes[relativePath] = file.sha256;
  }
  return Object.freeze({
    outputSha256: Object.freeze(hashes),
    sha256: outputHashesDigest(hashes),
  });
}

/**
 * Grants a path only to the controller's fixed operation after the opaque
 * checkout has been revalidated. It is not a public artifact or agent API.
 */
export async function withControllerCandidateCheckout<T>(
  checkout: ControllerCandidateCheckout,
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
  operation: (checkoutPath: string) => Promise<T>,
): Promise<T> {
  await assertControllerCandidateCheckout(checkout, output, plan, attemptId);
  return await operation(candidateCheckoutRecord(checkout).path);
}

export async function removeControllerCandidateCheckout(
  checkout: ControllerCandidateCheckout,
): Promise<void> {
  const record = candidateCheckoutRecord(checkout);
  await assertCandidateCheckoutLocation(record);
  await rm(record.root, { recursive: true, force: false });
  candidateCheckoutRecords.delete(checkout);
}

export interface StagedPackageBaselines {
  readonly packageJson: Buffer;
  readonly packageLockJson: Buffer;
}

async function baselineBlob(
  record: StagedOutputRecord,
  path: (typeof packageManifests)[number],
): Promise<Buffer> {
  const child = spawn(
    gitExecutable,
    [
      ...fixedGitArguments,
      "-C",
      record.repositoryRoot,
      "cat-file",
      "blob",
      `${record.baselineCommit}:${path}`,
    ],
    {
      env: fixedGitEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = collect(child, "stdout");
  const error = collect(child, "stderr");
  if ((await exitCode(child)) !== 0) {
    const details = Buffer.concat(error).toString("utf8").trim();
    throw new TypeError(
      `No se pudo leer el manifest del baseline controlador: ${details}`,
    );
  }
  return Buffer.concat(output);
}

/** Reads only the two fixed dependency manifests from the bound baseline. */
export async function readStagedPackageBaselines(
  output: StagedAgentOutput,
): Promise<StagedPackageBaselines> {
  const record = stagedOutputRecord(output);
  await assertStagedOutputLocation(record);
  const [packageJson, packageLockJson] = await Promise.all([
    baselineBlob(record, "package.json"),
    baselineBlob(record, "package-lock.json"),
  ]);
  await assertStagedOutputLocation(record);
  return Object.freeze({ packageJson, packageLockJson });
}

export async function removeStagedAgentOutput(
  output: StagedAgentOutput,
): Promise<void> {
  const record = stagedOutputRecord(output);
  await assertStagedOutputLocation(record);
  await rm(record.root, { recursive: true, force: false });
  stagedOutputRecords.delete(output);
}
