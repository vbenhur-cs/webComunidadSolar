import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveDeploymentTopology,
  type DeploymentTopology,
} from "../../scripts/parity-http.ts";

const buildTimeoutMs = 120_000;
const commandTimeoutMs = 30_000;
const shutdownTimeoutMs = 5_000;
const syntheticPrivateBindingNames = [
  "MANGANAFER_ALLOWED_EMAILS",
  "SOCIOS_ALLOWED_EMAILS",
  "TEAM_ALLOWED_EMAILS",
] as const;

const syntheticAllowlist = new RegExp(
  "^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@example\\.test(?:[;,][A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@example\\.test)*$",
  "i",
);

export interface LocalD1Worker {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  query(sql: string): Promise<Array<Record<string, unknown>>>;
}

export interface WithLocalD1WorkerOptions {
  root?: string;
  /** Reuses an emitted build already owned and validated by the caller. */
  useExistingBuild?: boolean;
  /** Leaves D1 empty so an integration test can exercise endpoint bootstrapping. */
  applyMigrations?: boolean;
  /**
   * Narrow test-only allowlists injected into `wrangler dev` with `--var`.
   * They are intentionally not inherited by build, migration, or query CLIs.
   */
  syntheticBindings?: Partial<
    Record<
      | "SOCIOS_ALLOWED_EMAILS"
      | "TEAM_ALLOWED_EMAILS"
      | "MANGANAFER_ALLOWED_EMAILS",
      string
    >
  >;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface LocalCommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  killProcess?: typeof process.kill;
}

export interface LocalD1WorkerDependencies {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  createTemporaryDirectory?: () => Promise<string>;
  removeTemporaryDirectory?: (path: string) => Promise<void>;
  resolveTopology?: (root: string) => Promise<DeploymentTopology>;
  runCommand?: (
    command: string,
    args: string[],
    options: LocalCommandOptions,
  ) => Promise<CommandResult>;
  spawn?: typeof spawn;
  waitForWorker?: (origin: string, signal: AbortSignal) => Promise<void>;
  workerStartupTimeoutMs?: number;
  findFreePort?: () => Promise<number>;
  closeProcess?: (child: ChildProcess) => Promise<void>;
  killProcess?: typeof process.kill;
}

function processGroupSupported(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

function assertPosixWorkerHarness(platform: NodeJS.Platform): void {
  if (!processGroupSupported(platform)) {
    throw new Error(
      "El arnés D1 local requiere POSIX para cerrar grupos de procesos completos",
    );
  }
}

function preserveFailure(
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
              "También falló la limpieza del Worker D1 local",
            ),
    });
  } catch {
    // Keep the primary operation failure actionable even if its cause is frozen.
  }
}

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  killProcess: typeof process.kill,
): void {
  if (child.pid === undefined) return;
  try {
    killProcess(-child.pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  const exited = once(child, "close").then(() => true);
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

async function closeLocalProcess(
  child: ChildProcess,
  platform: NodeJS.Platform,
  killProcess: typeof process.kill,
): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode === null) {
    signalProcessGroup(child, "SIGTERM", killProcess);
    if (
      !(await waitForExit(child, shutdownTimeoutMs)) &&
      child.exitCode === null
    ) {
      signalProcessGroup(child, "SIGKILL", killProcess);
      if (
        !(await waitForExit(child, shutdownTimeoutMs)) &&
        child.exitCode === null
      ) {
        throw new Error("El Worker D1 local no terminó después de SIGKILL");
      }
    }
  }
  if (processGroupSupported(platform)) {
    signalProcessGroup(child, "SIGKILL", killProcess);
  }
}

function appendOutput(chunks: Buffer[], chunk: Buffer): void {
  const maximumOutputBytes = 64 * 1024;
  const currentBytes = chunks.reduce((total, value) => total + value.length, 0);
  if (currentBytes >= maximumOutputBytes) return;
  chunks.push(chunk.subarray(0, maximumOutputBytes - currentBytes));
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} debe ser un entero positivo de milisegundos`);
  }
  return value;
}

async function withinWorkerDeadline<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `El Worker D1 local superó ${timeoutMs} ms durante ${stage}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Runs a local command with a deadline and final POSIX process-group kill. */
export async function runLocalCommand(
  command: string,
  args: string[],
  options: LocalCommandOptions,
): Promise<CommandResult> {
  const platform = options.platform ?? process.platform;
  assertPosixWorkerHarness(platform);
  const spawnCommand = options.spawn ?? spawn;
  const killProcess = options.killProcess ?? process.kill;
  const child = spawnCommand(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(stderr, chunk));
  const completed = new Promise<CommandResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline("deadline"), options.timeoutMs);
  });
  try {
    const result = await Promise.race([completed, deadline]);
    if (result === "deadline") {
      const timeoutFailure = new Error(
        `${command} agotó ${options.timeoutMs} ms`,
      );
      try {
        await closeLocalProcess(child, platform, killProcess);
      } catch (cleanupFailure) {
        preserveFailure(timeoutFailure, cleanupFailure);
      }
      throw timeoutFailure;
    }
    if (result.code !== 0) {
      const commandFailure = new Error(
        `${command} terminó con código ${result.code ?? "desconocido"}`,
      );
      try {
        await closeLocalProcess(child, platform, killProcess);
      } catch (cleanupFailure) {
        preserveFailure(commandFailure, cleanupFailure);
      }
      throw commandFailure;
    }
    signalProcessGroup(child, "SIGKILL", killProcess);
    return result;
  } catch (error) {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        await closeLocalProcess(child, platform, killProcess);
      } catch (cleanupFailure) {
        preserveFailure(error, cleanupFailure);
      }
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  if (address === null || typeof address === "string") {
    throw new Error("No se pudo reservar un puerto local para D1");
  }
  return address.port;
}

async function waitForSpawn(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const resolve = () => {
        clearTimeout(timer);
        resolveSpawn();
      };
      const reject = (error: unknown) => {
        clearTimeout(timer);
        rejectSpawn(error);
      };
      child.once("spawn", resolve);
      child.once("error", reject);
      timer = setTimeout(
        () =>
          reject(new Error(`Wrangler dev agotó ${timeoutMs} ms al iniciar`)),
        timeoutMs,
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchWithin(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function waitForWorker(
  origin: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + commandTimeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new Error("La preparación del Worker D1 fue cancelada");
    }
    try {
      await fetchWithin(origin, { redirect: "manual" }, 1_000, signal);
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      lastFailure = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error("El Worker D1 local no quedó disponible", {
    cause: lastFailure,
  });
}

function selectedConfigPath(
  root: string,
  environment: NodeJS.ProcessEnv,
): string {
  return resolve(root, environment.CLOUDFLARE_CONFIG_PATH ?? "wrangler.jsonc");
}

function environmentArguments(environment: NodeJS.ProcessEnv): string[] {
  const name = environment.CLOUDFLARE_ENV;
  return name === undefined || name === "" ? [] : ["--env", name];
}

function syntheticBindingArguments(
  bindings: WithLocalD1WorkerOptions["syntheticBindings"],
): string[] {
  if (bindings === undefined) return [];

  const entries = Object.entries(bindings).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const argumentsForWorker: string[] = [];
  for (const [name, value] of entries) {
    if (
      !syntheticPrivateBindingNames.includes(
        name as (typeof syntheticPrivateBindingNames)[number],
      ) ||
      typeof value !== "string" ||
      !syntheticAllowlist.test(value)
    ) {
      throw new Error(`Binding sintético privado no válido: ${name}`);
    }
    argumentsForWorker.push("--var", `${name}:${value}`);
  }
  return argumentsForWorker;
}

function parseQueryResult(output: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || !isRecord(parsed[0])) {
    throw new Error("Wrangler D1 local no devolvió JSON de consulta válido");
  }
  const results = parsed[0].results;
  if (!Array.isArray(results) || !results.every(isRecord)) {
    throw new Error("Wrangler D1 local no devolvió filas de consulta válidas");
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function wranglerExecutable(root: string): string {
  return join(root, "node_modules", ".bin", "wrangler");
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Runs the emitted Worker against only a new local D1 persistence directory.
 * Windows is intentionally unsupported: this harness requires POSIX process
 * groups to prove that Wrangler/workerd descendants cannot outlive the test.
 */
export async function withLocalD1Worker<T>(
  callback: (worker: LocalD1Worker) => Promise<T>,
  options: WithLocalD1WorkerOptions = {},
  dependencies: LocalD1WorkerDependencies = {},
): Promise<T> {
  const platform = dependencies.platform ?? process.platform;
  assertPosixWorkerHarness(platform);
  const root = resolve(options.root ?? process.cwd());
  const environment = dependencies.environment ?? process.env;
  const configPath = selectedConfigPath(root, environment);
  const createTemporaryDirectory =
    dependencies.createTemporaryDirectory ??
    (() => mkdtemp(join(tmpdir(), "comunidadsolar-d1-")));
  const removeTemporaryDirectory =
    dependencies.removeTemporaryDirectory ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const resolveTopology =
    dependencies.resolveTopology ?? resolveDeploymentTopology;
  const runCommand = dependencies.runCommand ?? runLocalCommand;
  const spawnWorker = dependencies.spawn ?? spawn;
  const waitUntilReady = dependencies.waitForWorker ?? waitForWorker;
  const workerStartupTimeoutMs = positiveTimeout(
    dependencies.workerStartupTimeoutMs ?? commandTimeoutMs,
    "El timeout de inicio del Worker D1 local",
  );
  const reservePort = dependencies.findFreePort ?? findFreePort;
  const killProcess = dependencies.killProcess ?? process.kill;
  const closeWorker =
    dependencies.closeProcess ??
    ((child: ChildProcess) => closeLocalProcess(child, platform, killProcess));
  const workerBindingArguments = syntheticBindingArguments(
    options.syntheticBindings,
  );
  const persistenceRoot = await createTemporaryDirectory();
  let worker: ChildProcess | undefined;
  let value: T | undefined;
  let primaryFailure: unknown;
  try {
    if (!options.useExistingBuild) {
      await runCommand(npmExecutable(), ["run", "build"], {
        cwd: root,
        timeoutMs: buildTimeoutMs,
        env: environment,
        platform,
        killProcess,
      });
    }
    const topology = await resolveTopology(root);
    const wrangler = wranglerExecutable(root);
    const envArguments = environmentArguments(environment);
    const migrationEnvironment = { ...environment, CI: "1" };
    if (options.applyMigrations ?? true) {
      await runCommand(
        wrangler,
        [
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--persist-to",
          persistenceRoot,
          "--config",
          configPath,
          ...envArguments,
        ],
        {
          cwd: root,
          timeoutMs: commandTimeoutMs,
          env: migrationEnvironment,
          platform,
          killProcess,
        },
      );
    }

    const port = await reservePort();
    worker = spawnWorker(
      wrangler,
      [
        "dev",
        topology.entryPath,
        "--no-bundle",
        "--assets",
        join(root, "dist"),
        "--local",
        "--persist-to",
        persistenceRoot,
        "--port",
        String(port),
        "--config",
        topology.wranglerConfigPath,
        ...envArguments,
        ...workerBindingArguments,
      ],
      {
        cwd: root,
        env: environment,
        detached: true,
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    await waitForSpawn(worker, workerStartupTimeoutMs);
    const readinessAbort = new AbortController();
    // Keep an error listener after readiness so a late ChildProcess error is
    // never unhandled by Node; subsequent requests still fail closed.
    worker.on("error", () => undefined);
    try {
      await withinWorkerDeadline(
        "readiness",
        waitUntilReady(`http://127.0.0.1:${port}/`, readinessAbort.signal),
        workerStartupTimeoutMs,
      );
    } finally {
      readinessAbort.abort();
    }

    const origin = `http://127.0.0.1:${port}`;
    value = await callback({
      fetch(path, init) {
        return fetchWithin(new URL(path, origin), init, commandTimeoutMs);
      },
      async query(sql) {
        const result = await runCommand(
          wrangler,
          [
            "d1",
            "execute",
            "DB",
            "--local",
            "--persist-to",
            persistenceRoot,
            "--config",
            configPath,
            "--command",
            sql,
            "--json",
            ...envArguments,
          ],
          {
            cwd: root,
            timeoutMs: commandTimeoutMs,
            env: environment,
            platform,
            killProcess,
          },
        );
        return parseQueryResult(result.stdout);
      },
    });
  } catch (error) {
    primaryFailure = error;
  }
  const cleanupFailures: unknown[] = [];
  if (worker !== undefined) {
    try {
      await closeWorker(worker);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await removeTemporaryDirectory(persistenceRoot);
  } catch (error) {
    cleanupFailures.push(error);
  }
  const cleanupFailure =
    cleanupFailures.length === 0
      ? undefined
      : cleanupFailures.length === 1
        ? cleanupFailures[0]
        : new AggregateError(cleanupFailures, "Falló la limpieza D1 local");
  if (primaryFailure !== undefined) {
    if (cleanupFailure !== undefined) {
      preserveFailure(primaryFailure, cleanupFailure);
    }
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return value as T;
}
