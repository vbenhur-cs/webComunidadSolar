import { canonicalJson } from "../canonical-json.ts";
import type { ChangePlan } from "../domain.ts";

import {
  assertCandidateCommitOutput,
  withCandidateCommitCheckout,
  type CandidateCommit,
} from "./commit.ts";

const validationIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,63})$/u;
const evidenceMaximumCharacters = 8 * 1024;

export interface CandidateBuildInvocation {
  readonly checkoutPath: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly plan: ChangePlan;
  readonly attemptId: string;
}

export interface CandidateBuildResult {
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

type CandidateBuildAdapter = (
  invocation: CandidateBuildInvocation,
) => Promise<CandidateBuildResult>;

/** A test-only capability; createCandidate never accepts a raw build callback. */
declare const candidateBuildTestCapabilityBrand: unique symbol;
export interface CandidateBuildTestCapability {
  readonly [candidateBuildTestCapabilityBrand]: true;
}

const candidateBuildCapabilities = new WeakMap<
  CandidateBuildTestCapability,
  CandidateBuildAdapter
>();

/**
 * Mints a fixture-only build capability. Production remains fail-closed until
 * a later controller integration provides a separately reviewed adapter.
 */
export function createCandidateBuildTestCapability(
  adapter: CandidateBuildAdapter,
): CandidateBuildTestCapability {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La capability de build candidato sólo existe en modo de pruebas",
    );
  }
  if (typeof adapter !== "function") {
    throw new TypeError("El adaptador de build candidato no es válido");
  }
  const capability = Object.freeze({}) as CandidateBuildTestCapability;
  candidateBuildCapabilities.set(capability, adapter);
  return capability;
}

function validatedBuildResult(result: CandidateBuildResult): readonly {
  readonly id: string;
  readonly status: "passed";
  readonly evidence: string;
}[] {
  if (!Array.isArray(result.validations) || result.validations.length === 0) {
    throw new TypeError(
      "El build candidato no devolvió evidencia de validación",
    );
  }
  const identifiers = new Set<string>();
  const validations = result.validations.map((validation) => {
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

/**
 * Runs only a controller-minted candidate build adapter inside commit A, then
 * rechecks the approved staged bytes before its evidence can be consumed.
 */
export async function runCandidateBoundBuild(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
  capability: CandidateBuildTestCapability | undefined,
): Promise<CandidateBoundBuildEvidence> {
  if (capability === undefined) {
    throw new TypeError(
      "No existe una capability de build candidato confiable",
    );
  }
  const adapter = candidateBuildCapabilities.get(capability);
  if (adapter === undefined) {
    throw new TypeError(
      "La capability de build candidato no pertenece al controlador",
    );
  }
  const result = await withCandidateCommitCheckout(
    candidate,
    plan,
    attemptId,
    async (checkoutPath) =>
      await adapter(
        Object.freeze({
          checkoutPath,
          candidateCommit: candidate.candidateCommit,
          candidateTree: candidate.candidateTree,
          plan,
          attemptId,
        }),
      ),
  );
  await assertCandidateCommitOutput(candidate, plan, attemptId);
  const validations = validatedBuildResult(result);
  return Object.freeze({
    candidateCommit: candidate.candidateCommit,
    candidateTree: candidate.candidateTree,
    planSha256: plan.planSha256,
    attemptId,
    validations,
  });
}

/** A stable binding representation for persisted candidate-build evidence. */
export function canonicalCandidateBuildEvidence(
  evidence: CandidateBoundBuildEvidence,
): string {
  return canonicalJson(evidence);
}
