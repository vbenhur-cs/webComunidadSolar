import {
  promoteCandidateWithDossier,
  recordCandidatePublicationFailure,
  type CandidatePromotionTestCapability,
} from "./candidate/manifest.ts";
import type { CandidateManifest } from "./domain.ts";

export interface PromotionInput {
  readonly candidate: CandidateManifest;
  /** Test-only failure token; it cannot add authority or change Git inputs. */
  readonly testCapability?: CandidatePromotionTestCapability;
}

export interface PromotionResult {
  readonly candidateCommit: string;
  readonly dossierCommit: string;
  /** Protected main is published even when local reconciliation is pending. */
  readonly reconciliation: "complete" | "pending";
}

/** Promotes only candidate A, then records the sealed documentation-only B. */
export async function promoteCandidate(
  input: PromotionInput,
): Promise<PromotionResult> {
  try {
    return await promoteCandidateWithDossier(
      input.candidate,
      input.testCapability,
    );
  } catch (error) {
    await recordCandidatePublicationFailure(input.candidate, "promotion").catch(
      () => undefined,
    );
    throw error;
  }
}
