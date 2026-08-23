import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  closePreviewProcess,
  createPreviewPool,
  startWorkerPreview,
} from "./preview-pool.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs = 150,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`el test superó ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function blockEventLoop(milliseconds: number): void {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // Deliberately model archive-load timer delay for lifecycle ordering.
  }
}

test("keeps redirect responses observable by HTTP contracts", async () => {
  let requestInit: RequestInit | undefined;
  const pool = createPreviewPool({
    startPreview: async () => ({
      origin: "http://preview.test",
      close: async () => {},
    }),
    fetch: async (_input, init) => {
      requestInit = init;
      return new Response(null, {
        status: 308,
        headers: { location: "/mantenimiento" },
      });
    },
  });

  const response = await pool.requestPreview("/mantenimiento-placas-solares");

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/mantenimiento");
  assert.equal(requestInit?.redirect, "manual");
  await pool.close();
});

test("does not let a rejected preview startup mask test cleanup", async () => {
  const pool = createPreviewPool({
    startPreview: async () => {
      throw new Error("preview startup failed");
    },
  });

  await assert.rejects(() => pool.requestPreview(), /preview startup failed/);
  await assert.doesNotReject(() => pool.close());
});

test("serializes distinct preview environments before starting the next Astro preview", async () => {
  const events: string[] = [];
  const pool = createPreviewPool({
    startPreview: async (env) => {
      const fixture = env.TEAM_ALLOWED_EMAILS ? "allowed" : "anonymous";
      events.push(`start:${fixture}`);
      return {
        origin: `http://${fixture}.preview.test`,
        close: async () => {
          events.push(`close:${fixture}`);
        },
      };
    },
    fetch: async (input) => {
      const fixture = new URL(String(input)).hostname.split(".")[0];
      events.push(`fetch:${fixture}`);
      return new Response(fixture);
    },
  });

  const anonymous = await pool.requestPreview("/guia-equipo");
  const allowed = await pool.requestPreview("/guia-equipo", {
    env: { TEAM_ALLOWED_EMAILS: "allowed@example.test" },
  });

  assert.equal(await anonymous.text(), "anonymous");
  assert.equal(await allowed.text(), "allowed");
  assert.deepEqual(events, [
    "start:anonymous",
    "fetch:anonymous",
    "close:anonymous",
    "start:allowed",
    "fetch:allowed",
  ]);
  await pool.close();
  assert.deepEqual(events.at(-1), "close:allowed");
});

test("buffers a response before a different environment can close its preview", async () => {
  const events: string[] = [];
  const firstFetchStarted = deferred<void>();
  const releaseFirstBody = deferred<void>();
  const pool = createPreviewPool({
    startPreview: async (env) => {
      const fixture = env.TEAM_ALLOWED_EMAILS ? "allowed" : "anonymous";
      events.push(`start:${fixture}`);
      return {
        origin: `http://${fixture}.preview.test`,
        close: async () => {
          events.push(`close:${fixture}`);
        },
        fetch: async () => {
          events.push(`fetch:${fixture}`);
          if (fixture === "anonymous") {
            firstFetchStarted.resolve();
            return new Response(
              new ReadableStream({
                async start(controller) {
                  await releaseFirstBody.promise;
                  controller.enqueue(new TextEncoder().encode("anonymous"));
                  controller.close();
                },
              }),
            );
          }
          return new Response("allowed");
        },
      };
    },
  });

  const first = pool.requestPreview("/guia-equipo");
  await firstFetchStarted.promise;
  const second = pool.requestPreview("/guia-equipo", {
    env: { TEAM_ALLOWED_EMAILS: "allowed@example.test" },
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(events, ["start:anonymous", "fetch:anonymous"]);

  releaseFirstBody.resolve();
  assert.equal(await (await first).text(), "anonymous");
  assert.equal(await (await second).text(), "allowed");
  assert.deepEqual(events, [
    "start:anonymous",
    "fetch:anonymous",
    "close:anonymous",
    "start:allowed",
    "fetch:allowed",
  ]);
  await pool.close();
});

test("starts the built Worker with only the explicit preview bindings", async () => {
  let receivedOptions:
    | {
        config: string;
        entrypoint: string;
        bindings: unknown;
        dev: { persist?: boolean; watch?: boolean };
      }
    | undefined;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let disposed = 0;

  const preview = await startWorkerPreview(
    { TEAM_ALLOWED_EMAILS: "allowed@example.test" },
    {
      root: "/candidate",
      resolveTopology: async (root) => {
        assert.equal(root, "/candidate");
        return {
          deployConfigPath: "/candidate/.wrangler/deploy/config.json",
          wranglerConfigPath: "/candidate/.wrangler/generated/wrangler.json",
          entryPath: "/candidate/.wrangler/generated/worker.mjs",
        };
      },
      startWorker: async (options) => {
        receivedOptions = options;
        return {
          ready: Promise.resolve(),
          fetch: async (url, init) => {
            requests.push({ url, init });
            return new Response("worker response");
          },
          dispose: async () => {
            disposed += 1;
          },
        };
      },
    },
  );

  assert.equal(
    receivedOptions?.config,
    "/candidate/.wrangler/generated/wrangler.json",
  );
  assert.equal(
    receivedOptions?.entrypoint,
    "/candidate/.wrangler/generated/worker.mjs",
  );
  assert.deepEqual(receivedOptions?.bindings, {
    TEAM_ALLOWED_EMAILS: {
      type: "secret_text",
      value: "allowed@example.test",
    },
  });
  assert.equal(receivedOptions?.dev.persist, false);
  assert.equal(receivedOptions?.dev.watch, false);
  if (!preview.fetch) throw new Error("El preview Worker debe exponer fetch");
  assert.equal(
    await (
      await preview.fetch(new URL("/guia-equipo", preview.origin), {
        headers: { "x-fixture": "allowed" },
      })
    ).text(),
    "worker response",
  );
  assert.deepEqual(requests, [
    {
      url: "http://preview.local/guia-equipo",
      init: { headers: { "x-fixture": "allowed" } },
    },
  ]);

  await preview.close();
  assert.equal(disposed, 1);
});

test("disposes a Worker whose readiness fails before surfacing the failure", async () => {
  let disposed = 0;
  await assert.rejects(
    () =>
      startWorkerPreview(
        {},
        {
          resolveTopology: async () => ({
            deployConfigPath: "/fixture/.wrangler/deploy/config.json",
            wranglerConfigPath: "/fixture/wrangler.json",
            entryPath: "/fixture/entry.mjs",
          }),
          startWorker: async () => ({
            ready: Promise.reject(new Error("worker not ready")),
            fetch: async () => new Response(),
            dispose: async () => {
              disposed += 1;
            },
          }),
        },
      ),
    /worker not ready/,
  );
  assert.equal(disposed, 1);
});

test("bounds an unresponsive Worker startup", async () => {
  await assert.rejects(
    () =>
      settleWithin(
        startWorkerPreview(
          {},
          {
            startupTimeoutMs: 5,
            cleanupTimeoutMs: 5,
            resolveTopology: async () => ({
              deployConfigPath: "/fixture/.wrangler/deploy/config.json",
              wranglerConfigPath: "/fixture/wrangler.json",
              entryPath: "/fixture/entry.mjs",
            }),
            startWorker: async () => new Promise(() => undefined),
          },
        ),
      ),
    /iniciar el Worker preview/i,
  );
});

test("closes a late Worker acquisition before reporting its startup timeout", async () => {
  const lateWorker = deferred<{
    ready: Promise<void>;
    fetch(): Promise<Response>;
    dispose(): Promise<void>;
  }>();
  let disposed = 0;
  const startup = startWorkerPreview(
    {},
    {
      startupTimeoutMs: 5,
      cleanupTimeoutMs: 40,
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/wrangler.json",
        entryPath: "/fixture/entry.mjs",
      }),
      startWorker: async () => lateWorker.promise,
    },
  );
  setTimeout(() => {
    lateWorker.resolve({
      ready: Promise.resolve(),
      fetch: async () => new Response(),
      dispose: async () => {
        disposed += 1;
      },
    });
  }, 10);

  await assert.rejects(
    () => settleWithin(startup),
    /iniciar el Worker preview/i,
  );
  assert.equal(disposed, 1);
});

test("eventually tears down a Worker that appears after the startup cleanup grace", async () => {
  const lateWorker = deferred<{
    ready: Promise<void>;
    fetch(): Promise<Response>;
    dispose(): Promise<void>;
  }>();
  const disposed = deferred<void>();
  const startup = startWorkerPreview(
    {},
    {
      startupTimeoutMs: 5,
      cleanupTimeoutMs: 5,
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/wrangler.json",
        entryPath: "/fixture/entry.mjs",
      }),
      startWorker: async () => lateWorker.promise,
    },
  );

  await assert.rejects(
    () => settleWithin(startup),
    /iniciar el Worker preview/i,
  );
  lateWorker.resolve({
    ready: Promise.resolve(),
    fetch: async () => new Response(),
    dispose: async () => {
      disposed.resolve();
    },
  });
  await settleWithin(disposed.promise);
});

test("closes a Worker before reporting a readiness deadline", async () => {
  let disposed = 0;
  await assert.rejects(
    () =>
      settleWithin(
        startWorkerPreview(
          {},
          {
            startupTimeoutMs: 5,
            cleanupTimeoutMs: 30,
            resolveTopology: async () => ({
              deployConfigPath: "/fixture/.wrangler/deploy/config.json",
              wranglerConfigPath: "/fixture/wrangler.json",
              entryPath: "/fixture/entry.mjs",
            }),
            startWorker: async () => ({
              ready: new Promise<void>(() => undefined),
              fetch: async () => new Response(),
              dispose: async () => {
                disposed += 1;
              },
            }),
          },
        ),
      ),
    /esperar el Worker preview listo/i,
  );
  assert.equal(disposed, 1);
});

test("closes a Worker before reporting a hung preview fetch", async () => {
  let disposed = 0;
  const preview = await startWorkerPreview(
    {},
    {
      requestTimeoutMs: 5,
      cleanupTimeoutMs: 30,
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/wrangler.json",
        entryPath: "/fixture/entry.mjs",
      }),
      startWorker: async () => ({
        ready: Promise.resolve(),
        fetch: async () => new Promise<Response>(() => undefined),
        dispose: async () => {
          disposed += 1;
        },
      }),
    },
  );

  const previewFetch = preview.fetch;
  if (previewFetch === undefined)
    assert.fail("El Worker preview debe exponer fetch");
  await assert.rejects(
    () => settleWithin(previewFetch(new URL("/guia-equipo", preview.origin))),
    /solicitud preview/i,
  );
  assert.equal(disposed, 1);
});

test("bounds a hung custom PreviewInstance fetch before changing environments", async () => {
  let closed = false;
  const pool = createPreviewPool({
    requestTimeoutMs: 5,
    cleanupTimeoutMs: 30,
    startPreview: async () => ({
      origin: "http://preview.test",
      close: async () => {
        closed = true;
      },
      fetch: async () => new Promise<Response>(() => undefined),
    }),
  });

  await assert.rejects(
    () => settleWithin(pool.requestPreview("/guia-equipo")),
    /solicitud preview/i,
  );
  assert.equal(closed, true);
});

test("closes a preview before reporting a hung response body buffer", async () => {
  const events: string[] = [];
  const pool = createPreviewPool({
    requestTimeoutMs: 5,
    cleanupTimeoutMs: 30,
    startPreview: async () => ({
      origin: "http://preview.test",
      close: async () => {
        events.push("close");
      },
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {
              // Deliberately never closes: Response.arrayBuffer() must time out.
            },
            cancel() {
              events.push("cancel");
            },
          }),
        ),
    }),
  });

  await assert.rejects(
    () => settleWithin(pool.requestPreview("/guia-equipo")),
    /bufferizar la respuesta preview/i,
  );
  assert.deepEqual(events, ["cancel", "close"]);
});

test("bounds a hung response-body cancel without hiding the body deadline", async () => {
  const events: string[] = [];
  const pool = createPreviewPool({
    requestTimeoutMs: 5,
    cleanupTimeoutMs: 30,
    startPreview: async () => ({
      origin: "http://preview.test",
      close: async () => {
        events.push("close");
      },
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {
              // Deliberately never closes: the reader and its cancel both hang.
            },
            cancel() {
              events.push("cancel");
              return new Promise<void>(() => undefined);
            },
          }),
        ),
    }),
  });

  await assert.rejects(
    () => settleWithin(pool.requestPreview("/guia-equipo")),
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /bufferizar la respuesta preview/i,
      );
      assert.match(
        String((error as Error & { cause?: unknown }).cause),
        /cancelar el cuerpo preview/i,
      );
      return true;
    },
  );
  assert.deepEqual(events, ["cancel", "close"]);
});

test("forces raw teardown before returning a hung Worker disposal failure", async () => {
  let tornDown = false;
  const preview = await startWorkerPreview(
    {},
    {
      cleanupTimeoutMs: 30,
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/wrangler.json",
        entryPath: "/fixture/entry.mjs",
      }),
      startWorker: async () => ({
        ready: Promise.resolve(),
        fetch: async () => new Response(),
        dispose: async () => new Promise<void>(() => undefined),
        raw: {
          teardown: async () => {
            tornDown = true;
          },
        },
      }),
    },
  );

  await assert.rejects(
    () => settleWithin(preview.close()),
    /cerrar el Worker preview/i,
  );
  assert.equal(tornDown, true);
});

test("lets pool.close finish raw teardown before its outer cleanup deadline", async () => {
  let rawTeardownCompleted = false;
  const preview = await startWorkerPreview(
    {},
    {
      cleanupTimeoutMs: 30,
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/wrangler.json",
        entryPath: "/fixture/entry.mjs",
      }),
      startWorker: async () => ({
        ready: Promise.resolve(),
        fetch: async () => new Response("ok"),
        dispose: async () => new Promise<void>(() => undefined),
        raw: {
          teardown: async () => {
            await new Promise((resolveLater) => setTimeout(resolveLater, 20));
            rawTeardownCompleted = true;
          },
        },
      }),
    },
  );
  const pool = createPreviewPool({
    cleanupTimeoutMs: 30,
    startPreview: async () => preview,
  });

  assert.equal(await (await pool.requestPreview("/guia-equipo")).text(), "ok");
  await assert.rejects(
    () => settleWithin(pool.close()),
    /cerrar el Worker preview/i,
  );
  assert.equal(rawTeardownCompleted, true);
});

test("preserves a bounded Worker close failure through delayed timer scheduling", async () => {
  let rawTeardownCompleted = false;
  const preview = await startWorkerPreview(
    {},
    {
      cleanupTimeoutMs: 30,
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/wrangler.json",
        entryPath: "/fixture/entry.mjs",
      }),
      startWorker: async () => ({
        ready: Promise.resolve(),
        fetch: async () => new Response("ok"),
        dispose: async () => new Promise<void>(() => undefined),
        raw: {
          teardown: async () => {
            await new Promise((resolveLater) => setTimeout(resolveLater, 20));
            rawTeardownCompleted = true;
          },
        },
      }),
    },
  );
  const pool = createPreviewPool({
    cleanupTimeoutMs: 30,
    startPreview: async () => preview,
  });

  assert.equal(await (await pool.requestPreview("/guia-equipo")).text(), "ok");
  const blocker = new Promise<void>((resolveLater) => {
    setTimeout(() => {
      blockEventLoop(45);
      resolveLater();
    }, 20);
  });

  await assert.rejects(
    () => settleWithin(pool.close(), 300),
    /cerrar el Worker preview/i,
  );
  await blocker;
  assert.equal(rawTeardownCompleted, true);
});

test("bounds an untrusted custom preview close that never settles", async () => {
  const pool = createPreviewPool({
    cleanupTimeoutMs: 30,
    startPreview: async () => ({
      origin: "http://preview.test",
      close: async () => new Promise<void>(() => undefined),
      fetch: async () => new Response("ok"),
    }),
  });

  assert.equal(await (await pool.requestPreview("/guia-equipo")).text(), "ok");
  await assert.rejects(
    () => settleWithin(pool.close(), 150),
    /cerrar el preview activo/i,
  );
});

test("never writes or alters .dev.vars while starting or closing an explicit Worker preview", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-preview-dev-vars-"),
  );
  const devVarsPath = join(root, ".dev.vars");
  const existing = Buffer.from(
    "PREEXISTING_SYNTHETIC_VALUE=unchanged\n",
    "utf8",
  );
  const resolveTopology = async () => ({
    deployConfigPath: join(root, ".wrangler", "deploy", "config.json"),
    wranglerConfigPath: join(root, ".wrangler", "generated", "wrangler.json"),
    entryPath: join(root, ".wrangler", "generated", "worker.mjs"),
  });
  let disposed = 0;
  try {
    await writeFile(devVarsPath, existing);
    const preview = await startWorkerPreview(
      { TEAM_ALLOWED_EMAILS: "visual-parity-auth@example.test" },
      {
        root,
        resolveTopology,
        startWorker: async () => ({
          ready: Promise.resolve(),
          fetch: async () => new Response(),
          dispose: async () => {
            disposed += 1;
          },
        }),
      },
    );
    assert.deepEqual(await readFile(devVarsPath), existing);
    await preview.close();
    assert.deepEqual(await readFile(devVarsPath), existing);

    await assert.rejects(
      startWorkerPreview(
        { TEAM_ALLOWED_EMAILS: "visual-parity-auth@example.test" },
        {
          root,
          resolveTopology,
          startWorker: async () => ({
            ready: Promise.reject(new Error("preview ready failed")),
            fetch: async () => new Response(),
            dispose: async () => {
              disposed += 1;
            },
          }),
        },
      ),
      /preview ready failed/,
    );
    assert.deepEqual(await readFile(devVarsPath), existing);

    await assert.rejects(
      startWorkerPreview(
        { TEAM_ALLOWED_EMAILS: "visual-parity-auth@example.test" },
        {
          root,
          resolveTopology,
          startWorker: async () => {
            throw new Error("preview startup threw");
          },
        },
      ),
      /preview startup threw/,
    );
    assert.deepEqual(await readFile(devVarsPath), existing);

    await rm(devVarsPath);
    await assert.rejects(
      startWorkerPreview(
        { TEAM_ALLOWED_EMAILS: "visual-parity-auth@example.test" },
        {
          root,
          resolveTopology,
          startWorker: async () => ({
            ready: Promise.reject(new Error("second preview ready failed")),
            fetch: async () => new Response(),
            dispose: async () => {
              disposed += 1;
            },
          }),
        },
      ),
      /second preview ready failed/,
    );
    assert.equal(existsSync(devVarsPath), false);
    assert.equal(disposed, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("arms the exit listener before terminating a process that exits synchronously", async () => {
  class ImmediateExitChild extends EventEmitter {
    exitCode: number | null = null;
    pid = 1;

    kill() {
      this.exitCode = 0;
      this.emit("exit", 0, "SIGTERM");
      return true;
    }
  }

  const child = new ImmediateExitChild();
  await closePreviewProcess(child, { timeoutMs: 5, processGroup: false });
  assert.equal(child.exitCode, 0);
});

test(
  "kills an owned POSIX process group when its leader exits before a descendant",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "comunidadsolar-preview-pool-"));
    const ready = join(root, "ready");
    const marker = join(root, "descendant-marker");
    const childProgram = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      'setTimeout(() => fs.writeFileSync(process.argv[1], "orphan"), 700);',
      "setInterval(() => {}, 1_000);",
    ].join(" ");
    const parentProgram = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}, process.argv[2]], { stdio: "ignore" });`,
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => {}, 1_000);",
    ].join(" ");
    const parent = spawn(
      process.execPath,
      ["-e", parentProgram, ready, marker],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await readFile(ready, "utf8");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await assert.doesNotReject(() => readFile(ready, "utf8"));
      await closePreviewProcess(parent, { timeoutMs: 250, processGroup: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await assert.rejects(() => readFile(marker, "utf8"), { code: "ENOENT" });
    } finally {
      if (parent.exitCode === null) parent.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "kills an owned POSIX process group after its leader has already exited",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "comunidadsolar-preview-pool-"));
    const ready = join(root, "ready");
    const marker = join(root, "descendant-marker");
    const childProgram = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      'setTimeout(() => fs.writeFileSync(process.argv[1], "orphan"), 900);',
      "setInterval(() => {}, 1_000);",
    ].join(" ");
    const parentProgram = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}, process.argv[2]], { stdio: "ignore" });`,
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "process.exit(0);",
    ].join(" ");
    const parent = spawn(
      process.execPath,
      ["-e", parentProgram, ready, marker],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const parentExited = once(parent, "exit");

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await readFile(ready, "utf8");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const descendantPid = Number(await readFile(ready, "utf8"));
      await parentExited;
      assert.notEqual(parent.exitCode, null);

      await closePreviewProcess(parent, { timeoutMs: 250, processGroup: true });
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      await assert.rejects(() => readFile(marker, "utf8"), { code: "ENOENT" });
      assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    } finally {
      if (parent.pid !== undefined) {
        try {
          process.kill(-parent.pid, "SIGKILL");
        } catch {
          // El fixture puede haber terminado ya; no debe ocultar el fallo real.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
