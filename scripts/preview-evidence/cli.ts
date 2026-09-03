import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./domain.ts";
import {
  createGitHubApi,
  type GitHubApi,
  resolvePullRequestRun,
  writeGitHubOutputs,
  writePullRequestContext,
} from "./github.ts";
import { loadEvidenceRequest } from "./request.ts";

export interface PreviewEvidenceCliDependencies {
  createApi?: (token: string, repository: string) => GitHubApi;
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
  if (command !== "resolve-pr" && command !== "validate-request") {
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
