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
import { dirname, isAbsolute, join } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import type { ChangePlan } from "../domain.ts";
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
  readonly workspace: AgentWorkspace;
  readonly files: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
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

  async function visit(relativeDirectory: string): Promise<void> {
    const directory =
      relativeDirectory === ""
        ? root
        : join(root, ...relativeDirectory.split("/"));
    const handle = await opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) names.push(entry.name);
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
      const bytes = await readFile(absolute);
      entries.set(path, {
        kind: "file",
        mode,
        bytes: bytes.byteLength,
        sha256: hash(bytes),
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
  for (const path of uniqueFiles) {
    if (!outputAllowed(path, plan)) {
      throw new TypeError(
        `El path ${path} no aprobado fue modificado por el agente`,
      );
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

async function regularFileBytes(
  path: string,
  expected?: ManifestEntry,
): Promise<Buffer> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new TypeError("La salida aceptada no es un archivo regular seguro");
    }
    const bytes = await handle.readFile();
    if (
      expected &&
      (expected.kind !== "file" ||
        bytes.byteLength !== expected.bytes ||
        hash(bytes) !== expected.sha256)
    ) {
      throw new TypeError("La salida aceptada cambió durante la copia");
    }
    return bytes;
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
): Promise<string> {
  const source = join(workspace.path, ...path.split("/"));
  const destination = join(stagingPath, ...path.split("/"));
  const sourceBytes = await regularFileBytes(source, expected);
  const acceptedHash = hash(sourceBytes);
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
  const destinationHandle = await open(destination, flags, 0o600);
  try {
    await destinationHandle.writeFile(Buffer.from(sourceBytes));
  } finally {
    await destinationHandle.close();
  }
  const copiedBytes = await regularFileBytes(destination);
  if (hash(copiedBytes) !== acceptedHash) {
    throw new TypeError(
      "El hash del staging no coincide con la salida aceptada",
    );
  }
  return acceptedHash;
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
  let stagingPath: string | undefined;
  try {
    stagingPath = await mkdtemp(
      join(dirname(workspace.path), `${workspace.attemptId}-staging-`),
    );
    await exportBaseline(workspace, stagingPath);
    await stripOperationalFiles(stagingPath);
    assertSameManifest(
      await captureManifest(stagingPath),
      workspace.baselineManifest,
    );
    const hashes = new Map<string, string>();
    for (const path of files) {
      const expected = current.get(path);
      if (!expected || expected.kind !== "file") {
        throw new TypeError("El inventario aceptado cambió durante el handoff");
      }
      hashes.set(
        path,
        await copyAcceptedFile(workspace, stagingPath, path, expected),
      );
    }
    await assertWorkspaceInputs(workspace);
    await assertPrivateOutputDirectory(workspace);
    await assertTrustedRepositoriesUnchanged(workspace);
    return Object.freeze({
      path: stagingPath,
      workspace,
      files: Object.freeze([...files]),
      sha256: Object.freeze(Object.fromEntries(hashes)),
    });
  } catch (error: unknown) {
    if (stagingPath !== undefined) {
      await rm(stagingPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}
