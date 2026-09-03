import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  deployExactVersion,
  runWrangler,
  type UploadInput,
  uploadPreviewVersion,
  type WranglerInvocation,
  type WranglerResult,
  type WranglerRunner,
} from "../../scripts/preview-evidence/cloudflare.ts";
import { createSealedBundle } from "../../scripts/preview-evidence/bundle.ts";
import {
  sha256,
  type EvidenceRole,
} from "../../scripts/preview-evidence/domain.ts";

const candidateSha = `a1b2c3d${"e".repeat(33)}`;
const versionId = "12345678-1234-4abc-8def-123456789abc";
const accountId = "a".repeat(32);
const apiToken = "unit-test-cloudflare-token_1234567890";
const databaseId = "11111111-2222-4333-8444-555555555555";
const workerName = "comunidad-solar-preview";

interface Fixture {
  root: string;
  source: string;
  bundle: string;
  profilePath: string;
  profileSha256: string;
  role: EvidenceRole;
}

function profileConfig(): Record<string, unknown> {
  return {
    assets: {
      binding: "ASSETS",
      directory: "../../dist",
      run_worker_first: true,
    },
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_id: databaseId,
        database_name: workerName,
        migrations_dir: "../../drizzle",
      },
    ],
    main: "../../src/worker.ts",
    name: workerName,
    preview_urls: true,
    vars: { SITE_INDEXABLE: "false" },
    workers_dev: true,
  };
}

function generatedConfig(): Record<string, unknown> {
  return {
    topLevelName: workerName,
    name: workerName,
    main: "entry.mjs",
    no_bundle: true,
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      binding: "ASSETS",
      directory: "../client",
      run_worker_first: true,
    },
    vars: { SITE_INDEXABLE: "false" },
    d1_databases: [
      {
        binding: "DB",
        database_id: databaseId,
        database_name: workerName,
        migrations_dir: "../../drizzle",
      },
    ],
    routes: [],
    triggers: {},
    services: [],
    durable_objects: { bindings: [] },
    kv_namespaces: [{ binding: "SESSION" }],
    images: { binding: "IMAGES" },
    secrets_store_secrets: [],
  };
}

async function fixture(role: EvidenceRole = "candidate"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "preview-cloudflare-"));
  const source = join(root, "source");
  const bundle = join(root, "bundle");
  const profileDirectory = join(source, ".artifacts", "config");
  await mkdir(join(source, "dist", "server"), { recursive: true });
  await mkdir(join(source, "dist", "client"), { recursive: true });
  await mkdir(join(source, "drizzle"));
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(source, "dist", "server", "wrangler.json"),
    JSON.stringify(generatedConfig()),
  );
  await writeFile(
    join(source, "dist", "server", "entry.mjs"),
    "export default { fetch() { return new Response('ok') } };\n",
  );
  await writeFile(join(source, "dist", "client", "index.html"), "ok\n");
  await writeFile(join(source, "drizzle", "0000.sql"), "SELECT 1;\n");
  const profileBytes = `${JSON.stringify(profileConfig())}\n`;
  const profilePath = join(profileDirectory, "preview.json");
  const profileSha256 = sha256(profileBytes);
  await writeFile(profilePath, profileBytes);
  await createSealedBundle({
    sourceRoot: source,
    outputRoot: bundle,
    role,
    sourceSha: candidateSha,
    profilePath,
    profileSha256,
  });
  return { root, source, bundle, profilePath, profileSha256, role };
}

function result(overrides: Partial<WranglerResult> = {}): WranglerResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}

function fakeRunner(
  queued: WranglerResult[],
  calls: WranglerInvocation[],
): WranglerRunner {
  return async (invocation) => {
    calls.push(invocation);
    const next = queued.shift();
    if (next === undefined) throw new Error("Unexpected Wrangler invocation");
    return next;
  };
}

function identity(role: EvidenceRole): { tag: string; message: string } {
  if (role === "release") {
    return { tag: "main-a1b2c3d", message: "main release a1b2c3d" };
  }
  return {
    tag: `pr-4-${role === "base" ? "base" : "head"}-a1b2c3d`,
    message: `PR 4 ${role} a1b2c3d`,
  };
}

function uploadStdout(
  role: EvidenceRole = "candidate",
  overrides: { id?: string; versionUrl?: string; aliasUrl?: string } = {},
): string {
  const { tag } = identity(role);
  const id = overrides.id ?? versionId;
  const versionUrl =
    overrides.versionUrl ??
    `https://${id.slice(0, 8)}-${workerName}.comunidadsolar-dev.workers.dev`;
  const aliasUrl =
    overrides.aliasUrl ??
    `https://${tag}-${workerName}.comunidadsolar-dev.workers.dev`;
  return [
    `Uploaded ${workerName} (1 sec)`,
    `Worker Version ID: ${id}`,
    `Version Preview URL: ${versionUrl}`,
    `Version Preview Alias URL: ${aliasUrl}`,
    "",
  ].join("\n");
}

function listStdout(
  role: EvidenceRole = "candidate",
  overrides: Record<string, unknown> = {},
): string {
  const expected = identity(role);
  return JSON.stringify([
    {
      id: versionId,
      number: 7,
      metadata: {
        author_email: "operator@example.invalid",
        author_id: "b".repeat(32),
        created_on: "2026-09-03T20:00:00.000Z",
        modified_on: "2026-09-03T20:00:00.000Z",
        hasPreview: true,
        source: "wrangler",
      },
      annotations: {
        "workers/alias": expected.tag,
        "workers/message": expected.message,
        "workers/tag": expected.tag,
        "workers/triggered_by": "versions upload",
      },
      ...overrides,
    },
  ]);
}

function uploadInput(value: Fixture): UploadInput {
  return {
    bundleRoot: value.bundle,
    profilePath: value.profilePath,
    profileSha256: value.profileSha256,
    role: value.role,
    sourceSha: candidateSha,
    prNumber: value.role === "release" ? undefined : 4,
    credentials: { accountId, apiToken },
  };
}

test("runs the pinned local Wrangler without inheriting ambient environment", async () => {
  const outcome = await runWrangler({
    argv: ["--version"],
    cwd: process.cwd(),
    environment: {
      CI: "true",
      NO_COLOR: "1",
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: apiToken,
    },
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.outputLimitExceeded, false);
  assert.match(outcome.stdout, /^4\.125\.0\s*$/u);
  assert.equal(`${outcome.stdout}${outcome.stderr}`.includes(apiToken), false);
});

test("uploads with fixed argv and verifies the exact listed version", async () => {
  const value = await fixture();
  const calls: WranglerInvocation[] = [];
  try {
    const descriptor = await uploadPreviewVersion(
      uploadInput(value),
      fakeRunner(
        [result({ stdout: uploadStdout() }), result({ stdout: listStdout() })],
        calls,
      ),
    );
    const config = resolve(value.bundle, "dist", "server", "wrangler.json");
    assert.deepEqual(
      calls.map((call) => call.argv),
      [
        [
          "versions",
          "upload",
          "--config",
          config,
          "--no-bundle",
          "--strict",
          "--tag",
          "pr-4-head-a1b2c3d",
          "--message",
          "PR 4 candidate a1b2c3d",
          "--preview-alias",
          "pr-4-head-a1b2c3d",
        ],
        ["versions", "list", "--json", "--config", config],
      ],
    );
    for (const call of calls) {
      assert.equal(call.cwd, resolve(value.bundle));
      assert.equal(call.timeoutMs, 10 * 60 * 1000);
      assert.equal(call.maxOutputBytes, 1024 * 1024);
      assert.deepEqual(call.environment, {
        CI: "true",
        NO_COLOR: "1",
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: apiToken,
      });
    }
    assert.deepEqual(descriptor, {
      schemaVersion: 1,
      role: "candidate",
      sourceSha: candidateSha,
      bundleSha256: descriptor.bundleSha256,
      workerName,
      versionId,
      tag: "pr-4-head-a1b2c3d",
      alias: "pr-4-head-a1b2c3d",
      url: `https://pr-4-head-a1b2c3d-${workerName}.comunidadsolar-dev.workers.dev/`,
    });
    assert.match(descriptor.bundleSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects failed, timed out and oversized Wrangler runs without leaking credentials", async () => {
  const value = await fixture();
  try {
    const cases: Array<[string, WranglerResult]> = [
      [
        "nonzero",
        result({
          exitCode: 1,
          stderr: `Authorization failed for ${apiToken}`,
        }),
      ],
      ["timeout", result({ exitCode: null, timedOut: true })],
      ["reported output cap", result({ outputLimitExceeded: true })],
      ["defensive output cap", result({ stdout: "x".repeat(1024 * 1024 + 1) })],
    ];
    for (const [label, failed] of cases) {
      const error = await assert.rejects(
        uploadPreviewVersion(uploadInput(value), fakeRunner([failed], [])),
        /Wrangler|Cloudflare|tiempo|límite|output/i,
        label,
      );
      assert.equal(String(error).includes(apiToken), false, label);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects ambiguous IDs and unsafe preview URLs", async () => {
  const value = await fixture();
  try {
    const safeUrl = `https://pr-4-head-a1b2c3d-${workerName}.comunidadsolar-dev.workers.dev`;
    const cases: Array<[string, string]> = [
      [
        "missing alias",
        uploadStdout().replace(/^Version Preview Alias URL:.*\n/mu, ""),
      ],
      [
        "duplicate alias",
        `${uploadStdout()}Version Preview Alias URL: ${safeUrl}\n`,
      ],
      ["duplicate id", `${uploadStdout()}Worker Version ID: ${versionId}\n`],
      ["invalid id", uploadStdout("candidate", { id: "not-a-uuid" })],
      [
        "http",
        uploadStdout("candidate", {
          aliasUrl: safeUrl.replace("https:", "http:"),
        }),
      ],
      [
        "userinfo",
        uploadStdout("candidate", {
          aliasUrl: safeUrl.replace("https://", "https://user:pass@"),
        }),
      ],
      ["port", uploadStdout("candidate", { aliasUrl: `${safeUrl}:8443` })],
      ["query", uploadStdout("candidate", { aliasUrl: `${safeUrl}?unsafe=1` })],
      [
        "fragment",
        uploadStdout("candidate", { aliasUrl: `${safeUrl}#unsafe` }),
      ],
      [
        "foreign host",
        uploadStdout("candidate", { aliasUrl: "https://example.com" }),
      ],
      ["control", uploadStdout().replace(versionId, `\u001b[31m${versionId}`)],
    ];
    for (const [label, stdout] of cases) {
      await assert.rejects(
        uploadPreviewVersion(
          uploadInput(value),
          fakeRunner([result({ stdout })], []),
        ),
        /Cloudflare|UUID|URL|control|salida|ambigua|preview/i,
        label,
      );
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects a list response that does not prove the uploaded identity", async () => {
  const value = await fixture();
  try {
    const expected = identity("candidate");
    const cases: Array<[string, string]> = [
      ["invalid JSON", "not-json"],
      ["not an array", JSON.stringify({})],
      [
        "wrong id",
        listStdout("candidate", { id: "87654321-1234-4abc-8def-123456789abc" }),
      ],
      [
        "wrong tag",
        listStdout("candidate", {
          annotations: {
            "workers/alias": expected.tag,
            "workers/message": expected.message,
            "workers/tag": "other",
          },
        }),
      ],
      [
        "wrong message",
        listStdout("candidate", {
          annotations: {
            "workers/alias": expected.tag,
            "workers/message": "other",
            "workers/tag": expected.tag,
          },
        }),
      ],
      [
        "wrong alias",
        listStdout("candidate", {
          annotations: {
            "workers/alias": "other",
            "workers/message": expected.message,
            "workers/tag": expected.tag,
          },
        }),
      ],
      [
        "duplicate tag",
        JSON.stringify([
          ...JSON.parse(listStdout()),
          ...JSON.parse(listStdout()),
        ]),
      ],
      ["unknown version field", listStdout("candidate", { surprise: true })],
      ["control", listStdout().replace(expected.message, `bad\u001bvalue`)],
    ];
    for (const [label, stdout] of cases) {
      await assert.rejects(
        uploadPreviewVersion(
          uploadInput(value),
          fakeRunner(
            [result({ stdout: uploadStdout() }), result({ stdout })],
            [],
          ),
        ),
        /Cloudflare|JSON|versión|version|tag|message|alias|campo|control/i,
        label,
      );
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("deploys only a sealed release descriptor by exact UUID at 100 percent", async () => {
  const value = await fixture("release");
  const uploadCalls: WranglerInvocation[] = [];
  const deployCalls: WranglerInvocation[] = [];
  try {
    const descriptor = await uploadPreviewVersion(
      uploadInput(value),
      fakeRunner(
        [
          result({ stdout: uploadStdout("release") }),
          result({ stdout: listStdout("release") }),
        ],
        uploadCalls,
      ),
    );
    await deployExactVersion(
      {
        bundleRoot: value.bundle,
        profilePath: value.profilePath,
        profileSha256: value.profileSha256,
        descriptor,
        credentials: { accountId, apiToken },
      },
      fakeRunner([result()], deployCalls),
    );
    assert.deepEqual(
      deployCalls.map((call) => call.argv),
      [
        [
          "versions",
          "deploy",
          `${versionId}@100%`,
          "--yes",
          "--config",
          resolve(value.bundle, "dist", "server", "wrangler.json"),
          "--message",
          "Shared preview release a1b2c3d",
        ],
      ],
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
