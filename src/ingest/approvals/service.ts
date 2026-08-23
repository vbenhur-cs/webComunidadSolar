import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256Canonical } from "../canonical-json.ts";
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

interface ApprovalOptions extends ApprovalStorageOptions {
  actor: string;
  now?: () => Date;
}

export interface Gate1ApprovalInput extends ApprovalOptions {
  plan: ChangePlan;
}

export interface Gate2ApprovalInput extends ApprovalOptions {
  plan: ChangePlan;
  candidate: CandidateManifest;
  currentBaseline: string;
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
): Promise<ApprovalRecord> {
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
  const prompt = approvalPrompt(fixturePrompt);
  assertPromptStateRoot(prompt, input);
  const subjectSha256 = planSubject(input.plan);
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
  return persistApproval(approval, input);
}

export async function approveGate2(
  input: Gate2ApprovalInput,
  fixturePrompt?: FixtureApprovalPrompt,
): Promise<ApprovalRecord> {
  assertActor(input.actor);
  const prompt = approvalPrompt(fixturePrompt);
  assertPromptStateRoot(prompt, input);
  const approvedPlanSha256 = planSubject(input.plan);
  const gate1 = await persistedGate1(input);
  verifyApproval(gate1, input.plan, input.currentBaseline);
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
  return persistApproval(approval, input);
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
