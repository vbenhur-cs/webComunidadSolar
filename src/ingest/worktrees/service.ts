import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { sanitizedGitEnv } from "../git-env.ts";

const execFileAsync = promisify(execFile);
const inputNames = ["request.json", "plan.json", "policy.json"] as const;

export interface CandidateWorktreeInput {
  repositoryRoot: string;
  sourceRepositoryRoot?: string;
  changeId: string;
  attemptId: string;
  baselineCommit: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
}

export interface CandidateWorktree {
  path: string;
  repositoryRoot: string;
  sourceRepositoryRoot: string;
  changeId: string;
  attemptId: string;
  baselineCommit: string;
  branch: string;
  inputHash: string;
  mainRef: string;
  repositoryStatus: string;
  sourceStatus: string;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)) {
    throw new TypeError(`El ${label} no es seguro para un worktree`);
  }
}

function assertCommit(value: string): void {
  if (!/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new TypeError("El baseline no es un commit válido");
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnv(),
  });
  return result.stdout.trim();
}

async function trustedRoot(root: string): Promise<string> {
  const lexical = resolve(root);
  const entry = await lstat(lexical);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError("La raíz del worktree no es un directorio seguro");
  }
  const canonical = await realpath(lexical);
  if ((await git(canonical, ["rev-parse", "--show-toplevel"])) !== canonical) {
    throw new TypeError("La raíz del worktree no coincide con Git");
  }
  return canonical;
}

async function status(root: string): Promise<string> {
  return await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
}

async function inputHash(inputDirectory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of inputNames) {
    const path = join(inputDirectory, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new TypeError("La entrada del agente no es un archivo seguro");
    }
    const content = await readFile(path);
    hash.update(name);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function copyInput(from: string, destination: string): Promise<void> {
  const entry = await lstat(from);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError("La entrada aprobada no es un archivo seguro");
  }
  await cp(from, destination, { dereference: false, errorOnExist: true });
}

function candidatePath(
  root: string,
  changeId: string,
  attemptId: string,
): string {
  return join(root, ".agent-worktrees", changeId, attemptId);
}

function assertCandidatePath(candidate: CandidateWorktree): string {
  const expected = candidatePath(
    candidate.repositoryRoot,
    candidate.changeId,
    candidate.attemptId,
  );
  if (resolve(candidate.path) !== resolve(expected)) {
    throw new TypeError("La limpieza del worktree no reconoce ese path");
  }
  const rootRelative = relative(candidate.repositoryRoot, expected);
  if (rootRelative.startsWith("..") || rootRelative === "") {
    throw new TypeError("La limpieza del worktree no reconoce ese path");
  }
  return expected;
}

export async function createCandidateWorktree(
  input: CandidateWorktreeInput,
): Promise<CandidateWorktree> {
  assertIdentifier(input.changeId, "changeId");
  assertIdentifier(input.attemptId, "attemptId");
  assertCommit(input.baselineCommit);
  const repositoryRoot = await trustedRoot(input.repositoryRoot);
  const sourceRepositoryRoot = await trustedRoot(
    input.sourceRepositoryRoot ?? input.repositoryRoot,
  );
  const mainRef = await git(repositoryRoot, [
    "rev-parse",
    "--verify",
    "refs/heads/main^{commit}",
  ]);
  if (mainRef !== input.baselineCommit) {
    throw new TypeError("El baseline aprobado no coincide con refs/heads/main");
  }
  await git(repositoryRoot, [
    "cat-file",
    "-e",
    `${input.baselineCommit}^{commit}`,
  ]);

  const path = candidatePath(repositoryRoot, input.changeId, input.attemptId);
  const branch = `candidate/${input.changeId}/${input.attemptId}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        repositoryRoot,
        "worktree",
        "add",
        "--detach",
        path,
        input.baselineCommit,
      ],
      { encoding: "utf8", env: sanitizedGitEnv() },
    );
    await git(path, ["switch", "--quiet", "-c", branch]);
    const inputDirectory = join(path, ".agent-input");
    await mkdir(inputDirectory, { recursive: false });
    await Promise.all([
      copyInput(input.requestPath, join(inputDirectory, inputNames[0])),
      copyInput(input.planPath, join(inputDirectory, inputNames[1])),
      copyInput(input.policyPath, join(inputDirectory, inputNames[2])),
    ]);
    const hash = await inputHash(inputDirectory);
    await writeFile(join(inputDirectory, ".sha256"), `${hash}\n`, "utf8");
    return {
      path,
      repositoryRoot,
      sourceRepositoryRoot,
      changeId: input.changeId,
      attemptId: input.attemptId,
      baselineCommit: input.baselineCommit,
      branch,
      inputHash: hash,
      mainRef,
      repositoryStatus: await status(repositoryRoot),
      sourceStatus: await status(sourceRepositoryRoot),
    };
  } catch (error) {
    await removeWorktreeAt(repositoryRoot, path);
    throw error;
  }
}

async function removeWorktreeAt(
  repositoryRoot: string,
  path: string,
): Promise<void> {
  try {
    await execFileAsync(
      "git",
      ["-C", repositoryRoot, "worktree", "remove", "--force", path],
      { encoding: "utf8", env: sanitizedGitEnv() },
    );
  } catch {
    // A failed add may have no registered worktree. Only the exact candidate can be removed.
    await rm(path, { recursive: true, force: true });
  }
}

export async function removeCandidateWorktree(
  candidate: CandidateWorktree,
): Promise<void> {
  const path = assertCandidatePath(candidate);
  const entry = await lstat(path).catch(() => undefined);
  if (entry?.isSymbolicLink()) {
    throw new TypeError("La limpieza rechaza un worktree enlazado");
  }
  await removeWorktreeAt(candidate.repositoryRoot, path);
}

export async function copiedInputHash(
  candidate: CandidateWorktree,
): Promise<string> {
  assertCandidatePath(candidate);
  const hash = await inputHash(join(candidate.path, ".agent-input"));
  const recorded = await readFile(
    join(candidate.path, ".agent-input", ".sha256"),
    "utf8",
  );
  if (recorded !== `${candidate.inputHash}\n`) {
    throw new TypeError("La entrada del agente cambió después del aislamiento");
  }
  return hash;
}

export async function worktreeGit(
  candidate: CandidateWorktree,
  args: string[],
): Promise<string> {
  assertCandidatePath(candidate);
  return await git(candidate.path, args);
}

export async function worktreeStatus(
  candidate: CandidateWorktree,
): Promise<string> {
  assertCandidatePath(candidate);
  return await status(candidate.path);
}

export async function externalStatus(root: string): Promise<string> {
  return await status(root);
}
