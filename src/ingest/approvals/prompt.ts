import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { sanitizedGitEnv } from "../git-env.ts";

const execFileAsync = promisify(execFile);
const fixturePromptBrand: unique symbol = Symbol("fixtureApprovalPrompt");

export interface ApprovalConfirmation {
  gate: 1 | 2;
  subjectSha256: string;
  summary: string;
}

interface ApprovalPrompt {
  readonly isTTY: boolean;
  readonly environment: "production" | "test";
  readonly fixtureProjectRoot: string | null;
  confirm(confirmation: ApprovalConfirmation): Promise<string>;
}

export interface FixtureApprovalPrompt {
  readonly [fixturePromptBrand]: true;
}

export interface FixtureApprovalRun {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  createPrompt(options: {
    isTTY: boolean;
    answer: string;
  }): Promise<FixtureApprovalPrompt>;
  dispose(): Promise<void>;
}

export interface FixtureApprovalRunOptions {
  fixtureSourceRoot: string;
}

const fixturePrompts = new WeakMap<FixtureApprovalPrompt, ApprovalPrompt>();

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertSafeStateRoot(root: string): Promise<void> {
  const stateRoot = join(root, ".change-state");
  try {
    const entry = await lstat(stateRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError(
        "El estado fixture no puede atravesar enlaces simbólicos",
      );
    }
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw error;
  }
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: sanitizedGitEnv(),
    });
    return result.stdout.trim();
  } catch {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
}

async function assertOwnedFixtureClone(root: string): Promise<void> {
  const gitEntry = await lstat(join(root, ".git"));
  if (!gitEntry.isDirectory() || gitEntry.isSymbolicLink()) {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
  if ((await realpath(join(root, ".git"))) !== join(root, ".git")) {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
  if ((await gitOutput(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
  const head = await gitOutput(root, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const origin = await gitOutput(root, ["remote", "get-url", "origin"]);
  const trackedMain = await gitOutput(root, [
    "rev-parse",
    "--verify",
    "refs/remotes/origin/main^{commit}",
  ]);
  if (
    !/^[a-f0-9]{40,64}$/u.test(head) ||
    origin === "" ||
    trackedMain !== head
  ) {
    throw new TypeError("El clon temporal fixture no tiene origen verificable");
  }
  await assertSafeStateRoot(root);
}

async function safeFixtureSource(source: string): Promise<string> {
  const lexical = resolve(source);
  const entry = await lstat(lexical);
  if (entry.isSymbolicLink())
    throw new TypeError("La fuente fixture no puede ser un enlace simbólico");
  return realpath(lexical);
}

export async function createFixtureApprovalRun(
  options: FixtureApprovalRunOptions,
): Promise<FixtureApprovalRun> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "El fixture exige INGEST_TEST_MODE=true explícitamente",
    );
  }
  const source = await safeFixtureSource(options.fixtureSourceRoot);
  const temporaryRoot = await realpath(tmpdir());
  const parent = await mkdtemp(
    join(temporaryRoot, "comunidadsolar-approval-fixture-"),
  );
  const repositoryRoot = join(parent, "clone");
  let disposed = false;
  try {
    await execFileAsync(
      "git",
      ["clone", "--quiet", "--branch", "main", source, repositoryRoot],
      {
        env: sanitizedGitEnv(),
      },
    );
    if (
      !isWithin(temporaryRoot, repositoryRoot) ||
      repositoryRoot.split(/[\\/]+/u).includes(".agent-worktrees")
    ) {
      throw new TypeError(
        "El clon fixture no puede vivir en un worktree de agente",
      );
    }
    await assertOwnedFixtureClone(repositoryRoot);
  } catch (error) {
    await rm(parent, { force: true, recursive: true });
    throw error;
  }

  return Object.freeze({
    repositoryRoot,
    stateRoot: join(repositoryRoot, ".change-state"),
    async createPrompt({ isTTY, answer }: { isTTY: boolean; answer: string }) {
      if (disposed)
        throw new TypeError("El fixture de aprobación ya fue liberado");
      await assertSafeStateRoot(repositoryRoot);
      const capability = Object.freeze({
        [fixturePromptBrand]: true as const,
      }) as FixtureApprovalPrompt;
      fixturePrompts.set(capability, {
        isTTY,
        environment: "test",
        fixtureProjectRoot: repositoryRoot,
        confirm: async () => answer,
      });
      return capability;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(parent, { force: true, recursive: true });
    },
  });
}

function createProductionApprovalPrompt(): ApprovalPrompt {
  return {
    isTTY: stdin.isTTY === true && stdout.isTTY === true,
    environment: "production",
    fixtureProjectRoot: null,
    async confirm({ gate, subjectSha256, summary }): Promise<string> {
      stdout.write(`\nGate ${gate}\n${summary}\nHash: ${subjectSha256}\n`);
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        return await prompt.question(
          `Escriba ${subjectSha256.slice(0, 12)} para aprobar: `,
        );
      } finally {
        prompt.close();
      }
    },
  };
}

export function approvalPrompt(
  fixturePrompt?: FixtureApprovalPrompt,
): ApprovalPrompt {
  if (fixturePrompt === undefined) return createProductionApprovalPrompt();
  const prompt = fixturePrompts.get(fixturePrompt);
  if (prompt === undefined)
    throw new TypeError(
      "El prompt de aprobación debe ser una capacidad fixture autorizada",
    );
  return prompt;
}

export async function assertPromptStateRoot(
  prompt: ReturnType<typeof approvalPrompt>,
  options: { repositoryRoot?: string; stateRoot?: string },
): Promise<void> {
  if (prompt.fixtureProjectRoot === null) return;
  if (
    options.repositoryRoot === undefined ||
    (await realpath(options.repositoryRoot)) !== prompt.fixtureProjectRoot
  ) {
    throw new TypeError(
      "El prompt fixture solo puede leer main desde su clon temporal",
    );
  }
  if (
    resolve(options.stateRoot ?? "") !==
    join(prompt.fixtureProjectRoot, ".change-state")
  ) {
    throw new TypeError(
      "El prompt fixture solo puede escribir estado en su clon temporal",
    );
  }
  await assertSafeStateRoot(prompt.fixtureProjectRoot);
}
