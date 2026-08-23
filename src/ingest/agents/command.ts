import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runProcess,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
  type IsolationBroker,
  type ProcessRunner,
} from "./types.ts";

export interface CommandAgentConfig {
  command: string;
  args: string[];
}

function outputPaths(worktree: string): {
  outputDir: string;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  finalMessagePath: string;
} {
  const outputDir = join(worktree, ".agent-output");
  return {
    outputDir,
    resultPath: join(outputDir, "command-result.json"),
    stdoutPath: join(outputDir, "command.stdout.log"),
    stderrPath: join(outputDir, "command.stderr.log"),
    finalMessagePath: join(outputDir, "command-final-message.json"),
  };
}

function assertCommand(config: CommandAgentConfig): void {
  if (!config.command || config.command.includes("\0")) {
    throw new TypeError("El comando del agente no es válido");
  }
  if (config.args.some((argument) => argument.includes("\0"))) {
    throw new TypeError("Los argumentos del agente no son válidos");
  }
}

function assertEnvironment(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      name.toUpperCase().startsWith("GIT_")
    ) {
      throw new TypeError("El broker proporcionó un entorno no permitido");
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError("El broker proporcionó un entorno no permitido");
    }
  }
}

export class CommandAgent implements AgentAdapter {
  readonly name = "command";

  constructor(
    private readonly config: CommandAgentConfig,
    private readonly broker: IsolationBroker | null,
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    assertCommand(this.config);
    if (this.broker === null) {
      throw new TypeError(
        "El command adapter exige un isolation broker del operador",
      );
    }
    const wrapped = this.broker.wrap({
      worktree: input.worktree,
      command: this.config.command,
      args: [...this.config.args],
    });
    assertEnvironment(wrapped.env);
    const paths = outputPaths(input.worktree);
    await mkdir(paths.outputDir, { recursive: true });
    const result = await this.runner(wrapped.command, wrapped.args, {
      cwd: input.worktree,
      env: { ...wrapped.env },
      input: JSON.stringify({
        requestPath: input.requestPath,
        planPath: input.planPath,
        policyPath: input.policyPath,
        resultSchemaPath: input.resultSchemaPath,
        resultPath: paths.resultPath,
      }),
      shell: false,
    });
    await Promise.all([
      writeFile(paths.stdoutPath, result.stdout, "utf8"),
      writeFile(paths.stderrPath, result.stderr, "utf8"),
      writeFile(paths.finalMessagePath, result.stdout, "utf8"),
    ]);
    return {
      adapter: this.name,
      exitCode: result.exitCode,
      generatedFiles: await generatedFiles(paths.resultPath),
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      finalMessagePath: paths.finalMessagePath,
    };
  }
}

async function generatedFiles(path: string): Promise<string[]> {
  try {
    const result = JSON.parse(await readFile(path, "utf8")) as unknown;
    const files = (result as { generatedFiles?: unknown })?.generatedFiles;
    if (
      Array.isArray(files) &&
      files.every((file) => typeof file === "string")
    ) {
      return files;
    }
  } catch {
    // The result file is untrusted and may be absent after a failed command.
  }
  return [];
}
