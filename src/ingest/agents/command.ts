import { assertOperatorIsolationBroker } from "./isolation.ts";
import {
  AGENT_FINAL_MESSAGE_MAX_BYTES,
  AGENT_TIMEOUT_DEFAULT_MS,
  assertAgentTextLimit,
  assertBrokerResultLimits,
  validatedAgentTimeout,
} from "../limits.ts";
import { validateSchema } from "../schema-validator.ts";
import {
  assertWorkspaceInputs,
  workspaceInputs,
  type AgentWorkspace,
  type AgentWorkspaceInputs,
} from "../workspaces/service.ts";

import {
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
  type IsolationBroker,
} from "./types.ts";

export interface CommandAgentConfig {
  command: string;
  args: string[];
  timeoutMs?: number;
}

function assertCommand(config: CommandAgentConfig): void {
  if (!config.command || config.command.includes("\0")) {
    throw new TypeError("El comando del agente no es válido");
  }
  if (config.args.some((argument) => argument.includes("\0"))) {
    throw new TypeError("Los argumentos del agente no son válidos");
  }
}

function assertWorkspaceRunInput(
  workspace: AgentWorkspace,
  input: AgentRunInput,
): AgentWorkspaceInputs {
  const expected = workspaceInputs(workspace);
  if ("timeoutMs" in input) {
    throw new TypeError("El timeout no pertenece al contexto del caller");
  }
  if (
    input.changeId !== expected.changeId ||
    input.attemptId !== expected.attemptId ||
    input.workspace !== expected.workspace ||
    input.requestPath !== expected.requestPath ||
    input.planPath !== expected.planPath ||
    input.policyPath !== expected.policyPath ||
    input.resultSchemaPath !== expected.resultSchemaPath
  ) {
    throw new TypeError(
      "El contexto de Command no corresponde al workspace aprobado",
    );
  }
  return expected;
}

export class CommandAgent implements AgentAdapter {
  readonly name = "command";
  private readonly timeoutMs: number;

  constructor(
    private readonly config: CommandAgentConfig,
    private readonly broker: IsolationBroker | null,
    private readonly workspace: AgentWorkspace,
  ) {
    this.timeoutMs = validatedAgentTimeout(
      config.timeoutMs ?? AGENT_TIMEOUT_DEFAULT_MS,
    );
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    assertCommand(this.config);
    assertOperatorIsolationBroker(this.broker);
    const approved = assertWorkspaceRunInput(this.workspace, input);
    await assertWorkspaceInputs(this.workspace);
    const result = await this.broker.run({
      workspace: approved.workspace,
      command: this.config.command,
      args: [...this.config.args],
      stdin: JSON.stringify({
        requestPath: approved.requestPath,
        planPath: approved.planPath,
        policyPath: approved.policyPath,
        resultSchemaPath: approved.resultSchemaPath,
      }),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: this.timeoutMs,
    });
    if (result.timedOut) throw new TypeError("El broker agotó el timeout");
    if (result.exitCode !== 0)
      throw new TypeError(
        `El broker terminó con código de salida ${result.exitCode}`,
      );
    assertBrokerResultLimits(result);
    assertAgentTextLimit(
      "mensaje final",
      result.stdout,
      AGENT_FINAL_MESSAGE_MAX_BYTES,
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
