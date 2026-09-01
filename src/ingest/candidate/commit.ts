import type { ChangePlan } from "../domain.ts";
import {
  assertControllerCandidateCommit,
  captureControllerCandidateBuildArtifacts,
  createControllerCandidateCommit,
  persistControllerCandidateCommit,
  removeControllerCandidateCommit,
  runControllerCandidateBuildFiles,
  type ControllerCandidateCapturedBuild,
  type ControllerCandidateCommit,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";
import {
  candidateBuildFixture,
  validatedCandidateBuildValidations,
  type CandidateBoundBuildEvidence,
  type CandidateBuildTestCapability,
} from "./evidence.ts";

/** Immutable public identity backed only by sealed controller lifecycle state. */
export type CandidateCommit = ControllerCandidateCommit;
export type CandidateCapturedBuild = ControllerCandidateCapturedBuild;

/** Creates commit A without exposing a temporary checkout or repository path. */
export async function createCandidateCommit(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<CandidateCommit> {
  return await createControllerCandidateCommit(output, plan, attemptId);
}

/** Applies declarative controller fixture bytes through the sealed lifecycle. */
export async function runCandidateBoundBuild(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
  capability: CandidateBuildTestCapability | undefined,
): Promise<CandidateBoundBuildEvidence> {
  const fixture = candidateBuildFixture(capability);
  await runControllerCandidateBuildFiles(
    candidate,
    plan,
    attemptId,
    fixture.files,
  );
  await assertControllerCandidateCommit(candidate, plan, attemptId);
  return Object.freeze({
    candidateCommit: candidate.candidateCommit,
    candidateTree: candidate.candidateTree,
    planSha256: plan.planSha256,
    attemptId,
    validations: validatedCandidateBuildValidations(fixture),
  });
}

/** Copies generated output through the sealed lifecycle, never a checkout callback. */
export async function captureCandidateBuildArtifacts(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
  bundlePath: string,
): Promise<CandidateCapturedBuild> {
  return await captureControllerCandidateBuildArtifacts(
    candidate,
    plan,
    attemptId,
    bundlePath,
  );
}

/** Revalidates a private candidate checkout without revealing its path. */
export async function assertCandidateCommitOutput(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
): Promise<void> {
  await assertControllerCandidateCommit(candidate, plan, attemptId);
}

/** Transfers commit A to its deterministic durable controller-private ref. */
export async function persistCandidateCommit(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
): Promise<void> {
  await persistControllerCandidateCommit(candidate, plan, attemptId);
}

/** Drops only the temporary sealed checkout; durable ref/state remains. */
export async function removeCandidateCommit(
  candidate: CandidateCommit,
): Promise<void> {
  await removeControllerCandidateCommit(candidate);
}
