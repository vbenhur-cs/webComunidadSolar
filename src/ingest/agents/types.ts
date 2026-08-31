import { spawn } from "node:child_process";

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
  /** Broker-enforced execution deadline. */
  timeoutMs?: number;
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
    const usesDeadline = options.timeoutMs !== undefined;
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
    let deadline: NodeJS.Timeout | undefined;
    let forceTermination: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      if (forceTermination !== undefined) clearTimeout(forceTermination);
    };
    const terminate = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (processGroup && child.pid !== undefined)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimers();
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
        terminate("SIGTERM");
        forceTermination = setTimeout(
          () => terminate("SIGKILL"),
          options.terminationGraceMs ?? 100,
        );
      }, options.timeoutMs);
    }
    child.stdin.end(options.input);
  });
