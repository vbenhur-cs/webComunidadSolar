import { sha256Canonical } from "./canonical-json.ts";
import type { CandidateManifest } from "./domain.ts";

export interface CandidateDossierCommitment {
  /** Hash of the complete sealed candidate manifest approved at Gate 2. */
  readonly sealedCandidateSha256: string;
  /** Hash of every field that can appear in the sanitized candidate record. */
  readonly sanitizedProjectionSha256: string;
  /** Existing Gate 2 subject: the complete sealed candidate manifest hash. */
  readonly approvalSubjectSha256: string;
}

export interface DossierCommitmentFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * This is the complete allowlisted candidate projection that may leave sealed
 * controller state. Commitment fields are deliberately added only afterwards,
 * so their hash has no self-reference.
 */
export function sanitizedCandidateProjection(
  candidate: CandidateManifest,
): object {
  const prefix = `.artifacts/candidates/${candidate.changeId}/${candidate.attemptId}/bundle/`;
  return {
    schemaVersion: candidate.schemaVersion,
    changeId: candidate.changeId,
    attemptId: candidate.attemptId,
    requestSha256: candidate.requestSha256,
    planSha256: candidate.planSha256,
    baselineCommit: candidate.baselineCommit,
    candidateCommit: candidate.candidateCommit,
    artifactSha256: candidate.artifactSha256,
    buildProfile: candidate.buildProfile,
    routes: candidate.routes,
    files: candidate.files,
    artifacts: candidate.artifacts.map((artifact) => ({
      path: artifact.path.startsWith(prefix)
        ? `bundle/${artifact.path.slice(prefix.length)}`
        : `sealed-artifact/${sha256Canonical({
            path: artifact.path,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
          })}`,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    })),
    validations: candidate.validations.map((validation) => ({
      id: validation.id,
      status: validation.status,
      evidence: `evidence/${validation.id}.json`,
    })),
    preview: {
      command: "sealed verified candidate preview",
    },
    knownDifferences: candidate.knownDifferences.map(() => ({
      approvalRequired: true,
    })),
  };
}

/** Computes the Gate 2 subject without exposing any local candidate paths. */
export function candidateDossierCommitmentFromProjection(
  sealedCandidateSha256: string,
  projection: object,
): CandidateDossierCommitment {
  const sanitizedProjectionSha256 = sha256Canonical(projection);
  return Object.freeze({
    sealedCandidateSha256,
    sanitizedProjectionSha256,
    approvalSubjectSha256: sha256Canonical({
      candidateSha256: sealedCandidateSha256,
      sanitizedProjectionSha256,
    }),
  });
}

/** Binds the exact sealed manifest and every allowlisted dossier projection. */
export function candidateDossierCommitment(
  candidate: CandidateManifest,
): CandidateDossierCommitment {
  return candidateDossierCommitmentFromProjection(
    sha256Canonical(candidate),
    sanitizedCandidateProjection(candidate),
  );
}

export function candidateApprovalSubject(candidate: CandidateManifest): string {
  return candidateDossierCommitment(candidate).approvalSubjectSha256;
}

function assertDossierArtifactPaths(candidate: CandidateManifest): void {
  const prefix = `.artifacts/candidates/${candidate.changeId}/${candidate.attemptId}/bundle/`;
  if (
    candidate.artifacts.some((artifact) => !artifact.path.startsWith(prefix))
  ) {
    throw new TypeError(
      "El expediente recibió un artefacto candidato inseguro",
    );
  }
}

/** Adds the non-self-referential commitments to the printable candidate file. */
export function sanitizedCandidateDossierRecord(
  candidate: CandidateManifest,
): object {
  assertDossierArtifactPaths(candidate);
  const projection = sanitizedCandidateProjection(candidate);
  return {
    ...projection,
    ...candidateDossierCommitmentFromProjection(
      sha256Canonical(candidate),
      projection,
    ),
  };
}

/**
 * The annotated fixture tag seals the exact bytes of every sanitized dossier
 * file. Sorting makes this commitment independent of directory enumeration.
 */
export function sanitizedDossierSha256(
  files: readonly DossierCommitmentFile[],
): string {
  const normalized = files
    .map((file) => ({ path: file.path, contents: file.contents }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  if (
    normalized.some(
      (file, index) => index > 0 && normalized[index - 1]?.path === file.path,
    )
  ) {
    throw new TypeError("El expediente contiene rutas repetidas");
  }
  return sha256Canonical(normalized);
}
