import {
  assertCandidateCloudflarePublication,
  createCandidateCloudflareDryRunTestCapability,
  inspectCandidateCloudflareDryRun,
  recordCandidatePublicationFailure,
  runCandidateCloudflareDryRun,
  type CandidateCloudflareDryRunTestCapability,
} from "../candidate/manifest.ts";

import type {
  CloudflareDryRunDescription,
  CloudflarePublicationInput,
  PublishResult,
  Publisher,
} from "./types.ts";

export { createCandidateCloudflareDryRunTestCapability as createCloudflarePublisherTestCapability };

function assertCloudflareOperator(input: CloudflarePublicationInput): void {
  const profile = input.candidate.buildProfile;
  const operator = input.operator;
  if (profile.adapter !== "cloudflare" || operator.adapter !== "cloudflare") {
    throw new TypeError(
      "El operador Cloudflare no coincide con el perfil de build candidato",
    );
  }
}

function assertNoCloudflareExecutionOverride(
  input: CloudflarePublicationInput,
): void {
  const unsafe = [
    "execute",
    "executable",
    "cwd",
    "argv",
    "command",
    "config",
    "env",
    "assets",
    "entrypoint",
  ].find((key) => Object.hasOwn(input, key));
  if (unsafe !== undefined) {
    throw new TypeError(
      `Cloudflare no acepta ${unsafe}; execute requiere una capability CLI futura`,
    );
  }
}

/** Cloudflare remains fail-closed until a later trusted controller capability exists. */
export class CloudflarePublisher implements Publisher<
  CloudflarePublicationInput,
  PublishResult
> {
  constructor(
    private readonly testCapability?: CandidateCloudflareDryRunTestCapability,
  ) {}

  async inspectDryRun(
    input: CloudflarePublicationInput,
    capability: CandidateCloudflareDryRunTestCapability,
  ): Promise<CloudflareDryRunDescription> {
    assertNoCloudflareExecutionOverride(input);
    assertCloudflareOperator(input);
    await inspectCandidateCloudflareDryRun(
      input.candidate,
      capability,
      input.operator,
    );
    return Object.freeze({
      publisher: "cloudflare",
      dryRun: true,
      changeId: input.candidate.changeId,
      artifactSha256: input.candidate.artifactSha256,
      sealedRedirect: true,
      fixedDeployArguments: true,
      targetEnvironmentBound: true,
    });
  }

  async publish(input: CloudflarePublicationInput): Promise<PublishResult> {
    try {
      assertNoCloudflareExecutionOverride(input);
      assertCloudflareOperator(input);
      await assertCandidateCloudflarePublication(
        input.candidate,
        input.operator,
      );
      if (this.testCapability === undefined) {
        throw new TypeError(
          "No existe una capability Cloudflare confiable para ejecutar el dry-run",
        );
      }
      await runCandidateCloudflareDryRun(
        input.candidate,
        this.testCapability,
        input.operator,
      );
      return Object.freeze({
        status: "published",
        publisher: "cloudflare",
        changeId: input.candidate.changeId,
        candidateCommit: input.candidate.candidateCommit,
        artifactSha256: input.candidate.artifactSha256,
        dryRun: true,
      });
    } catch (error) {
      await recordCandidatePublicationFailure(
        input.candidate,
        "cloudflare",
      ).catch(() => undefined);
      throw error;
    }
  }
}
