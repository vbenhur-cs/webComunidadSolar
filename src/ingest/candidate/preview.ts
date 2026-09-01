import type { ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import type { CandidateManifest } from "../domain.ts";

import {
  candidateRecordForPreview,
  setCandidatePreviewPid,
  verifyCandidateArtifact,
} from "./manifest.ts";

const previewStopGraceMilliseconds = 1_500;
const previewStopPollMilliseconds = 25;

export interface FixedPreviewInvocation {
  /** The fixed controller-local Wrangler executable; never caller supplied. */
  readonly executable: string;
  /** Includes the executable as argv[0] so fixture assertions see exact argv. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface PreviewHandle {
  readonly url: string;
  stop(): Promise<void>;
}

interface PreviewLaunch {
  readonly child: ChildProcess;
  readonly url: string;
}

type CandidatePreviewAdapter = (
  invocation: FixedPreviewInvocation,
) => Promise<PreviewLaunch>;

/** A fixture-only capability; callers can never provide process arguments. */
declare const candidatePreviewTestCapabilityBrand: unique symbol;
export interface CandidatePreviewTestCapability {
  readonly [candidatePreviewTestCapabilityBrand]: true;
}

const candidatePreviewCapabilities = new WeakMap<
  CandidatePreviewTestCapability,
  CandidatePreviewAdapter
>();

/**
 * Mints a test controller seam. Production has no preview adapter until the
 * separately reviewed Task 12 integration supplies one, so it fails closed.
 */
export function createCandidatePreviewTestCapability(
  adapter: CandidatePreviewAdapter,
): CandidatePreviewTestCapability {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "La capability de preview candidato sólo existe en modo de pruebas",
    );
  }
  if (typeof adapter !== "function") {
    throw new TypeError("El adaptador de preview candidato no es válido");
  }
  const capability = Object.freeze({}) as CandidatePreviewTestCapability;
  candidatePreviewCapabilities.set(capability, adapter);
  return capability;
}

function localWranglerPath(): string {
  return resolve(process.cwd(), "node_modules", ".bin", "wrangler");
}

function fixedPreviewEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: "/tmp",
    LANG: "C",
    LC_ALL: "C",
    CI: "true",
    NO_COLOR: "1",
  });
}

function fixedPreviewInvocation(
  candidate: CandidateManifest,
): FixedPreviewInvocation {
  const record = candidateRecordForPreview(candidate);
  const worker = join(record.bundlePath, "dist", "_worker.js", "index.js");
  const assets = join(
    record.bundlePath,
    ...record.configuration.assetsRelativePath.split("/"),
  );
  const config = join(
    record.bundlePath,
    ...record.configuration.primaryConfigRelativePath.split("/"),
  );
  const executable = localWranglerPath();
  return Object.freeze({
    executable,
    argv: Object.freeze([
      executable,
      "dev",
      worker,
      "--no-bundle",
      "--assets",
      assets,
      "--config",
      config,
      "--local",
    ]),
    cwd: record.bundlePath,
    env: fixedPreviewEnvironment(),
  });
}

function localPreviewUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("El preview candidato no devolvió una URL válida");
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("El preview candidato debe escuchar sólo en local");
  }
  return parsed.toString();
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, previewStopPollMilliseconds);
    });
  }
  return true;
}

async function stopProcessGroup(pid: number): Promise<void> {
  if (!processGroupExists(pid)) return;
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, previewStopGraceMilliseconds)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, previewStopGraceMilliseconds))) {
    throw new TypeError("No se pudo detener el grupo de preview candidato");
  }
}

/**
 * Starts only a verified copied bundle. The fixed invocation contains no build
 * command, shell, caller-selected executable, cwd, arguments or environment.
 */
export async function startCandidatePreview(
  candidate: CandidateManifest,
): Promise<PreviewHandle> {
  await verifyCandidateArtifact(candidate);
  const record = candidateRecordForPreview(candidate);
  if (record.previewPid !== undefined) {
    throw new TypeError("El candidato ya tiene un preview en ejecución");
  }
  if (record.previewCapability === undefined) {
    throw new TypeError(
      "No existe una capability de preview candidato confiable",
    );
  }
  const adapter = candidatePreviewCapabilities.get(record.previewCapability);
  if (adapter === undefined) {
    throw new TypeError("La capability de preview no pertenece al controlador");
  }

  const launch = await adapter(fixedPreviewInvocation(candidate));
  const launchPid = launch.child.pid;
  if (
    typeof launchPid !== "number" ||
    !Number.isSafeInteger(launchPid) ||
    launchPid <= 0 ||
    launch.child.exitCode !== null
  ) {
    if (
      typeof launchPid === "number" &&
      Number.isSafeInteger(launchPid) &&
      launchPid > 0
    ) {
      await stopProcessGroup(launchPid).catch(() => undefined);
    }
    throw new TypeError("El preview candidato no creó un proceso válido");
  }
  const pid = launchPid;
  let url: string;
  try {
    url = localPreviewUrl(launch.url);
  } catch (error: unknown) {
    await stopProcessGroup(pid).catch(() => undefined);
    throw error;
  }
  setCandidatePreviewPid(candidate, pid);

  let stopped = false;
  return Object.freeze({
    url,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        await stopProcessGroup(pid);
      } finally {
        setCandidatePreviewPid(candidate, undefined);
      }
    },
  });
}
