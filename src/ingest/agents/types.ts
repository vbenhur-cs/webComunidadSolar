import { spawn } from "node:child_process";

import {
  AGENT_STDERR_MAX_BYTES,
  AGENT_STDOUT_MAX_BYTES,
  validatedAgentTimeout,
} from "../limits.ts";

export interface AgentRunInput {
  changeId: string;
  attemptId: string;
  /** The owned workspace where this single broker job may execute. */
  workspace?: string;
  /** Transitional alias until the workspace service migrates. */
  worktree: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
  resultSchemaPath: string;
  /** Legacy sidecar ownership, unused by CommandAgent results. */
  outputDirectory?: string;
}

export interface AgentRunResult {
  adapter: string;
  exitCode: number;
  generatedFiles: string[];
  stdout?: string;
  stderr?: string;
  finalMessage?: string;
  /** Legacy adapter result field. */
  stdoutPath?: string;
  /** Legacy adapter result field. */
  stderrPath?: string;
  /** Legacy adapter result field. */
  finalMessagePath?: string;
}

export interface AgentAdapter {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface BrokerRunInput {
  workspace: string;
  command: string;
  args: readonly string[];
  stdin: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface BrokerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface IsolationBroker {
  run(input: BrokerRunInput): Promise<BrokerRunResult>;
}

export interface ProcessRunOptions {
  cwd: string;
  env: Record<string, string>;
  input: string;
  shell: false;
  timeoutMs?: number;
  terminationGraceMs?: number;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

/** Run an argv-only agent process. No caller can opt into a shell. */
export const runProcess: ProcessRunner = async (command, args, options) =>
  await new Promise<ProcessRunResult>((resolve, reject) => {
    const timeoutMs =
      options.timeoutMs === undefined
        ? undefined
        : validatedAgentTimeout(options.timeoutMs);
    const usesDeadline = timeoutMs !== undefined;
    const processGroup = usesDeadline && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: processGroup,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let captureError: TypeError | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let deadline: NodeJS.Timeout | undefined;
    let forceTermination: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      if (forceTermination !== undefined) clearTimeout(forceTermination);
    };
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (processGroup && child.pid !== undefined) {
          process.kill(-child.pid, signal);
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const requestTermination = () => {
      terminate("SIGTERM");
      forceTermination ??= setTimeout(
        () => terminate("SIGKILL"),
        options.terminationGraceMs ?? 100,
      );
    };
    const capture = (
      chunks: Buffer[],
      chunk: Buffer,
      label: "stdout" | "stderr",
    ) => {
      const maximum =
        label === "stdout" ? AGENT_STDOUT_MAX_BYTES : AGENT_STDERR_MAX_BYTES;
      const current = label === "stdout" ? stdoutBytes : stderrBytes;
      const next = current + chunk.byteLength;
      if (next > maximum) {
        captureError ??= new TypeError(
          `El ${label} del agente excede el límite permitido`,
        );
        requestTermination();
        return;
      }
      if (label === "stdout") stdoutBytes = next;
      else stderrBytes = next;
      chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) =>
      capture(stdout, chunk, "stdout"),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      capture(stderr, chunk, "stderr"),
    );
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimers();
      if (captureError !== undefined) {
        reject(captureError);
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
    if (usesDeadline) {
      deadline = setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, timeoutMs);
    }
    child.stdin.end(options.input);
  });
