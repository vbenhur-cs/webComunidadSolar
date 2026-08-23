import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256Canonical } from "../canonical-json.ts";
import { sanitizedGitEnv } from "../git-env.ts";
import type {
  ApprovalRecord,
  CandidateManifest,
  ChangePlan,
} from "../domain.ts";
import { ingestPaths, type IngestPathOptions } from "../paths.ts";
import { validateSchema } from "../schema-validator.ts";
import { writeAtomic } from "../state-store.ts";

import {
  approvalPrompt,
  assertPromptStateRoot,
  type FixtureApprovalPrompt,
} from "./prompt.ts";

export type ApprovalStorageOptions = IngestPathOptions;

const execFileAsync = promisify(execFile);

interface ApprovalOptions extends ApprovalStorageOptions {
  actor: string;
  repositoryRoot: string;
  now?: () => Date;
}

export interface Gate1ApprovalInput extends ApprovalOptions {
  plan: ChangePlan;
}

export interface Gate2ApprovalInput extends ApprovalOptions {
  plan: ChangePlan;
  candidate: CandidateManifest;
}

async function protectedMainBaseline(repositoryRoot: string): Promise<string> {
  const lexicalRoot = resolve(repositoryRoot);
  try {
    const lexicalEntry = await lstat(lexicalRoot);
    if (lexicalEntry.isSymbolicLink() || !lexicalEntry.isDirectory()) {
      throw new TypeError("El repositorio no tiene una raíz segura");
    }
    const root = await realpath(lexicalRoot);
    const git = await lstat(join(root, ".git"));
    if (git.isSymbolicLink() || !git.isDirectory()) {
      throw new TypeError("El repositorio no tiene Git seguro");
    }
    const gitRoot = join(root, ".git");
    if ((await realpath(gitRoot)) !== gitRoot) {
      throw new TypeError("El repositorio no tiene Git seguro");
    }
    const [topLevel, absoluteGitDir, commonGitDir] = await Promise.all([
      execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        env: sanitizedGitEnv(),
      }),
      execFileAsync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
        env: sanitizedGitEnv(),
      }),
      execFileAsync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        env: sanitizedGitEnv(),
      }),
    ]);
    if (topLevel.stdout.trim() !== root) {
      throw new TypeError("El repositorio no tiene una raíz segura");
    }
    if (
      resolve(root, absoluteGitDir.stdout.trim()) !== gitRoot ||
      resolve(root, commonGitDir.stdout.trim()) !== gitRoot ||
      (await realpath(resolve(root, absoluteGitDir.stdout.trim()))) !==
        gitRoot ||
      (await realpath(resolve(root, commonGitDir.stdout.trim()))) !== gitRoot
    ) {
      throw new TypeError("El repositorio no tiene Git independiente");
    }
    const main = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--verify", "refs/heads/main^{commit}"],
      { encoding: "utf8", env: sanitizedGitEnv() },
    );
    const baseline = main.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(baseline)) {
      throw new TypeError("La referencia main no es un commit válido");
    }
    return baseline;
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("No se pudo leer la referencia protegida main");
  }
}

async function assertIssuanceBaseline(
  plan: ChangePlan,
  repositoryRoot: string,
): Promise<string> {
  const baseline = await protectedMainBaseline(repositoryRoot);
  if (plan.baselineCommit !== baseline) {
    throw new TypeError("El baseline de main no coincide con el plan aprobado");
  }
  return baseline;
}

function assertActor(actor: string): void {
  const normalized = actor.toLocaleLowerCase("en-US");
  if (
    actor.length < 3 ||
    actor.length > 120 ||
    actor.trim() !== actor ||
    ["agent", "codex", "fixture"].includes(normalized)
  ) {
    throw new TypeError("El actor de aprobación no identifica a una persona");
  }
}

function assertInteractive(prompt: ReturnType<typeof approvalPrompt>): void {
  if (!prompt.isTTY) {
    throw new TypeError(
      "La aprobación exige un terminal interactivo de una persona",
    );
  }
}

function approvedAt(now: (() => Date) | undefined): string {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("El reloj de aprobación no devolvió una fecha válida");
  }
  return value.toISOString();
}

function planSubject(plan: ChangePlan): string {
  validateSchema<ChangePlan>("change-plan", plan);
  const { planSha256, ...unsignedPlan } = plan;
  const subjectSha256 = sha256Canonical(unsignedPlan);
  if (planSha256 !== subjectSha256) {
    throw new TypeError("El hash canónico del plan no coincide");
  }
  return subjectSha256;
}

function candidateSubject(candidate: CandidateManifest): string {
  validateSchema<CandidateManifest>("candidate", candidate);
  return sha256Canonical(candidate);
}

function assertCandidateBelongsToPlan(
  candidate: CandidateManifest,
  plan: ChangePlan,
  subjectSha256: string,
): void {
  if (
    candidate.changeId !== plan.changeId ||
    candidate.baselineCommit !== plan.baselineCommit ||
    candidate.planSha256 !== subjectSha256 ||
    candidate.requestSha256 !== plan.requestSha256 ||
    canonicalJson(candidate.buildProfile) !== canonicalJson(plan.publication)
  ) {
    throw new TypeError("El candidato no está vinculado al plan aprobado");
  }
}

async function persistedGate1(
  input: Gate2ApprovalInput,
): Promise<ApprovalRecord> {
  const paths = await ingestPaths(input.plan.changeId, input);
  const path = join(paths.approvalsDir, "gate-1.json");
  let bytes: Uint8Array;
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new TypeError("El registro Gate 1 no es un archivo seguro");
    }
    bytes = await readFile(path);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Falta un registro Gate 1 aprobado");
  }
  try {
    return validateSchema<ApprovalRecord>(
      "approval",
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new TypeError("El registro Gate 1 no contiene JSON válido");
    }
    throw error;
  }
}

async function confirm(
  prompt: ReturnType<typeof approvalPrompt>,
  gate: 1 | 2,
  subjectSha256: string,
  summary: string,
): Promise<void> {
  assertInteractive(prompt);
  const answer = await prompt.confirm({ gate, subjectSha256, summary });
  if (answer !== subjectSha256.slice(0, 12)) {
    throw new TypeError("La confirmación del hash aprobado no coincide");
  }
}

async function persistApproval(
  approval: ApprovalRecord,
  options: ApprovalStorageOptions,
  prompt: ReturnType<typeof approvalPrompt>,
): Promise<ApprovalRecord> {
  await assertPromptStateRoot(prompt, options);
  const paths = await ingestPaths(approval.changeId, options);
  const filename = `gate-${approval.gate}.json`;
  await writeAtomic(
    join(paths.approvalsDir, filename),
    new TextEncoder().encode(canonicalJson(approval)),
  );
  return approval;
}

export async function approveGate1(
  input: Gate1ApprovalInput,
  fixturePrompt?: FixtureApprovalPrompt,
): Promise<ApprovalRecord> {
  assertActor(input.actor);
  const subjectSha256 = planSubject(input.plan);
  const prompt = approvalPrompt(fixturePrompt);
  await assertPromptStateRoot(prompt, input);
  await assertIssuanceBaseline(input.plan, input.repositoryRoot);
  await confirm(
    prompt,
    1,
    subjectSha256,
    `Cambio ${input.plan.changeId}; baseline ${input.plan.baselineCommit}; ruta ${input.plan.targetPath}.`,
  );
  const approval = validateSchema<ApprovalRecord>("approval", {
    schemaVersion: 1,
    environment: prompt.environment,
    gate: 1,
    changeId: input.plan.changeId,
    actor: input.actor,
    approvedAt: approvedAt(input.now),
    subjectSha256,
    baselineCommit: input.plan.baselineCommit,
    candidateCommit: null,
    artifactSha256: null,
  });
  return persistApproval(approval, input, prompt);
}

export async function approveGate2(
  input: Gate2ApprovalInput,
  fixturePrompt?: FixtureApprovalPrompt,
): Promise<ApprovalRecord> {
  assertActor(input.actor);
  const approvedPlanSha256 = planSubject(input.plan);
  const prompt = approvalPrompt(fixturePrompt);
  await assertPromptStateRoot(prompt, input);
  const currentBaseline = await assertIssuanceBaseline(
    input.plan,
    input.repositoryRoot,
  );
  const gate1 = await persistedGate1(input);
  verifyApproval(gate1, input.plan, currentBaseline);
  if (gate1.environment !== prompt.environment) {
    throw new TypeError(
      "Gate 2 requiere una aprobación Gate 1 de la misma procedencia",
    );
  }
  assertCandidateBelongsToPlan(input.candidate, input.plan, approvedPlanSha256);
  const subjectSha256 = candidateSubject(input.candidate);
  await confirm(
    prompt,
    2,
    subjectSha256,
    `Cambio ${input.candidate.changeId}; candidato ${input.candidate.candidateCommit}; artefacto ${input.candidate.artifactSha256}.`,
  );
  const approval = validateSchema<ApprovalRecord>("approval", {
    schemaVersion: 1,
    environment: prompt.environment,
    gate: 2,
    changeId: input.candidate.changeId,
    actor: input.actor,
    approvedAt: approvedAt(input.now),
    subjectSha256,
    baselineCommit: input.candidate.baselineCommit,
    candidateCommit: input.candidate.candidateCommit,
    artifactSha256: input.candidate.artifactSha256,
  });
  return persistApproval(approval, input, prompt);
}

export function verifyApproval(
  record: ApprovalRecord,
  subject: ChangePlan | CandidateManifest,
  currentBaseline: string,
): void {
  validateSchema<ApprovalRecord>("approval", record);
  assertActor(record.actor);
  if (record.baselineCommit !== currentBaseline) {
    throw new TypeError("El baseline actual no coincide con el aprobado");
  }

  if (record.gate === 1) {
    const plan = subject as ChangePlan;
    const subjectSha256 = planSubject(plan);
    if (
      record.changeId !== plan.changeId ||
      record.baselineCommit !== plan.baselineCommit ||
      record.subjectSha256 !== subjectSha256
    ) {
      throw new TypeError("El hash aprobado no coincide con el plan actual");
    }
    return;
  }

  const candidate = subject as CandidateManifest;
  const subjectSha256 = candidateSubject(candidate);
  if (
    record.changeId !== candidate.changeId ||
    record.baselineCommit !== candidate.baselineCommit ||
    record.subjectSha256 !== subjectSha256 ||
    record.candidateCommit !== candidate.candidateCommit ||
    record.artifactSha256 !== candidate.artifactSha256
  ) {
    throw new TypeError("El hash aprobado no coincide con el candidato actual");
  }
}
