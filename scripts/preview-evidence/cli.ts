import { lstat, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./domain.ts";
import { createSealedBundle, verifySealedBundle } from "./bundle.ts";
import {
  deployExactVersion,
  readCloudflareVersionDescriptor,
  uploadPreviewVersion,
  type WranglerRunner,
  writeCloudflareVersionDescriptor,
} from "./cloudflare.ts";
import {
  type BrowserAdapter,
  capturePullRequestEvidence,
  captureReleaseEvidence,
  readReleaseCaptureContext,
  writeReleaseCaptureContext,
} from "./capture.ts";
import {
  approvePreviewForCurrentPullRequest,
  assertCurrentMainHead,
  createGitHubApi,
  type GitHubApi,
  readPullRequestContext,
  resolveMainRun,
  resolvePullRequestRun,
  upsertEvidenceComments,
  upsertReleaseEvidenceComments,
  writeGitHubOutputs,
  writePullRequestContext,
} from "./github.ts";
import {
  publishEvidenceToCheckout,
  readCaptureSet,
  readPublishEvidenceResult,
  writePublishEvidenceResult,
} from "./evidence.ts";
import { loadEvidenceRequest } from "./request.ts";
import { materializePreviewProfile } from "./profile.ts";

export interface PreviewEvidenceCliDependencies {
  createApi?: (token: string, repository: string) => GitHubApi;
  wranglerRunner?: WranglerRunner;
  browserAdapter?: BrowserAdapter;
  stdout?: (message: string) => void;
}

type CliEnvironment = Readonly<Record<string, string | undefined>>;

function parseFlags(
  values: readonly string[],
  expected: readonly string[],
): Record<string, string> {
  if (values.length !== expected.length * 2) {
    throw new TypeError("Uso inválido del comando preview:evidence");
  }
  const allowed = new Set(expected);
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      !allowed.has(flag) ||
      Object.hasOwn(result, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0")
    ) {
      throw new TypeError("Uso inválido del comando preview:evidence");
    }
    result[flag] = value;
  }
  if (expected.some((flag) => !Object.hasOwn(result, flag))) {
    throw new TypeError("Uso inválido del comando preview:evidence");
  }
  return result;
}

async function readJsonFile(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
    throw new TypeError("El evento GitHub debe ser un archivo JSON regular");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new TypeError("El evento GitHub contiene JSON inválido");
  }
}

function requireEnvironment(environment: CliEnvironment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`Falta la configuración requerida ${key}`);
  }
  return value;
}

export async function runPreviewEvidenceCli(
  argv: readonly string[],
  environment: CliEnvironment = process.env,
  dependencies: PreviewEvidenceCliDependencies = {},
): Promise<void> {
  const [command, ...rest] = argv;
  const stdout =
    dependencies.stdout ?? ((message: string) => process.stdout.write(message));
  if (
    command !== "resolve-pr" &&
    command !== "resolve-main" &&
    command !== "recheck-main" &&
    command !== "validate-request" &&
    command !== "seal-bundle" &&
    command !== "verify-bundle" &&
    command !== "upload-version" &&
    command !== "deploy-version" &&
    command !== "capture-pr" &&
    command !== "capture-release" &&
    command !== "publish-evidence" &&
    command !== "publish-release-evidence" &&
    command !== "comment-evidence" &&
    command !== "comment-release-evidence" &&
    command !== "approve-preview" &&
    command !== "materialize-profile"
  ) {
    throw new TypeError(
      "Comando preview:evidence desconocido; consulte el uso",
    );
  }

  if (command === "validate-request") {
    const flags = parseFlags(rest, ["--path", "--root"]);
    const request = await loadEvidenceRequest(flags["--path"], flags["--root"]);
    stdout(
      `EVIDENCE_REQUEST_OK issue=${request.issue} route=${request.route}\n`,
    );
    return;
  }

  if (command === "materialize-profile") {
    const flags = parseFlags(rest, ["--output", "--root", "--github-output"]);
    const artifact = await materializePreviewProfile(
      requireEnvironment(environment, "CLOUDFLARE_PREVIEW_CONFIG_B64"),
      flags["--output"],
      flags["--root"],
    );
    const relativePath = relative(resolve(flags["--output"]), artifact.path)
      .split(sep)
      .join("/");
    if (relativePath.startsWith("../") || relativePath.startsWith("/")) {
      throw new TypeError("El perfil saneado salió del output esperado");
    }
    await writeGitHubOutputs(flags["--github-output"], {
      profile_relative: relativePath,
      profile_sha256: artifact.sha256,
    });
    stdout(`PREVIEW_PROFILE_OK indexable=${artifact.indexable}\n`);
    return;
  }

  if (command === "seal-bundle") {
    const flags = parseFlags(rest, [
      "--source",
      "--output",
      "--role",
      "--sha",
      "--profile",
      "--profile-sha",
    ]);
    const manifest = await createSealedBundle({
      sourceRoot: flags["--source"],
      outputRoot: flags["--output"],
      role: flags["--role"] as "base" | "candidate" | "release",
      sourceSha: flags["--sha"],
      profilePath: flags["--profile"],
      profileSha256: flags["--profile-sha"],
    });
    stdout(
      `BUNDLE_SEALED_OK role=${manifest.role} sha256=${manifest.bundleSha256}\n`,
    );
    return;
  }

  if (command === "verify-bundle") {
    const flags = parseFlags(rest, [
      "--root",
      "--role",
      "--sha",
      "--profile",
      "--profile-sha",
    ]);
    const manifest = await verifySealedBundle(flags["--root"], {
      role: flags["--role"] as "base" | "candidate" | "release",
      sourceSha: flags["--sha"],
      profilePath: flags["--profile"],
      profileSha256: flags["--profile-sha"],
    });
    stdout(
      `BUNDLE_VERIFIED_OK role=${manifest.role} sha256=${manifest.bundleSha256}\n`,
    );
    return;
  }

  if (command === "upload-version") {
    const flags = parseFlags(rest, [
      "--bundle",
      "--profile",
      "--profile-sha",
      "--context",
      "--context-sha",
      "--role",
      "--output",
    ]);
    if (
      flags["--role"] !== "base" &&
      flags["--role"] !== "candidate" &&
      flags["--role"] !== "release"
    ) {
      throw new TypeError("upload-version recibió un role inválido");
    }
    const role = flags["--role"];
    let sourceSha: string;
    let prNumber: number | undefined;
    if (role === "release") {
      const context = await readReleaseCaptureContext(
        flags["--context"],
        flags["--context-sha"],
      );
      sourceSha = context.sourceSha;
    } else {
      const context = await readPullRequestContext(
        flags["--context"],
        flags["--context-sha"],
      );
      sourceSha = role === "base" ? context.baseSha : context.headSha;
      prNumber = context.prNumber;
    }
    await verifySealedBundle(flags["--bundle"], {
      role,
      sourceSha,
      profilePath: flags["--profile"],
      profileSha256: flags["--profile-sha"],
    });
    const credentials = {
      accountId: requireEnvironment(environment, "CLOUDFLARE_ACCOUNT_ID"),
      apiToken: requireEnvironment(environment, "CLOUDFLARE_API_TOKEN"),
    };
    const descriptor = await uploadPreviewVersion(
      {
        bundleRoot: flags["--bundle"],
        profilePath: flags["--profile"],
        profileSha256: flags["--profile-sha"],
        role,
        sourceSha,
        prNumber,
        credentials,
      },
      dependencies.wranglerRunner,
    );
    await writeCloudflareVersionDescriptor(flags["--output"], descriptor);
    stdout(
      `CLOUDFLARE_VERSION_UPLOADED_OK role=${role} sha256=${descriptor.bundleSha256}\n`,
    );
    return;
  }

  if (command === "deploy-version") {
    const flags = parseFlags(rest, [
      "--bundle",
      "--profile",
      "--profile-sha",
      "--descriptor",
    ]);
    const descriptor = await readCloudflareVersionDescriptor(
      flags["--descriptor"],
    );
    const manifest = await verifySealedBundle(flags["--bundle"], {
      role: descriptor.role,
      sourceSha: descriptor.sourceSha,
      profilePath: flags["--profile"],
      profileSha256: flags["--profile-sha"],
    });
    if (manifest.bundleSha256 !== descriptor.bundleSha256) {
      throw new Error(
        "El descriptor Cloudflare no coincide con el bundle sellado",
      );
    }
    const credentials = {
      accountId: requireEnvironment(environment, "CLOUDFLARE_ACCOUNT_ID"),
      apiToken: requireEnvironment(environment, "CLOUDFLARE_API_TOKEN"),
    };
    await deployExactVersion(
      {
        bundleRoot: flags["--bundle"],
        profilePath: flags["--profile"],
        profileSha256: flags["--profile-sha"],
        descriptor,
        credentials,
      },
      dependencies.wranglerRunner,
    );
    stdout(
      `CLOUDFLARE_VERSION_DEPLOYED_OK role=${descriptor.role} sha=${descriptor.sourceSha}\n`,
    );
    return;
  }

  if (command === "capture-pr") {
    const flags = parseFlags(rest, [
      "--context",
      "--context-sha",
      "--base",
      "--candidate",
      "--output",
      "--run-attempt",
    ]);
    if (!/^[1-9][0-9]*$/u.test(flags["--run-attempt"])) {
      throw new TypeError("El run attempt de captura es inválido");
    }
    const runAttempt = Number(flags["--run-attempt"]);
    if (!Number.isSafeInteger(runAttempt)) {
      throw new TypeError("El run attempt de captura es inválido");
    }
    const context = await readPullRequestContext(
      flags["--context"],
      flags["--context-sha"],
    );
    const base = await readCloudflareVersionDescriptor(flags["--base"]);
    const candidate = await readCloudflareVersionDescriptor(
      flags["--candidate"],
    );
    const set = await capturePullRequestEvidence(
      {
        context,
        base,
        candidate,
        outputRoot: flags["--output"],
        runAttempt,
      },
      dependencies.browserAdapter,
    );
    stdout(
      `PREVIEW_CAPTURE_OK issue=${set.manifest.issue} files=${set.manifest.captures.length}\n`,
    );
    return;
  }

  if (command === "capture-release") {
    const flags = parseFlags(rest, [
      "--context",
      "--context-sha",
      "--release",
      "--shared-url",
      "--output",
      "--run-attempt",
    ]);
    if (!/^[1-9][0-9]*$/u.test(flags["--run-attempt"])) {
      throw new TypeError("El run attempt de captura es inválido");
    }
    const runAttempt = Number(flags["--run-attempt"]);
    if (!Number.isSafeInteger(runAttempt)) {
      throw new TypeError("El run attempt de captura es inválido");
    }
    const context = await readReleaseCaptureContext(
      flags["--context"],
      flags["--context-sha"],
    );
    const release = await readCloudflareVersionDescriptor(flags["--release"]);
    const set = await captureReleaseEvidence(
      {
        context,
        release,
        sharedUrl: flags["--shared-url"],
        outputRoot: flags["--output"],
        runAttempt,
      },
      dependencies.browserAdapter,
    );
    stdout(
      `RELEASE_CAPTURE_OK issue=${set.manifest.issue} files=${set.manifest.captures.length}\n`,
    );
    return;
  }

  if (
    command === "publish-evidence" ||
    command === "publish-release-evidence"
  ) {
    const flags = parseFlags(rest, [
      "--capture",
      "--checkout",
      "--context",
      "--context-sha",
      "--output",
      "--github-output",
    ]);
    const context =
      command === "publish-release-evidence"
        ? await readReleaseCaptureContext(
            flags["--context"],
            flags["--context-sha"],
          )
        : await readPullRequestContext(
            flags["--context"],
            flags["--context-sha"],
          );
    const capture = await readCaptureSet(flags["--capture"]);
    const publication = await publishEvidenceToCheckout({
      capture,
      checkoutRoot: flags["--checkout"],
      context,
    });
    await writePublishEvidenceResult(flags["--output"], publication);
    const identityEntry = publication.entries.find(
      (entry) =>
        entry.role ===
        (publication.kind === "pull-request" ? "candidate" : "release"),
    );
    if (identityEntry === undefined) {
      throw new Error("La publicación no contiene su identidad principal");
    }
    await writeGitHubOutputs(flags["--github-output"], {
      added_count: String(publication.addedPaths.length),
      added_paths: publication.addedPaths.join("\n"),
      commit_message: publication.commitMessage,
      identity_manifest: `${identityEntry.relativeDirectory}/manifest.json`,
    });
    const label =
      command === "publish-release-evidence"
        ? "RELEASE_EVIDENCE_PUBLISHED_OK"
        : "EVIDENCE_PUBLISHED_OK";
    stdout(
      `${label} issue=${publication.issueNumber} added=${publication.addedPaths.length} existing=${publication.existingPaths.length}\n`,
    );
    return;
  }

  if (
    command === "comment-evidence" ||
    command === "comment-release-evidence"
  ) {
    const flags = parseFlags(rest, [
      "--publication",
      "--context",
      "--context-sha",
      "--evidence-sha",
    ]);
    const context =
      command === "comment-release-evidence"
        ? await readReleaseCaptureContext(
            flags["--context"],
            flags["--context-sha"],
          )
        : await readPullRequestContext(
            flags["--context"],
            flags["--context-sha"],
          );
    const publication = await readPublishEvidenceResult(flags["--publication"]);
    const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
    if (repository !== context.repository) {
      throw new TypeError("El repositorio de comments no coincide con GitHub");
    }
    const token = requireEnvironment(environment, "GITHUB_TOKEN");
    const api = (dependencies.createApi ?? createGitHubApi)(token, repository);
    if (command === "comment-release-evidence") {
      if (!("sourceSha" in context)) {
        throw new TypeError("El contexto de comentarios release es inválido");
      }
      await upsertReleaseEvidenceComments(api, {
        context,
        publication,
        evidenceCommitSha: flags["--evidence-sha"],
      });
      stdout(
        `RELEASE_EVIDENCE_COMMENTS_OK issue=${context.issueNumber} sha=${context.sourceSha}\n`,
      );
    } else {
      if (!("headSha" in context)) {
        throw new TypeError("El contexto de comentarios PR es inválido");
      }
      await upsertEvidenceComments(api, {
        context,
        publication,
        evidenceCommitSha: flags["--evidence-sha"],
      });
      stdout(
        `EVIDENCE_COMMENTS_OK issue=${context.issueNumber} sha=${context.headSha}\n`,
      );
    }
    return;
  }

  if (command === "approve-preview") {
    const flags = parseFlags(rest, ["--context", "--context-sha"]);
    const context = await readPullRequestContext(
      flags["--context"],
      flags["--context-sha"],
    );
    const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
    if (repository !== context.repository) {
      throw new TypeError("El repositorio de approval no coincide con GitHub");
    }
    const token = requireEnvironment(environment, "GITHUB_TOKEN");
    const api = (dependencies.createApi ?? createGitHubApi)(token, repository);
    await approvePreviewForCurrentPullRequest(api, context);
    stdout(`PREVIEW_APPROVED_OK sha=${context.headSha}\n`);
    return;
  }

  if (command === "recheck-main") {
    const flags = parseFlags(rest, ["--context", "--context-sha"]);
    const context = await readReleaseCaptureContext(
      flags["--context"],
      flags["--context-sha"],
    );
    const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
    if (repository !== context.repository) {
      throw new TypeError("El repositorio de main no coincide con GitHub");
    }
    const token = requireEnvironment(environment, "GITHUB_TOKEN");
    const api = (dependencies.createApi ?? createGitHubApi)(token, repository);
    await assertCurrentMainHead(api, context);
    stdout(`MAIN_HEAD_RECHECK_OK sha=${context.sourceSha}\n`);
    return;
  }

  const flags = parseFlags(rest, ["--event", "--output", "--context"]);
  const token = requireEnvironment(environment, "GITHUB_TOKEN");
  const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
  const api = (dependencies.createApi ?? createGitHubApi)(token, repository);
  if (command === "resolve-main") {
    const resolved = await resolveMainRun(
      await readJsonFile(flags["--event"]),
      api,
      environment.PREVIEW_PIPELINE_BOOTSTRAP_PR,
    );
    const resolvedRepository =
      resolved.kind === "release"
        ? resolved.context.repository
        : resolved.repository;
    if (resolvedRepository !== repository) {
      throw new TypeError("El repositorio del evento no coincide con GitHub");
    }
    if (resolved.kind === "bootstrap") {
      await writeGitHubOutputs(flags["--output"], {
        bootstrap: "true",
        pr_number: String(resolved.prNumber),
        source_sha: resolved.sourceSha,
        run_id: String(resolved.runId),
      });
      stdout(
        `${canonicalJson({ ok: true, command: "resolve-main", bootstrap: true })}\n`,
      );
      return;
    }
    const context = resolved.context;
    const sealed = await writeReleaseCaptureContext(
      flags["--context"],
      context,
    );
    await writeGitHubOutputs(flags["--output"], {
      bootstrap: "false",
      pr_number: String(context.prNumber),
      issue_number: String(context.issueNumber),
      source_sha: context.sourceSha,
      request_path: context.requestPath,
      run_id: String(context.runId),
      context_path: sealed.path,
      context_sha256: sealed.sha256,
    });
    stdout(
      `${canonicalJson({ ok: true, command: "resolve-main", bootstrap: false })}\n`,
    );
    return;
  }
  const context = await resolvePullRequestRun(
    await readJsonFile(flags["--event"]),
    api,
  );
  if (context.repository !== repository) {
    throw new TypeError("El repositorio del evento no coincide con GitHub");
  }
  const sealed = await writePullRequestContext(flags["--context"], context);
  await writeGitHubOutputs(flags["--output"], {
    pr_number: String(context.prNumber),
    issue_number: String(context.issueNumber),
    base_sha: context.baseSha,
    head_sha: context.headSha,
    request_path: context.requestPath,
    run_id: String(context.runId),
    context_path: sealed.path,
    context_sha256: sealed.sha256,
  });
  stdout(`${canonicalJson({ ok: true, command: "resolve-pr" })}\n`);
}

async function main(): Promise<void> {
  await runPreviewEvidenceCli(process.argv.slice(2));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Fallo preview:evidence"}\n`,
    );
    process.exitCode = 1;
  });
}
