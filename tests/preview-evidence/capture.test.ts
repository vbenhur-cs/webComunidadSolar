import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DETERMINISTIC_INIT_SCRIPT,
  capturePullRequestEvidence,
  captureReleaseEvidence,
  stableCaptureProjection,
  writeReleaseCaptureContext,
  type BrowserAdapter,
  type BrowserCaptureRequest,
  type BrowserCaptureResult,
  type CaptureLimits,
} from "../../scripts/preview-evidence/capture.ts";
import {
  type CloudflareVersionDescriptor,
  writeCloudflareVersionDescriptor,
} from "../../scripts/preview-evidence/cloudflare.ts";
import { runPreviewEvidenceCli } from "../../scripts/preview-evidence/cli.ts";
import {
  type PullRequestRunContext,
  writePullRequestContext,
} from "../../scripts/preview-evidence/github.ts";

interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

interface PngConstructor {
  new (options: { width: number; height: number }): PngImage;
  sync: { write(image: PngImage): Buffer };
}

const PNG = (createRequire(import.meta.url)("pngjs") as { PNG: PngConstructor })
  .PNG;
const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const releaseSha = "c".repeat(40);
const bundleSha = "d".repeat(64);
const repository = "vbenhur-cs/webComunidadSolar";
const runUrl = `https://github.com/${repository}/actions/runs/987`;

test("ships a self-contained browser init script", () => {
  assert.doesNotMatch(DETERMINISTIC_INIT_SCRIPT, /__name/u);
  assert.doesNotThrow(() => new Function(DETERMINISTIC_INIT_SCRIPT));
  assert.match(DETERMINISTIC_INIT_SCRIPT, /preview-evidence-motion/u);
  assert.match(DETERMINISTIC_INIT_SCRIPT, /cookie-consent/u);
});

function createPng(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  image.data = Buffer.alloc(width * height * 4, 255);
  return PNG.sync.write(image);
}

function descriptor(
  role: "base" | "candidate" | "release",
): CloudflareVersionDescriptor {
  const sourceSha =
    role === "base"
      ? baseSha
      : role === "candidate"
        ? candidateSha
        : releaseSha;
  const shortSha = sourceSha.slice(0, 7);
  const tag =
    role === "release"
      ? `main-${shortSha}`
      : `pr-4-${role === "base" ? "base" : "head"}-${shortSha}`;
  const versionId =
    role === "base"
      ? "11111111-1111-4111-8111-111111111111"
      : role === "candidate"
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333";
  return {
    schemaVersion: 1,
    role,
    sourceSha,
    bundleSha256: bundleSha,
    workerName: "comunidad-solar-preview",
    versionId,
    tag,
    alias: tag,
    url: `https://${tag}-comunidad-solar-preview.comunidadsolar-dev.workers.dev/`,
  };
}

function context(scope: "page" | "section" = "page"): PullRequestRunContext {
  return {
    repository,
    runId: 987,
    runUrl,
    prNumber: 4,
    prUrl: `https://github.com/${repository}/pull/4`,
    issueNumber: 4,
    issueUrl: `https://github.com/${repository}/issues/4`,
    baseSha,
    headSha: candidateSha,
    requestPath: "evidence/requests/issue-4.yaml",
    request: {
      schemaVersion: 1,
      issue: 4,
      scope,
      route: "/pruebas/guia/",
      selector: scope === "section" ? "[data-evidence-id='hero']" : null,
      expectedStatus: { base: 404, candidate: 200 },
      viewports: ["desktop", "mobile"],
    },
  };
}

type CaptureTransform = (
  result: BrowserCaptureResult,
  request: BrowserCaptureRequest,
  index: number,
) => BrowserCaptureResult;

class FakeBrowserAdapter implements BrowserAdapter {
  readonly requests: BrowserCaptureRequest[] = [];
  readonly toolVersions = {
    browser: "Chromium 140.0.0.0",
    playwright: "1.62.1",
  };
  closed = false;

  constructor(private readonly transform?: CaptureTransform) {}

  async capture(request: BrowserCaptureRequest): Promise<BrowserCaptureResult> {
    this.requests.push(structuredClone(request));
    const result: BrowserCaptureResult = {
      status: request.expectedStatus,
      finalUrl: request.url,
      documentVisible: true,
      pagePng: createPng(request.viewport.width, 4),
      section:
        request.selector === null
          ? null
          : {
              count: 1,
              visible: true,
              width: 120,
              height: 30,
              png: createPng(120, 30),
            },
      pageErrors: [],
      failedRequests: [
        { url: "https://cdn.example.invalid/optional-font.woff2" },
      ],
    };
    return (
      this.transform?.(result, request, this.requests.length - 1) ?? result
    );
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

test("captures page evidence in canonical base/candidate and desktop/mobile order", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-capture-page-"));
  const output = join(root, "capture");
  const browser = new FakeBrowserAdapter();
  try {
    const set = await capturePullRequestEvidence(
      {
        context: context(),
        base: descriptor("base"),
        candidate: descriptor("candidate"),
        outputRoot: output,
        runAttempt: 2,
      },
      browser,
    );
    assert.deepEqual(
      browser.requests.map((request) => [
        request.role,
        request.viewport.name,
        request.expectedStatus,
        request.selector,
      ]),
      [
        ["base", "desktop", 404, null],
        ["base", "mobile", 404, null],
        ["candidate", "desktop", 200, null],
        ["candidate", "mobile", 200, null],
      ],
    );
    assert.deepEqual(
      set.manifest.captures.map((capture) => capture.filename),
      [
        "before-desktop.png",
        "before-mobile.png",
        "after-desktop.png",
        "after-mobile.png",
      ],
    );
    assert.equal(browser.closed, true);
    assert.equal(set.manifest.kind, "pull-request");
    assert.equal(set.manifest.issue, 4);
    assert.equal(set.manifest.prNumber, 4);
    assert.equal(set.manifest.run.id, 987);
    assert.equal(set.manifest.run.url, runUrl);
    assert.equal(set.manifest.run.attempt, 2);
    assert.deepEqual(set.manifest.tools, {
      node: process.versions.node,
      playwright: "1.62.1",
      browser: "Chromium 140.0.0.0",
    });
    assert.match(set.manifest.capturedAt, /^\d{4}-\d{2}-\d{2}T/u);
    for (const capture of set.manifest.captures) {
      assert.match(capture.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(
        capture.crossOriginFailures["https://cdn.example.invalid"],
        1,
      );
      assert.equal(capture.sameOriginFailures, 0);
      assert.equal(capture.pageErrors, 0);
      assert.equal((await stat(join(output, capture.filename))).isFile(), true);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
      set.manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adds one canonical section PNG for every variant and viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-capture-section-"));
  const output = join(root, "capture");
  const browser = new FakeBrowserAdapter();
  try {
    const set = await capturePullRequestEvidence(
      {
        context: context("section"),
        base: descriptor("base"),
        candidate: descriptor("candidate"),
        outputRoot: output,
      },
      browser,
    );
    assert.deepEqual(
      set.manifest.captures.map((capture) => capture.filename),
      [
        "before-desktop.png",
        "before-section-desktop.png",
        "before-mobile.png",
        "before-section-mobile.png",
        "after-desktop.png",
        "after-section-desktop.png",
        "after-mobile.png",
        "after-section-mobile.png",
      ],
    );
    assert.equal(
      set.manifest.captures.filter((capture) => capture.kind === "section")
        .length,
      4,
    );
    assert.equal(
      set.manifest.captures.every(
        (capture) =>
          capture.selector === "[data-evidence-id='hero']" &&
          capture.route === "/pruebas/guia/",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captures a release using release names and candidate status", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-capture-release-"));
  const output = join(root, "capture");
  const browser = new FakeBrowserAdapter();
  try {
    const set = await captureReleaseEvidence(
      {
        context: {
          schemaVersion: 1,
          repository,
          issueNumber: 4,
          issueUrl: `https://github.com/${repository}/issues/4`,
          prNumber: 4,
          prUrl: `https://github.com/${repository}/pull/4`,
          runId: 1001,
          runUrl: `https://github.com/${repository}/actions/runs/1001`,
          sourceSha: releaseSha,
          requestPath: "evidence/requests/issue-4.yaml",
          request: context("section").request,
        },
        runAttempt: 1,
        release: descriptor("release"),
        outputRoot: output,
      },
      browser,
    );
    assert.deepEqual(
      browser.requests.map((request) => [request.role, request.expectedStatus]),
      [
        ["release", 200],
        ["release", 200],
      ],
    );
    assert.deepEqual(
      set.manifest.captures.map((capture) => capture.filename),
      [
        "release-desktop.png",
        "release-section-desktop.png",
        "release-mobile.png",
        "release-section-mobile.png",
      ],
    );
    assert.equal(set.manifest.kind, "release");
    assert.equal(set.manifest.source.releaseSha, releaseSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects operational, network, selector and PNG failures before writing", async () => {
  const cases: Array<
    [
      string,
      "page" | "section",
      CaptureTransform,
      RegExp,
      { limits?: CaptureLimits },
    ]
  > = [
    [
      "page error",
      "page",
      (result) => ({ ...result, pageErrors: ["ReferenceError"] }),
      /page|error/i,
      {},
    ],
    [
      "same-origin request",
      "page",
      (result, request) => ({
        ...result,
        failedRequests: [{ url: `${new URL(request.url).origin}/asset.js` }],
      }),
      /mismo origen|same.origin|request/i,
      {},
    ],
    [
      "wrong status",
      "page",
      (result) => ({ ...result, status: 500 }),
      /status|HTTP/i,
      {},
    ],
    [
      "foreign final URL",
      "page",
      (result) => ({ ...result, finalUrl: "https://example.com/" }),
      /URL|origen|origin/i,
      {},
    ],
    [
      "hidden document",
      "page",
      (result) => ({ ...result, documentVisible: false }),
      /documento|visible/i,
      {},
    ],
    [
      "selector missing",
      "section",
      (result) => ({
        ...result,
        section: {
          ...(result.section as NonNullable<typeof result.section>),
          count: 0,
        },
      }),
      /selector|elemento/i,
      {},
    ],
    [
      "selector hidden",
      "section",
      (result) => ({
        ...result,
        section: {
          ...(result.section as NonNullable<typeof result.section>),
          visible: false,
        },
      }),
      /selector|visible/i,
      {},
    ],
    [
      "selector oversized",
      "section",
      (result, request) => ({
        ...result,
        section: {
          ...(result.section as NonNullable<typeof result.section>),
          width: request.viewport.width + 1,
          png: createPng(request.viewport.width + 1, 1),
        },
      }),
      /selector|ancho|width|dimensi/i,
      {},
    ],
    [
      "invalid PNG",
      "page",
      (result) => ({ ...result, pagePng: Buffer.from("not-png") }),
      /PNG/i,
      {},
    ],
    [
      "truncated PNG",
      "page",
      (result) => ({ ...result, pagePng: result.pagePng.subarray(0, 20) }),
      /PNG|truncad/i,
      {},
    ],
    [
      "width mismatch",
      "page",
      (result, request) => ({
        ...result,
        pagePng: createPng(request.viewport.width - 1, 4),
      }),
      /ancho|width|viewport|dimensi/i,
      {},
    ],
    [
      "height limit",
      "page",
      (result) => {
        const changed = Buffer.from(result.pagePng);
        changed.writeUInt32BE(30_001, 20);
        return { ...result, pagePng: changed };
      },
      /alto|height|30.000|dimensi/i,
      {},
    ],
    [
      "file limit",
      "page",
      (result) => ({
        ...result,
        pagePng: Buffer.alloc(8 * 1024 * 1024 + 1),
      }),
      /8 MiB|archivo|tamaño/i,
      {},
    ],
    [
      "total limit",
      "page",
      (result) => result,
      /total|40 MiB|tamaño/i,
      {
        limits: {
          maxFileBytes: 1024 * 1024,
          maxTotalBytes: 100,
          maxHeight: 30_000,
        },
      },
    ],
  ];

  for (const [label, scope, transform, expected, options] of cases) {
    const root = await mkdtemp(join(tmpdir(), "preview-capture-reject-"));
    const output = join(root, "capture");
    const browser = new FakeBrowserAdapter((result, request, index) =>
      index === 0 ? transform(result, request, index) : result,
    );
    try {
      await assert.rejects(
        capturePullRequestEvidence(
          {
            context: context(scope),
            base: descriptor("base"),
            candidate: descriptor("candidate"),
            outputRoot: output,
          },
          browser,
          options,
        ),
        expected,
        label,
      );
      await assert.rejects(stat(output), /ENOENT/u, label);
      assert.equal(browser.closed, true, label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("stable projection omits only capture time and run attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-capture-stable-"));
  const browser = new FakeBrowserAdapter();
  try {
    const set = await capturePullRequestEvidence(
      {
        context: context(),
        base: descriptor("base"),
        candidate: descriptor("candidate"),
        outputRoot: join(root, "capture"),
        runAttempt: 2,
      },
      browser,
    );
    const rerun = structuredClone(set.manifest);
    rerun.capturedAt = "2099-01-01T00:00:00.000Z";
    rerun.run.attempt = 99;
    assert.deepEqual(
      stableCaptureProjection(rerun),
      stableCaptureProjection(set.manifest),
    );
    rerun.captures[0].versionId = "99999999-9999-4999-8999-999999999999";
    assert.notDeepEqual(
      stableCaptureProjection(rerun),
      stableCaptureProjection(set.manifest),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture-pr CLI reads only sealed inputs and writes the canonical set", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-capture-cli-"));
  const contextPath = join(root, "context.json");
  const basePath = join(root, "base.json");
  const candidatePath = join(root, "candidate.json");
  const output = join(root, "capture");
  const browser = new FakeBrowserAdapter();
  try {
    const sealed = await writePullRequestContext(contextPath, context());
    await writeCloudflareVersionDescriptor(basePath, descriptor("base"));
    await writeCloudflareVersionDescriptor(
      candidatePath,
      descriptor("candidate"),
    );
    await runPreviewEvidenceCli(
      [
        "capture-pr",
        "--context",
        contextPath,
        "--context-sha",
        sealed.sha256,
        "--base",
        basePath,
        "--candidate",
        candidatePath,
        "--output",
        output,
        "--run-attempt",
        "3",
      ],
      {},
      { browserAdapter: browser, stdout: () => undefined },
    );
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.run.attempt, 3);
    assert.equal(manifest.captures.length, 4);
    assert.equal(browser.closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture-release CLI consumes a sealed main context", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-capture-release-cli-"));
  const contextPath = join(root, "main-context.json");
  const releasePath = join(root, "release.json");
  const output = join(root, "capture");
  const browser = new FakeBrowserAdapter();
  try {
    const sealed = await writeReleaseCaptureContext(contextPath, {
      schemaVersion: 1,
      repository,
      issueNumber: 4,
      issueUrl: `https://github.com/${repository}/issues/4`,
      prNumber: 4,
      prUrl: `https://github.com/${repository}/pull/4`,
      runId: 1001,
      runUrl: `https://github.com/${repository}/actions/runs/1001`,
      sourceSha: releaseSha,
      requestPath: "evidence/requests/issue-4.yaml",
      request: context().request,
    });
    await writeCloudflareVersionDescriptor(releasePath, descriptor("release"));
    await runPreviewEvidenceCli(
      [
        "capture-release",
        "--context",
        contextPath,
        "--context-sha",
        sealed.sha256,
        "--release",
        releasePath,
        "--output",
        output,
        "--run-attempt",
        "2",
      ],
      {},
      { browserAdapter: browser, stdout: () => undefined },
    );
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.kind, "release");
    assert.equal(manifest.run.attempt, 2);
    assert.deepEqual(
      manifest.captures.map(
        (capture: { filename: string }) => capture.filename,
      ),
      ["release-desktop.png", "release-mobile.png"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
