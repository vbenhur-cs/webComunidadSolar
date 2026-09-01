/** The fixed upper bound used by private controller process execution. */
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const renderedOutputMaximumCharacters = 8 * 1024;

export type CommandCapability = "process" | "preview" | "browser";

export type BrowserCheck =
  | "preview"
  | "e2e"
  | "route-smoke"
  | "console-errors"
  | "axe"
  | "capture"
  | "html-visual-comparison";

export type BrowserCaptureDevice = "desktop" | "tablet" | "mobile";

/** A fixed request emitted only by the validation controller. */
export interface BrowserValidationRequest {
  readonly check: BrowserCheck;
  readonly targetPath: `/${string}`;
  readonly device?: BrowserCaptureDevice;
}

/** Evidence returned by a trusted browser/preview adapter for that exact request. */
export interface BrowserValidationProof extends BrowserValidationRequest {
  readonly evidenceSha256: string;
}

/**
 * A fixed invocation built privately by the validation runner. Consumers can
 * inspect it in an injected trusted runner, but cannot execute arbitrary argv.
 */
export interface CommandInvocation {
  readonly id: string;
  readonly capability: CommandCapability;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly browser?: BrowserValidationRequest;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly unsupported: boolean;
  readonly browserProof?: BrowserValidationProof;
}

/** Trusted controller/test seam. It receives only already-fixed invocations. */
export type CommandRunner = (
  command: CommandInvocation,
) => Promise<CommandResult>;

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
