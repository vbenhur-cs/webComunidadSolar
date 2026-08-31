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
  workspace: AgentWorkspace,
  destination: string,
): Promise<void> {
  const archive = spawn(
    gitExecutable,
    [
      ...fixedGitArguments,
      "-C",
      workspace.repositoryRoot,
      "archive",
      "--format=tar",
      workspace.baselineCommit,
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
  workspace: AgentWorkspace,
  stagingPath: string,
  path: string,
  expected: ManifestEntry,
  remainingBytes: number,
): Promise<string> {
  const source = join(workspace.path, ...path.split("/"));
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
      plan.changeId,
      plan.planSha256,
      canonicalJson(plan),
    );
    const stagingPath = staging.path;
    await exportBaseline(workspace, stagingPath);
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
          workspace,
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

/** Proves that a staging handoff was minted by this controller instance. */
export async function assertControllerStagedOutput(
  output: StagedAgentOutput,
  plan: ChangePlan,
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
  await assertStagedOutputLocation(record);
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
