import { assertOperatorIsolationBroker } from "./isolation.ts";
import { resolveAgentRunContext } from "../worktrees/service.ts";
import { validateSchema } from "../schema-validator.ts";

import {
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
  type IsolationBroker,
} from "./types.ts";

export interface CommandAgentConfig {
  command: string;
  args: string[];
}

function assertCommand(config: CommandAgentConfig): void {
  if (!config.command || config.command.includes("\0")) {
    throw new TypeError("El comando del agente no es válido");
  }
  if (config.args.some((argument) => argument.includes("\0"))) {
    throw new TypeError("Los argumentos del agente no son válidos");
  }
}

export class CommandAgent implements AgentAdapter {
  readonly name = "command";

  constructor(
    private readonly config: CommandAgentConfig,
    private readonly broker: IsolationBroker | null,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    assertCommand(this.config);
    assertOperatorIsolationBroker(this.broker);
    input = await resolveAgentRunContext(input);
    const workspace = input.workspace ?? input.worktree;
    const result = await this.broker.run({
      workspace,
      command: this.config.command,
      args: [...this.config.args],
      stdin: JSON.stringify({
        requestPath: input.requestPath,
        planPath: input.planPath,
        policyPath: input.policyPath,
        resultSchemaPath: input.resultSchemaPath,
      }),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: input.timeoutMs ?? 60_000,
    });
    if (result.timedOut) throw new TypeError("El broker agotó el timeout");
    if (result.exitCode !== 0)
      throw new TypeError(
        `El broker terminó con código de salida ${result.exitCode}`,
      );
    return {
      adapter: this.name,
      exitCode: result.exitCode,
      generatedFiles: await generatedFiles(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr,
      finalMessage: result.stdout,
    };
  }
}

async function generatedFiles(output: string): Promise<string[]> {
  let result: unknown;
  try {
    result = JSON.parse(output) as unknown;
  } catch {
    throw new TypeError("El resultado del agente debe ser JSON válido");
  }
  {
    const validated = validateSchema<{ generatedFiles: string[] }>(
      "agent-result",
      result,
    );
    return validated.generatedFiles.map(assertSafeGeneratedFile);
  }
}

function assertSafeGeneratedFile(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new TypeError(
      "El resultado del agente contiene un path generado no seguro",
    );
  return path;
}
