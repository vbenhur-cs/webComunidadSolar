import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
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
interface WorktreeTestHooks {
  afterRegistration?(): Promise<void> | void;
  beforeSidecarDelete?(path: string): Promise<void> | void;
  beforeSetupSnapshot?(): Promise<void> | void;
  beforeServiceDirectoryRead?(path: string): Promise<void> | void;
  afterServiceDirectoryRead?(path: string): Promise<void> | void;
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
async function serviceEntries(
  repositoryRoot: string,
  excluded: string[],
): Promise<string> {
  const lines: string[] = [];
  const skip = excluded.map((path) => resolve(path));
  const assertDirectory = async (path: string, identity: Identity) => {
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !equalIdentity(identity, { device: entry.dev, inode: entry.ino }) ||
      (await realpath(path)) !== path
    )
      throw new TypeError("La identidad del directorio de servicio cambió");
  };
  const regularDigest = async (path: string, identity: Identity) => {
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !equalIdentity(identity, { device: before.dev, inode: before.ino })
    )
      throw new TypeError("La identidad del archivo de servicio cambió");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: Buffer;
    try {
      content = await handle.readFile();
    } finally {
      await handle.close();
    }
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !equalIdentity(identity, { device: after.dev, inode: after.ino })
    )
      throw new TypeError("La identidad del archivo de servicio cambió");
    return createHash("sha256").update(content).digest("hex");
  };
  const visit = async (path: string): Promise<boolean> => {
    if (skip.some((root) => path === root || path.startsWith(`${root}/`)))
      return false;
    const entry = await lstat(path);
    const identity = { device: entry.dev, inode: entry.ino };
    if (entry.isSymbolicLink()) {
      lines.push(
        `S\0${relative(repositoryRoot, path)}\0${entry.dev}\0${entry.ino}`,
      );
      return true;
    }
    if (!entry.isDirectory()) {
      if (!entry.isFile())
        throw new TypeError(
          "El manifiesto de servicio contiene una entrada no regular",
        );
      lines.push(
        `F\0${relative(repositoryRoot, path)}\0${entry.dev}\0${entry.ino}\0${await regularDigest(path, identity)}`,
      );
      return true;
    }
    await assertDirectory(path, identity);
    await testHooks.beforeServiceDirectoryRead?.(path);
    await assertDirectory(path, identity);
    const children = await readdir(path);
    await assertDirectory(path, identity);
    await testHooks.afterServiceDirectoryRead?.(path);
    await assertDirectory(path, identity);
    for (const child of children) {
      await assertDirectory(path, identity);
      await visit(join(path, child));
      await assertDirectory(path, identity);
    }
    // Directories are first-class manifest entries, including empty service
    // directories and ancestors containing only an owned excluded leaf. This
    // keeps a pre-existing service parent stable while still exposing any
    // unowned empty sibling or identity change.
    await assertDirectory(path, identity);
    lines.push(
      `D\0${relative(repositoryRoot, path)}\0${entry.dev}\0${entry.ino}`,
    );
    return true;
  };
  for (const root of [".agent-worktrees", ".agent-quarantine"]) {
    const path = join(repositoryRoot, root);
    if (await lstat(path).catch(() => undefined)) await visit(path);
  }
  return lines.sort().join("\n");
}
export async function gitSnapshot(
  path: string,
  excludedServicePaths: string[] = [],
): Promise<GitSnapshot> {
  const [head, refs, status] = await Promise.all([
    git(path, ["rev-parse", "HEAD"]),
    git(path, ["for-each-ref", "--format=%(refname)%00%(objectname)"]),
    git(path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
  ]);
  return {
    head,
    refs,
    status,
    serviceEntries: await serviceEntries(path, excludedServicePaths),
  };
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
        approvedPlan: Object.freeze({ ...approved }),
        repositorySnapshot: frozenSnapshot(await gitSnapshot(repositoryRoot)),
        sourceSnapshot: frozenSnapshot(await gitSnapshot(sourceRepositoryRoot)),
        candidateSnapshot: frozenSnapshot(await gitSnapshot(path)),
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
      candidateSnapshot: frozenSnapshot(await gitSnapshot(path)),
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
      complete.repositorySnapshot.serviceEntries !==
        beforeRepository.serviceEntries,
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
      complete.sourceSnapshot.serviceEntries !== beforeSource.serviceEntries,
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
    const entry = await lstat(moved);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !equalIdentity(record.identity, {
        device: entry.dev,
        inode: entry.ino,
      }) ||
      (await realpath(moved)) !== moved
    )
      throw new TypeError("La cuarentena del worktree candidato ha cambiado");
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
export async function worktreeGit(
  candidate: CandidateWorktree,
  args: string[],
): Promise<string> {
  await assertOwned(candidate);
  return await git(candidate.path, args);
}
export async function worktreeStatus(
  candidate: CandidateWorktree,
): Promise<string> {
  await assertOwned(candidate);
  return (await gitSnapshot(candidate.path)).status;
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
