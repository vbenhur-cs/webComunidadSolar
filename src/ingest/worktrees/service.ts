import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256Canonical } from "../canonical-json.ts";
import type { ChangePlan, NormalizedRequest } from "../domain.ts";
import { sanitizedGitEnv } from "../git-env.ts";
import { validateSchema } from "../schema-validator.ts";

const execFileAsync = promisify(execFile);
const names = ["request.json", "plan.json", "policy.json"] as const;
const owned = new WeakSet<CandidateWorktree>();
const runContexts = new WeakMap<object, CandidateWorktree | null>();
type Identity = { device: number; inode: number };
export interface GitSnapshot {
  head: string;
  refs: string;
  status: string;
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
  identity: Identity;
  repositorySnapshot: GitSnapshot;
  sourceSnapshot: GitSnapshot;
  candidateSnapshot: GitSnapshot;
  approvedPlan: ChangePlan;
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
export async function gitSnapshot(path: string): Promise<GitSnapshot> {
  const [head, refs, status] = await Promise.all([
    git(path, ["rev-parse", "HEAD"]),
    git(path, ["for-each-ref", "--format=%(refname)%00%(objectname)"]),
    git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  return { head, refs, status };
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
  const beforeRepository = await gitSnapshot(repositoryRoot);
  const beforeSource = await gitSnapshot(sourceRepositoryRoot);
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
  const branch = `candidate/${input.changeId}/${input.attemptId}`;
  let wasRegistered = false;
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        repositoryRoot,
        "worktree",
        "add",
        "--detach",
        path,
        input.baselineCommit,
      ],
      { encoding: "utf8", env: sanitizedGitEnv() },
    );
    wasRegistered = await registered(repositoryRoot, path);
    if (!wasRegistered)
      throw new TypeError("Git no registró el worktree candidato");
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (await realpath(path)) !== path
    )
      throw new TypeError("El worktree candidato no es seguro");
    await git(path, ["switch", "--quiet", "-c", branch]);
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
    const candidate: CandidateWorktree = {
      path,
      outputDirectory: await sidecar(
        repositoryRoot,
        input.changeId,
        input.attemptId,
      ),
      repositoryRoot,
      sourceRepositoryRoot,
      changeId: input.changeId,
      attemptId: input.attemptId,
      baselineCommit: input.baselineCommit,
      branch,
      inputHash: await inputHash(inputs),
      requestSha256: approved.requestSha256,
      planSha256: approved.planSha256,
      identity: { device: entry.dev, inode: entry.ino },
      repositorySnapshot: await gitSnapshot(repositoryRoot),
      sourceSnapshot: await gitSnapshot(sourceRepositoryRoot),
      candidateSnapshot: await gitSnapshot(path),
      approvedPlan: approved,
    };
    const candidateRef = `refs/heads/${branch}\0${input.baselineCommit}`;
    const withoutCandidateRef = (refs: string) =>
      refs
        .split("\n")
        .filter((entry) => entry !== candidateRef)
        .join("\n");
    if (
      withoutCandidateRef(candidate.repositorySnapshot.refs) !==
        beforeRepository.refs ||
      candidate.repositorySnapshot.head !== beforeRepository.head ||
      withoutCandidateRef(candidate.sourceSnapshot.refs) !==
        beforeSource.refs ||
      candidate.sourceSnapshot.head !== beforeSource.head
    ) {
      throw new TypeError(
        "Las refs protegidas cambiaron durante la creación del candidato",
      );
    }
    owned.add(candidate);
    return candidate;
  } catch (error) {
    // A partially-created path is quarantined for operator inspection.  Never
    // delete on a failure path: a pathname may have changed after registration.
    void wasRegistered;
    throw error;
  }
}
const equalIdentity = (a: Identity, b: Identity) =>
  a.device === b.device && a.inode === b.inode;
async function assertOwned(candidate: CandidateWorktree): Promise<void> {
  if (!owned.has(candidate))
    throw new TypeError("El worktree no pertenece a este servicio");
  const expected = join(
    candidate.repositoryRoot,
    ".agent-worktrees",
    candidate.changeId,
    candidate.attemptId,
  );
  if (candidate.path !== expected)
    throw new TypeError("La limpieza no reconoce ese worktree");
  const entry = await lstat(candidate.path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    !equalIdentity(candidate.identity, {
      device: entry.dev,
      inode: entry.ino,
    }) ||
    (await realpath(candidate.path)) !== candidate.path ||
    !(await registered(candidate.repositoryRoot, candidate.path))
  )
    throw new TypeError("La identidad del worktree candidato ha cambiado");
}
export async function removeCandidateWorktree(
  candidate: CandidateWorktree,
): Promise<void> {
  if (!(await lstat(candidate.path).catch(() => undefined))) return;
  if (!owned.has(candidate))
    throw new TypeError("El worktree no pertenece a este servicio");
  await assertOwned(candidate);
  await execFileAsync(
    "git",
    ["-C", candidate.repositoryRoot, "worktree", "remove", candidate.path],
    { encoding: "utf8", env: sanitizedGitEnv() },
  ).catch(() => undefined);
  // Dirty or identity-ambiguous candidates remain quarantined for an operator;
  // never escalate to --force or a recursive filesystem delete.
}
export async function validateCopiedInputs(
  candidate: CandidateWorktree,
  plan: ChangePlan,
): Promise<void> {
  await assertOwned(candidate);
  const approved = checkedPlan(plan);
  if (
    approved.planSha256 !== candidate.planSha256 ||
    approved.requestSha256 !== candidate.requestSha256
  )
    throw new TypeError("El plan aprobado no corresponde al candidato");
  const inputs = join(candidate.path, ".agent-input");
  await bindInputs(
    join(inputs, names[0]),
    join(inputs, names[1]),
    join(inputs, names[2]),
    approved,
  );
  if ((await inputHash(inputs)) !== candidate.inputHash)
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
  resultSchemaPath: string,
): Promise<import("../agents/types.ts").AgentRunInput> {
  await assertOwned(candidate);
  await validateCopiedInputs(candidate, candidate.approvedPlan);
  const output = await realpath(candidate.outputDirectory);
  const entry = await lstat(output);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    output !== candidate.outputDirectory
  )
    throw new TypeError("La salida del agente no es un directorio seguro");
  const value = Object.freeze({
    changeId: candidate.changeId,
    attemptId: candidate.attemptId,
    worktree: candidate.path,
    requestPath: join(candidate.path, ".agent-input", names[0]),
    planPath: join(candidate.path, ".agent-input", names[1]),
    policyPath: join(candidate.path, ".agent-input", names[2]),
    resultSchemaPath,
    outputDirectory: candidate.outputDirectory,
  });
  runContexts.set(value, candidate);
  return value;
}

export async function resolveAgentRunContext(
  value: import("../agents/types.ts").AgentRunInput,
): Promise<import("../agents/types.ts").AgentRunInput> {
  const candidate = runContexts.get(value);
  if (candidate === undefined)
    throw new TypeError(
      "El contexto de ejecución del agente no fue emitido por el servicio",
    );
  if (candidate === null) return value;
  await assertOwned(candidate);
  await validateCopiedInputs(candidate, candidate.approvedPlan);
  const output = await realpath(candidate.outputDirectory);
  const entry = await lstat(output);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    output !== candidate.outputDirectory
  )
    throw new TypeError("La salida del agente no es un directorio seguro");
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
