import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

async function assertTemporaryFixtureClone(projectRoot: string): Promise<void> {
  const root = resolve(projectRoot);
  if (
    !isWithin(resolve(tmpdir()), root) ||
    root.split(/[\\/]+/u).includes(".agent-worktrees")
  ) {
    throw new TypeError(
      "El prompt fixture exige un clon temporal fuera de worktrees de agente",
    );
  }

  try {
    const gitEntry = await lstat(join(root, ".git"));
    if (!gitEntry.isDirectory() && !gitEntry.isFile()) {
      throw new TypeError("El clon temporal fixture no tiene Git válido");
    }
    const result = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8" },
    );
    if (result.stdout.trim() !== "true") {
      throw new TypeError("El clon temporal fixture no tiene Git válido");
    }
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("El clon temporal fixture no tiene Git válido");
  }
}

export async function createFixtureApprovalPrompt(
  options: FixtureApprovalPromptOptions,
): Promise<FixtureApprovalPrompt> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "El prompt fixture exige INGEST_TEST_MODE=true explícitamente",
    );
  }
  await assertTemporaryFixtureClone(options.projectRoot);
  const capability = Object.freeze({
    [fixturePromptBrand]: true as const,
  }) as FixtureApprovalPrompt;
  fixturePrompts.set(capability, {
    isTTY: options.isTTY,
    environment: "test",
    fixtureProjectRoot: resolve(options.projectRoot),
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

export function assertPromptStateRoot(
  prompt: ReturnType<typeof approvalPrompt>,
  options: { projectRoot?: string; stateRoot?: string },
): void {
  if (prompt.fixtureProjectRoot === null) return;
  const stateRoot = resolve(
    options.stateRoot ??
      join(options.projectRoot ?? process.cwd(), ".change-state"),
  );
  if (stateRoot !== join(prompt.fixtureProjectRoot, ".change-state")) {
    throw new TypeError(
      "El prompt fixture solo puede escribir estado en su clon temporal",
    );
  }
}
