import { sha256Canonical } from "./canonical-json.ts";
import type { CandidateManifest } from "./domain.ts";
import { validateSchema } from "./schema-validator.ts";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface CandidateDossierCommitment {
  /** Hash of the durable, canonical preimage approved at Gate 2. */
  readonly sealedCandidateSha256: string;
  /** Hash of every field that can appear in the sanitized candidate record. */
  readonly sanitizedProjectionSha256: string;
  /** Gate 2 binds both the durable preimage and printable projection. */
  readonly approvalSubjectSha256: string;
}

export interface DossierCommitmentFile {
  readonly path: string;
  readonly contents: string;
}

interface IndexedHash {
  readonly index: number;
  readonly valueSha256: string;
}

interface CandidateDossierValidationPreimage {
  readonly index: number;
  readonly id: string;
  readonly status: "passed";
  /** Digest of the original candidate evidence reference, never its path. */
  readonly evidencePathSha256: string;
  /** Digest of its sealed evidence bytes; audited candidates never omit it. */
  readonly evidenceSha256: string;
}

interface CandidateDossierArtifactPreimage {
  readonly index: number;
  /** Digest of the original state artifact path, never the raw path. */
  readonly sourcePathSha256: string;
  /** Digest of the printable dossier artifact path. */
  readonly dossierPathSha256: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface CandidateDossierDifferencePreimage {
  readonly index: number;
  /** Digest of the operator-visible difference, never its raw description. */
  readonly descriptionSha256: string;
  readonly approvalRequired: true;
}

/**
 * Durable, allowlisted representation of every CandidateManifest field. Raw
 * paths, preview process values, URLs and difference text remain absent; their
 * canonical SHA-256 commitments retain their Gate 2 binding.
 */
export interface CandidateDossierPreimage {
  readonly schemaVersion: 1;
  readonly kind: "sealed-candidate-preimage";
  readonly candidateSchemaVersion: 1;
  readonly changeId: string;
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly planSha256: string;
  readonly baselineCommit: string;
  readonly candidateCommit: string;
  readonly artifactSha256: string;
  readonly buildProfile: {
    readonly adapter: "local" | "cloudflare";
    readonly configSha256: string;
    readonly environmentSha256: string | null;
    readonly siteIndexable: boolean;
  };
  /** Indexes preserve the exact source-array ordering in canonical JSON. */
  readonly routes: readonly IndexedHash[];
  readonly files: readonly IndexedHash[];
  readonly validations: readonly CandidateDossierValidationPreimage[];
  readonly artifacts: readonly CandidateDossierArtifactPreimage[];
  readonly preview: {
    readonly commandSha256: string;
    readonly urlSha256: string;
  };
  readonly knownDifferences: readonly CandidateDossierDifferencePreimage[];
}

/** The complete, printable candidate record before commitment fields. */
export interface SanitizedCandidateProjection {
  readonly schemaVersion: 1;
  readonly changeId: string;
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly planSha256: string;
  readonly baselineCommit: string;
  readonly candidateCommit: string;
  readonly artifactSha256: string;
  readonly buildProfile: CandidateManifest["buildProfile"];
  readonly routes: readonly string[];
  readonly files: readonly string[];
  readonly artifacts: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly validations: readonly {
    readonly id: string;
    readonly status: "passed" | "failed";
    readonly evidence: string;
    /** Sealed validation bytes are safe to expose only as their digest. */
    readonly evidenceSha256?: string;
  }[];
  readonly preview: { readonly command: "sealed verified candidate preview" };
  readonly knownDifferences: readonly { readonly approvalRequired: true }[];
}

function candidateArtifactPrefix(candidate: CandidateManifest): string {
  return `.artifacts/candidates/${candidate.changeId}/${candidate.attemptId}/bundle/`;
}

function sanitizedArtifactPath(
  candidate: CandidateManifest,
  artifact: CandidateManifest["artifacts"][number],
): string {
  const prefix = candidateArtifactPrefix(candidate);
  return artifact.path.startsWith(prefix)
    ? `bundle/${artifact.path.slice(prefix.length)}`
    : `sealed-artifact/${sha256Canonical({
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      })}`;
}

function valueSha256(value: string): string {
  return sha256Canonical(value);
}

function indexedHashes(values: readonly string[]): readonly IndexedHash[] {
  return Object.freeze(
    values.map((value, index) =>
      Object.freeze({ index, valueSha256: valueSha256(value) }),
    ),
  );
}

function sealedValidationPreimage(
  validation: CandidateManifest["validations"][number],
  index: number,
): CandidateDossierValidationPreimage {
  const evidenceSha256 = validation.evidenceSha256;
  if (
    validation.status !== "passed" ||
    evidenceSha256 === undefined ||
    !sha256Pattern.test(evidenceSha256)
  ) {
    throw new TypeError(
      "La preimagen sólo admite validaciones aprobadas con evidencia sellada",
    );
  }
  return Object.freeze({
    index,
    id: validation.id,
    status: "passed",
    evidencePathSha256: valueSha256(validation.evidence),
    evidenceSha256,
  });
}

/**
 * This is the complete allowlisted candidate projection that may leave sealed
 * controller state. Commitment fields are deliberately added only afterwards,
 * so their hash has no self-reference.
 */
export function sanitizedCandidateProjection(
  candidate: CandidateManifest,
): SanitizedCandidateProjection {
  return Object.freeze({
    schemaVersion: candidate.schemaVersion,
    changeId: candidate.changeId,
    attemptId: candidate.attemptId,
    requestSha256: candidate.requestSha256,
    planSha256: candidate.planSha256,
    baselineCommit: candidate.baselineCommit,
    candidateCommit: candidate.candidateCommit,
    artifactSha256: candidate.artifactSha256,
    buildProfile: Object.freeze({ ...candidate.buildProfile }),
    routes: Object.freeze([...candidate.routes]),
    files: Object.freeze([...candidate.files]),
    artifacts: Object.freeze(
      candidate.artifacts.map((artifact) =>
        Object.freeze({
          path: sanitizedArtifactPath(candidate, artifact),
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        }),
      ),
    ),
    validations: Object.freeze(
      candidate.validations.map((validation) =>
        Object.freeze({
          id: validation.id,
          status: validation.status,
          evidence: `evidence/${validation.id}.json`,
          ...(validation.evidenceSha256 === undefined
            ? {}
            : { evidenceSha256: validation.evidenceSha256 }),
        }),
      ),
    ),
    preview: Object.freeze({ command: "sealed verified candidate preview" }),
    knownDifferences: Object.freeze(
      candidate.knownDifferences.map(() =>
        Object.freeze({ approvalRequired: true }),
      ),
    ),
  });
}

/**
 * Builds the canonical durable preimage. Every original CandidateManifest
 * field is either copied as a constrained identifier/digest or represented by
 * its SHA-256; arrays retain their source order through contiguous indexes.
 */
export function candidateDossierPreimage(
  candidate: CandidateManifest,
): CandidateDossierPreimage {
  const projection = sanitizedCandidateProjection(candidate);
  return Object.freeze({
    schemaVersion: 1,
    kind: "sealed-candidate-preimage",
    candidateSchemaVersion: candidate.schemaVersion,
    changeId: candidate.changeId,
    attemptId: candidate.attemptId,
    requestSha256: candidate.requestSha256,
    planSha256: candidate.planSha256,
    baselineCommit: candidate.baselineCommit,
    candidateCommit: candidate.candidateCommit,
    artifactSha256: candidate.artifactSha256,
    buildProfile: Object.freeze({
      adapter: candidate.buildProfile.adapter,
      configSha256: candidate.buildProfile.configSha256,
      environmentSha256:
        candidate.buildProfile.environment === null
          ? null
          : valueSha256(candidate.buildProfile.environment),
      siteIndexable: candidate.buildProfile.siteIndexable,
    }),
    routes: indexedHashes(candidate.routes),
    files: indexedHashes(candidate.files),
    validations: Object.freeze(
      candidate.validations.map(sealedValidationPreimage),
    ),
    artifacts: Object.freeze(
      candidate.artifacts.map((artifact, index) => {
        const printable = projection.artifacts[index];
        if (printable === undefined) {
          throw new TypeError(
            "La preimagen no conserva el artefacto candidato",
          );
        }
        return Object.freeze({
          index,
          sourcePathSha256: valueSha256(artifact.path),
          dossierPathSha256: valueSha256(printable.path),
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        });
      }),
    ),
    preview: Object.freeze({
      commandSha256: valueSha256(candidate.preview.command),
      urlSha256: valueSha256(candidate.preview.url),
    }),
    knownDifferences: Object.freeze(
      candidate.knownDifferences.map((difference, index) =>
        Object.freeze({
          index,
          descriptionSha256: valueSha256(difference.description),
          approvalRequired: difference.approvalRequired,
        }),
      ),
    ),
  });
}

export function candidateDossierPreimageSha256(
  preimage: CandidateDossierPreimage,
): string {
  return sha256Canonical(preimage);
}

function assertContiguousIndexes(
  entries: readonly { readonly index: number }[],
  label: string,
): void {
  if (entries.some((entry, index) => entry.index !== index)) {
    throw new TypeError(`${label} no conserva un orden canónico`);
  }
}

/** Parses the exact durable preimage schema and rejects unordered arrays. */
export function parseCandidateDossierPreimage(
  value: unknown,
): CandidateDossierPreimage {
  const preimage = validateSchema<CandidateDossierPreimage>(
    "candidate-dossier-preimage",
    value,
  );
  assertContiguousIndexes(preimage.routes, "Las rutas de la preimagen");
  assertContiguousIndexes(preimage.files, "Los archivos de la preimagen");
  assertContiguousIndexes(
    preimage.validations,
    "Las validaciones de la preimagen",
  );
  assertContiguousIndexes(preimage.artifacts, "Los artefactos de la preimagen");
  assertContiguousIndexes(
    preimage.knownDifferences,
    "Las diferencias de la preimagen",
  );
  if (
    new Set(preimage.validations.map((validation) => validation.id)).size !==
    preimage.validations.length
  ) {
    throw new TypeError("La preimagen repite IDs de validación");
  }
  return preimage;
}

function projectionBinding(projection: SanitizedCandidateProjection): object {
  return {
    candidateSchemaVersion: projection.schemaVersion,
    changeId: projection.changeId,
    attemptId: projection.attemptId,
    requestSha256: projection.requestSha256,
    planSha256: projection.planSha256,
    baselineCommit: projection.baselineCommit,
    candidateCommit: projection.candidateCommit,
    artifactSha256: projection.artifactSha256,
    buildProfile: {
      adapter: projection.buildProfile.adapter,
      configSha256: projection.buildProfile.configSha256,
      environmentSha256:
        projection.buildProfile.environment === null
          ? null
          : valueSha256(projection.buildProfile.environment),
      siteIndexable: projection.buildProfile.siteIndexable,
    },
    routes: indexedHashes(projection.routes),
    files: indexedHashes(projection.files),
    validations: projection.validations.map((validation, index) => ({
      index,
      id: validation.id,
      status: validation.status,
      evidenceSha256: validation.evidenceSha256 ?? null,
    })),
    artifacts: projection.artifacts.map((artifact, index) => ({
      index,
      dossierPathSha256: valueSha256(artifact.path),
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    })),
    knownDifferences: projection.knownDifferences.map((difference, index) => ({
      index,
      approvalRequired: difference.approvalRequired,
    })),
  };
}

function preimageProjectionBinding(preimage: CandidateDossierPreimage): object {
  return {
    candidateSchemaVersion: preimage.candidateSchemaVersion,
    changeId: preimage.changeId,
    attemptId: preimage.attemptId,
    requestSha256: preimage.requestSha256,
    planSha256: preimage.planSha256,
    baselineCommit: preimage.baselineCommit,
    candidateCommit: preimage.candidateCommit,
    artifactSha256: preimage.artifactSha256,
    buildProfile: preimage.buildProfile,
    routes: preimage.routes,
    files: preimage.files,
    validations: preimage.validations.map((validation) => ({
      index: validation.index,
      id: validation.id,
      status: validation.status,
      evidenceSha256: validation.evidenceSha256,
    })),
    artifacts: preimage.artifacts.map((artifact) => ({
      index: artifact.index,
      dossierPathSha256: artifact.dossierPathSha256,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    })),
    knownDifferences: preimage.knownDifferences.map((difference) => ({
      index: difference.index,
      approvalRequired: difference.approvalRequired,
    })),
  };
}

/**
 * Ensures the printable candidate record is exactly the safe projection that
 * its preimage commits to. This detects a rewritten routes/files/artifacts or
 * validation projection even if another dossier field is updated alongside it.
 */
export function assertCandidateDossierProjectionBinding(
  preimage: CandidateDossierPreimage,
  projection: SanitizedCandidateProjection,
): void {
  if (
    sha256Canonical(projectionBinding(projection)) !==
    sha256Canonical(preimageProjectionBinding(preimage))
  ) {
    throw new TypeError("La preimagen no coincide con el candidato saneado");
  }
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

/** Binds the durable preimage and every allowlisted dossier projection. */
export function candidateDossierCommitment(
  candidate: CandidateManifest,
): CandidateDossierCommitment {
  const preimage = candidateDossierPreimage(candidate);
  return candidateDossierCommitmentFromProjection(
    candidateDossierPreimageSha256(preimage),
    sanitizedCandidateProjection(candidate),
  );
}

function hasRecordableValidationEvidence(
  candidate: CandidateManifest,
): boolean {
  return (
    candidate.validations.length > 0 &&
    candidate.validations.every(
      (validation) =>
        validation.status === "passed" &&
        typeof validation.evidenceSha256 === "string" &&
        sha256Pattern.test(validation.evidenceSha256),
    )
  );
}

/**
 * Gate 2 may inspect a valid legacy candidate before its evidence is
 * recordable. Its subject remains bound to the complete candidate, but it is
 * deliberately distinct from the durable dossier commitment. Once every
 * validation has sealed evidence, Gate 2 uses the stronger durable subject.
 */
function legacyCandidateApprovalSubject(candidate: CandidateManifest): string {
  return candidateDossierCommitmentFromProjection(
    sha256Canonical(candidate),
    Object.freeze({
      ...sanitizedCandidateProjection(candidate),
      // Keep already-issued legacy Gate 2 subjects stable: they predate the
      // durable evidence-digest field and cannot authorize a dossier anyway.
      validations: Object.freeze(
        candidate.validations.map((validation) =>
          Object.freeze({
            id: validation.id,
            status: validation.status,
            evidence: `evidence/${validation.id}.json`,
          }),
        ),
      ),
    }),
  ).approvalSubjectSha256;
}

export function candidateApprovalSubject(candidate: CandidateManifest): string {
  return hasRecordableValidationEvidence(candidate)
    ? candidateDossierCommitment(candidate).approvalSubjectSha256
    : legacyCandidateApprovalSubject(candidate);
}

function assertDossierArtifactPaths(candidate: CandidateManifest): void {
  const prefix = candidateArtifactPrefix(candidate);
  if (
    candidate.artifacts.some((artifact) => !artifact.path.startsWith(prefix))
  ) {
    throw new TypeError(
      "El expediente recibió un artefacto candidato inseguro",
    );
  }
}

/** Adds non-self-referential commitments to the printable candidate file. */
export function sanitizedCandidateDossierRecord(
  candidate: CandidateManifest,
): object {
  assertDossierArtifactPaths(candidate);
  const projection = sanitizedCandidateProjection(candidate);
  return {
    ...projection,
    ...candidateDossierCommitmentFromProjection(
      candidateDossierPreimageSha256(candidateDossierPreimage(candidate)),
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
