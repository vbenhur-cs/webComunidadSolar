import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  closePreviewProcess,
  createPreviewPool,
  previewEnvironment,
} from "./preview-pool.ts";

test("disables Astro agent backgrounding for an owned preview process", () => {
  assert.equal(
    previewEnvironment({ SITE_INDEXABLE: "true" }).ASTRO_PREVIEW_BACKGROUND,
    "0",
  );
  assert.equal(
    previewEnvironment({ SITE_INDEXABLE: "true" }).SITE_INDEXABLE,
    "true",
  );
});

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
