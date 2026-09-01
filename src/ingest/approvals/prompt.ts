import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import {
  fixedGitArgs,
  fixedGitExecutable,
  sanitizedGitEnv,
} from "../git-env.ts";

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
  /** Private issuance class; persisted provenance is derived only by service. */
  readonly issuer: "controller" | "fixture";
  readonly fixtureProjectRoot: string | null;
  confirm(confirmation: ApprovalConfirmation): Promise<string>;
  revalidate(): Promise<void>;
  acquireLease(): Promise<() => void>;
  beforePersist?: () => Promise<void>;
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
    beforePersist?: () => Promise<void>;
  }): Promise<FixtureApprovalPrompt>;
  dispose(): Promise<void>;
}

export interface FixtureApprovalRunOptions {
  fixtureSourceRoot: string;
}

const fixturePrompts = new WeakMap<FixtureApprovalPrompt, ApprovalPrompt>();

interface FilesystemIdentity {
  readonly device: number;
  readonly inode: number;
}

interface FixtureRootIdentity {
  readonly root: FilesystemIdentity;
  readonly git: FilesystemIdentity;
}

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
    const result = await execFileAsync(
      fixedGitExecutable,
      fixedGitArgs(["-C", root, ...args]),
      {
        encoding: "utf8",
        env: sanitizedGitEnv(),
      },
    );
    return result.stdout.trim();
  } catch {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
}

function filesystemIdentity(entry: {
  dev: number;
  ino: number;
}): FilesystemIdentity {
  return { device: entry.dev, inode: entry.ino };
}

function sameFilesystemIdentity(
  left: FilesystemIdentity,
  right: FilesystemIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function assertStandaloneGitRoot(
  root: string,
  expectedIdentity?: FixtureRootIdentity,
): Promise<FixtureRootIdentity> {
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
  if ((await realpath(root)) !== root) {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
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
  const gitRoot = join(root, ".git");
  const [absoluteGitDir, commonGitDir] = await Promise.all([
    gitOutput(root, ["rev-parse", "--absolute-git-dir"]),
    gitOutput(root, ["rev-parse", "--git-common-dir"]),
  ]);
  if (
    resolve(root, absoluteGitDir) !== gitRoot ||
    resolve(root, commonGitDir) !== gitRoot ||
    (await realpath(resolve(root, absoluteGitDir))) !== gitRoot ||
    (await realpath(resolve(root, commonGitDir))) !== gitRoot
  ) {
    throw new TypeError("El clon temporal fixture no tiene Git independiente");
  }
  const identity = {
    root: filesystemIdentity(rootEntry),
    git: filesystemIdentity(gitEntry),
  };
  if (
    expectedIdentity !== undefined &&
    (!sameFilesystemIdentity(identity.root, expectedIdentity.root) ||
      !sameFilesystemIdentity(identity.git, expectedIdentity.git))
  ) {
    throw new TypeError("La identidad del clon fixture ha cambiado");
  }
  return identity;
}

async function assertOwnedFixtureClone(
  root: string,
  expectedIdentity?: FixtureRootIdentity,
  requireOriginAtHead = false,
): Promise<FixtureRootIdentity> {
  const identity = await assertStandaloneGitRoot(root, expectedIdentity);
  if (requireOriginAtHead) {
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
      throw new TypeError(
        "El clon temporal fixture no tiene origen verificable",
      );
    }
  }
  await assertSafeStateRoot(root);
  return identity;
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
  let closing = false;
  let activeLeases = 0;
  let resolveIdleLeases: (() => void) | undefined;
  let disposePromise: Promise<void> | undefined;
  const capabilities = new Set<FixtureApprovalPrompt>();
  let identity: FixtureRootIdentity;
  try {
    await execFileAsync(
      fixedGitExecutable,
      fixedGitArgs([
        "clone",
        "--no-hardlinks",
        "--quiet",
        "--branch",
        "main",
        source,
        repositoryRoot,
      ]),
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
    identity = await assertOwnedFixtureClone(repositoryRoot, undefined, true);
  } catch (error) {
    await rm(parent, { force: true, recursive: true });
    throw error;
  }

  return Object.freeze({
    repositoryRoot,
    stateRoot: join(repositoryRoot, ".change-state"),
    async createPrompt({
      isTTY,
      answer,
      beforePersist,
    }: {
      isTTY: boolean;
      answer: string;
      beforePersist?: () => Promise<void>;
    }) {
      if (closing)
        throw new TypeError("El fixture de aprobación ya fue liberado");
      await assertOwnedFixtureClone(repositoryRoot, identity);
      const capability = Object.freeze({
        [fixturePromptBrand]: true as const,
      }) as FixtureApprovalPrompt;
      capabilities.add(capability);
      fixturePrompts.set(capability, {
        isTTY,
        environment: "test",
        issuer: "fixture",
        fixtureProjectRoot: repositoryRoot,
        confirm: async () => answer,
        beforePersist,
        async acquireLease() {
          if (closing)
            throw new TypeError("El fixture de aprobación ya fue liberado");
          activeLeases += 1;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            activeLeases -= 1;
            if (activeLeases === 0) resolveIdleLeases?.();
          };
        },
        async revalidate() {
          if (closing)
            throw new TypeError("El fixture de aprobación ya fue liberado");
          try {
            await assertOwnedFixtureClone(repositoryRoot, identity);
          } catch (error: unknown) {
            if (error instanceof TypeError) throw error;
            throw new TypeError("La identidad del clon fixture no es válida");
          }
        },
      });
      return capability;
    },
    async dispose() {
      if (disposePromise !== undefined) return disposePromise;
      closing = true;
      for (const capability of capabilities) fixturePrompts.delete(capability);
      capabilities.clear();
      disposePromise = (async () => {
        if (activeLeases > 0) {
          await new Promise<void>((resolve) => {
            resolveIdleLeases = resolve;
          });
        }
        await rm(parent, {
          force: true,
          maxRetries: 3,
          recursive: true,
          retryDelay: 10,
        });
      })();
      return disposePromise;
    },
  });
}

function createProductionApprovalPrompt(): ApprovalPrompt {
  return {
    isTTY: stdin.isTTY === true && stdout.isTTY === true,
    environment: "production",
    issuer: "controller",
    fixtureProjectRoot: null,
    async revalidate() {},
    async acquireLease() {
      return () => {};
    },
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
  capability?: FixtureApprovalPrompt,
): ApprovalPrompt {
  if (capability === undefined) return createProductionApprovalPrompt();
  const prompt = fixturePrompts.get(capability);
  if (prompt === undefined)
    throw new TypeError(
      "El prompt de aprobación debe ser una capacidad controladora autorizada",
    );
  return prompt;
}

export async function acquireApprovalLease(
  prompt: ReturnType<typeof approvalPrompt>,
): Promise<() => void> {
  return prompt.acquireLease();
}

export async function beforeApprovalPersist(
  prompt: ReturnType<typeof approvalPrompt>,
): Promise<void> {
  await prompt.beforePersist?.();
}

export async function assertPromptStateRoot(
  prompt: ReturnType<typeof approvalPrompt>,
  options: { repositoryRoot?: string; stateRoot?: string },
): Promise<void> {
  if (prompt.fixtureProjectRoot === null) return;
  await prompt.revalidate();
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(options.repositoryRoot ?? "");
  } catch {
    throw new TypeError("El repositorio fixture no tiene una raíz válida");
  }
  if (
    options.repositoryRoot === undefined ||
    repositoryRoot !== prompt.fixtureProjectRoot
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
