import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

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

/** An opaque prompt capability minted only for an explicit fixture run. */
export interface FixtureApprovalPrompt {
  readonly [fixturePromptBrand]: true;
}

export interface FixtureApprovalPromptOptions {
  projectRoot: string;
  isTTY: boolean;
  answer: string;
}

const fixturePrompts = new WeakMap<FixtureApprovalPrompt, ApprovalPrompt>();

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertNoSymlinkDescendants(
  parent: string,
  child: string,
): Promise<void> {
  let cursor = child;
  while (cursor !== parent) {
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink()) {
      throw new TypeError(
        "El clon fixture no puede atravesar enlaces simbólicos",
      );
    }
    const parent = resolve(cursor, "..");
    cursor = parent;
  }
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
    ) {
      return;
    }
    throw error;
  }
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
    });
    return result.stdout.trim();
  } catch {
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
}

async function assertTemporaryFixtureClone(
  projectRoot: string,
): Promise<string> {
  const lexicalRoot = resolve(projectRoot);
  const lexicalTemporaryRoot = resolve(tmpdir());
  if (!isWithin(lexicalTemporaryRoot, lexicalRoot)) {
    throw new TypeError(
      "El prompt fixture exige un clon temporal fuera de worktrees de agente",
    );
  }
  const relativeRoot = relative(lexicalTemporaryRoot, lexicalRoot);
  const [root, temporaryRoot] = await Promise.all([
    realpath(lexicalRoot),
    realpath(tmpdir()),
  ]);
  if (
    root !== resolve(temporaryRoot, relativeRoot) ||
    !isWithin(temporaryRoot, root) ||
    root.split(/[\\/]+/u).includes(".agent-worktrees")
  ) {
    throw new TypeError(
      "El prompt fixture exige un clon temporal fuera de worktrees de agente",
    );
  }
  try {
    await assertNoSymlinkDescendants(temporaryRoot, root);
  } catch {
    throw new TypeError(
      "El prompt fixture exige un clon temporal fuera de worktrees de agente",
    );
  }

  try {
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
      throw new TypeError(
        "El clon temporal fixture no tiene origen verificable",
      );
    }
    await assertSafeStateRoot(root);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
  return root;
}

export async function createFixtureApprovalPrompt(
  options: FixtureApprovalPromptOptions,
): Promise<FixtureApprovalPrompt> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "El prompt fixture exige INGEST_TEST_MODE=true explícitamente",
    );
  }
  const projectRoot = await assertTemporaryFixtureClone(options.projectRoot);
  const capability = Object.freeze({
    [fixturePromptBrand]: true as const,
  }) as FixtureApprovalPrompt;
  fixturePrompts.set(capability, {
    isTTY: options.isTTY,
    environment: "test",
    fixtureProjectRoot: projectRoot,
    confirm: async () => options.answer,
  });
  return capability;
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
  if (prompt === undefined) {
    throw new TypeError(
      "El prompt de aprobación debe ser una capacidad fixture autorizada",
    );
  }
  return prompt;
}

export async function assertPromptStateRoot(
  prompt: ReturnType<typeof approvalPrompt>,
  options: {
    projectRoot?: string;
    repositoryRoot?: string;
    stateRoot?: string;
  },
): Promise<void> {
  if (prompt.fixtureProjectRoot === null) return;
  const stateRoot = resolve(
    options.stateRoot ??
      join(options.projectRoot ?? process.cwd(), ".change-state"),
  );
  const expectedStateRoot = resolve(
    options.repositoryRoot ?? "",
    ".change-state",
  );
  if (stateRoot !== expectedStateRoot) {
    throw new TypeError(
      "El prompt fixture solo puede escribir estado en su clon temporal",
    );
  }
  if (
    options.repositoryRoot === undefined ||
    (await realpath(options.repositoryRoot)) !== prompt.fixtureProjectRoot
  ) {
    throw new TypeError(
      "El prompt fixture solo puede leer main desde su clon temporal",
    );
  }
  await assertSafeStateRoot(prompt.fixtureProjectRoot);
}
