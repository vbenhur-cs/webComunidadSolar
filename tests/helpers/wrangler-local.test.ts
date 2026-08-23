import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runLocalCommand,
  withLocalD1Worker,
  type LocalD1WorkerDependencies,
} from "./wrangler-local.ts";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  pid = 41_001;

  kill(): boolean {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

function successfulDependencies(
  overrides: Partial<LocalD1WorkerDependencies> = {},
): LocalD1WorkerDependencies {
  return {
    platform: "darwin",
    environment: {
      CLOUDFLARE_CONFIG_PATH: "config/isolated.jsonc",
      CLOUDFLARE_ENV: "preview",
    },
    createTemporaryDirectory: async () => "/tmp/comunidadsolar-d1-test",
    removeTemporaryDirectory: async () => undefined,
    resolveTopology: async () => ({
      deployConfigPath: "/project/.wrangler/deploy/config.json",
      wranglerConfigPath: "/project/dist/server/wrangler.json",
      entryPath: "/project/dist/server/entry.mjs",
    }),
    runCommand: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    findFreePort: async () => 43111,
    spawn: () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    },
    waitForWorker: async () => undefined,
    closeProcess: async () => undefined,
    ...overrides,
  };
}

test("uses the selected config, optional environment and explicit dist assets for D1 commands", async () => {
  const commands: Array<{
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }> = [];
  const spawned: string[][] = [];
  const dependencies = successfulDependencies({
    runCommand: async (command, args, options) => {
      commands.push({ command, args, env: options.env });
      return { code: 0, stdout: "[]", stderr: "" };
    },
    spawn: ((_command: string, args: readonly string[] | undefined) => {
      spawned.push(args === undefined ? [] : [...args]);
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    }) as unknown as typeof import("node:child_process").spawn,
  });

  await withLocalD1Worker(
    async () => undefined,
    { root: "/project" },
    dependencies,
  );

  const migration = commands.find((command) => command.args[0] === "d1");
  assert.ok(migration);
  assert.deepEqual(migration.args.slice(0, 5), [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
  ]);
  assert.equal(
    migration.args.includes("--yes"),
    false,
    "Wrangler 4.125 no admite una bandera --yes para migraciones",
  );
  assert.equal(
    migration.env?.CI,
    "1",
    "las migraciones locales deben suprimir el prompt sólo mediante CI=1",
  );
  assert.equal(
    migration.args[migration.args.indexOf("--config") + 1],
    "/project/config/isolated.jsonc",
  );
  assert.deepEqual(migration.args.slice(-2), ["--env", "preview"]);
  assert.equal(
    commands[0]?.env?.CLOUDFLARE_CONFIG_PATH,
    "config/isolated.jsonc",
  );

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.[0], "dev");
  assert.equal(
    spawned[0]?.[spawned[0]?.indexOf("--config") + 1],
    "/project/dist/server/wrangler.json",
  );
  assert.equal(
    spawned[0]?.[spawned[0]?.indexOf("--assets") + 1],
    "/project/dist",
  );
  assert.deepEqual(spawned[0]?.slice(-2), ["--env", "preview"]);
});

test("passes sorted synthetic private allowlists only to the local dev Worker", async () => {
  const commands: string[][] = [];
  const spawned: string[][] = [];
  const root = await mkdtemp(join(tmpdir(), "wrangler-local-bindings-"));
  const dependencies = successfulDependencies({
    runCommand: async (_command, args) => {
      commands.push(args);
      return { code: 0, stdout: "[]", stderr: "" };
    },
    spawn: ((_command: string, args: readonly string[] | undefined) => {
      spawned.push(args === undefined ? [] : [...args]);
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    }) as unknown as typeof import("node:child_process").spawn,
  });

  try {
    await withLocalD1Worker(
      async () => undefined,
      {
        root,
        syntheticBindings: {
          TEAM_ALLOWED_EMAILS: "team-synthetic@example.test",
          MANGANAFER_ALLOWED_EMAILS: "admin-synthetic@example.test",
        },
      },
      dependencies,
    );

    assert.equal(
      commands.every((args) => args.includes("--var") === false),
      true,
    );
    assert.deepEqual(spawned[0]?.slice(-4), [
      "--var",
      "MANGANAFER_ALLOWED_EMAILS:admin-synthetic@example.test",
      "--var",
      "TEAM_ALLOWED_EMAILS:team-synthetic@example.test",
    ]);
    assert.equal(existsSync(join(root, ".dev.vars")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe synthetic bindings before local D1 build or spawn", async () => {
  let commands = 0;
  let spawned = 0;
  const dependencies = successfulDependencies({
    runCommand: async () => {
      commands += 1;
      return { code: 0, stdout: "[]", stderr: "" };
    },
    spawn: () => {
      spawned += 1;
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    },
  });

  await assert.rejects(
    withLocalD1Worker(
      async () => undefined,
      {
        root: "/project",
        syntheticBindings: {
          MANGANAFER_ALLOWED_EMAILS: "outside@example.invalid:unsafe",
        },
      },
      dependencies,
    ),
    /binding sintético.*no válido/i,
  );
  assert.equal(commands, 0);
  assert.equal(spawned, 0);
});

test("can deliberately start an empty local D1 without preapplying migrations", async () => {
  const commands: string[][] = [];
  const dependencies = successfulDependencies({
    runCommand: async (_command, args) => {
      commands.push(args);
      return { code: 0, stdout: "[]", stderr: "" };
    },
  });

  await withLocalD1Worker(
    async () => undefined,
    { root: "/project", applyMigrations: false },
    dependencies,
  );

  assert.equal(
    commands.some(
      (args) =>
        args[0] === "d1" && args[1] === "migrations" && args[2] === "apply",
    ),
    false,
  );
});

test("can reuse an already validated emitted build without rebuilding its shared dist", async () => {
  const commands: string[][] = [];
  const dependencies = successfulDependencies({
    runCommand: async (_command, args) => {
      commands.push(args);
      return { code: 0, stdout: "[]", stderr: "" };
    },
  });

  await withLocalD1Worker(
    async () => undefined,
    { root: "/project", useExistingBuild: true },
    dependencies,
  );

  assert.equal(
    commands.some((args) => args[0] === "run" && args[1] === "build"),
    false,
  );
  assert.equal(
    commands.some(
      (args) =>
        args[0] === "d1" && args[1] === "migrations" && args[2] === "apply",
    ),
    true,
  );
});

test("fails promptly when spawning the local Worker fails instead of waiting for readiness", async () => {
  let waitedForReady = false;
  let closed = false;
  const dependencies = successfulDependencies({
    spawn: () => {
      const child = new FakeChild();
      queueMicrotask(() =>
        child.emit("error", new Error("synthetic spawn failure")),
      );
      return child as never;
    },
    waitForWorker: async () => {
      waitedForReady = true;
      await new Promise<never>(() => undefined);
    },
    closeProcess: async () => {
      closed = true;
    },
  });

  await assert.rejects(
    withLocalD1Worker(
      async () => undefined,
      { root: "/project" },
      dependencies,
    ),
    /synthetic spawn failure/,
  );
  assert.equal(waitedForReady, false);
  assert.equal(closed, true);
});

test("bounds a non-cooperative injected readiness before returning from local Worker setup", async () => {
  let closed = false;
  const dependencies = successfulDependencies({
    workerStartupTimeoutMs: 5,
    waitForWorker: async () => new Promise<never>(() => undefined),
    closeProcess: async () => {
      closed = true;
    },
  });

  await assert.rejects(
    withLocalD1Worker(
      async () => undefined,
      { root: "/project" },
      dependencies,
    ),
    /Worker D1 local.*5 ms durante readiness/,
  );
  assert.equal(closed, true);
});

test("kills the POSIX process group after a normally exiting command", async () => {
  const child = new FakeChild();
  const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  queueMicrotask(() => child.emit("close", 0));

  await runLocalCommand("synthetic", [], {
    cwd: "/project",
    timeoutMs: 100,
    platform: "darwin",
    spawn: () => child as never,
    killProcess: (pid, signal) => {
      assert.equal(typeof signal, "string");
      groupSignals.push({ pid, signal: signal as NodeJS.Signals });
      return true;
    },
  });

  assert.deepEqual(groupSignals, [{ pid: -41_001, signal: "SIGKILL" }]);
});

test("keeps a callback failure primary when local Worker cleanup also fails", async () => {
  const primary = new Error("synthetic callback failure");
  const cleanup = new Error("synthetic cleanup failure");
  const dependencies = successfulDependencies({
    closeProcess: async () => {
      throw cleanup;
    },
  });

  await assert.rejects(
    withLocalD1Worker(
      async () => {
        throw primary;
      },
      { root: "/project" },
      dependencies,
    ),
    (error: unknown) => {
      assert.equal(error, primary);
      assert.equal((error as Error & { cause?: unknown }).cause, cleanup);
      return true;
    },
  );
});

test("fails closed on Windows before creating local state or spawning a process", async () => {
  let touched = false;
  const dependencies = successfulDependencies({
    platform: "win32",
    createTemporaryDirectory: async () => {
      touched = true;
      return "/tmp/should-not-exist";
    },
  });

  await assert.rejects(
    withLocalD1Worker(
      async () => undefined,
      { root: "/project" },
      dependencies,
    ),
    /POSIX.*grupos de procesos/,
  );
  assert.equal(touched, false);
});

test(
  "kills a real POSIX descendant after its leader exits normally",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrangler-local-pgid-"));
    const markerPath = join(directory, "descendant-marker");
    const pidPath = join(directory, "descendant-pid");
    let descendantPid: number | undefined;
    let primaryFailure: unknown;
    try {
      const descendantProgram = [
        "const { writeFileSync } = require('node:fs');",
        "process.on('SIGTERM', () => undefined);",
        "setTimeout(() => writeFileSync(process.argv[1], 'unexpected marker'), 2200);",
        "setInterval(() => undefined, 1000);",
      ].join("\n");
      const leaderProgram = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}, process.argv[1]], { stdio: 'ignore' });`,
        "writeFileSync(process.argv[2], String(child.pid));",
        "setTimeout(() => process.exit(0), 800);",
      ].join("\n");
      await runLocalCommand(
        process.execPath,
        ["-e", leaderProgram, markerPath, pidPath],
        { cwd: directory, timeoutMs: 5_000 },
      );
      descendantPid = Number(await readFile(pidPath, "utf8"));

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_400));
      await assert.rejects(
        readFile(markerPath, "utf8"),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );
      assert.throws(
        () => process.kill(descendantPid!, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    } catch (error) {
      primaryFailure = error;
    }
    let cleanupFailure: unknown;
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          cleanupFailure = error;
        }
      }
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  },
);
