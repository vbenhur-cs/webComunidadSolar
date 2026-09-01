import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";

export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const capturedOutputMaximumBytes = 64 * 1024;
const renderedOutputMaximumCharacters = 8 * 1024;
const controllerNpmExecutable = join(dirname(process.execPath), "npm");

export type CommandCapability = "process" | "preview" | "browser";

export interface CommandInvocation {
  readonly id: string;
  readonly capability: CommandCapability;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly unsupported: boolean;
}

/** Trusted controller/test capability. It receives an already fixed invocation. */
export type CommandRunner = (
  command: CommandInvocation,
) => Promise<CommandResult>;

export interface CloudflareCommandProfile {
  readonly path: string;
  readonly environment: string;
}

const safeEnvironment = Object.freeze({
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: "/tmp",
  LANG: "C",
  LC_ALL: "C",
  CI: "true",
  NO_COLOR: "1",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

function bounded(value: string): string {
  return value.length <= renderedOutputMaximumCharacters
    ? value
    : `${value.slice(0, renderedOutputMaximumCharacters)}\n[truncated]`;
}

/** Removes terminal control sequences and common credentials before evidence persists. */
export function sanitizeCommandOutput(value: string): string {
  const noAnsi = value
    // eslint-disable-next-line no-control-regex -- evidence must strip terminal escapes.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex -- evidence must not persist control bytes.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?");
  return bounded(
    noAnsi
      .replace(
        /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
        (match) => `${match.split(/[:=]/u, 1)[0] ?? "credential"}=<redacted>`,
      )
      .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/gu, "<redacted>")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "<redacted>"),
  );
}

function unsupportedResult(message: string): CommandResult {
  return Object.freeze({
    exitCode: null,
    stdout: "",
    stderr: message,
    timedOut: false,
    aborted: false,
    unsupported: true,
  });
}

function capture(stream: NodeJS.ReadableStream | null): {
  rendered: () => string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  stream?.on("data", (chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = capturedOutputMaximumBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const selected = buffer.subarray(0, remaining);
    chunks.push(selected);
    bytes += selected.byteLength;
    if (selected.byteLength < buffer.byteLength) truncated = true;
  });
  return {
    rendered: () =>
      sanitizeCommandOutput(
        `${Buffer.concat(chunks).toString("utf8")}${truncated ? "\n[captured output truncated]" : ""}`,
      ),
  };
}

function validRawInvocation(command: CommandInvocation): boolean {
  return (
    command.capability === "process" &&
    command.argv.length > 0 &&
    isAbsolute(command.argv[0] ?? "") &&
    command.argv.every(
      (argument) => argument.length > 0 && !argument.includes("\0"),
    ) &&
    isAbsolute(command.cwd) &&
    command.timeoutMs > 0 &&
    command.timeoutMs <= COMMAND_TIMEOUT_MS &&
    Object.values(command.env).every(
      (value) => typeof value === "string" && !value.includes("\0"),
    )
  );
}

async function rawCommandRunner(
  command: CommandInvocation,
): Promise<CommandResult> {
  if (command.capability !== "process") {
    return unsupportedResult(
      `La capability ${command.capability} requiere un runner exacto del controlador`,
    );
  }
  if (!validRawInvocation(command)) {
    return unsupportedResult(
      "La invocación de comando no pertenece al perfil seguro",
    );
  }

  return await new Promise<CommandResult>((resolve) => {
    let timedOut = false;
    let spawnFailure: Error | undefined;
    let closed = false;
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      const error =
        spawnFailure === undefined ? "" : `\n${spawnFailure.message}`;
      resolve(
        Object.freeze({
          exitCode: spawnFailure === undefined ? exitCode : null,
          stdout: stdout.rendered(),
          stderr: sanitizeCommandOutput(`${stderr.rendered()}${error}`),
          timedOut,
          aborted: spawnFailure !== undefined || signal !== null,
          unsupported: false,
        }),
      );
    };
    child.once("error", (error: Error) => {
      spawnFailure = error;
      finish(null, "SIGTERM");
    });
    child.once("close", finish);
  });
}

function commandEnvironment(
  profile: CloudflareCommandProfile | undefined,
): Readonly<Record<string, string>> {
  if (profile === undefined) return safeEnvironment;
  return Object.freeze({
    ...safeEnvironment,
    CLOUDFLARE_CONFIG_PATH: profile.path,
    CLOUDFLARE_ENV: profile.environment,
  });
}

export function controllerCommand(
  id: string,
  args: readonly string[],
  cwd: string,
  capability: CommandCapability = "process",
  profile?: CloudflareCommandProfile,
): CommandInvocation {
  return Object.freeze({
    id,
    capability,
    argv: Object.freeze([controllerNpmExecutable, ...args]),
    cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: commandEnvironment(profile),
  });
}

export async function runControllerCommand(
  command: CommandInvocation,
): Promise<CommandResult> {
  return await rawCommandRunner(command);
}
