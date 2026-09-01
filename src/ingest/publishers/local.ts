import {
  assertCandidateLocalPublication,
  createCandidateLocalPublicationTestCapability,
  recordCandidatePublicationFailure,
} from "../candidate/manifest.ts";
import { startCandidatePreview } from "../candidate/preview.ts";

import type {
  LocalPublicationInput,
  PublishResult,
  Publisher,
} from "./types.ts";

export { createCandidateLocalPublicationTestCapability as createLocalPublisherTestCapability };

function assertLocalOperator(input: LocalPublicationInput): void {
  const profile = input.candidate.buildProfile;
  const operator = input.operator;
  if (
    profile.adapter !== "local" ||
    operator.adapter !== "local" ||
    operator.configSha256 !== profile.configSha256 ||
    operator.environment !== profile.environment ||
    operator.siteIndexable !== profile.siteIndexable
  ) {
    throw new TypeError(
      "El operador local no coincide con el perfil de build candidato",
    );
  }
}

async function healthCheck(
  candidate: LocalPublicationInput["candidate"],
  url: string,
): Promise<void> {
  const base = new URL(url);
  const route = new URL(candidate.routes[0] ?? "", base);
  if (route.origin !== base.origin) {
    throw new TypeError("La ruta local declarada escapa el preview candidato");
  }
  const response = await fetch(route, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new TypeError(
      `El health check local respondió ${response.status.toString()}`,
    );
  }
}

/** Local publication always starts and stops only the sealed candidate preview. */
export class LocalPublisher implements Publisher<
  LocalPublicationInput,
  PublishResult
> {
  async publish(input: LocalPublicationInput): Promise<PublishResult> {
    try {
      assertLocalOperator(input);
      await assertCandidateLocalPublication(
        input.candidate,
        input.testCapability,
      );
      const preview = await startCandidatePreview(input.candidate);
      try {
        await healthCheck(input.candidate, preview.url);
      } finally {
        await preview.stop();
      }
      return Object.freeze({
        status: "published",
        publisher: "local",
        changeId: input.candidate.changeId,
        candidateCommit: input.candidate.candidateCommit,
        artifactSha256: input.candidate.artifactSha256,
        dryRun: false,
      });
    } catch (error) {
      await recordCandidatePublicationFailure(input.candidate, "local").catch(
        () => undefined,
      );
      throw error;
    }
  }
}
