import type { ChangePlan } from "../domain.ts";

import {
  copiedInputHash,
  externalStatus,
  removeCandidateWorktree,
  worktreeGit,
  worktreeStatus,
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

function isAgentSidecar(path: string): boolean {
  return path === ".agent-output" || path.startsWith(".agent-output/");
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
    await removeCandidateWorktree(candidate);
    throw error;
  }
}

async function validateDiff(
  candidate: CandidateWorktree,
  plan: ChangePlan,
): Promise<string[]> {
  if (
    plan.changeId !== candidate.changeId ||
    plan.baselineCommit !== candidate.baselineCommit
  ) {
    throw new TypeError(
      "El plan aprobado no corresponde al worktree candidato",
    );
  }
  const [head, mainRef, copiedHash, repositoryStatus, sourceStatus] =
    await Promise.all([
      worktreeGit(candidate, ["rev-parse", "HEAD"]),
      worktreeGit(candidate, ["rev-parse", "refs/heads/main"]),
      copiedInputHash(candidate),
      externalStatus(candidate.repositoryRoot),
      externalStatus(candidate.sourceRepositoryRoot),
    ]);
  if (head !== candidate.baselineCommit) {
    throw new TypeError("Se detectó un commit creado por el agente");
  }
  if (mainRef !== candidate.mainRef || mainRef !== candidate.baselineCommit) {
    throw new TypeError("Git ref protegido refs/heads/main fue modificado");
  }
  if (copiedHash !== candidate.inputHash) {
    throw new TypeError("La entrada del agente cambió después del aislamiento");
  }
  if (repositoryStatus !== candidate.repositoryStatus) {
    throw new TypeError("El repositorio principal cambió fuera del worktree");
  }
  if (sourceStatus !== candidate.sourceStatus) {
    throw new TypeError("El source sibling cambió fuera del worktree");
  }

  const allowed = new Set(plan.files.map((file) => file.path));
  const paths = changedPaths(await worktreeStatus(candidate)).filter(
    (path) => !path.startsWith(".agent-input/") && !isAgentSidecar(path),
  );
  for (const path of paths) {
    if (!allowed.has(path)) {
      throw new TypeError(
        `El path ${path} no aprobado fue modificado por el agente`,
      );
    }
  }
  return [...new Set(paths)].sort();
}
