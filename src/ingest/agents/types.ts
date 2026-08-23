import { spawn } from "node:child_process";

export interface AgentRunInput {
  changeId: string;
  attemptId: string;
  worktree: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
  resultSchemaPath: string;
  /** Created by worktree service outside the agent-writable candidate. */
  outputDirectory?: string;
}

export interface AgentRunResult {
  adapter: string;
  exitCode: number;
  generatedFiles: string[];
  stdoutPath: string;
  stderrPath: string;
  finalMessagePath: string;
}

export interface AgentAdapter {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface IsolationBroker {
  wrap(input: { worktree: string; command: string; args: string[] }): {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

export interface ProcessRunOptions {
  cwd: string;
  env: Record<string, string>;
  input: string;
  shell: false;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

/** Run an argv-only agent process. No caller can opt into a shell. */
export const runProcess: ProcessRunner = async (command, args, options) =>
  await new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(options.input);
  });
