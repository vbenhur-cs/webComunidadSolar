import type { ChangePlan } from "../domain.ts";

import {
  assertCandidateServiceManifest,
  candidateRecord,
  externalSnapshot,
  gitSnapshot,
  removeCandidateWorktree,
  worktreeStatus,
  validateCopiedInputs,
  type CandidateWorktree,
} from "./service.ts";

function changedPaths(status: string): string[] {
  const fields = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4)
      throw new TypeError("Git devolvió un estado no válido");
    const state = field.slice(0, 2);
    paths.push(field.slice(3));
    if (state.includes("R") || state.includes("C")) {
      const original = fields[index + 1];
      if (original === undefined)
        throw new TypeError("Git devolvió un rename no válido");
      paths.push(original);
      index += 1;
    }
  }
  return paths;
}

function safeDescendant(root: string, path: string): boolean {
  if (!path.startsWith(`${root}/`)) return false;
  return path
    .slice(root.length + 1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function outputAllowed(path: string, plan: ChangePlan): boolean {
  if (plan.files.some((file) => file.path === path)) return true;
  const generatedRoots = [
    `src/components/generated/${plan.changeId}`,
    `public/generated/${plan.changeId}`,
  ].filter((root) => plan.files.some((file) => file.path === root));
  return generatedRoots.some((root) => safeDescendant(root, path));
}

/**
 * Reject all effects that an agent cannot authorize: commits, protected refs,
 * mutable copied inputs, external worktree changes, and unplanned paths.
 */
export async function validateWorktreeDiff(
  candidate: CandidateWorktree,
  plan: ChangePlan,
): Promise<string[]> {
  try {
    return await validateDiff(candidate, plan);
  } catch (error) {
    await removeCandidateWorktree(candidate).catch(() => undefined);
    throw error;
  }
}

async function validateDiff(
  candidate: CandidateWorktree,
  plan: ChangePlan,
): Promise<string[]> {
  if (
    plan.changeId !== (await candidateRecord(candidate)).changeId ||
    plan.baselineCommit !== (await candidateRecord(candidate)).baselineCommit
  ) {
    throw new TypeError(
      "El plan aprobado no corresponde al worktree candidato",
    );
  }
  const record = await candidateRecord(candidate);
  const [candidateSnapshot, repositorySnapshot, sourceSnapshot] =
    await Promise.all([
      gitSnapshot(record.path),
      externalSnapshot(record.repositoryRoot),
      externalSnapshot(record.sourceRepositoryRoot),
    ]);
  if (candidateSnapshot.head !== record.baselineCommit) {
    throw new TypeError("Se detectó un commit creado por el agente");
  }
  if (
    candidateSnapshot.refs !== record.candidateSnapshot.refs ||
    repositorySnapshot.refs !== record.repositorySnapshot.refs ||
    sourceSnapshot.refs !== record.sourceSnapshot.refs
  ) {
    throw new TypeError("Git ref protegido fue modificado");
  }
  if (
    repositorySnapshot.head !== record.repositorySnapshot.head ||
    repositorySnapshot.status !== record.repositorySnapshot.status
  ) {
    throw new TypeError("El repositorio principal cambió fuera del worktree");
  }
  if (
    sourceSnapshot.head !== record.sourceSnapshot.head ||
    sourceSnapshot.status !== record.sourceSnapshot.status
  ) {
    throw new TypeError("El source sibling cambió fuera del worktree");
  }
  await validateCopiedInputs(candidate, plan);
  await assertCandidateServiceManifest(candidate);

  const allowed = new Set(plan.files.map((file) => file.path));
  const initialPaths = new Set(changedPaths(record.candidateSnapshot.status));
  const paths = changedPaths(await worktreeStatus(candidate)).filter(
    (path) => !initialPaths.has(path),
  );
  for (const path of paths) {
    if (!allowed.has(path) && !outputAllowed(path, plan)) {
      throw new TypeError(
        `El path ${path} no aprobado fue modificado por el agente`,
      );
    }
  }
  return [...new Set(paths)].sort();
}
