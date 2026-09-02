import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDeploymentTopology,
  type DeploymentTopology,
} from "./parity-http.ts";
import {
  prepareCloudflareDryRunConfig,
  type PrepareCloudflareConfigOptions,
  type PreparedConfig,
} from "./prepare-cloudflare-config.ts";

export interface CloudflareDryRunResult extends PreparedConfig {
  deployed: false;
  network: false;
  topology: DeploymentTopology;
}

export interface CloudflareDryRunOptions extends PrepareCloudflareConfigOptions {
  inputPath?: string;
  environment?: string;
}

export interface CloudflareDryRunDependencies {
  build?(root: string, environment: NodeJS.ProcessEnv): Promise<void>;
  readGeneratedConfig?(path: string): Promise<unknown>;
  resolveTopology?(root: string): Promise<DeploymentTopology>;
}

export interface PreparedProfileBuildChild {
  exitCode: number | null;
  pid?: number;
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface PreparedProfileBuildDependencies {
  killProcess?: typeof process.kill;
  platform?: NodeJS.Platform;
  processKillGraceMs?: number;
  processTimeoutMs?: number;
  spawn?: (
    command: string,
    arguments_: string[],
    options: {
      cwd: string;
      detached: boolean;
      env: NodeJS.ProcessEnv;
      shell: false;
      stdio: "inherit";
    },
  ) => PreparedProfileBuildChild;
}

const dryBuildTimeoutMs = 120_000;
const dryBuildKillGraceMs = 5_000;

function positiveMilliseconds(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} debe ser un entero positivo de milisegundos`);
  }
  return value;
}

function assertPosixDryBuild(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      "La build Cloudflare seca requiere POSIX para cerrar grupos de procesos completos",
    );
  }
}

function preserveBuildFailure(
  primaryFailure: unknown,
  cleanupFailure: unknown,
): void {
  if (!(primaryFailure instanceof Error)) return;
  try {
    const existingCause = (primaryFailure as Error & { cause?: unknown }).cause;
    Object.defineProperty(primaryFailure, "cause", {
      configurable: true,
      value:
        existingCause === undefined
          ? cleanupFailure
          : new AggregateError(
              [existingCause, cleanupFailure],
              "También falló la limpieza de la build Cloudflare seca",
            ),
    });
  } catch {
    // Preserve the actionable build failure even if a third-party error is frozen.
  }
}

function signalPreparedBuildGroup(
  child: PreparedProfileBuildChild,
  signal: NodeJS.Signals | 0,
  killProcess: typeof process.kill,
): void {
  if (child.pid === undefined) return;
  try {
    killProcess(-child.pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForPreparedBuildExit(
  child: PreparedProfileBuildChild,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  const exited = new Promise<boolean>((resolveExit) => {
    child.once("close", () => resolveExit(true));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForPreparedBuildGroupGone(
  child: PreparedProfileBuildChild,
  timeoutMs: number,
  killProcess: typeof process.kill,
): Promise<boolean> {
  if (child.pid === undefined) return true;
  const expiresAt = Date.now() + timeoutMs;
  while (true) {
    try {
      killProcess(-child.pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    if (Date.now() >= expiresAt) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function closePreparedBuild(
  child: PreparedProfileBuildChild,
  killGraceMs: number,
  killProcess: typeof process.kill,
): Promise<void> {
  if (child.pid === undefined) return;
  let sentKill = false;
  if (child.exitCode === null) {
    const terminated = waitForPreparedBuildExit(child, killGraceMs);
    signalPreparedBuildGroup(child, "SIGTERM", killProcess);
    if (!(await terminated) && child.exitCode === null) {
      const killed = waitForPreparedBuildExit(child, killGraceMs);
      signalPreparedBuildGroup(child, "SIGKILL", killProcess);
      sentKill = true;
      if (!(await killed) && child.exitCode === null) {
        throw new Error(
          "La build Cloudflare seca no terminó después de SIGKILL",
        );
      }
    }
  }
  if (!sentKill) {
    signalPreparedBuildGroup(child, "SIGKILL", killProcess);
  }
  if (!(await waitForPreparedBuildGroupGone(child, killGraceMs, killProcess))) {
    throw new Error(
      "El grupo de procesos de la build Cloudflare seca no terminó después de SIGKILL",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks only non-secret deployment metadata emitted by Astro/Wrangler. The
 * generated profile must be the sanitized profile that the dry build selected.
 */
export function verifyPreparedCloudflareTopology(
  prepared: PreparedConfig,
  topology: DeploymentTopology,
  generated: unknown,
): void {
  if (!isRecord(generated) || typeof generated.configPath !== "string") {
    throw new Error("El config generado no define configPath");
  }
  if (
    resolve(dirname(topology.wranglerConfigPath), generated.configPath) !==
    resolve(prepared.outputPath)
  ) {
    throw new Error(
      "El configPath generado no corresponde al perfil preparado",
    );
  }

  const targetEnvironment =
    generated.targetEnvironment === undefined ||
    generated.targetEnvironment === null ||
    generated.targetEnvironment === ""
      ? null
      : generated.targetEnvironment;
  if (targetEnvironment !== prepared.environment) {
    throw new Error(
      "El targetEnvironment generado no corresponde al environment preparado",
    );
  }
  if (
    !isRecord(generated.vars) ||
    generated.vars.SITE_INDEXABLE !== (prepared.indexable ? "true" : "false")
  ) {
    throw new Error(
      "SITE_INDEXABLE generado no corresponde al perfil preparado",
    );
  }
  if (generated.name !== prepared.destination.workerName) {
    throw new Error(
      "El nombre Worker generado no corresponde al perfil preparado",
    );
  }
  if (
    !Array.isArray(generated.d1_databases) ||
    generated.d1_databases.length !== 1
  ) {
    throw new Error(
      "El config generado debe declarar exactamente un binding D1",
    );
  }
  const [database] = generated.d1_databases;
  if (
    !isRecord(database) ||
    database.binding !== prepared.destination.database.binding ||
    database.database_id !== prepared.destination.database.id ||
    database.database_name !== prepared.destination.database.name
  ) {
    throw new Error(
      "El binding D1 generado no corresponde al perfil preparado",
    );
  }
}

async function readGeneratedCloudflareConfig(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error("No se pudo leer el config generado por la build seca", {
      cause: error,
    });
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error("El config generado por la build seca no es JSON válido", {
      cause: error,
    });
  }
}

export async function buildPreparedProfile(
  root: string,
  environment: NodeJS.ProcessEnv,
  dependencies: PreparedProfileBuildDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  assertPosixDryBuild(platform);
  const timeoutMs = positiveMilliseconds(
    dependencies.processTimeoutMs ?? dryBuildTimeoutMs,
    "El timeout de la build Cloudflare seca",
  );
  const killGraceMs = positiveMilliseconds(
    dependencies.processKillGraceMs ?? dryBuildKillGraceMs,
    "La gracia de terminación de la build Cloudflare seca",
  );
  const command = "npm";
  const spawnPreparedBuild = dependencies.spawn ?? spawn;
  let child: PreparedProfileBuildChild;
  try {
    child = spawnPreparedBuild(command, ["run", "build"], {
      cwd: root,
      detached: true,
      env: environment,
      shell: false,
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error("No se pudo iniciar la build Cloudflare seca", {
      cause: error,
    });
  }

  const completed = new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolveCode(exitCode ?? 1));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let primaryFailure: unknown;
  try {
    const result = await Promise.race([
      completed,
      new Promise<"deadline">((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline("deadline"), timeoutMs);
      }),
    ]);
    if (result === "deadline") {
      throw new Error(`La build Cloudflare seca superó ${timeoutMs} ms`);
    }
    if (result !== 0) {
      throw new Error(`La build Cloudflare seca falló con código ${result}`);
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  let cleanupFailure: unknown;
  try {
    await closePreparedBuild(
      child,
      killGraceMs,
      dependencies.killProcess ?? process.kill,
    );
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure !== undefined) {
    if (cleanupFailure !== undefined) {
      preserveBuildFailure(primaryFailure, cleanupFailure);
    }
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

function environmentForPreparedProfile(
  prepared: PreparedConfig,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_CONFIG_PATH: prepared.outputPath,
  };
  if (prepared.environment === null) {
    delete environment.CLOUDFLARE_ENV;
  } else {
    environment.CLOUDFLARE_ENV = prepared.environment;
  }
  return environment;
}

/**
 * This command builds the sanitized profile locally and verifies its emitted
 * Wrangler topology. It never invokes Wrangler deploy or a network client.
 */
export async function runCloudflareDryRun(
  options: CloudflareDryRunOptions = {},
  dependencies: CloudflareDryRunDependencies = {},
): Promise<CloudflareDryRunResult> {
  const root = resolve(options.projectRoot ?? process.cwd());
  const prepared = await prepareCloudflareDryRunConfig(
    options.inputPath ?? process.env.CLOUDFLARE_CONFIG_PATH ?? "wrangler.jsonc",
    options.environment ?? process.env.CLOUDFLARE_ENV,
    options,
  );
  const environment = environmentForPreparedProfile(prepared);
  await (dependencies.build ?? buildPreparedProfile)(root, environment);
  const topology = await (
    dependencies.resolveTopology ?? resolveDeploymentTopology
  )(root);
  const generated = await (
    dependencies.readGeneratedConfig ?? readGeneratedCloudflareConfig
  )(topology.wranglerConfigPath);
  verifyPreparedCloudflareTopology(prepared, topology, generated);
  return { ...prepared, deployed: false, network: false, topology };
}

async function main(): Promise<void> {
  const result = await runCloudflareDryRun();
  process.stdout.write(
    `CLOUDFLARE_DRY_OK sha256=${result.sha256} indexable=${result.indexable} network=false deploy=false output=${result.outputPath} topology=${result.topology.wranglerConfigPath}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
