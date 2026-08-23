import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

import {
  resolveDeploymentTopology,
  type DeploymentTopology,
} from "../../scripts/parity-http.ts";

export interface PreviewRequestOptions {
  env?: NodeJS.ProcessEnv;
  method?: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
}

export interface PreviewInstance {
  origin: string;
  close(): Promise<void>;
  fetch?(url: URL, init?: RequestInit): Promise<Response>;
}

export interface PreviewPoolDependencies {
  fetch?: typeof fetch;
  startPreview?: (env: NodeJS.ProcessEnv) => Promise<PreviewInstance>;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

interface PreviewWorker {
  ready: Promise<unknown>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
  raw?: {
    teardown(): Promise<void>;
  };
}

interface PreviewWorkerStartOptions {
  config: string;
  entrypoint: string;
  bindings: Record<string, { type: "secret_text"; value: string }>;
  dev: {
    server: { hostname: string; port: number; secure: boolean };
    logLevel: "error";
    persist: false;
    remote: false;
    watch: false;
  };
}

export interface StartWorkerPreviewDependencies {
  root?: string;
  resolveTopology?: (root: string) => Promise<DeploymentTopology>;
  startWorker?: (
    options: PreviewWorkerStartOptions,
    signal?: AbortSignal,
  ) => Promise<PreviewWorker>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

type ClosableChildProcess = Pick<ChildProcess, "exitCode" | "kill" | "pid"> &
  NodeJS.EventEmitter;

const defaultPreviewStartupTimeoutMs = 30_000;
const defaultPreviewRequestTimeoutMs = 30_000;
const defaultPreviewCleanupTimeoutMs = 5_000;

class PreviewDeadlineError extends Error {}

export interface ClosePreviewProcessOptions {
  timeoutMs?: number;
  processGroup?: boolean;
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function previewTimeout(
  timeoutMs: number | undefined,
  fallback: number,
): number {
  const resolved = timeoutMs ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error("El timeout del preview debe ser un entero positivo");
  }
  return resolved;
}

function outerCleanupTimeout(timeoutMs: number): number {
  const budget = timeoutMs * 2 + 1;
  if (!Number.isSafeInteger(budget)) {
    throw new Error(
      "El presupuesto de limpieza del preview excede un entero seguro",
    );
  }
  return budget;
}

async function withinPreviewTimeout<T>(
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
              new PreviewDeadlineError(
                `El ciclo de vida del preview superó ${timeoutMs} ms durante ${stage}`,
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

function preservePreviewFailure(
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
              "También falló la limpieza del preview",
            ),
    });
  } catch {
    // The primary failure remains actionable if its cause cannot be attached.
  }
}

type Settled<T> =
  { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

async function observeWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<Settled<T> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then<Settled<T>, Settled<T>>(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      ),
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function bufferPreviewResponseBody(
  response: Response,
  requestTimeoutMs: number,
  cleanupTimeoutMs: number,
): Promise<ArrayBuffer | null> {
  if (response.body === null) return null;

  const reader = response.body.getReader();
  let body!: ArrayBuffer;
  let failed = false;
  let primaryFailure: unknown;
  let releaseFailed = false;
  let releaseFailure: unknown;
  try {
    const chunks: Uint8Array[] = [];
    body = await withinPreviewTimeout(
      "bufferizar la respuesta preview",
      (async () => {
        let length = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
          length += next.value.byteLength;
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes.buffer as ArrayBuffer;
      })(),
      requestTimeoutMs,
    );
  } catch (error) {
    failed = true;
    primaryFailure = error;
    try {
      await withinPreviewTimeout(
        "cancelar el cuerpo preview",
        reader.cancel(),
        cleanupTimeoutMs,
      );
    } catch (cancelFailure) {
      preservePreviewFailure(error, cancelFailure);
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      releaseFailed = true;
      releaseFailure = error;
      if (failed) preservePreviewFailure(primaryFailure, error);
    }
  }
  if (failed) throw primaryFailure;
  if (releaseFailed) throw releaseFailure;
  return body;
}

function canonicalEnvironment(env: NodeJS.ProcessEnv = {}): string {
  return JSON.stringify(
    Object.entries(env).sort(([left], [right]) => lexicalCompare(left, right)),
  );
}

function previewBindings(
  env: NodeJS.ProcessEnv,
): Record<string, { type: "secret_text"; value: string }> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .sort(([left], [right]) => lexicalCompare(left, right))
      .map(([name, value]) => [name, { type: "secret_text", value }]),
  );
}

async function defaultStartPreviewWorker(
  options: PreviewWorkerStartOptions,
): Promise<PreviewWorker> {
  const { unstable_startWorker } = await import("wrangler");
  return (await unstable_startWorker(
    options as Parameters<typeof unstable_startWorker>[0],
  )) as unknown as PreviewWorker;
}

async function disposePreviewWorker(
  worker: PreviewWorker,
  timeoutMs: number,
): Promise<void> {
  let disposeFailure: unknown;
  try {
    await withinPreviewTimeout(
      "cerrar el Worker preview",
      worker.dispose(),
      timeoutMs,
    );
  } catch (error) {
    disposeFailure = error;
  }
  if (disposeFailure === undefined) return;
  if (worker.raw === undefined) throw disposeFailure;

  try {
    await withinPreviewTimeout(
      "forzar teardown del Worker preview",
      worker.raw.teardown(),
      timeoutMs,
    );
  } catch (teardownFailure) {
    preservePreviewFailure(disposeFailure, teardownFailure);
  }
  throw disposeFailure;
}

async function acquirePreviewWorker(
  operation: Promise<PreviewWorker>,
  startupTimeoutMs: number,
  cleanupTimeoutMs: number,
): Promise<PreviewWorker> {
  try {
    return await withinPreviewTimeout(
      "iniciar el Worker preview",
      operation,
      startupTimeoutMs,
    );
  } catch (error) {
    if (!(error instanceof PreviewDeadlineError)) throw error;

    // Wrangler has no AbortSignal for unstable_startWorker. Give a late
    // acquisition one bounded cleanup window before returning the deadline;
    // if it appears later, its own bounded teardown still runs in the
    // background rather than leaking the Worker.
    const lateResult = await observeWithin(operation, cleanupTimeoutMs);
    if (lateResult?.status === "fulfilled") {
      try {
        await disposePreviewWorker(lateResult.value, cleanupTimeoutMs);
      } catch (cleanupFailure) {
        preservePreviewFailure(error, cleanupFailure);
      }
    } else if (lateResult?.status === "rejected") {
      preservePreviewFailure(error, lateResult.reason);
    } else {
      void operation.then(
        async (lateWorker) => {
          try {
            await disposePreviewWorker(lateWorker, cleanupTimeoutMs);
          } catch {
            // The acquisition deadline has already been returned. The late
            // Worker has still been given the only supported hard-stop path.
          }
        },
        () => undefined,
      );
    }
    throw error;
  }
}

/** Runs the emitted Worker with explicit bindings; no ignored `.dev.vars` file is written. */
export async function startWorkerPreview(
  env: NodeJS.ProcessEnv,
  dependencies: StartWorkerPreviewDependencies = {},
): Promise<PreviewInstance> {
  const root = resolve(dependencies.root ?? process.cwd());
  const startWorker = dependencies.startWorker ?? defaultStartPreviewWorker;
  const resolveTopology =
    dependencies.resolveTopology ?? resolveDeploymentTopology;
  const startupTimeoutMs = previewTimeout(
    dependencies.startupTimeoutMs,
    defaultPreviewStartupTimeoutMs,
  );
  const requestTimeoutMs = previewTimeout(
    dependencies.requestTimeoutMs,
    defaultPreviewRequestTimeoutMs,
  );
  const cleanupTimeoutMs = previewTimeout(
    dependencies.cleanupTimeoutMs,
    defaultPreviewCleanupTimeoutMs,
  );
  const topology = await withinPreviewTimeout(
    "resolver la topología emitida del preview",
    resolveTopology(root),
    startupTimeoutMs,
  );
  const worker = await acquirePreviewWorker(
    startWorker({
      config: topology.wranglerConfigPath,
      entrypoint: topology.entryPath,
      bindings: previewBindings(env),
      dev: {
        server: { hostname: "127.0.0.1", port: 0, secure: false },
        logLevel: "error",
        persist: false,
        remote: false,
        watch: false,
      },
    }),
    startupTimeoutMs,
    cleanupTimeoutMs,
  );
  try {
    await withinPreviewTimeout(
      "esperar el Worker preview listo",
      worker.ready,
      startupTimeoutMs,
    );
  } catch (error) {
    try {
      await disposePreviewWorker(worker, cleanupTimeoutMs);
    } catch (cleanupFailure) {
      preservePreviewFailure(error, cleanupFailure);
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= disposePreviewWorker(worker, cleanupTimeoutMs);
    return closePromise;
  };
  return {
    origin: "http://preview.local",
    async fetch(url, init) {
      try {
        return await withinPreviewTimeout(
          "realizar la solicitud preview",
          worker.fetch(url.href, init),
          requestTimeoutMs,
        );
      } catch (error) {
        try {
          await close();
        } catch (cleanupFailure) {
          preservePreviewFailure(error, cleanupFailure);
        }
        throw error;
      }
    },
    close,
  };
}

function terminateProcess(
  child: ClosableChildProcess,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  if (processGroup && process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  child.kill(signal);
}

async function waitForExit(
  exited: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function closePreviewProcess(
  child: ClosableChildProcess,
  options: ClosePreviewProcessOptions = {},
): Promise<void> {
  const processGroup = options.processGroup ?? process.platform !== "win32";
  if (child.exitCode !== null) {
    if (
      processGroup &&
      process.platform !== "win32" &&
      child.pid !== undefined
    ) {
      terminateProcess(child, "SIGKILL", true);
    }
    return;
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  const exited = once(child, "exit");
  terminateProcess(child, "SIGTERM", processGroup);
  if (!(await waitForExit(exited, timeoutMs)) && child.exitCode === null) {
    terminateProcess(child, "SIGKILL", processGroup);
    if (!(await waitForExit(exited, timeoutMs)) && child.exitCode === null) {
      throw new Error("astro preview no terminó después de SIGKILL");
    }
  }
  if (processGroup && process.platform !== "win32") {
    terminateProcess(child, "SIGKILL", true);
  }
}

export function createPreviewPool(dependencies: PreviewPoolDependencies = {}): {
  requestPreview(
    path?: string,
    options?: PreviewRequestOptions,
  ): Promise<Response>;
  close(): Promise<void>;
} {
  const fetchRequest = dependencies.fetch ?? fetch;
  const start = dependencies.startPreview ?? startWorkerPreview;
  const requestTimeoutMs = previewTimeout(
    dependencies.requestTimeoutMs,
    defaultPreviewRequestTimeoutMs,
  );
  const cleanupTimeoutMs = previewTimeout(
    dependencies.cleanupTimeoutMs,
    defaultPreviewCleanupTimeoutMs,
  );
  let active: { key: string; preview: Promise<PreviewInstance> } | undefined;
  let transition = Promise.resolve();

  function serializePreviewOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const nextTransition = transition.then(operation);
    transition = nextTransition.then(
      () => undefined,
      () => undefined,
    );
    return nextTransition;
  }

  async function closePreview(instance: PreviewInstance): Promise<void> {
    await withinPreviewTimeout(
      "cerrar el preview activo",
      instance.close(),
      // startWorkerPreview spends its own cleanup budget across dispose and
      // raw.teardown. The outer pool must leave deterministic room for both
      // phases instead of racing the inner hard-stop.
      outerCleanupTimeout(cleanupTimeoutMs),
    );
  }

  async function acquirePreview(
    key: string,
    env: NodeJS.ProcessEnv,
  ): Promise<PreviewInstance> {
    if (active?.key === key) return active.preview;

    const previous = active;
    active = undefined;
    if (previous) {
      const instance = await previous.preview.catch(() => undefined);
      if (instance !== undefined) await closePreview(instance);
    }

    const preview = start(env);
    active = { key, preview };
    try {
      return await preview;
    } catch (error) {
      if (active?.preview === preview) active = undefined;
      throw error;
    }
  }

  async function closeActivePreview(): Promise<void> {
    await serializePreviewOperation(async () => {
      const previous = active;
      active = undefined;
      const instance = await previous?.preview.catch(() => undefined);
      if (instance !== undefined) await closePreview(instance);
    });
  }

  async function closePreviewAfterRequestFailure(
    key: string,
    preview: PreviewInstance,
    primaryFailure: unknown,
  ): Promise<never> {
    if (active?.key === key) active = undefined;
    try {
      await closePreview(preview);
    } catch (cleanupFailure) {
      preservePreviewFailure(primaryFailure, cleanupFailure);
    }
    throw primaryFailure;
  }

  return {
    async requestPreview(
      path = "/",
      options: PreviewRequestOptions = {},
    ): Promise<Response> {
      return serializePreviewOperation(async () => {
        const key = canonicalEnvironment(options.env);
        const preview = await acquirePreview(key, options.env ?? {});
        const requestUrl = new URL(path, preview.origin);
        const request = {
          method: options.method ?? "GET",
          body: options.body,
          headers: { accept: "text/html", ...(options.headers ?? {}) },
          redirect: "manual",
        } satisfies RequestInit;
        try {
          const response = preview.fetch
            ? await withinPreviewTimeout(
                "realizar la solicitud preview",
                preview.fetch(requestUrl, request),
                requestTimeoutMs,
              )
            : await withinPreviewTimeout(
                "realizar la solicitud preview",
                fetchRequest(requestUrl, request),
                requestTimeoutMs,
              );
          const body = await bufferPreviewResponseBody(
            response,
            requestTimeoutMs,
            cleanupTimeoutMs,
          );
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (error) {
          return closePreviewAfterRequestFailure(key, preview, error);
        }
      });
    },
    async close(): Promise<void> {
      await closeActivePreview();
    },
  };
}

const defaultPreviewPool = createPreviewPool();

export const requestPreview = defaultPreviewPool.requestPreview;
export const closePreviewPool = defaultPreviewPool.close;
