import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

export interface PreviewRequestOptions {
  env?: NodeJS.ProcessEnv;
  method?: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
}

export interface PreviewInstance {
  origin: string;
  close(): Promise<void>;
}

export interface PreviewPoolDependencies {
  fetch?: typeof fetch;
  startPreview?: (env: NodeJS.ProcessEnv) => Promise<PreviewInstance>;
}

type ClosableChildProcess = Pick<ChildProcess, "exitCode" | "kill" | "pid"> &
  NodeJS.EventEmitter;

export interface ClosePreviewProcessOptions {
  timeoutMs?: number;
  processGroup?: boolean;
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalEnvironment(env: NodeJS.ProcessEnv = {}): string {
  return JSON.stringify(
    Object.entries(env).sort(([left], [right]) => lexicalCompare(left, right)),
  );
}

export function previewEnvironment(
  env: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { ...process.env, ...env, ASTRO_PREVIEW_BACKGROUND: "0" };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo reservar un puerto local para Astro preview");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForPreview(
  origin: string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let latestError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`astro preview terminó con código ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      if (response.status > 0) return;
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `astro preview no respondió en 30 segundos${latestError ? `: ${String(latestError)}` : ""}`,
  );
}

async function startPreview(env: NodeJS.ProcessEnv): Promise<PreviewInstance> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    "./node_modules/.bin/astro",
    ["preview", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: previewEnvironment(env),
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForPreview(origin, child);
    return { origin, close: () => closePreviewProcess(child) };
  } catch (error) {
    await closePreviewProcess(child);
    throw new Error(`${String(error)}${stderr ? `\n${stderr}` : ""}`);
  }
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
  const previews = new Map<string, Promise<PreviewInstance>>();
  const fetchRequest = dependencies.fetch ?? fetch;
  const start = dependencies.startPreview ?? startPreview;

  return {
    async requestPreview(
      path = "/",
      options: PreviewRequestOptions = {},
    ): Promise<Response> {
      const key = canonicalEnvironment(options.env);
      let preview = previews.get(key);
      if (!preview) {
        preview = start(options.env ?? {});
        previews.set(key, preview);
      }
      const { origin } = await preview;
      return fetchRequest(new URL(path, origin), {
        method: options.method ?? "GET",
        body: options.body,
        headers: { accept: "text/html", ...(options.headers ?? {}) },
        redirect: "manual",
      });
    },
    async close(): Promise<void> {
      const active = [...previews.values()];
      previews.clear();
      await Promise.all(
        active.map(async (preview) => {
          const instance = await preview.catch(() => undefined);
          await instance?.close();
        }),
      );
    },
  };
}

const defaultPreviewPool = createPreviewPool();

export const requestPreview = defaultPreviewPool.requestPreview;
export const closePreviewPool = defaultPreviewPool.close;
