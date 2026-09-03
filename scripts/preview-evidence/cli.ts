import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
} from "./capture.ts";
import {
  createGitHubApi,
  type GitHubApi,
  readPullRequestContext,
  resolvePullRequestRun,
  writeGitHubOutputs,
  writePullRequestContext,
} from "./github.ts";
import { loadEvidenceRequest } from "./request.ts";

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
    command !== "validate-request" &&
    command !== "seal-bundle" &&
    command !== "verify-bundle" &&
    command !== "upload-version" &&
    command !== "deploy-version" &&
    command !== "capture-pr" &&
    command !== "capture-release"
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
    if (flags["--role"] !== "base" && flags["--role"] !== "candidate") {
      throw new TypeError(
        "upload-version con contexto PR solo admite base o candidate",
      );
    }
    const context = await readPullRequestContext(
      flags["--context"],
      flags["--context-sha"],
    );
    const role = flags["--role"];
    const sourceSha = role === "base" ? context.baseSha : context.headSha;
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
        prNumber: context.prNumber,
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

  const flags = parseFlags(rest, ["--event", "--output", "--context"]);
  const token = requireEnvironment(environment, "GITHUB_TOKEN");
  const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
  const api = (dependencies.createApi ?? createGitHubApi)(token, repository);
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
