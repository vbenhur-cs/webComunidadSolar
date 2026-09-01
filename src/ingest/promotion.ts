import {
  promoteCandidateWithDossier,
  recordCandidatePublicationFailure,
} from "./candidate/manifest.ts";
import type { CandidateManifest } from "./domain.ts";

export interface PromotionInput {
  readonly candidate: CandidateManifest;
}

export interface PromotionResult {
  readonly candidateCommit: string;
  readonly dossierCommit: string;
}

/** Promotes only candidate A, then records the sealed documentation-only B. */
export async function promoteCandidate(
  input: PromotionInput,
): Promise<PromotionResult> {
  try {
    return await promoteCandidateWithDossier(input.candidate);
  } catch (error) {
    await recordCandidatePublicationFailure(input.candidate, "promotion").catch(
      () => undefined,
    );
    throw error;
  }
}
