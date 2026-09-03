import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type WranglerInvocation,
  type WranglerResult,
  type WranglerRunner,
} from "../../scripts/preview-evidence/cloudflare.ts";
import { createSealedBundle } from "../../scripts/preview-evidence/bundle.ts";
import {
  type GitHubApi,
  writePullRequestContext,
} from "../../scripts/preview-evidence/github.ts";
import { runPreviewEvidenceCli } from "../../scripts/preview-evidence/cli.ts";
import { sha256 } from "../../scripts/preview-evidence/domain.ts";

const repository = "vbenhur-cs/webComunidadSolar";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const requestPath = "evidence/requests/issue-4.yaml";
const requestYaml = `schema_version: 1
issue: 4
scope: page
route: /pruebas/guia/
expected_status:
  base: 404
  candidate: 200
viewports: [desktop, mobile]
`;

const cloudflareVersionId = "12345678-1234-4abc-8def-123456789abc";
const cloudflareAccountId = "a".repeat(32);
const cloudflareToken = "unit-test-cloudflare-token_1234567890";

function wranglerResult(
  overrides: Partial<WranglerResult> = {},
): WranglerResult {
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

function queuedWrangler(
  results: WranglerResult[],
  calls: WranglerInvocation[],
): WranglerRunner {
  return async (invocation) => {
    calls.push(invocation);
    const result = results.shift();
    if (result === undefined) throw new Error("Unexpected Wrangler call");
    return result;
  };
}

async function sealedCliFixture(
  root: string,
  role: "candidate" | "release",
): Promise<{
  bundle: string;
  profilePath: string;
  profileSha256: string;
  bundleSha256: string;
}> {
  const source = join(root, `source-${role}`);
  const bundle = join(root, `bundle-${role}`);
  const profileDirectory = join(source, ".artifacts", "config");
  const databaseId = "11111111-2222-4333-8444-555555555555";
  await mkdir(join(source, "dist", "server"), { recursive: true });
  await mkdir(join(source, "dist", "client"), { recursive: true });
  await mkdir(join(source, "drizzle"));
  await mkdir(profileDirectory, { recursive: true });
  const profile = `${JSON.stringify({
    name: "comunidad-solar-preview",
    main: "../../src/worker.ts",
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: true,
    assets: {
      binding: "ASSETS",
      directory: "../../dist",
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "comunidad-solar-preview",
        database_id: databaseId,
        migrations_dir: "../../drizzle",
      },
    ],
    vars: { SITE_INDEXABLE: "false" },
  })}\n`;
  const profilePath = join(profileDirectory, "preview.json");
  const profileSha256 = sha256(profile);
  await writeFile(profilePath, profile);
  await writeFile(
    join(source, "dist", "server", "wrangler.json"),
    JSON.stringify({
      topLevelName: "comunidad-solar-preview",
      name: "comunidad-solar-preview",
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
          database_name: "comunidad-solar-preview",
          database_id: databaseId,
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
    }),
  );
  await writeFile(
    join(source, "dist", "server", "entry.mjs"),
    "export default {};\n",
  );
  await writeFile(join(source, "dist", "client", "index.html"), "ok\n");
  await writeFile(join(source, "drizzle", "0000.sql"), "SELECT 1;\n");
  const manifest = await createSealedBundle({
    sourceRoot: source,
    outputRoot: bundle,
    role,
    sourceSha: headSha,
    profilePath,
    profileSha256,
  });
  return {
    bundle,
    profilePath,
    profileSha256,
    bundleSha256: manifest.bundleSha256,
  };
}

class CliGitHubApi implements GitHubApi {
  async get(path: string): Promise<unknown> {
    const values: Record<string, unknown> = {
      [`/repos/${repository}/pulls/4`]: {
        number: 4,
        state: "open",
        changed_files: 1,
        html_url: `https://github.com/${repository}/pull/4`,
        body: "Resuelve #4",
        base: { ref: "main", sha: baseSha },
        head: {
          ref: "feature/issue-4",
          sha: headSha,
          repo: { full_name: repository },
        },
      },
      [`/repos/${repository}/pulls/4/files?per_page=100&page=1`]: [
        { filename: requestPath, status: "added" },
      ],
      [`/repos/${repository}/contents/evidence/requests/issue-4.yaml?ref=${headSha}`]:
        {
          type: "file",
          path: requestPath,
          encoding: "base64",
          size: Buffer.byteLength(requestYaml),
          content: Buffer.from(requestYaml).toString("base64"),
        },
      [`/repos/${repository}/issues/4`]: {
        number: 4,
        state: "open",
        html_url: `https://github.com/${repository}/issues/4`,
      },
    };
    if (!Object.hasOwn(values, path)) throw new Error("Unexpected API path");
    return structuredClone(values[path]);
  }

  async post(): Promise<unknown> {
    throw new Error("Unexpected POST");
  }

  async patch(): Promise<unknown> {
    throw new Error("Unexpected PATCH");
  }
}

function eventPayload(): Record<string, unknown> {
  return {
    action: "completed",
    repository: { full_name: repository, default_branch: "main" },
    workflow_run: {
      id: 987,
      html_url: `https://github.com/${repository}/actions/runs/987`,
      conclusion: "success",
      event: "pull_request",
      head_branch: "feature/issue-4",
      head_sha: headSha,
      head_repository: { full_name: repository },
      pull_requests: [{ number: 4 }],
    },
  };
}

test("resolve-pr writes a sealed context and safe GitHub outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-"));
  try {
    const event = join(root, "event.json");
    const output = join(root, "github-output");
    const context = join(root, "context.json");
    await writeFile(event, JSON.stringify(eventPayload()), "utf8");
    await writeFile(output, "", "utf8");

    await runPreviewEvidenceCli(
      [
        "resolve-pr",
        "--event",
        event,
        "--output",
        output,
        "--context",
        context,
      ],
      { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: repository },
      { createApi: () => new CliGitHubApi(), stdout: () => undefined },
    );

    const stored = JSON.parse(await readFile(context, "utf8"));
    const outputs = await readFile(output, "utf8");
    assert.equal(stored.headSha, headSha);
    assert.equal(stored.request.route, "/pruebas/guia/");
    assert.match(outputs, /pr_number<<[^\n]+\n4\n/u);
    assert.match(outputs, new RegExp(`head_sha<<[^\\n]+\\n${headSha}\\n`, "u"));
    assert.match(outputs, /context_sha256<<[^\n]+\n[a-f0-9]{64}\n/u);
    assert.equal(outputs.includes("test-token"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown command before reading environment values", async () => {
  const secret = "secret-must-not-escape";
  await assert.rejects(
    runPreviewEvidenceCli(["unknown"], { GITHUB_TOKEN: secret }),
    (error: unknown) => {
      assert.equal(String(error).includes(secret), false);
      return /comando|uso/i.test(String(error));
    },
  );
});

test("validate-request checks the real file without GitHub credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-request-"));
  try {
    const requestDirectory = join(root, "evidence", "requests");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(requestDirectory, { recursive: true });
    await writeFile(
      join(requestDirectory, "issue-4.yaml"),
      requestYaml,
      "utf8",
    );
    const messages: string[] = [];

    await runPreviewEvidenceCli(
      [
        "validate-request",
        "--path",
        "evidence/requests/issue-4.yaml",
        "--root",
        root,
      ],
      {},
      { stdout: (message) => messages.push(message) },
    );

    assert.deepEqual(messages, [
      "EVIDENCE_REQUEST_OK issue=4 route=/pruebas/guia/\n",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seal-bundle and verify-bundle operate on the same exact identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-bundle-"));
  try {
    const source = join(root, "source");
    const output = join(root, "bundle");
    const profileDirectory = join(source, ".artifacts", "config");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(source, "dist", "server"), { recursive: true });
    await mkdir(join(source, "dist", "client"), { recursive: true });
    await mkdir(join(source, "drizzle"));
    await mkdir(profileDirectory, { recursive: true });
    const databaseId = "11111111-2222-4333-8444-555555555555";
    const profile = `${JSON.stringify({
      name: "comunidad-solar-preview",
      main: "../../src/worker.ts",
      compatibility_date: "2026-08-21",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: true,
      preview_urls: true,
      assets: {
        binding: "ASSETS",
        directory: "../../dist",
        run_worker_first: true,
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "comunidad-solar-preview",
          database_id: databaseId,
          migrations_dir: "../../drizzle",
        },
      ],
      vars: { SITE_INDEXABLE: "false" },
    })}\n`;
    const profilePath = join(profileDirectory, "preview.json");
    await writeFile(profilePath, profile);
    await writeFile(
      join(source, "dist", "server", "wrangler.json"),
      JSON.stringify({
        topLevelName: "comunidad-solar-preview",
        name: "comunidad-solar-preview",
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
            database_name: "comunidad-solar-preview",
            database_id: databaseId,
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
      }),
    );
    await writeFile(
      join(source, "dist", "server", "entry.mjs"),
      "export default {};\n",
    );
    await writeFile(join(source, "dist", "client", "index.html"), "ok\n");
    await writeFile(join(source, "drizzle", "0000.sql"), "SELECT 1;\n");
    const messages: string[] = [];

    const shared = [
      "--role",
      "candidate",
      "--sha",
      headSha,
      "--profile",
      profilePath,
      "--profile-sha",
      sha256(profile),
    ];
    await runPreviewEvidenceCli(
      ["seal-bundle", "--source", source, "--output", output, ...shared],
      {},
      { stdout: (message) => messages.push(message) },
    );
    await runPreviewEvidenceCli(
      ["verify-bundle", "--root", output, ...shared],
      {},
      { stdout: (message) => messages.push(message) },
    );

    assert.equal(
      messages.every((message) =>
        /BUNDLE_(?:SEALED|VERIFIED)_OK/u.test(message),
      ),
      true,
    );
    assert.equal(
      typeof JSON.parse(
        await readFile(
          join(output, ".preview-evidence", "bundle-manifest.json"),
          "utf8",
        ),
      ).bundleSha256,
      "string",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload-version validates sealed context before reading credentials and writes a descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-upload-"));
  try {
    const value = await sealedCliFixture(root, "candidate");
    const contextPath = join(root, "context.json");
    const outputPath = join(root, "candidate-descriptor.json");
    const sealedContext = await writePullRequestContext(contextPath, {
      repository,
      runId: 987,
      runUrl: `https://github.com/${repository}/actions/runs/987`,
      prNumber: 4,
      prUrl: `https://github.com/${repository}/pull/4`,
      issueNumber: 4,
      issueUrl: `https://github.com/${repository}/issues/4`,
      baseSha,
      headSha,
      requestPath,
      request: {
        schemaVersion: 1,
        issue: 4,
        scope: "page",
        route: "/pruebas/guia/",
        selector: null,
        expectedStatus: { base: 404, candidate: 200 },
        viewports: ["desktop", "mobile"],
      },
    });
    let credentialReads = 0;
    const unreadableEnvironment = new Proxy<Record<string, string>>(
      {},
      {
        get() {
          credentialReads += 1;
          return "must-not-be-read";
        },
      },
    );
    await assert.rejects(
      runPreviewEvidenceCli(
        [
          "upload-version",
          "--bundle",
          join(root, "missing-bundle"),
          "--profile",
          value.profilePath,
          "--profile-sha",
          value.profileSha256,
          "--context",
          contextPath,
          "--context-sha",
          sealedContext.sha256,
          "--role",
          "candidate",
          "--output",
          outputPath,
        ],
        unreadableEnvironment,
      ),
      /bundle|ENOENT|directorio/i,
    );
    assert.equal(credentialReads, 0);

    const tag = "pr-4-head-bbbbbbb";
    const message = "PR 4 candidate bbbbbbb";
    const url = `https://${tag}-comunidad-solar-preview.comunidadsolar-dev.workers.dev`;
    const calls: WranglerInvocation[] = [];
    await runPreviewEvidenceCli(
      [
        "upload-version",
        "--bundle",
        value.bundle,
        "--profile",
        value.profilePath,
        "--profile-sha",
        value.profileSha256,
        "--context",
        contextPath,
        "--context-sha",
        sealedContext.sha256,
        "--role",
        "candidate",
        "--output",
        outputPath,
      ],
      {
        CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
        CLOUDFLARE_API_TOKEN: cloudflareToken,
      },
      {
        wranglerRunner: queuedWrangler(
          [
            wranglerResult({
              stdout: [
                `Worker Version ID: ${cloudflareVersionId}`,
                `Version Preview URL: https://${cloudflareVersionId.slice(0, 8)}-comunidad-solar-preview.comunidadsolar-dev.workers.dev`,
                `Version Preview Alias URL: ${url}`,
                "",
              ].join("\n"),
            }),
            wranglerResult({
              stdout: JSON.stringify([
                {
                  id: cloudflareVersionId,
                  number: 1,
                  metadata: {
                    created_on: "2026-09-03T20:00:00.000Z",
                    hasPreview: true,
                    source: "wrangler",
                  },
                  annotations: {
                    "workers/alias": tag,
                    "workers/message": message,
                    "workers/tag": tag,
                  },
                },
              ]),
            }),
          ],
          calls,
        ),
        stdout: () => undefined,
      },
    );

    const descriptor = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(descriptor.role, "candidate");
    assert.equal(descriptor.sourceSha, headSha);
    assert.equal(descriptor.versionId, cloudflareVersionId);
    assert.equal(descriptor.url, `${url}/`);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy-version activates only the exact sealed release descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-deploy-"));
  try {
    const value = await sealedCliFixture(root, "release");
    const descriptorPath = join(root, "release-descriptor.json");
    await writeFile(
      descriptorPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "release",
        sourceSha: headSha,
        bundleSha256: value.bundleSha256,
        workerName: "comunidad-solar-preview",
        versionId: cloudflareVersionId,
        tag: "main-bbbbbbb",
        alias: "main-bbbbbbb",
        url: "https://main-bbbbbbb-comunidad-solar-preview.comunidadsolar-dev.workers.dev/",
      }),
    );
    const calls: WranglerInvocation[] = [];
    await runPreviewEvidenceCli(
      [
        "deploy-version",
        "--bundle",
        value.bundle,
        "--profile",
        value.profilePath,
        "--profile-sha",
        value.profileSha256,
        "--descriptor",
        descriptorPath,
      ],
      {
        CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
        CLOUDFLARE_API_TOKEN: cloudflareToken,
      },
      {
        wranglerRunner: queuedWrangler([wranglerResult()], calls),
        stdout: () => undefined,
      },
    );
    assert.deepEqual(
      calls.map((call) => call.argv.slice(0, 3)),
      [["versions", "deploy", `${cloudflareVersionId}@100%`]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
