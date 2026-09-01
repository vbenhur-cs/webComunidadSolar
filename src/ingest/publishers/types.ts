import type { CandidateManifest } from "../domain.ts";
import type {
  CandidateLocalPublicationTestCapability,
  CandidateOperatorProfile,
} from "../candidate/manifest.ts";

/** Publication surfaces are intentionally narrow; candidate authority stays sealed. */
export interface Publisher<Input, Result> {
  publish(input: Input): Promise<Result>;
}

/**
 * Semantic operator assertion over a sealed candidate config. It deliberately
 * contains hashes and destination identity only, never config bytes or paths.
 */
export type OperatorProfile = CandidateOperatorProfile;

export interface LocalPublicationInput {
  readonly candidate: CandidateManifest;
  readonly operator: OperatorProfile;
  /** Test-only; it cannot authorize Cloudflare or protected-main promotion. */
  readonly testCapability?: CandidateLocalPublicationTestCapability;
}

export interface CloudflarePublicationInput {
  readonly candidate: CandidateManifest;
  readonly operator: OperatorProfile;
}

export interface CloudflareDryRunDescription {
  readonly publisher: "cloudflare";
  readonly dryRun: true;
  readonly changeId: string;
  readonly artifactSha256: string;
  readonly sealedRedirect: true;
  readonly fixedDeployArguments: true;
  readonly targetEnvironmentBound: true;
}

export interface PublishResult {
  readonly status: "published";
  readonly publisher: "local" | "cloudflare";
  readonly changeId: string;
  readonly candidateCommit: string;
  readonly artifactSha256: string;
  readonly dryRun: boolean;
}
