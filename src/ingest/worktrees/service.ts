import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, sha256Canonical } from "../canonical-json.ts";
import type { ChangePlan, NormalizedRequest } from "../domain.ts";
import { sanitizedGitEnv } from "../git-env.ts";
import { validateSchema } from "../schema-validator.ts";

const execFileAsync = promisify(execFile);
const names = ["request.json", "plan.json", "policy.json"] as const;
const owned = new WeakSet<CandidateWorktree>();
const released = new WeakSet<CandidateWorktree>();
const quarantinedCandidates = new WeakMap<CandidateWorktree, string>();
const ownedQuarantines = new Set<string>();
interface CandidateRecord extends CandidateWorktree {
  readonly identity: Identity;
  readonly gitAuthority: CandidateGitAuthority;
  readonly approvedPlan: ChangePlan;
  readonly repositorySnapshot: GitSnapshot;
  readonly sourceSnapshot: GitSnapshot;
  readonly candidateSnapshot: GitSnapshot;
  outputIdentity?: Identity;
  inputDirectoryIdentity?: Identity;
  inputIdentities?: Readonly<Record<(typeof names)[number], Identity>>;
}
const records = new WeakMap<CandidateWorktree, Readonly<CandidateRecord>>();
interface SchemaIdentity extends Identity {
  readonly path: string;
  readonly digest: string;
}
interface CandidateGitAuthority {
  readonly gitFile: string;
  readonly gitFileIdentity: Identity;
  readonly gitFileDigest: string;
  readonly gitDirectory: string;
  readonly gitDirectoryIdentity: Identity;
  readonly commonDirectory: string;
  readonly commonDirectoryIdentity: Identity;
}
type CandidateGitScope = Readonly<
  Pick<CandidateRecord, "path" | "repositoryRoot" | "gitAuthority">
>;
interface RunContextRecord {
  readonly candidate: CandidateWorktree;
  readonly schema: SchemaIdentity;
}
const runContexts = new WeakMap<object, RunContextRecord | null>();
type Identity = { device: number; inode: number };
const agentResultSchema = fileURLToPath(
  new URL(
    "../../../schemas/ingestion/agent-result.schema.json",
    import.meta.url,
  ),
);
const manifestScanner = fileURLToPath(
  new URL("./manifest-scanner.mjs", import.meta.url),
);
interface WorktreeTestHooks {
  afterRegistration?(): Promise<void> | void;
  beforeSidecarDelete?(path: string): Promise<void> | void;
  beforeSetupSnapshot?(): Promise<void> | void;
  beforeServiceDirectoryRead?(path: string): Promise<void> | void;
  afterServiceDirectoryRead?(path: string): Promise<void> | void;
  afterServiceDirectoryEntry?(path: string): Promise<void> | void;
  beforeServiceChildTraversal?(
    parent: string,
    child: string,
  ): Promise<void> | void;
  afterServiceChildTraversal?(
    parent: string,
    child: string,
  ): Promise<void> | void;
  afterServiceFileRead?(path: string): Promise<void> | void;
  afterCandidateQuarantine?(path: string): Promise<void> | void;
  beforeGitSnapshotStatus?(path: string): Promise<void> | void;
  afterCandidateValidationSnapshot?(
    kind: "candidate" | "repository" | "source",
  ): Promise<void> | void;
}
let testHooks: WorktreeTestHooks = {};
/** Test-only deterministic fault/race injection; unavailable to production. */
export function setWorktreeTestHooks(hooks: WorktreeTestHooks): () => void {
  if (process.env.INGEST_TEST_MODE !== "true")
    throw new TypeError("Los hooks de worktree solo existen en pruebas");
  testHooks = hooks;
  return () => {
    testHooks = {};
  };
}
export interface GitSnapshot {
  head: string;
  refs: string;
  status: string;
  serviceEntries: string;
}
export interface CandidateWorktreeInput {
  repositoryRoot: string;
  sourceRepositoryRoot?: string;
  approvedPlan: ChangePlan;
  changeId: string;
  attemptId: string;
  baselineCommit: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
}
export interface CandidateWorktree {
  path: string;
  outputDirectory: string;
  repositoryRoot: string;
  sourceRepositoryRoot: string;
  changeId: string;
  attemptId: string;
  baselineCommit: string;
  branch: string;
  inputHash: string;
  requestSha256: string;
  planSha256: string;
}
const safeId = (value: string, name: string) => {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value))
    throw new TypeError(`El ${name} no es seguro para un worktree`);
};
const safeCommit = (value: string) => {
  if (!/^[a-f0-9]{40,64}$/u.test(value))
    throw new TypeError("El baseline no es un commit válido");
};
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnv(),
  });
  return result.stdout.trim();
}
async function root(path: string): Promise<string> {
  const lexical = resolve(path);
  const entry = await lstat(lexical);
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new TypeError("La raíz del worktree no es un directorio seguro");
  const canonical = await realpath(lexical);
  if ((await git(canonical, ["rev-parse", "--show-toplevel"])) !== canonical)
    throw new TypeError("La raíz del worktree no coincide con Git");
  return canonical;
}
async function directory(path: string, parent: string): Promise<string> {
  const expected = resolve(path);
  if (!inside(parent, expected))
    throw new TypeError("El directorio de agente escapa de la raíz segura");
  const entry = await lstat(expected).catch(() => undefined);
  if (!entry) await mkdir(expected);
  else if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new TypeError("El directorio de agente no puede atravesar enlaces");
  const canonical = await realpath(expected);
  if (canonical !== expected)
    throw new TypeError("El directorio de agente no puede atravesar enlaces");
  return canonical;
}
async function vacant(path: string): Promise<void> {
  if (await lstat(path).catch(() => undefined))
    throw new TypeError("El target del worktree ya existe u está ocupado");
}
async function bytes(path: string): Promise<Buffer> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new TypeError("La entrada aprobada no es un archivo seguro");
  return await readFile(path);
}
async function fileIdentity(path: string): Promise<Identity> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new TypeError("La entrada aprobada no es un archivo seguro");
  return { device: entry.dev, inode: entry.ino };
}
async function regularFile(
  path: string,
): Promise<{ identity: Identity; bytes: Buffer }> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new TypeError(
      "La autoridad Git del candidato no es un archivo seguro",
    );
  if ((await realpath(path)) !== path)
    throw new TypeError("La autoridad Git del candidato no es canónica");
  return {
    identity: { device: entry.dev, inode: entry.ino },
    bytes: await readFile(path),
  };
}
async function canonicalDirectoryAuthority(path: string): Promise<Identity> {
  const entry = await lstat(path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(path)) !== path
  )
    throw new TypeError(
      "La autoridad Git del candidato no es un directorio seguro",
    );
  return { device: entry.dev, inode: entry.ino };
}
const authorityText = (bytes: Buffer, label: string): string => {
  const text = bytes.toString("utf8");
  if (text.includes("\0"))
    throw new TypeError(`La autoridad Git ${label} contiene NUL`);
  return text.trimEnd();
};
async function candidateGitAuthority(
  repositoryRoot: string,
  candidatePath: string,
): Promise<CandidateGitAuthority> {
  const repositoryGitDirectory = await realpath(
    await git(repositoryRoot, ["rev-parse", "--absolute-git-dir"]),
  );
  await canonicalDirectoryAuthority(repositoryGitDirectory);
  const gitFile = join(candidatePath, ".git");
  const file = await regularFile(gitFile);
  const match = /^gitdir: (.+)$/u.exec(authorityText(file.bytes, "gitdir"));
  if (!match || !isAbsolute(match[1]))
    throw new TypeError(
      "La autoridad Git del candidato no tiene gitdir válido",
    );
  const gitDirectory = resolve(match[1]);
  if (!inside(join(repositoryGitDirectory, "worktrees"), gitDirectory))
    throw new TypeError("El gitdir candidato escapa del repositorio principal");
  const gitDirectoryIdentity = await canonicalDirectoryAuthority(gitDirectory);
  const commonFile = await regularFile(join(gitDirectory, "commondir"));
  const commonDirectory = await realpath(
    resolve(gitDirectory, authorityText(commonFile.bytes, "commondir")),
  );
  if (commonDirectory !== repositoryGitDirectory)
    throw new TypeError("El gitdir candidato no enlaza al common dir esperado");
  const commonDirectoryIdentity =
    await canonicalDirectoryAuthority(commonDirectory);
  const backlink = await regularFile(join(gitDirectory, "gitdir"));
  if (
    resolve(gitDirectory, authorityText(backlink.bytes, "backlink")) !== gitFile
  )
    throw new TypeError("El gitdir candidato no enlaza al worktree esperado");
  return Object.freeze({
    gitFile,
    gitFileIdentity: file.identity,
    gitFileDigest: createHash("sha256").update(file.bytes).digest("hex"),
    gitDirectory,
    gitDirectoryIdentity,
    commonDirectory,
    commonDirectoryIdentity,
  });
}
async function assertCandidateGitAuthority(
  record: CandidateGitScope,
): Promise<void> {
  const current = await candidateGitAuthority(
    record.repositoryRoot,
    record.path,
  );
  if (
    current.gitFile !== record.gitAuthority.gitFile ||
    !equalIdentity(
      current.gitFileIdentity,
      record.gitAuthority.gitFileIdentity,
    ) ||
    current.gitFileDigest !== record.gitAuthority.gitFileDigest ||
    current.gitDirectory !== record.gitAuthority.gitDirectory ||
    !equalIdentity(
      current.gitDirectoryIdentity,
      record.gitAuthority.gitDirectoryIdentity,
    ) ||
    current.commonDirectory !== record.gitAuthority.commonDirectory ||
    !equalIdentity(
      current.commonDirectoryIdentity,
      record.gitAuthority.commonDirectoryIdentity,
    )
  )
    throw new TypeError("La autoridad Git del candidato ha cambiado");
}
async function directoryIdentity(path: string): Promise<Identity> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new TypeError("El directorio de entrada no es seguro");
  return { device: entry.dev, inode: entry.ino };
}
async function schemaIdentity(): Promise<SchemaIdentity> {
  const path = await realpath(agentResultSchema);
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile() || path !== agentResultSchema)
    throw new TypeError("El schema de resultado no es un archivo seguro");
  return {
    path,
    device: entry.dev,
    inode: entry.ino,
    digest: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}
async function assertSchemaIdentity(schema: SchemaIdentity): Promise<void> {
  const current = await schemaIdentity();
  if (
    current.path !== schema.path ||
    current.device !== schema.device ||
    current.inode !== schema.inode ||
    current.digest !== schema.digest
  )
    throw new TypeError("La identidad del schema de resultado ha cambiado");
}
const frozenSnapshot = (snapshot: GitSnapshot): GitSnapshot =>
  Object.freeze({ ...snapshot });
function withoutOwnedStatusPaths(
  status: string,
  repositoryRoot: string,
  ownedPaths: string[],
): string {
  const roots = ownedPaths.map((path) => relative(repositoryRoot, path));
  return status
    .split("\0")
    .filter((entry) => {
      if (entry.length < 4) return true;
      const path = entry.slice(3);
      // Git can collapse ignored service roots into a marker that cannot be
      // matched safely to a leaf. The ignored-inclusive canonical manifest is
      // compared separately and is the authority for every descendant.
      if (path === ".agent-worktrees/" || path === ".agent-quarantine/")
        return false;
      // Exempt only a recorded candidate or a previously atomically moved,
      // service-owned quarantine leaf. Unowned siblings remain observable in
      // both porcelain (when expanded) and the canonical manifest.
      return !roots.some(
        (root) => path === root || path.startsWith(`${root}/`),
      );
    })
    .join("\0");
}
function withoutCandidateAncestorMetadata(
  manifest: string,
  repositoryRoot: string,
  candidatePath: string,
): string {
  return manifest
    .split("\n")
    .filter((entry) => {
      const [type, path] = entry.split("\0", 2);
      if (type !== "D" || !path) return true;
      const absolute = resolve(repositoryRoot, path);
      return !(
        absolute.startsWith(`${repositoryRoot}/.agent-worktrees`) &&
        candidatePath.startsWith(`${absolute}/`)
      );
    })
    .join("\n");
}
function checkedPlan(value: unknown): ChangePlan {
  const plan = validateSchema<ChangePlan>("change-plan", value);
  const { planSha256, ...unsigned } = plan;
  if (planSha256 !== sha256Canonical(unsigned))
    throw new TypeError("El hash canónico del plan no coincide");
  return plan;
}
function checkedRequest(value: unknown): NormalizedRequest {
  const request = validateSchema<NormalizedRequest>(
    "normalized-request",
    value,
  );
  const { inputSha256, ...unsigned } = request;
  if (inputSha256 !== sha256Canonical(unsigned))
    throw new TypeError("El hash canónico de la request no coincide");
  return request;
}
async function bindInputs(
  requestPath: string,
  planPath: string,
  policyPath: string,
  approved: ChangePlan,
): Promise<void> {
  const [requestBytes, planBytes, policyBytes] = await Promise.all([
    bytes(requestPath),
    bytes(planPath),
    bytes(policyPath),
  ]);
  let request: unknown;
  let plan: unknown;
  try {
    request = JSON.parse(requestBytes.toString("utf8"));
    plan = JSON.parse(planBytes.toString("utf8"));
    JSON.parse(policyBytes.toString("utf8"));
  } catch {
    throw new TypeError(
      "La entrada copiada del agente no contiene JSON válido",
    );
  }
  const normalized = checkedRequest(request);
  const copied = checkedPlan(plan);
  if (
    normalized.inputSha256 !== approved.requestSha256 ||
    copied.planSha256 !== approved.planSha256 ||
    canonicalJson(copied) !== canonicalJson(approved)
  ) {
    throw new TypeError(
      "La request o el plan copiado no coincide con el plan aprobado",
    );
  }
}
async function inputHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(await bytes(join(path, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
type ScannerIdentity = { device: string; inode: string };
type ScannerMetadata = ScannerIdentity & {
  mode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
};
type ScannerDirectory = ScannerMetadata;
type ScannerEntry = ScannerMetadata & {
  name: string;
  type: "D" | "F" | "S" | "X";
};
type ScannerDirectoryResult = {
  kind: "directory";
  directory: ScannerDirectory;
  entries: ScannerEntry[];
};
type ScannerLeafResult = {
  kind: "leaf";
  digest: string;
  metadata: ScannerMetadata;
};
const scannerIdentity = (identity: {
  device: number | string;
  inode: number | string;
}): ScannerIdentity => ({
  device: String(identity.device),
  inode: String(identity.inode),
});
const safeScannerName = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\0");
const equalScannerIdentity = (left: ScannerIdentity, right: ScannerIdentity) =>
  left.device === right.device && left.inode === right.inode;
const scannerObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("El scanner de servicio devolvió un objeto no válido");
  return value as Record<string, unknown>;
};
const closedKeys = (value: Record<string, unknown>, keys: string[]) => {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw new TypeError("El scanner de servicio devolvió campos no válidos");
};
const scannerIdentityValue = (value: unknown): ScannerIdentity => {
  const object = scannerObject(value);
  closedKeys(object, ["device", "inode"]);
  if (
    typeof object.device !== "string" ||
    !/^\d+$/u.test(object.device) ||
    typeof object.inode !== "string" ||
    !/^\d+$/u.test(object.inode)
  )
    throw new TypeError(
      "El scanner de servicio devolvió una identidad no válida",
    );
  return { device: object.device, inode: object.inode };
};
const scannerMetadataValue = (value: unknown): ScannerMetadata => {
  const object = scannerObject(value);
  closedKeys(object, [
    "device",
    "inode",
    "mode",
    "size",
    "mtimeNs",
    "ctimeNs",
    "nlink",
  ]);
  const identity = scannerIdentityValue({
    device: object.device,
    inode: object.inode,
  });
  if (
    ![
      object.mode,
      object.size,
      object.mtimeNs,
      object.ctimeNs,
      object.nlink,
    ].every((field) => typeof field === "string" && /^\d+$/u.test(field))
  )
    throw new TypeError("El scanner de servicio devolvió metadatos no válidos");
  return {
    ...identity,
    mode: object.mode as string,
    size: object.size as string,
    mtimeNs: object.mtimeNs as string,
    ctimeNs: object.ctimeNs as string,
    nlink: object.nlink as string,
  };
};
const sameScannerMetadata = (left: ScannerMetadata, right: ScannerMetadata) =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.nlink === right.nlink;
async function runManifestScanner(
  cwd: string,
  input: Record<string, unknown>,
  afterRead?: () => Promise<void> | void,
): Promise<unknown> {
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [manifestScanner], {
      cwd,
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let result: unknown;
    let settled = false;
    const reject = (error: unknown) => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectResult(error);
    };
    const line = (raw: string) => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        reject(new TypeError("El scanner de servicio no devolvió JSON válido"));
        return;
      }
      const object = scannerObject(value);
      if (object.event === "after-read") {
        if (!afterRead) {
          reject(
            new TypeError("El scanner de servicio pidió una pausa no válida"),
          );
          return;
        }
        Promise.resolve(afterRead()).then(
          () => child.stdin.end("continue\n"),
          reject,
        );
        return;
      }
      result = value;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const raw = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (raw) line(raw);
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      let object: Record<string, unknown> | undefined;
      try {
        object = result === undefined ? undefined : scannerObject(result);
      } catch (error) {
        rejectResult(error);
        return;
      }
      const scannerError = object?.error;
      if (code !== 0 || scannerError)
        rejectResult(
          new TypeError(
            typeof scannerError === "string"
              ? scannerError
              : `El scanner de servicio falló: ${stderr || code}`,
          ),
        );
      else if (result === undefined)
        rejectResult(
          new TypeError("El scanner de servicio no devolvió resultado"),
        );
      else resolveResult(result);
    });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    if (!afterRead) child.stdin.end();
  });
}
async function scanDirectory(
  path: string,
  expected: ScannerIdentity,
): Promise<ScannerDirectoryResult> {
  const value = scannerObject(
    await runManifestScanner(path, { action: "directory", expected }),
  );
  closedKeys(value, ["kind", "directory", "entries"]);
  if (value.kind !== "directory" || !Array.isArray(value.entries))
    throw new TypeError(
      "El scanner de directorio devolvió un resultado no válido",
    );
  const directory = scannerObject(value.directory);
  const metadata = scannerMetadataValue(directory);
  if (!equalScannerIdentity(metadata, expected))
    throw new TypeError("La identidad del directorio de servicio cambió");
  const entries = value.entries.map((value): ScannerEntry => {
    const entry = scannerObject(value);
    closedKeys(entry, [
      "name",
      "type",
      "device",
      "inode",
      "mode",
      "size",
      "mtimeNs",
      "ctimeNs",
      "nlink",
    ]);
    const entryMetadata = scannerMetadataValue({
      device: entry.device,
      inode: entry.inode,
      mode: entry.mode,
      size: entry.size,
      mtimeNs: entry.mtimeNs,
      ctimeNs: entry.ctimeNs,
      nlink: entry.nlink,
    });
    if (
      !safeScannerName(entry.name) ||
      !["D", "F", "S", "X"].includes(String(entry.type))
    )
      throw new TypeError(
        "El scanner de servicio devolvió una entrada no válida",
      );
    return {
      name: entry.name,
      type: entry.type as ScannerEntry["type"],
      ...entryMetadata,
    };
  });
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
    throw new TypeError("El scanner de servicio devolvió nombres duplicados");
  return {
    kind: "directory",
    directory: metadata,
    entries,
  };
}
async function scanLeaf(
  parent: string,
  parentIdentity: ScannerIdentity,
  entry: ScannerEntry,
  afterRead?: () => Promise<void> | void,
): Promise<ScannerLeafResult> {
  const value = scannerObject(
    await runManifestScanner(
      parent,
      {
        action: "leaf",
        name: entry.name,
        expected: scannerIdentity(entry),
        cwdExpected: parentIdentity,
        pause: afterRead !== undefined,
      },
      afterRead,
    ),
  );
  closedKeys(value, ["kind", "digest", "metadata"]);
  if (
    value.kind !== "leaf" ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest)
  )
    throw new TypeError(
      "El scanner de archivo devolvió un resultado no válido",
    );
  const metadata = scannerMetadataValue(value.metadata);
  if (!sameScannerMetadata(metadata, entry))
    throw new TypeError("Los metadatos del archivo de servicio cambiaron");
  return { kind: "leaf", digest: value.digest, metadata };
}
const sameDirectoryScan = (
  left: ScannerDirectoryResult,
  right: ScannerDirectoryResult,
) =>
  sameScannerMetadata(left.directory, right.directory) &&
  JSON.stringify(left.entries) === JSON.stringify(right.entries);
const manifestMetadata = (metadata: ScannerMetadata) =>
  [
    metadata.device,
    metadata.inode,
    metadata.mode,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
    metadata.nlink,
  ].join("\0");
async function captureServiceEntries(
  repositoryRoot: string,
  excluded: string[],
  hooks?: WorktreeTestHooks,
): Promise<string> {
  const lines: string[] = [];
  const skip = excluded.map((path) => resolve(path));
  const repository = await lstat(repositoryRoot);
  if (repository.isSymbolicLink() || !repository.isDirectory())
    throw new TypeError("La raíz del manifiesto de servicio no es segura");
  const rootScan = await scanDirectory(
    repositoryRoot,
    scannerIdentity({ device: repository.dev, inode: repository.ino }),
  );
  const visit = async (
    parentPath: string,
    parent: ScannerDirectoryResult,
    label: string,
    entry: ScannerEntry,
  ): Promise<boolean> => {
    if (skip.some((root) => label === root || label.startsWith(`${root}/`)))
      return false;
    if (entry.type === "S") {
      lines.push(
        `S\0${relative(repositoryRoot, label)}\0${manifestMetadata(entry)}`,
      );
      return true;
    }
    if (entry.type === "X")
      throw new TypeError(
        "El manifiesto de servicio contiene una entrada no regular",
      );
    if (entry.type === "F") {
      const leaf = await scanLeaf(
        parentPath,
        parent.directory,
        entry,
        hooks?.afterServiceFileRead
          ? () => hooks.afterServiceFileRead!(label)
          : undefined,
      );
      lines.push(
        `F\0${relative(repositoryRoot, label)}\0${manifestMetadata(leaf.metadata)}\0${leaf.digest}`,
      );
      return true;
    }
    const path = join(parentPath, entry.name);
    const initial = await scanDirectory(path, scannerIdentity(entry));
    const recheck = async () => {
      const current = await scanDirectory(path, scannerIdentity(entry));
      if (!sameDirectoryScan(initial, current))
        throw new TypeError("La enumeración del directorio de servicio cambió");
    };
    await hooks?.beforeServiceDirectoryRead?.(label);
    await recheck();
    await hooks?.afterServiceDirectoryRead?.(label);
    await recheck();
    for (const child of initial.entries) {
      await recheck();
      await hooks?.beforeServiceChildTraversal?.(label, child.name);
      try {
        await recheck();
        await visit(path, initial, join(label, child.name), child);
      } finally {
        await hooks?.afterServiceChildTraversal?.(label, child.name);
      }
      await recheck();
    }
    await recheck();
    lines.push(
      `D\0${relative(repositoryRoot, label)}\0${manifestMetadata(entry)}`,
    );
    await hooks?.afterServiceDirectoryEntry?.(label);
    return true;
  };
  for (const name of [".agent-worktrees", ".agent-quarantine"]) {
    const entry = rootScan.entries.find((entry) => entry.name === name);
    if (entry)
      await visit(repositoryRoot, rootScan, join(repositoryRoot, name), entry);
  }
  const finalRoot = await scanDirectory(
    repositoryRoot,
    scannerIdentity(rootScan.directory),
  );
  if (!sameDirectoryScan(rootScan, finalRoot))
    throw new TypeError("La enumeración del directorio de servicio cambió");
  return lines.sort().join("\n");
}
async function serviceEntries(
  repositoryRoot: string,
  excluded: string[] = [],
): Promise<string> {
  const first = await captureServiceEntries(
    repositoryRoot,
    excluded,
    testHooks,
  );
  const second = await captureServiceEntries(repositoryRoot, excluded);
  if (first !== second)
    throw new TypeError("El manifiesto de servicio cambió durante la captura");
  return first;
}
export async function gitSnapshot(
  path: string,
  excludedServicePaths: string[] = [],
): Promise<GitSnapshot> {
  const entries = await serviceEntries(path, excludedServicePaths);
  const head = await git(path, ["rev-parse", "HEAD"]);
  const refs = await git(path, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  await testHooks.beforeGitSnapshotStatus?.(path);
  const status = await git(path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  const finalHead = await git(path, ["rev-parse", "HEAD"]);
  const finalRefs = await git(path, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  if (head !== finalHead || refs !== finalRefs)
    throw new TypeError("El estado Git cambió durante el snapshot");
  return {
    head,
    refs,
    status,
    serviceEntries: entries,
  };
}
async function candidateGit(
  record: CandidateGitScope,
  args: string[],
): Promise<string> {
  await assertCandidateGitAuthority(record);
  const result = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "--git-dir",
      record.gitAuthority.gitDirectory,
      "--work-tree",
      record.path,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...sanitizedGitEnv(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return result.stdout.trim();
}
async function candidateGitSnapshot(
  record: CandidateGitScope,
): Promise<GitSnapshot> {
  await assertCandidateGitAuthority(record);
  const service = await serviceEntries(record.path);
  const head = await candidateGit(record, ["rev-parse", "HEAD"]);
  const refs = await candidateGit(record, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  await testHooks.beforeGitSnapshotStatus?.(record.path);
  const status = await candidateGit(record, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  const finalHead = await candidateGit(record, ["rev-parse", "HEAD"]);
  const finalRefs = await candidateGit(record, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  if (head !== finalHead || refs !== finalRefs)
    throw new TypeError("El estado Git candidato cambió durante el snapshot");
  return { head, refs, status, serviceEntries: service };
}
async function registered(
  repositoryRoot: string,
  path: string,
): Promise<boolean> {
  return (await git(repositoryRoot, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .includes(`worktree ${path}`);
}
async function sidecar(
  _rootPath: string,
  changeId: string,
  attemptId: string,
): Promise<string> {
  return await realpath(
    await mkdtemp(
      join(tmpdir(), `comunidadsolar-agent-${changeId}-${attemptId}-`),
    ),
  );
}
/** Candidate ownership is only minted after Git registration and identity checks. */
export async function createCandidateWorktree(
  input: CandidateWorktreeInput,
): Promise<CandidateWorktree> {
  safeId(input.changeId, "changeId");
  safeId(input.attemptId, "attemptId");
  safeCommit(input.baselineCommit);
  const approved = checkedPlan(input.approvedPlan);
  if (
    approved.changeId !== input.changeId ||
    approved.baselineCommit !== input.baselineCommit
  )
    throw new TypeError("El plan aprobado no corresponde al intento candidato");
  const repositoryRoot = await root(input.repositoryRoot);
  const sourceRepositoryRoot = await root(
    input.sourceRepositoryRoot ?? input.repositoryRoot,
  );
  if (
    (await git(repositoryRoot, ["rev-parse", "refs/heads/main"])) !==
    input.baselineCommit
  )
    throw new TypeError("El baseline aprobado no coincide con refs/heads/main");
  await bindInputs(
    input.requestPath,
    input.planPath,
    input.policyPath,
    approved,
  );
  const base = await directory(
    join(repositoryRoot, ".agent-worktrees"),
    repositoryRoot,
  );
  const parent = await directory(join(base, input.changeId), base);
  const path = join(parent, input.attemptId);
  await vacant(path);
  // Establish service-owned parents before preflight. They are then stable
  // manifest entries rather than apparent drift caused by candidate setup.
  const beforeRepository = await gitSnapshot(repositoryRoot, [
    ...ownedQuarantines,
  ]);
  const beforeSource = await gitSnapshot(
    sourceRepositoryRoot,
    sourceRepositoryRoot === repositoryRoot ? [...ownedQuarantines] : [],
  );
  const branch = `candidate/${input.changeId}/${input.attemptId}`;
  const ref = `refs/heads/${branch}`;
  let candidate: CandidateWorktree | undefined;
  let reserved = false;
  try {
    // Reserve the exact ref before worktree creation: no post-registration
    // switch/create step can collide with another candidate attempt.
    await git(repositoryRoot, ["update-ref", ref, input.baselineCommit, ""]);
    reserved = true;
    await execFileAsync(
      "git",
      ["-C", repositoryRoot, "worktree", "add", path, branch],
      { encoding: "utf8", env: sanitizedGitEnv() },
    );
    if (!(await registered(repositoryRoot, path)))
      throw new TypeError("Git no registró el worktree candidato");
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (await realpath(path)) !== path
    )
      throw new TypeError("El worktree candidato no es seguro");
    const gitAuthority = await candidateGitAuthority(repositoryRoot, path);
    candidate = {
      path,
      outputDirectory: "",
      repositoryRoot,
      sourceRepositoryRoot,
      changeId: input.changeId,
      attemptId: input.attemptId,
      baselineCommit: input.baselineCommit,
      branch,
      inputHash: "",
      requestSha256: approved.requestSha256,
      planSha256: approved.planSha256,
    };
    // This record exists before any post-add work. All failure paths below use
    // the same reconciled cleanup rather than forgetting a registered worktree.
    records.set(
      candidate,
      Object.freeze({
        ...candidate,
        identity: { device: entry.dev, inode: entry.ino },
        gitAuthority,
        approvedPlan: Object.freeze({ ...approved }),
        repositorySnapshot: frozenSnapshot(await gitSnapshot(repositoryRoot)),
        sourceSnapshot: frozenSnapshot(await gitSnapshot(sourceRepositoryRoot)),
        candidateSnapshot: frozenSnapshot(
          await candidateGitSnapshot({ path, repositoryRoot, gitAuthority }),
        ),
      }),
    );
    owned.add(candidate);
    await testHooks.afterRegistration?.();
    const outputDirectory = await sidecar(
      repositoryRoot,
      input.changeId,
      input.attemptId,
    );
    const outputEntry = await lstat(outputDirectory);
    candidate.outputDirectory = outputDirectory;
    const withSidecar = Object.freeze({
      ...(records.get(candidate) as CandidateRecord),
      outputDirectory,
      outputIdentity: { device: outputEntry.dev, inode: outputEntry.ino },
    });
    records.set(candidate, withSidecar);
    const inputs = await directory(join(path, ".agent-input"), path);
    await Promise.all([
      cp(input.requestPath, join(inputs, names[0]), {
        dereference: false,
        errorOnExist: true,
      }),
      cp(input.planPath, join(inputs, names[1]), {
        dereference: false,
        errorOnExist: true,
      }),
      cp(input.policyPath, join(inputs, names[2]), {
        dereference: false,
        errorOnExist: true,
      }),
    ]);
    await bindInputs(
      join(inputs, names[0]),
      join(inputs, names[1]),
      join(inputs, names[2]),
      approved,
    );
    const inputDirectoryIdentity = await directoryIdentity(inputs);
    const inputIdentities = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name,
          await fileIdentity(join(inputs, name)),
        ]),
      ),
    ) as Record<(typeof names)[number], Identity>;
    candidate.inputHash = await inputHash(inputs);
    await testHooks.beforeSetupSnapshot?.();
    const complete = Object.freeze({
      ...candidate,
      identity: { device: entry.dev, inode: entry.ino },
      gitAuthority,
      approvedPlan: Object.freeze({ ...approved }),
      repositorySnapshot: frozenSnapshot(
        await gitSnapshot(repositoryRoot, [path, ...ownedQuarantines]),
      ),
      sourceSnapshot: frozenSnapshot(
        await gitSnapshot(
          sourceRepositoryRoot,
          sourceRepositoryRoot === repositoryRoot
            ? [path, ...ownedQuarantines]
            : [],
        ),
      ),
      candidateSnapshot: frozenSnapshot(
        await candidateGitSnapshot({ path, repositoryRoot, gitAuthority }),
      ),
      outputIdentity: { device: outputEntry.dev, inode: outputEntry.ino },
      inputDirectoryIdentity,
      inputIdentities,
    });
    const candidateRef = `refs/heads/${branch}\0${input.baselineCommit}`;
    const withoutCandidateRef = (refs: string) =>
      refs
        .split("\n")
        .filter((entry) => entry !== candidateRef)
        .join("\n");
    const setupDrift = [
      withoutCandidateRef(complete.repositorySnapshot.refs) !==
        beforeRepository.refs,
      complete.repositorySnapshot.head !== beforeRepository.head,
      withoutOwnedStatusPaths(
        complete.repositorySnapshot.status,
        repositoryRoot,
        [path, ...ownedQuarantines],
      ) !==
        withoutOwnedStatusPaths(beforeRepository.status, repositoryRoot, [
          path,
          ...ownedQuarantines,
        ]),
      withoutCandidateAncestorMetadata(
        complete.repositorySnapshot.serviceEntries,
        repositoryRoot,
        path,
      ) !==
        withoutCandidateAncestorMetadata(
          beforeRepository.serviceEntries,
          repositoryRoot,
          path,
        ),
      withoutCandidateRef(complete.sourceSnapshot.refs) !== beforeSource.refs,
      complete.sourceSnapshot.head !== beforeSource.head,
      withoutOwnedStatusPaths(
        complete.sourceSnapshot.status,
        sourceRepositoryRoot,
        [path, ...ownedQuarantines],
      ) !==
        withoutOwnedStatusPaths(beforeSource.status, sourceRepositoryRoot, [
          path,
          ...ownedQuarantines,
        ]),
      withoutCandidateAncestorMetadata(
        complete.sourceSnapshot.serviceEntries,
        sourceRepositoryRoot,
        path,
      ) !==
        withoutCandidateAncestorMetadata(
          beforeSource.serviceEntries,
          sourceRepositoryRoot,
          path,
        ),
    ];
    if (setupDrift.some(Boolean)) {
      throw new TypeError(
        "Las refs protegidas cambiaron durante la creación del candidato",
      );
    }
    records.set(candidate, complete);
    Object.freeze(candidate);
    return candidate;
  } catch (error) {
    if (candidate) {
      try {
        await removeCandidateWorktree(candidate);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `La preparación del candidato falló y requiere reconciliación: ${path}`,
        );
      }
    } else if (reserved) {
      // Ref reservation happened before the worktree existed. Delete only the
      // exact baseline-valued reservation; an unexpected value is retained.
      const oid = await git(repositoryRoot, [
        "rev-parse",
        "--verify",
        ref,
      ]).catch(() => "");
      if (oid === input.baselineCommit)
        await git(repositoryRoot, [
          "update-ref",
          "-d",
          ref,
          input.baselineCommit,
        ]);
    }
    throw error;
  }
}
const equalIdentity = (a: Identity, b: Identity) =>
  a.device === b.device && a.inode === b.inode;
async function assertOwned(candidate: CandidateWorktree): Promise<void> {
  const record = records.get(candidate);
  if (!owned.has(candidate) || record === undefined)
    throw new TypeError("El worktree no pertenece a este servicio");
  const expected = join(
    record.repositoryRoot,
    ".agent-worktrees",
    record.changeId,
    record.attemptId,
  );
  if (record.path !== expected)
    throw new TypeError("La limpieza no reconoce ese worktree");
  const entry = await lstat(record.path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    !equalIdentity(record.identity, {
      device: entry.dev,
      inode: entry.ino,
    }) ||
    (await realpath(record.path)) !== record.path ||
    !(await registered(record.repositoryRoot, record.path))
  )
    throw new TypeError("La identidad del worktree candidato ha cambiado");
  await assertCandidateGitAuthority(record);
}
async function assertOwnedOutput(candidate: CandidateWorktree): Promise<void> {
  const record = records.get(candidate);
  if (!owned.has(candidate) || record === undefined)
    throw new TypeError("El worktree no pertenece a este servicio");
  if (!record.outputIdentity)
    throw new TypeError("La salida del candidato aún no fue reconciliada");
  const output = await realpath(record.outputDirectory);
  const entry = await lstat(output);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    output !== record.outputDirectory ||
    !equalIdentity(record.outputIdentity, {
      device: entry.dev,
      inode: entry.ino,
    })
  ) {
    throw new TypeError("La identidad de la salida del agente ha cambiado");
  }
}
async function assertOwnedInputs(candidate: CandidateWorktree): Promise<void> {
  const record = records.get(candidate);
  if (!owned.has(candidate) || record === undefined)
    throw new TypeError("El worktree no pertenece a este servicio");
  if (!record.inputDirectoryIdentity || !record.inputIdentities)
    throw new TypeError("La entrada del candidato aún no fue reconciliada");
  const inputs = join(record.path, ".agent-input");
  const entry = await lstat(inputs);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(inputs)) !== inputs ||
    !equalIdentity(record.inputDirectoryIdentity, {
      device: entry.dev,
      inode: entry.ino,
    })
  ) {
    throw new TypeError("La identidad de la entrada del agente ha cambiado");
  }
  for (const name of names) {
    if (
      !equalIdentity(
        record.inputIdentities[name],
        await fileIdentity(join(inputs, name)),
      )
    )
      throw new TypeError("La identidad de la entrada del agente ha cambiado");
  }
}
async function removeOwnedSidecar(
  record: Readonly<CandidateRecord>,
): Promise<void> {
  if (!record.outputIdentity) return;
  const quarantine = await realpath(
    await mkdtemp(join(dirname(record.outputDirectory), ".agent-sidecar-")),
  );
  const entry = await lstat(record.outputDirectory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(record.outputDirectory)) !== record.outputDirectory ||
    !equalIdentity(record.outputIdentity, {
      device: entry.dev,
      inode: entry.ino,
    })
  )
    throw new TypeError("La identidad de la salida del agente ha cambiado");
  // Keep the target on the same filesystem as the sidecar, then delete only
  // the atomically moved, service-owned leaf.
  const moved = join(quarantine, "sidecar");
  await rename(record.outputDirectory, moved);
  await testHooks.beforeSidecarDelete?.(moved);
  const movedEntry = await lstat(moved);
  if (
    movedEntry.isSymbolicLink() ||
    !movedEntry.isDirectory() ||
    !equalIdentity(record.outputIdentity, {
      device: movedEntry.dev,
      inode: movedEntry.ino,
    }) ||
    (await realpath(moved)) !== moved
  )
    throw new TypeError("La cuarentena de salida del agente ha cambiado");
  await rm(moved, { recursive: true, force: false });
  await rmdir(quarantine);
}
async function assertQuarantinedCandidate(
  record: Readonly<CandidateRecord>,
  path: string,
): Promise<void> {
  const entry = await lstat(path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    !equalIdentity(record.identity, { device: entry.dev, inode: entry.ino }) ||
    (await realpath(path)) !== path
  )
    throw new TypeError("La cuarentena del worktree candidato ha cambiado");
}
export async function candidateRecord(
  candidate: CandidateWorktree,
): Promise<Readonly<CandidateRecord>> {
  await assertOwned(candidate);
  const record = records.get(candidate);
  if (!record) throw new TypeError("El worktree no pertenece a este servicio");
  return record;
}
export async function assertCandidateServiceManifest(
  candidate: CandidateWorktree,
): Promise<void> {
  const record = await candidateRecord(candidate);
  const [repository, source] = await Promise.all([
    gitSnapshot(record.repositoryRoot, [record.path, ...ownedQuarantines]),
    gitSnapshot(
      record.sourceRepositoryRoot,
      record.sourceRepositoryRoot === record.repositoryRoot
        ? [record.path, ...ownedQuarantines]
        : [],
    ),
  ]);
  if (
    repository.serviceEntries !== record.repositorySnapshot.serviceEntries ||
    source.serviceEntries !== record.sourceSnapshot.serviceEntries
  )
    throw new TypeError("El manifiesto de servicio externo cambió");
}
export async function removeCandidateWorktree(
  candidate: CandidateWorktree,
): Promise<void> {
  if (released.has(candidate)) return;
  if (!owned.has(candidate))
    throw new TypeError("El worktree no pertenece a este servicio");
  const moved = quarantinedCandidates.get(candidate);
  const record = moved
    ? records.get(candidate)
    : await candidateRecord(candidate);
  if (!record) throw new TypeError("El worktree no pertenece a este servicio");
  if (moved) {
    await assertQuarantinedCandidate(record, moved);
  }
  if (record.outputIdentity) await assertOwnedOutput(candidate);
  const quarantineBase = await directory(
    join(record.repositoryRoot, ".agent-quarantine"),
    record.repositoryRoot,
  );
  const quarantineChange = await directory(
    join(quarantineBase, record.changeId),
    quarantineBase,
  );
  if (!moved) {
    const quarantined = join(
      quarantineChange,
      `${record.attemptId}-${randomUUID()}`,
    );
    // Atomic same-filesystem move: a swapped leaf is quarantined, never erased.
    await rename(record.path, quarantined);
    quarantinedCandidates.set(candidate, quarantined);
    ownedQuarantines.add(quarantined);
    await testHooks.afterCandidateQuarantine?.(quarantined);
    // Do not prune Git metadata, release a ref, or touch the sidecar until the
    // atomically moved leaf is proved to retain the record's exact identity.
    await assertQuarantinedCandidate(record, quarantined);
  }
  await execFileAsync(
    "git",
    ["-C", record.repositoryRoot, "worktree", "prune"],
    { encoding: "utf8", env: sanitizedGitEnv() },
  );
  if (await registered(record.repositoryRoot, record.path))
    throw new TypeError("Git no liberó el registro del worktree candidato");
  const ref = `refs/heads/${record.branch}`;
  const oid = await git(record.repositoryRoot, [
    "rev-parse",
    "--verify",
    ref,
  ]).catch(() => "");
  if (oid === record.baselineCommit) {
    await git(record.repositoryRoot, ["update-ref", "-d", ref, oid]);
  }
  if (oid && oid !== record.baselineCommit)
    throw new TypeError(
      "La ref candidata cambió y quedó en cuarentena sin reconciliar",
    );
  const residual = await git(record.repositoryRoot, [
    "rev-parse",
    "--verify",
    ref,
  ]).catch(() => "");
  if (residual) throw new TypeError("Git no liberó la ref del candidato");
  await removeOwnedSidecar(record);
  owned.delete(candidate);
  records.delete(candidate);
  quarantinedCandidates.delete(candidate);
  released.add(candidate);
}
export async function validateCopiedInputs(
  candidate: CandidateWorktree,
  plan: ChangePlan,
): Promise<void> {
  const record = await candidateRecord(candidate);
  await assertOwnedInputs(candidate);
  const approved = checkedPlan(plan);
  if (
    approved.planSha256 !== record.planSha256 ||
    approved.requestSha256 !== record.requestSha256
  )
    throw new TypeError("El plan aprobado no corresponde al candidato");
  const inputs = join(record.path, ".agent-input");
  await bindInputs(
    join(inputs, names[0]),
    join(inputs, names[1]),
    join(inputs, names[2]),
    approved,
  );
  if ((await inputHash(inputs)) !== record.inputHash)
    throw new TypeError("La entrada del agente cambió después del aislamiento");
}
export async function candidateValidationSnapshots(
  candidate: CandidateWorktree,
): Promise<[GitSnapshot, GitSnapshot, GitSnapshot]> {
  const record = await candidateRecord(candidate);
  const capture = async (
    hooks: boolean,
  ): Promise<[GitSnapshot, GitSnapshot, GitSnapshot]> => {
    const candidateSnapshot = await candidateGitSnapshot(record);
    if (hooks) await testHooks.afterCandidateValidationSnapshot?.("candidate");
    const repositorySnapshot = await gitSnapshot(record.repositoryRoot, [
      record.path,
      ...ownedQuarantines,
    ]);
    if (hooks) await testHooks.afterCandidateValidationSnapshot?.("repository");
    const sourceSnapshot = await gitSnapshot(
      record.sourceRepositoryRoot,
      record.sourceRepositoryRoot === record.repositoryRoot
        ? [record.path, ...ownedQuarantines]
        : [],
    );
    if (hooks) await testHooks.afterCandidateValidationSnapshot?.("source");
    return [candidateSnapshot, repositorySnapshot, sourceSnapshot];
  };
  // A single stable read for each repository is insufficient: another state
  // may move while a later authority is being inspected. Require the complete
  // ordered triple to repeat unchanged immediately before paths are derived.
  const first = await capture(true);
  const second = await capture(false);
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new TypeError(
      "Los snapshots Git protegidos cambiaron durante la validación",
    );
  return second;
}
export async function worktreeGit(
  candidate: CandidateWorktree,
  args: string[],
): Promise<string> {
  return await candidateGit(await candidateRecord(candidate), args);
}
export async function worktreeStatus(
  candidate: CandidateWorktree,
): Promise<string> {
  return (await candidateGitSnapshot(await candidateRecord(candidate))).status;
}
export async function externalSnapshot(path: string): Promise<GitSnapshot> {
  return await gitSnapshot(path);
}
export async function assertCandidateOwnership(
  candidate: CandidateWorktree,
): Promise<void> {
  await assertOwned(candidate);
}

/** Mint the only adapter input accepted at runtime for this owned candidate. */
export async function createAgentRunContext(
  candidate: CandidateWorktree,
): Promise<import("../agents/types.ts").AgentRunInput> {
  const record = await candidateRecord(candidate);
  await validateCopiedInputs(candidate, record.approvedPlan);
  await assertOwnedOutput(candidate);
  const schema = await schemaIdentity();
  const value = Object.freeze({
    changeId: record.changeId,
    attemptId: record.attemptId,
    worktree: record.path,
    requestPath: join(record.path, ".agent-input", names[0]),
    planPath: join(record.path, ".agent-input", names[1]),
    policyPath: join(record.path, ".agent-input", names[2]),
    resultSchemaPath: schema.path,
    outputDirectory: record.outputDirectory,
  });
  runContexts.set(value, Object.freeze({ candidate, schema }));
  return value;
}

export async function resolveAgentRunContext(
  value: import("../agents/types.ts").AgentRunInput,
): Promise<import("../agents/types.ts").AgentRunInput> {
  const context = runContexts.get(value);
  if (context === undefined)
    throw new TypeError(
      "El contexto de ejecución del agente no fue emitido por el servicio",
    );
  if (context === null) return value;
  const record = await candidateRecord(context.candidate);
  await validateCopiedInputs(context.candidate, record.approvedPlan);
  await assertOwnedOutput(context.candidate);
  await assertSchemaIdentity(context.schema);
  if (
    value.worktree !== record.path ||
    value.requestPath !== join(record.path, ".agent-input", names[0]) ||
    value.planPath !== join(record.path, ".agent-input", names[1]) ||
    value.policyPath !== join(record.path, ".agent-input", names[2]) ||
    value.resultSchemaPath !== context.schema.path ||
    value.outputDirectory !== record.outputDirectory
  )
    throw new TypeError("El contexto de ejecución del agente fue sustituido");
  return value;
}

/** Test-only adapter capability; unavailable outside explicit test mode. */
export function createTestAgentRunContext(
  input: import("../agents/types.ts").AgentRunInput,
): import("../agents/types.ts").AgentRunInput {
  if (process.env.INGEST_TEST_MODE !== "true")
    throw new TypeError("El contexto fixture exige modo de prueba");
  const value = Object.freeze({ ...input });
  runContexts.set(value, null);
  return value;
}
