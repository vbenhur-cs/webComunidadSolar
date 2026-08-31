import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJson, sha256Canonical } from "../canonical-json.ts";
import type { ChangePlan } from "../domain.ts";

const safeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/u;
const safeCommitPattern = /^[a-f0-9]{40,64}$/u;
const gitExecutable = "/usr/bin/git";
const tarExecutable = "/usr/bin/tar";
const privateInputDirectory = ".agent-input";
const privateOutputDirectory = ".agent-output";
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

export interface AgentWorkspace {
  readonly path: string;
  readonly repositoryRoot: string;
  readonly baselineCommit: string;
  readonly changeId: string;
  readonly attemptId: string;
  readonly requestPath: string;
  readonly planPath: string;
  readonly policyPath: string;
  readonly resultSchemaPath: string;
  readonly baselineManifest: ReadonlyMap<string, ManifestEntry>;
}

export interface AgentWorkspaceInput {
  repositoryRoot: string;
  sourceRepositoryRoot?: string;
  workspaceRoot: string;
  approvedPlan: ChangePlan;
  changeId: string;
  attemptId: string;
  baselineCommit: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
  resultSchemaPath: string;
}

export interface ManifestEntry {
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly bytes: number;
  readonly sha256: string | null;
}

export interface TrustedRepositorySnapshot {
  readonly head: string;
  readonly status: string;
}

export interface AgentWorkspaceInputs {
  readonly changeId: string;
  readonly attemptId: string;
  readonly workspace: string;
  readonly requestPath: string;
  readonly planPath: string;
  readonly policyPath: string;
  readonly resultSchemaPath: string;
}

interface InputRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface RepositoryRecord {
  readonly root: string;
  readonly snapshot: TrustedRepositorySnapshot;
}

interface WorkspaceRecord {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly identity: { readonly device: number; readonly inode: number };
  readonly repositories: readonly RepositoryRecord[];
  readonly inputs: ReadonlyMap<string, InputRecord>;
  readonly baselineManifest: ReadonlyMap<string, ManifestEntry>;
}

const workspaceRecords = new WeakMap<AgentWorkspace, WorkspaceRecord>();

class ImmutableManifest implements ReadonlyMap<string, ManifestEntry> {
  readonly #entries: Map<string, ManifestEntry>;

  constructor(entries: Iterable<readonly [string, ManifestEntry]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): ManifestEntry | undefined {
    return this.#entries.get(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  entries(): MapIterator<[string, ManifestEntry]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<string> {
    return this.#entries.keys();
  }

  values(): MapIterator<ManifestEntry> {
    return this.#entries.values();
  }

  forEach(
    callbackfn: (
      value: ManifestEntry,
      key: string,
      map: ReadonlyMap<string, ManifestEntry>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[string, ManifestEntry]> {
    return this.#entries[Symbol.iterator]();
  }
}

function immutableManifest(
  entries: Iterable<readonly [string, ManifestEntry]>,
): ReadonlyMap<string, ManifestEntry> {
  return new ImmutableManifest(entries);
}

function safeId(value: string, field: string): void {
  if (!safeIdPattern.test(value)) {
    throw new TypeError(`El identificador ${field} no es seguro`);
  }
}

function safeCommit(value: string): void {
  if (!safeCommitPattern.test(value)) {
    throw new TypeError("El commit baseline no es seguro");
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function workspaceRecord(workspace: AgentWorkspace): WorkspaceRecord {
  const record = workspaceRecords.get(workspace);
  if (!record) {
    throw new TypeError("El workspace no pertenece a este servicio");
  }
  return record;
}

async function trustedDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const entry = await lstat(absolute);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError(`${label} debe ser un directorio confiable`);
  }
  return await realpath(absolute);
}

async function applicationWorkspaceRoot(path: string): Promise<string> {
  const root = await trustedDirectory(path, "El root temporal de workspaces");
  const temporaryRoot = await realpath(tmpdir());
  const entry = await lstat(root);
  if (
    root === temporaryRoot ||
    !isWithin(temporaryRoot, root) ||
    (typeof process.getuid === "function" && entry.uid !== process.getuid()) ||
    (process.platform !== "win32" && (entry.mode & 0o077) !== 0)
  ) {
    throw new TypeError(
      "El workspaceRoot debe ser un root temporal privado de la aplicación",
    );
  }
  return root;
}

function validateApprovedPlan(input: AgentWorkspaceInput): void {
  const approved = input.approvedPlan;
  const { planSha256, ...unsigned } = approved;
  if (
    approved.changeId !== input.changeId ||
    approved.baselineCommit !== input.baselineCommit ||
    planSha256 !== sha256Canonical(unsigned)
  ) {
    throw new TypeError("El plan aprobado no corresponde al workspace");
  }
}

function validateCopiedAuthorities(
  input: AgentWorkspaceInput,
  requestBytes: Buffer,
  planBytes: Buffer,
): void {
  let copiedRequest: unknown;
  let copiedPlan: unknown;
  try {
    copiedRequest = JSON.parse(requestBytes.toString("utf8"));
    copiedPlan = JSON.parse(planBytes.toString("utf8"));
  } catch {
    throw new TypeError(
      "La entrada autoritativa del agente no contiene JSON válido",
    );
  }
  if (
    typeof copiedRequest !== "object" ||
    copiedRequest === null ||
    canonicalJson(copiedPlan) !== canonicalJson(input.approvedPlan)
  ) {
    throw new TypeError(
      "La entrada autoritativa no coincide con el plan aprobado",
    );
  }
  const { inputSha256, ...unsignedRequest } = copiedRequest as Record<
    string,
    unknown
  >;
  if (
    inputSha256 !== input.approvedPlan.requestSha256 ||
    inputSha256 !== sha256Canonical(unsignedRequest)
  ) {
    throw new TypeError(
      "La entrada autoritativa no coincide con el plan aprobado",
    );
  }
}

async function authoritativeBytes(
  path: string,
  label: string,
): Promise<Buffer> {
  const absolute = resolve(path);
  const entry = await lstat(absolute);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new TypeError(`${label} debe ser un archivo regular autoritativo`);
  }
  return await readFile(absolute);
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

async function git(root: string, args: readonly string[]): Promise<Buffer> {
  const child = spawn(
    gitExecutable,
    [...fixedGitArguments, "-C", root, ...args],
    {
      env: fixedGitEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = collect(child, "stdout");
  const stderr = collect(child, "stderr");
  const code = await exitCode(child);
  if (code !== 0) {
    throw new TypeError(
      `Git rechazó el repositorio confiable: ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
  }
  return Buffer.concat(stdout);
}

async function repositorySnapshot(
  root: string,
): Promise<TrustedRepositorySnapshot> {
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]))
    .toString("ascii")
    .trim();
  const status = (
    await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ).toString("latin1");
  return Object.freeze({ head, status });
}

async function exportBaseline(
  repositoryRoot: string,
  baselineCommit: string,
  workspacePath: string,
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
  const extract = spawn(tarExecutable, ["-xf", "-", "-C", workspacePath], {
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
    throw new TypeError(`No se pudo exportar el baseline aprobado: ${details}`);
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
    (segment.startsWith(".env.") && segment !== ".env.example") ||
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

function validateRelativePath(path: string): void {
  const segments = path.split(/[\\/]/u);
  if (
    path === "" ||
    isAbsolute(path) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0"),
    )
  ) {
    throw new TypeError("El workspace contiene un path inseguro");
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
      if (
        relativeDirectory === "" &&
        (name === privateInputDirectory || name === privateOutputDirectory)
      ) {
        continue;
      }
      if (forbiddenExportSegment(name)) {
        throw new TypeError(
          "El workspace contiene estado o configuración prohibida",
        );
      }
      const absolute = join(root, ...path.split("/"));
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        throw new TypeError("El workspace contiene un enlace simbólico");
      }
      const mode = entry.mode & 0o7777;
      if (entry.isDirectory()) {
        entries.set(
          path,
          Object.freeze({ kind: "directory", mode, bytes: 0, sha256: null }),
        );
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new TypeError("El workspace contiene un archivo especial");
      }
      if (entry.nlink !== 1) {
        throw new TypeError("El workspace contiene un hardlink inseguro");
      }
      const bytes = await readFile(absolute);
      entries.set(
        path,
        Object.freeze({
          kind: "file",
          mode,
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      );
    }
  }

  await visit("");
  return immutableManifest(entries);
}

async function createSafeChild(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (await realpath(path)) !== path
    ) {
      throw new TypeError("El parent del workspace no es seguro");
    }
  }
  return path;
}

async function createExclusiveWorkspace(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") {
      throw new TypeError("El destino del workspace está ocupado");
    }
    throw error;
  }
}

async function assertWorkspaceLocation(record: WorkspaceRecord): Promise<void> {
  if (
    (await realpath(record.workspaceRoot)) !== record.workspaceRoot ||
    !isWithin(record.workspaceRoot, record.path)
  ) {
    throw new TypeError("El root canónico del workspace cambió");
  }
  const parent = dirname(record.path);
  const entry = await lstat(record.path);
  if (
    (await realpath(parent)) !== parent ||
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(record.path)) !== record.path ||
    entry.dev !== record.identity.device ||
    entry.ino !== record.identity.inode
  ) {
    throw new TypeError("La identidad canónica del workspace cambió");
  }
}

export async function createAgentWorkspace(
  input: AgentWorkspaceInput,
): Promise<AgentWorkspace> {
  safeId(input.changeId, "changeId");
  safeId(input.attemptId, "attemptId");
  safeCommit(input.baselineCommit);
  validateApprovedPlan(input);

  const [repositoryRoot, workspaceRoot] = await Promise.all([
    trustedDirectory(input.repositoryRoot, "El repositorio controlador"),
    applicationWorkspaceRoot(input.workspaceRoot),
  ]);
  const sourceRepositoryRoot = input.sourceRepositoryRoot
    ? await trustedDirectory(input.sourceRepositoryRoot, "El source sibling")
    : repositoryRoot;
  if (
    isWithin(repositoryRoot, workspaceRoot) ||
    isWithin(sourceRepositoryRoot, workspaceRoot) ||
    (sourceRepositoryRoot !== repositoryRoot &&
      (isWithin(repositoryRoot, sourceRepositoryRoot) ||
        isWithin(sourceRepositoryRoot, repositoryRoot)))
  ) {
    throw new TypeError(
      "El workspace temporal y los repositorios confiables deben estar separados",
    );
  }

  const repositories: RepositoryRecord[] = [];
  const repositoryBefore = await repositorySnapshot(repositoryRoot);
  if (repositoryBefore.head !== input.baselineCommit) {
    throw new TypeError(
      "El HEAD del repositorio no coincide con el baseline aprobado",
    );
  }
  repositories.push(
    Object.freeze({ root: repositoryRoot, snapshot: repositoryBefore }),
  );
  if (sourceRepositoryRoot !== repositoryRoot) {
    repositories.push(
      Object.freeze({
        root: sourceRepositoryRoot,
        snapshot: await repositorySnapshot(sourceRepositoryRoot),
      }),
    );
  }

  const [requestBytes, planBytes, policyBytes, resultSchemaBytes] =
    await Promise.all([
      authoritativeBytes(input.requestPath, "La request"),
      authoritativeBytes(input.planPath, "El plan"),
      authoritativeBytes(input.policyPath, "La policy"),
      authoritativeBytes(input.resultSchemaPath, "El schema de resultado"),
    ]);
  validateCopiedAuthorities(input, requestBytes, planBytes);

  const changeRoot = await createSafeChild(workspaceRoot, input.changeId);
  const path = join(changeRoot, input.attemptId);
  let created = false;
  try {
    await createExclusiveWorkspace(path);
    created = true;
    await exportBaseline(repositoryRoot, input.baselineCommit, path);
    await stripOperationalFiles(path);
    const baselineManifest = await captureManifest(path);
    const inputRoot = await createSafeChild(path, privateInputDirectory);
    await createSafeChild(path, privateOutputDirectory);
    const copies = [
      ["request.json", requestBytes],
      ["plan.json", planBytes],
      ["policy.json", policyBytes],
      ["agent-result.schema.json", resultSchemaBytes],
    ] as const;
    const inputRecords = new Map<string, InputRecord>();
    for (const [name, bytes] of copies) {
      const copiedPath = join(inputRoot, name);
      await writeFile(copiedPath, bytes, { flag: "wx", mode: 0o600 });
      inputRecords.set(
        name,
        Object.freeze({
          path: copiedPath,
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      );
    }
    const identity = await lstat(path);
    const exposedManifest = immutableManifest(baselineManifest);
    const workspace: AgentWorkspace = Object.freeze({
      path,
      repositoryRoot,
      baselineCommit: input.baselineCommit,
      changeId: input.changeId,
      attemptId: input.attemptId,
      requestPath: join(inputRoot, "request.json"),
      planPath: join(inputRoot, "plan.json"),
      policyPath: join(inputRoot, "policy.json"),
      resultSchemaPath: join(inputRoot, "agent-result.schema.json"),
      baselineManifest: exposedManifest,
    });
    workspaceRecords.set(
      workspace,
      Object.freeze({
        workspaceRoot,
        path,
        identity: Object.freeze({
          device: identity.dev,
          inode: identity.ino,
        }),
        repositories: Object.freeze(repositories),
        inputs: new Map(inputRecords),
        baselineManifest,
      }),
    );
    return workspace;
  } catch (error: unknown) {
    if (created) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        // Preserve a failed export when cleanup cannot complete for diagnosis.
      }
    }
    throw error;
  }
}

export function workspaceInputs(
  workspace: AgentWorkspace,
): AgentWorkspaceInputs {
  workspaceRecord(workspace);
  return Object.freeze({
    changeId: workspace.changeId,
    attemptId: workspace.attemptId,
    workspace: workspace.path,
    requestPath: workspace.requestPath,
    planPath: workspace.planPath,
    policyPath: workspace.policyPath,
    resultSchemaPath: workspace.resultSchemaPath,
  });
}

export async function workspaceManifest(
  workspace: AgentWorkspace,
): Promise<ReadonlyMap<string, ManifestEntry>> {
  const record = workspaceRecord(workspace);
  await assertWorkspaceLocation(record);
  return await captureManifest(record.path);
}

export async function assertWorkspaceInputs(
  workspace: AgentWorkspace,
): Promise<void> {
  const record = workspaceRecord(workspace);
  await assertWorkspaceLocation(record);
  try {
    const inputRoot = join(record.path, privateInputDirectory);
    const directory = await lstat(inputRoot);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new TypeError("La entrada copiada del agente cambió");
    }
    const names = (await readdir(inputRoot)).sort();
    const expectedNames = [...record.inputs.keys()].sort();
    if (canonicalJson(names) !== canonicalJson(expectedNames)) {
      throw new TypeError("La entrada copiada del agente cambió");
    }
    for (const [name, expected] of record.inputs) {
      const path = join(inputRoot, name);
      const entry = await lstat(path);
      if (
        path !== expected.path ||
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        entry.nlink !== 1
      ) {
        throw new TypeError("La entrada copiada del agente cambió");
      }
      const bytes = await readFile(path);
      if (
        bytes.byteLength !== expected.bytes ||
        sha256(bytes) !== expected.sha256
      ) {
        throw new TypeError("La entrada copiada del agente cambió");
      }
    }
  } catch (error: unknown) {
    if (
      error instanceof TypeError &&
      error.message === "La entrada copiada del agente cambió"
    ) {
      throw error;
    }
    throw new TypeError("La entrada copiada del agente cambió", {
      cause: error,
    });
  }
}

export async function assertTrustedRepositoriesUnchanged(
  workspace: AgentWorkspace,
): Promise<void> {
  const record = workspaceRecord(workspace);
  await assertWorkspaceLocation(record);
  for (const repository of record.repositories) {
    const current = await repositorySnapshot(repository.root);
    if (
      current.head !== repository.snapshot.head ||
      current.status !== repository.snapshot.status
    ) {
      throw new TypeError("El repositorio confiable cambió durante el intento");
    }
  }
}

export async function removeAgentWorkspace(
  workspace: AgentWorkspace,
): Promise<void> {
  const record = workspaceRecord(workspace);
  await assertWorkspaceLocation(record);
  await rm(record.path, { recursive: true, force: false });
  workspaceRecords.delete(workspace);
}
