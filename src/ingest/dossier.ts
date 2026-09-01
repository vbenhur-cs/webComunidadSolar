import { canonicalJson } from "./canonical-json.ts";
import { sanitizedCandidateDossierRecord } from "./dossier-integrity.ts";
import type {
  ApprovalRecord,
  AttemptRecord,
  CandidateManifest,
  ChangePlan,
  NormalizedRequest,
} from "./domain.ts";

export interface CandidateDossierSource {
  readonly request: NormalizedRequest;
  readonly plan: ChangePlan;
  readonly gate1: ApprovalRecord;
  readonly gate2: ApprovalRecord;
  readonly attempt: AttemptRecord;
  readonly candidate: CandidateManifest;
}

export interface SanitizedDossierFile {
  readonly path: string;
  readonly contents: string;
}

export interface SanitizedCandidateDossier {
  readonly files: readonly SanitizedDossierFile[];
}

function sanitizedRequest(request: NormalizedRequest): object {
  return {
    schemaVersion: request.schemaVersion,
    changeId: request.changeId,
    inputKind: request.inputKind,
    targetPath: request.targetPath,
    mode: request.mode,
    privacy: request.privacy,
    inputSha256: request.inputSha256,
  };
}

function sanitizedAttempt(attempt: AttemptRecord): object {
  return {
    schemaVersion: attempt.schemaVersion,
    changeId: attempt.changeId,
    attemptId: attempt.attemptId,
    status: attempt.status,
    resumeState: attempt.resumeState,
    adapter: attempt.adapter,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    requestSha256: attempt.requestSha256,
    planSha256: attempt.planSha256,
    baselineCommit: attempt.baselineCommit,
    generatedFiles: attempt.generatedFiles,
    logs: { stdout: null, stderr: null, finalMessage: null },
    validations: attempt.validations.map((validation) => ({
      id: validation.id,
      status: validation.status,
      evidence:
        validation.evidence === null ? null : `evidence/${validation.id}.json`,
      evidenceSha256: validation.evidenceSha256,
    })),
    failure: attempt.failure === null ? null : { code: attempt.failure.code },
  };
}

/** Creates a fixed, path-free dossier payload; destination selection stays sealed. */
export function createSanitizedCandidateDossier(
  source: CandidateDossierSource,
): SanitizedCandidateDossier {
  const changeId = source.candidate.changeId;
  const files = [
    {
      path: "request.json",
      contents: `${canonicalJson(sanitizedRequest(source.request))}\n`,
    },
    { path: "plan.json", contents: `${canonicalJson(source.plan)}\n` },
    {
      path: "approvals/gate-1.json",
      contents: `${canonicalJson(source.gate1)}\n`,
    },
    {
      path: "approvals/gate-2.json",
      contents: `${canonicalJson(source.gate2)}\n`,
    },
    {
      path: `attempts/${source.attempt.attemptId}.json`,
      contents: `${canonicalJson(sanitizedAttempt(source.attempt))}\n`,
    },
    {
      path: "candidate.json",
      contents: `${canonicalJson(sanitizedCandidateDossierRecord(source.candidate))}\n`,
    },
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (
    source.request.changeId !== changeId ||
    source.plan.changeId !== changeId ||
    source.gate1.changeId !== changeId ||
    source.gate2.changeId !== changeId ||
    source.attempt.changeId !== changeId
  ) {
    throw new TypeError("El expediente no comparte la identidad candidata");
  }
  return Object.freeze({
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
  });
}
