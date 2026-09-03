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
  readReleaseCaptureContext,
  writeReleaseCaptureContext,
} from "../../scripts/preview-evidence/capture.ts";
import {
  type GitHubApi,
  writePullRequestContext,
} from "../../scripts/preview-evidence/github.ts";
import { runPreviewEvidenceCli } from "../../scripts/preview-evidence/cli.ts";
import {
  canonicalJson,
  sha256,
} from "../../scripts/preview-evidence/domain.ts";
import { readProductionReleaseContext } from "../../scripts/preview-evidence/release.ts";

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

function mainEventPayload(): Record<string, unknown> {
  return {
    action: "completed",
    repository: { full_name: repository, default_branch: "main" },
    workflow_run: {
      id: 1001,
      html_url: `https://github.com/${repository}/actions/runs/1001`,
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: headSha,
      head_repository: { full_name: repository },
      pull_requests: [],
    },
  };
}

class MainCliGitHubApi implements GitHubApi {
  constructor(private readonly bootstrap = false) {}

  async get(path: string): Promise<unknown> {
    const files = this.bootstrap
      ? [{ filename: ".github/workflows/shared-preview.yml", status: "added" }]
      : [{ filename: requestPath, status: "added" }];
    const values: Record<string, unknown> = {
      [`/repos/${repository}/branches/main`]: {
        name: "main",
        commit: { sha: headSha },
      },
      [`/repos/${repository}/commits/${headSha}/pulls?per_page=100`]: [
        { number: 9 },
      ],
      [`/repos/${repository}/pulls/9`]: {
        number: 9,
        state: "closed",
        merged: true,
        merged_at: "2026-09-03T20:00:00Z",
        merge_commit_sha: headSha,
        changed_files: files.length,
        html_url: `https://github.com/${repository}/pull/9`,
        body: "Resuelve #4",
        base: { ref: "main", sha: baseSha },
        head: {
          ref: "feature/issue-4",
          sha: "c".repeat(40),
          repo: { full_name: repository },
        },
      },
      [`/repos/${repository}/pulls/9/files?per_page=100&page=1`]: files,
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
    if (!Object.hasOwn(values, path)) {
      throw new Error(`Unexpected main API path: ${path}`);
    }
    return structuredClone(values[path]);
  }

  async post(): Promise<unknown> {
    throw new Error("Unexpected POST");
  }

  async patch(): Promise<unknown> {
    throw new Error("Unexpected PATCH");
  }
}

class ProductionCliGitHubApi implements GitHubApi {
  readonly candidateSha = "c".repeat(40);

  async get(path: string): Promise<unknown> {
    const previewOrigin =
      "https://comunidad-solar-preview.comunidadsolar-dev.workers.dev";
    const versionId = "33333333-3333-4333-8333-333333333333";
    const capture = (viewport: "desktop" | "mobile", width: number) => ({
      role: "release",
      kind: "page",
      sourceSha: headSha,
      versionId,
      origin: previewOrigin,
      url: `${previewOrigin}/pruebas/guia/`,
      route: "/pruebas/guia/",
      status: 200,
      viewport: {
        name: viewport,
        width,
        height: viewport === "desktop" ? 1000 : 844,
        deviceScaleFactor: 1,
      },
      selector: null,
      filename: `release-${viewport}.png`,
      bytes: 1234,
      width,
      height: 900,
      sha256: viewport === "desktop" ? "d".repeat(64) : "e".repeat(64),
      pageErrors: 0,
      sameOriginFailures: 0,
      crossOriginFailures: {},
    });
    const manifest = {
      schemaVersion: 1,
      kind: "release",
      issue: 4,
      prNumber: 9,
      requestPath,
      route: "/pruebas/guia/",
      selector: null,
      source: { baseSha: null, candidateSha: null, releaseSha: headSha },
      capturedAt: "2026-09-04T00:00:00.000Z",
      run: {
        id: 1001,
        url: `https://github.com/${repository}/actions/runs/1001`,
        attempt: 1,
      },
      tools: {
        node: "22.22.3",
        playwright: "1.62.1",
        browser: "Chromium 140.0.0.0",
      },
      captures: [capture("desktop", 1440), capture("mobile", 390)],
    };
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
    const values: Record<string, unknown> = {
      [`/repos/${repository}/compare/${headSha}...main`]: {
        status: "ahead",
        merge_base_commit: { sha: headSha },
      },
      [`/repos/${repository}/commits/${headSha}/pulls?per_page=100`]: [
        { number: 9 },
      ],
      [`/repos/${repository}/pulls/9`]: {
        number: 9,
        state: "closed",
        merged: true,
        merged_at: "2026-09-03T20:00:00Z",
        merge_commit_sha: headSha,
        changed_files: 1,
        html_url: `https://github.com/${repository}/pull/9`,
        base: { ref: "main" },
        head: {
          sha: this.candidateSha,
          repo: { full_name: repository },
        },
      },
      [`/repos/${repository}/pulls/9/files?per_page=100&page=1`]: [
        { filename: requestPath, status: "added" },
      ],
      [`/repos/${repository}/contents/issue-4/releases/${headSha}/manifest.json?ref=evidence`]:
        {
          type: "file",
          path: `issue-4/releases/${headSha}/manifest.json`,
          encoding: "base64",
          size: manifestBytes.length,
          sha: "f".repeat(40),
          content: manifestBytes.toString("base64"),
        },
      [`/repos/${repository}/commits/${this.candidateSha}/status?per_page=100`]:
        {
          sha: this.candidateSha,
          statuses: [
            {
              context: "preview-approved",
              state: "success",
              target_url: `https://github.com/${repository}/actions/runs/999`,
            },
          ],
        },
    };
    if (!Object.hasOwn(values, path)) {
      throw new Error(`Unexpected production API path: ${path}`);
    }
    return structuredClone(values[path]);
  }

  async post(): Promise<unknown> {
    throw new Error("Unexpected POST");
  }

  async patch(): Promise<unknown> {
    throw new Error("Unexpected PATCH");
  }
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

test("resolve-main seals a release context or emits a non-deployable bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-main-"));
  try {
    const event = join(root, "event.json");
    const output = join(root, "github-output");
    const context = join(root, "context.json");
    await writeFile(event, JSON.stringify(mainEventPayload()), "utf8");
    await writeFile(output, "", "utf8");

    await runPreviewEvidenceCli(
      [
        "resolve-main",
        "--event",
        event,
        "--output",
        output,
        "--context",
        context,
      ],
      { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: repository },
      { createApi: () => new MainCliGitHubApi(), stdout: () => undefined },
    );

    const outputs = await readFile(output, "utf8");
    const digest = /context_sha256<<[^\n]+\n([a-f0-9]{64})\n/u.exec(
      outputs,
    )?.[1];
    assert.equal(typeof digest, "string");
    const stored = await readReleaseCaptureContext(context, digest as string);
    assert.equal(stored.sourceSha, headSha);
    assert.equal(stored.prNumber, 9);
    assert.match(outputs, /bootstrap<<[^\n]+\nfalse\n/u);
    assert.match(
      outputs,
      new RegExp(`source_sha<<[^\\n]+\\n${headSha}\\n`, "u"),
    );
    await runPreviewEvidenceCli(
      ["recheck-main", "--context", context, "--context-sha", digest as string],
      { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: repository },
      { createApi: () => new MainCliGitHubApi(), stdout: () => undefined },
    );

    const bootstrapOutput = join(root, "bootstrap-output");
    const bootstrapContext = join(root, "bootstrap-context.json");
    await writeFile(bootstrapOutput, "", "utf8");
    await runPreviewEvidenceCli(
      [
        "resolve-main",
        "--event",
        event,
        "--output",
        bootstrapOutput,
        "--context",
        bootstrapContext,
      ],
      {
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: repository,
        PREVIEW_PIPELINE_BOOTSTRAP_PR: "9",
      },
      {
        createApi: () => new MainCliGitHubApi(true),
        stdout: () => undefined,
      },
    );
    const bootstrap = await readFile(bootstrapOutput, "utf8");
    assert.match(bootstrap, /bootstrap<<[^\n]+\ntrue\n/u);
    await assert.rejects(readFile(bootstrapContext), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authorize-production fails closed, seals context and can reauthorize it", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-cli-authorize-"));
  try {
    const output = join(root, "github-output");
    const context = join(root, "context.json");
    await writeFile(output, "", "utf8");
    let apiCreated = false;
    await assert.rejects(
      runPreviewEvidenceCli(
        [
          "authorize-production",
          "--sha",
          headSha,
          "--output",
          output,
          "--context",
          context,
        ],
        { PRODUCTION_ENABLED: "false" },
        {
          createApi: () => {
            apiCreated = true;
            return new ProductionCliGitHubApi();
          },
        },
      ),
      /PRODUCTION_ENABLED|producci[oó]n/i,
    );
    assert.equal(apiCreated, false);

    const environment = {
      PRODUCTION_ENABLED: "true",
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: "2001",
      GITHUB_TOKEN: "test-token",
    };
    await runPreviewEvidenceCli(
      [
        "authorize-production",
        "--sha",
        headSha,
        "--output",
        output,
        "--context",
        context,
      ],
      environment,
      {
        createApi: () => new ProductionCliGitHubApi(),
        stdout: () => undefined,
      },
    );
    const outputs = await readFile(output, "utf8");
    const digest = /context_sha256<<[^\n]+\n([a-f0-9]{64})\n/u.exec(
      outputs,
    )?.[1];
    assert.equal(typeof digest, "string");
    const stored = await readProductionReleaseContext(
      context,
      digest as string,
    );
    assert.equal(stored.sourceSha, headSha);
    assert.equal(stored.issueNumber, 4);
    assert.match(outputs, /issue_number<<[^\n]+\n4\n/u);

    await runPreviewEvidenceCli(
      [
        "reauthorize-production",
        "--context",
        context,
        "--context-sha",
        digest as string,
      ],
      environment,
      {
        createApi: () => new ProductionCliGitHubApi(),
        stdout: () => undefined,
      },
    );
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

test("upload-version derives a release identity only from the sealed main context", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-upload-release-"));
  try {
    const value = await sealedCliFixture(root, "release");
    const contextPath = join(root, "main-context.json");
    const outputPath = join(root, "release-descriptor.json");
    const sealedContext = await writeReleaseCaptureContext(contextPath, {
      schemaVersion: 1,
      repository,
      issueNumber: 4,
      issueUrl: `https://github.com/${repository}/issues/4`,
      prNumber: 9,
      prUrl: `https://github.com/${repository}/pull/9`,
      runId: 1001,
      runUrl: `https://github.com/${repository}/actions/runs/1001`,
      sourceSha: headSha,
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
    const tag = "main-bbbbbbb";
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
        "release",
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
                  number: 2,
                  metadata: {
                    created_on: "2026-09-03T20:00:00.000Z",
                    hasPreview: true,
                    source: "wrangler",
                  },
                  annotations: {
                    "workers/alias": tag,
                    "workers/message": "main release bbbbbbb",
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
    assert.equal(descriptor.role, "release");
    assert.equal(descriptor.sourceSha, headSha);
    assert.equal(descriptor.tag, tag);
    assert.equal(descriptor.url, `${url}/`);
    assert.equal(calls[0].argv.includes("pr-9"), false);
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
