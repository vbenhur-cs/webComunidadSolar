import type { CandidateManifest, ChangePlan } from "../domain.ts";
import type { CandidateLocalPublicationTestCapability } from "../candidate/manifest.ts";

/** Publication surfaces are intentionally narrow; candidate authority stays sealed. */
export interface Publisher<Input, Result> {
  publish(input: Input): Promise<Result>;
}

export interface OperatorProfile {
  readonly adapter: ChangePlan["publication"]["adapter"];
  readonly configSha256: string;
  readonly environment: string | null;
  readonly siteIndexable: boolean;
}

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
}

export interface PublishResult {
  readonly status: "published";
  readonly publisher: "local" | "cloudflare";
  readonly changeId: string;
  readonly candidateCommit: string;
  readonly artifactSha256: string;
  readonly dryRun: boolean;
}
