import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  openIngestionAuditController,
  type IngestionAudit,
} from "../src/ingest/controller.ts";
import { safeError, safeJson } from "../src/ingest/safe-output.ts";

interface AuditPort {
  audit(): Promise<IngestionAudit>;
  dispose?(): Promise<void>;
}

export interface VerifyIngestionOptions {
  readonly controller?: AuditPort;
}

/**
 * Revalidates the controller's durable journal, candidates and evidence facts.
 * The returned object deliberately contains identities and digests, never
 * storage paths, raw intake bytes, capabilities, or credential material.
 */
export async function verifyIngestion(
  options: VerifyIngestionOptions = {},
): Promise<IngestionAudit> {
  if (options.controller !== undefined) return await options.controller.audit();
  const controller = await openIngestionAuditController();
  try {
    return await controller.audit();
  } finally {
    await controller.dispose();
  }
}

async function main(): Promise<void> {
  try {
    const audit = await verifyIngestion();
    process.stdout.write(`${JSON.stringify(safeJson(audit))}\n`);
    process.exitCode = audit.ok ? 0 : 1;
  } catch (error: unknown) {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
