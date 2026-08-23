import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { assertOperatorIsolationBroker } from "./isolation.ts";

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

function outputPaths(input: AgentRunInput): {
  outputDir: string;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  finalMessagePath: string;
} {
  if (input.outputDirectory === undefined)
    throw new TypeError(
      "El agente exige un directorio de salida propiedad del servicio",
    );
  const outputDir = resolve(input.outputDirectory);
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

function assertWrapped(value: unknown): asserts value is {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  if (typeof value !== "object" || value === null)
    throw new TypeError("El broker proporcionó una invocación no válida");
  const wrapped = value as { command?: unknown; args?: unknown; env?: unknown };
  if (
    typeof wrapped.command !== "string" ||
    wrapped.command === "" ||
    wrapped.command.includes("\0") ||
    !Array.isArray(wrapped.args) ||
    !wrapped.args.every(
      (item) => typeof item === "string" && !item.includes("\0"),
    ) ||
    typeof wrapped.env !== "object" ||
    wrapped.env === null
  )
    throw new TypeError("El broker proporcionó una invocación no válida");
  const env = wrapped.env as Record<string, unknown>;
  if (
    Object.keys(env).length !== 0 ||
    Object.values(env).some(
      (item) => typeof item !== "string" || item.includes("\0"),
    )
  )
    throw new TypeError("El broker proporcionó un entorno no permitido");
}

async function assertOutputDirectory(input: AgentRunInput): Promise<void> {
  const output = outputPaths(input).outputDir;
  const relation = relative(resolve(input.worktree), output);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation)))
    throw new TypeError("La salida del agente no puede vivir en el worktree");
  const entry = await lstat(output);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(output)) !== output
  )
    throw new TypeError("La salida del agente no es un directorio seguro");
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
    assertOperatorIsolationBroker(this.broker);
    const wrapped = this.broker.wrap({
      worktree: input.worktree,
      command: this.config.command,
      args: [...this.config.args],
    });
    assertWrapped(wrapped);
    const paths = outputPaths(input);
    await assertOutputDirectory(input);
    const result = await this.runner(wrapped.command, wrapped.args, {
      cwd: input.worktree,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
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
