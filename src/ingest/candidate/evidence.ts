import { canonicalJson } from "../canonical-json.ts";

const validationIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,63})$/u;
const evidenceMaximumCharacters = 8 * 1024;

export interface CandidateBuildFixture {
  /** Fixture bytes written only by the controller inside its private checkout. */
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly validations: readonly {
    readonly id: string;
    readonly status: "passed" | "failed" | "skipped";
    readonly evidence: string;
  }[];
}

export interface CandidateBoundBuildEvidence {
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly planSha256: string;
  readonly attemptId: string;
  readonly validations: readonly {
    readonly id: string;
    readonly status: "passed";
    readonly evidence: string;
  }[];
}

/** A test-only capability; it contains data, never a checkout callback. */
declare const candidateBuildTestCapabilityBrand: unique symbol;
export interface CandidateBuildTestCapability {
  readonly [candidateBuildTestCapabilityBrand]: true;
}

const candidateBuildCapabilities = new WeakMap<
  CandidateBuildTestCapability,
  CandidateBuildFixture
>();

function frozenFixture(fixture: CandidateBuildFixture): CandidateBuildFixture {
  if (
    fixture === null ||
    typeof fixture !== "object" ||
    !fixture.files ||
    typeof fixture.files !== "object" ||
    !Array.isArray(fixture.validations)
  ) {
    throw new TypeError("La fixture de build candidato no es válida");
  }
  const files: Record<string, string | Uint8Array> = {};
  for (const [path, contents] of Object.entries(fixture.files)) {
    if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
      throw new TypeError("La fixture de build contiene bytes no válidos");
    }
    files[path] =
      typeof contents === "string" ? contents : new Uint8Array(contents);
  }
  return Object.freeze({
    files: Object.freeze(files),
    validations: Object.freeze(
      fixture.validations.map((validation) => Object.freeze({ ...validation })),
    ),
  });
}

/**
 * Mints a fixture-only declarative build capability. Production remains
 * fail-closed until a later controller integration supplies fixed behavior.
 */
export function createCandidateBuildTestCapability(
  fixture: CandidateBuildFixture,
): CandidateBuildTestCapability {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La capability de build candidato sólo existe en modo de pruebas",
    );
  }
  const capability = Object.freeze({}) as CandidateBuildTestCapability;
  candidateBuildCapabilities.set(capability, frozenFixture(fixture));
  return capability;
}

/** @internal Resolves only a controller-minted immutable fixture descriptor. */
export function candidateBuildFixture(
  capability: CandidateBuildTestCapability | undefined,
): CandidateBuildFixture {
  if (capability === undefined) {
    throw new TypeError(
      "No existe una capability de build candidato confiable",
    );
  }
  const fixture = candidateBuildCapabilities.get(capability);
  if (fixture === undefined) {
    throw new TypeError(
      "La capability de build candidato no pertenece al controlador",
    );
  }
  return fixture;
}

/** @internal Validates the fixed fixture evidence before it is persisted. */
export function validatedCandidateBuildValidations(
  fixture: CandidateBuildFixture,
): readonly {
  readonly id: string;
  readonly status: "passed";
  readonly evidence: string;
}[] {
  if (fixture.validations.length === 0) {
    throw new TypeError(
      "El build candidato no devolvió evidencia de validación",
    );
  }
  const identifiers = new Set<string>();
  const validations = fixture.validations.map((validation) => {
    if (
      !validationIdPattern.test(validation.id) ||
      identifiers.has(validation.id) ||
      validation.status !== "passed" ||
      typeof validation.evidence !== "string" ||
      validation.evidence.length === 0 ||
      validation.evidence.length > evidenceMaximumCharacters
    ) {
      throw new TypeError(
        "El build candidato no devolvió validaciones aprobadas y estructuradas",
      );
    }
    identifiers.add(validation.id);
    return Object.freeze({
      id: validation.id,
      status: "passed" as const,
      evidence: validation.evidence,
    });
  });
  return Object.freeze(validations);
}

/** A stable binding representation for persisted candidate-build evidence. */
export function canonicalCandidateBuildEvidence(
  evidence: CandidateBoundBuildEvidence,
): string {
  return canonicalJson(evidence);
}
