import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  buildPreparedProfile,
  runCloudflareDryRun,
  type PreparedProfileBuildChild,
} from "../../scripts/deploy-dry.ts";
import { prepareCloudflareConfig } from "../../scripts/prepare-cloudflare-config.ts";

const localD1Id = "00000000-0000-4000-8000-000000000000";

function localConfig(): string {
  return JSON.stringify({
    name: "comunidad-solar-astro-local",
    main: "./src/worker.ts",
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      binding: "ASSETS",
      directory: "./dist",
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "comunidad-solar-local",
        database_id: localD1Id,
        migrations_dir: "./drizzle",
      },
    ],
  });
}

function generatedLocalProfile(configPath: string): Record<string, unknown> {
  return {
    configPath,
    // Wrangler serializes an explicitly selected base profile as an empty name.
    targetEnvironment: "",
    name: "comunidad-solar-astro-local",
    vars: { SITE_INDEXABLE: "false" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "comunidad-solar-local",
        database_id: localD1Id,
      },
    ],
  };
}

class HangingBuildChild
  extends EventEmitter
  implements PreparedProfileBuildChild
{
  exitCode: number | null = null;
  pid = 41_901;
}

test("dry deployment validates a local profile without fetching or publishing", async () => {
  const root = await mkdirTemp();
  const inputPath = join(root, "wrangler.jsonc");
  const artifactRoot = join(root, "artifacts", "config");
  const input = localConfig();
  await writeFile(inputPath, input, "utf8");
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  let preparedOutputPath = "";
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("dry deployment must not fetch");
  }) as typeof fetch;

  try {
    await assert.rejects(
      prepareCloudflareConfig(inputPath, undefined, { artifactRoot }),
      /database_id de producción o preview/i,
    );

    const result = await runCloudflareDryRun(
      { inputPath, artifactRoot },
      {
        build: async (_root, environment) => {
          preparedOutputPath = environment.CLOUDFLARE_CONFIG_PATH ?? "";
        },
        readGeneratedConfig: async () =>
          generatedLocalProfile(preparedOutputPath),
        resolveTopology: async () => ({
          deployConfigPath: "/fixture/.wrangler/deploy/config.json",
          wranglerConfigPath: "/fixture/dist/server/wrangler.json",
          entryPath: "/fixture/dist/server/entry.mjs",
        }),
      },
    );

    assert.equal(fetchCalls, 0);
    assert.equal(result.network, false);
    assert.equal(result.deployed, false);
    assert.equal(result.indexable, false);
    assert.equal(await readFile(inputPath, "utf8"), input);
    assert.match(await readFile(result.outputPath, "utf8"), /"database_id"/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("dry deployment builds the prepared profile locally without a deploy or network action", async () => {
  const root = await mkdirTemp();
  const inputPath = join(root, "wrangler.jsonc");
  const artifactRoot = join(root, "artifacts", "config");
  await writeFile(inputPath, localConfig(), "utf8");
  let buildRoot: string | undefined;
  let buildEnvironment: NodeJS.ProcessEnv | undefined;
  const topology = {
    deployConfigPath: "/project/.wrangler/deploy/config.json",
    wranglerConfigPath: "/project/dist/server/wrangler.json",
    entryPath: "/project/dist/server/entry.mjs",
  };

  try {
    const result = await runCloudflareDryRun(
      { inputPath, artifactRoot },
      {
        build: async (requestedRoot, environment) => {
          buildRoot = requestedRoot;
          buildEnvironment = environment;
        },
        readGeneratedConfig: async () =>
          generatedLocalProfile(buildEnvironment?.CLOUDFLARE_CONFIG_PATH ?? ""),
        resolveTopology: async () => topology,
      },
    );

    assert.equal(buildEnvironment?.CLOUDFLARE_CONFIG_PATH, result.outputPath);
    assert.equal(buildEnvironment?.CLOUDFLARE_ENV, undefined);
    assert.equal(buildRoot, process.cwd());
    assert.equal(result.network, false);
    assert.equal(result.deployed, false);
    assert.deepEqual(result.topology, topology);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry deployment rejects generated topology from a different profile, environment, indexability, or D1", async () => {
  const root = await mkdirTemp();
  const inputPath = join(root, "wrangler.jsonc");
  const artifactRoot = join(root, "artifacts", "config");
  await writeFile(inputPath, localConfig(), "utf8");
  const topology = {
    deployConfigPath: "/fixture/.wrangler/deploy/config.json",
    wranglerConfigPath: "/fixture/dist/server/wrangler.json",
    entryPath: "/fixture/dist/server/entry.mjs",
  };
  let preparedOutputPath = "";

  const generatedProfile = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    configPath: preparedOutputPath,
    targetEnvironment: null,
    name: "comunidad-solar-astro-local",
    vars: { SITE_INDEXABLE: "false" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "comunidad-solar-local",
        database_id: localD1Id,
      },
    ],
    ...overrides,
  });

  try {
    for (const [label, generated, expected] of [
      [
        "profile",
        () => generatedProfile({ configPath: "/another/profile.json" }),
        /configPath.*perfil preparado/i,
      ],
      [
        "environment",
        () => generatedProfile({ targetEnvironment: "preview" }),
        /targetEnvironment.*environment preparado/i,
      ],
      [
        "indexability",
        () => generatedProfile({ vars: { SITE_INDEXABLE: "true" } }),
        /SITE_INDEXABLE.*perfil preparado/i,
      ],
      [
        "database",
        () =>
          generatedProfile({
            d1_databases: [
              {
                binding: "DB",
                database_name: "comunidad-solar-other",
                database_id: "11111111-2222-4333-8444-555555555555",
              },
            ],
          }),
        /D1.*perfil preparado/i,
      ],
    ] as const) {
      const dependencies = {
        build: async (_root: string, environment: NodeJS.ProcessEnv) => {
          preparedOutputPath = environment.CLOUDFLARE_CONFIG_PATH ?? "";
        },
        resolveTopology: async () => topology,
        readGeneratedConfig: async () => generated(),
      };
      await assert.rejects(
        runCloudflareDryRun({ inputPath, artifactRoot }, dependencies),
        expected,
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry deployment bounds a hung build and closes its owned process group before rejecting", async () => {
  const child = new HangingBuildChild();
  const signals: Array<{ pid: number; signal: string | number }> = [];
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    await assert.rejects(
      Promise.race([
        buildPreparedProfile(
          "/fixture",
          {},
          {
            processTimeoutMs: 5,
            processKillGraceMs: 5,
            platform: "darwin",
            spawn: () => child,
            killProcess: (pid, signal) => {
              signals.push({ pid, signal: signal ?? 0 });
              if (signal === 0 && child.exitCode !== null) {
                throw Object.assign(new Error("synthetic group exited"), {
                  code: "ESRCH",
                });
              }
              if (signal === "SIGKILL") {
                child.exitCode = 0;
                queueMicrotask(() => child.emit("close", 0));
              }
              return true;
            },
          },
        ),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("test watchdog expired")),
            50,
          );
        }),
      ]),
      /build Cloudflare seca.*5 ms/i,
    );
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }

  assert.equal(child.exitCode, 0);
  assert.deepEqual(
    signals.map(({ pid, signal }) => ({ pid, signal })),
    [
      { pid: -41_901, signal: "SIGTERM" },
      { pid: -41_901, signal: "SIGKILL" },
      { pid: -41_901, signal: 0 },
    ],
  );
});

test("dry deployment keeps a build failure primary when its process-group cleanup also fails", async () => {
  const child = new HangingBuildChild();
  const cleanupFailure = new Error("synthetic process-group cleanup failure");

  await assert.rejects(
    buildPreparedProfile(
      "/fixture",
      {},
      {
        platform: "darwin",
        spawn: () => {
          queueMicrotask(() => {
            child.exitCode = 7;
            child.emit("close", 7);
          });
          return child;
        },
        killProcess: () => {
          throw cleanupFailure;
        },
      },
    ),
    (error: unknown) => {
      assert.match(
        (error as Error).message,
        /build Cloudflare seca falló con código 7/i,
      );
      assert.equal(
        (error as Error & { cause?: unknown }).cause,
        cleanupFailure,
      );
      return true;
    },
  );
});

test(
  "dry deployment removes a POSIX build descendant after the npm leader ignores TERM",
  { skip: process.platform === "win32", timeout: 7_000 },
  async () => {
    const root = await mkdirTemp();
    const bin = join(root, "bin");
    const markerPath = join(root, "descendant-marker");
    const pidPath = join(root, "descendant-pid");
    let descendantPid: number | undefined;
    let cleanupFailure: unknown;
    try {
      await mkdir(bin);
      const descendantProgram = [
        "const { writeFileSync } = require('node:fs');",
        "process.on('SIGTERM', () => undefined);",
        "setTimeout(() => writeFileSync(process.argv[1], 'orphan'), 3_000);",
        "setInterval(() => undefined, 1_000);",
      ].join("\n");
      const npmProgram = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}, process.env.DRY_MARKER], { stdio: "ignore" });
writeFileSync(process.env.DRY_PID, String(child.pid));
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1_000);
`;
      const npmPath = join(bin, "npm");
      await writeFile(npmPath, npmProgram, { mode: 0o755 });
      await chmod(npmPath, 0o755);

      const build = buildPreparedProfile(
        root,
        {
          ...process.env,
          DRY_MARKER: markerPath,
          DRY_PID: pidPath,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        },
        { processKillGraceMs: 250, processTimeoutMs: 1_000 },
      );
      const buildFailure = build.then(
        () => new Error("La build seca debía agotar su deadline"),
        (error: unknown) => error,
      );
      for (let attempt = 0; attempt < 125; attempt += 1) {
        try {
          descendantPid = Number(await readFile(pidPath, "utf8"));
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      assert.equal(typeof descendantPid, "number");
      assert.match(
        String(await buildFailure),
        /build Cloudflare seca superó 1000 ms/i,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_100));
      await assert.rejects(() => readFile(markerPath, "utf8"), {
        code: "ENOENT",
      });
      assert.throws(() => process.kill(descendantPid!, 0), { code: "ESRCH" });
    } finally {
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
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
  },
);

test("the package dry script uses the local validator instead of wrangler deploy", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    scripts?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };

  assert.equal(
    packageJson.scripts?.["deploy:dry"],
    "tsx scripts/deploy-dry.ts",
  );
  assert.equal(
    packageJson.scripts?.["verify:server"],
    "tsx scripts/verify-server.ts",
  );
  assert.equal(
    packageJson.scripts?.["preview:cloudflare"],
    "tsx scripts/prepare-cloudflare-config.ts",
  );
  assert.equal(packageJson.devDependencies?.["jsonc-parser"], "3.3.1");
});

test("the environment template declares every Cloudflare binding without values", async () => {
  const contents = await readFile(
    new URL("../../.env.example", import.meta.url),
    "utf8",
  );
  const entries = contents
    .trim()
    .split("\n")
    .map((line) => line.split("=", 2));

  assert.deepEqual(
    entries.map(([key]) => key),
    [
      "CLOUDFLARE_CONFIG_PATH",
      "CLOUDFLARE_ENV",
      "SOCIOS_ALLOWED_EMAILS",
      "TEAM_ALLOWED_EMAILS",
      "MANGANAFER_ALLOWED_EMAILS",
      "SITE_INDEXABLE",
      "MANGANAFER_QUOTING_BEARER_TOKEN",
      "MANGANAFER_PANEL_MONTHLY_FEE",
      "MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT",
      "MANGANAFER_PANEL_FEE_VAT",
      "MANGANAFER_AVAILABLE_PANELS",
      "MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH",
      "MANGANAFER_DISCOUNT",
      "MANGANAFER_PANEL_POWER_W",
      "MANGANAFER_ANNUAL_DEGRADATION",
      "MANGANAFER_MAXIMUM_PANELS_PER_QUOTE",
    ],
  );
  assert.equal(
    entries.every(([, value]) => value === ""),
    true,
  );
});

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "comunidadsolar-cloudflare-dry-"));
}
