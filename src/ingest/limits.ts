/**
 * Trusted operational ceilings for hostile agent material. These values are
 * deployment policy, not request or broker inputs, so untrusted data cannot
 * enlarge controller allocations.
 */
export const AGENT_INPUT_MAX_BYTES = 1 * 1024 * 1024;
export const AGENT_WORKSPACE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const AGENT_WORKSPACE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
export const AGENT_WORKSPACE_FILE_MAX_COUNT = 1024;
export const AGENT_WORKSPACE_ENTRY_MAX_COUNT = 1024;
export const AGENT_ACCEPTED_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export const AGENT_ACCEPTED_OUTPUT_MAX_FILES = 256;
export const AGENT_FINAL_MESSAGE_MAX_BYTES = 64 * 1024;
export const AGENT_STDOUT_MAX_BYTES = 256 * 1024;
export const AGENT_STDERR_MAX_BYTES = 256 * 1024;
export const AGENT_IO_CHUNK_BYTES = 64 * 1024;

export function assertAgentTextLimit(
  label: "stdout" | "stderr" | "mensaje final",
  value: string,
  maximumBytes: number,
): void {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new TypeError(`El ${label} del agente excede el límite permitido`);
  }
}

export function assertBrokerResultLimits(result: {
  readonly stdout: string;
  readonly stderr: string;
}): void {
  assertAgentTextLimit("stdout", result.stdout, AGENT_STDOUT_MAX_BYTES);
  assertAgentTextLimit("stderr", result.stderr, AGENT_STDERR_MAX_BYTES);
}
