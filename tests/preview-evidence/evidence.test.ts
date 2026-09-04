import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  capturePullRequestEvidence,
  captureReleaseEvidence,
  writeReleaseCaptureContext,
  type BrowserAdapter,
  type BrowserCaptureRequest,
  type BrowserCaptureResult,
  type CaptureSet,
  type ReleaseCaptureContext,
} from "../../scripts/preview-evidence/capture.ts";
import {
  publishEvidenceToCheckout,
  readCaptureSet,
} from "../../scripts/preview-evidence/evidence.ts";
import { runPreviewEvidenceCli } from "../../scripts/preview-evidence/cli.ts";
import { canonicalJson } from "../../scripts/preview-evidence/domain.ts";
import type { CloudflareVersionDescriptor } from "../../scripts/preview-evidence/cloudflare.ts";
import {
  type GitHubApi,
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
const repository = "vbenhur-cs/webComunidadSolar";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const releaseSha = "c".repeat(40);
const bundleSha = "d".repeat(64);

function png(width: number, height: number, shade: number): Buffer {
  const image = new PNG({ width, height });
  image.data = Buffer.alloc(width * height * 4, shade);
  return PNG.sync.write(image);
}

class FakeBrowser implements BrowserAdapter {
  readonly toolVersions = {
    browser: "Chromium 140.0.0.0",
    playwright: "1.62.1",
  };

  async capture(request: BrowserCaptureRequest): Promise<BrowserCaptureResult> {
    const shade = request.role === "base" ? 120 : 220;
    return {
      status: request.expectedStatus,
      finalUrl: request.url,
      documentVisible: true,
      pagePng: png(request.viewport.width, 4, shade),
      section:
        request.selector === null
          ? null
          : {
              count: 1,
              visible: true,
              width: 120,
              height: 30,
              png: png(120, 30, shade),
            },
      pageErrors: [],
      failedRequests: [],
    };
  }

  async close(): Promise<void> {}
}

function descriptor(
  role: "base" | "candidate" | "release",
): CloudflareVersionDescriptor {
  const sourceSha =
    role === "base" ? baseSha : role === "candidate" ? headSha : releaseSha;
  const shortSha = sourceSha.slice(0, 7);
  const tag =
    role === "release"
      ? `main-${shortSha}`
      : `pr-9-${role === "base" ? "base" : "head"}-${shortSha}`;
  return {
    schemaVersion: 1,
    role,
    sourceSha,
    bundleSha256: bundleSha,
    workerName: "comunidad-solar-preview",
    versionId:
      role === "base"
        ? "11111111-1111-4111-8111-111111111111"
        : role === "candidate"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
    tag,
    alias: tag,
    url: `https://${tag}-comunidad-solar-preview.comunidadsolar-dev.workers.dev/`,
  };
}

function prContext(scope: "page" | "section" = "page"): PullRequestRunContext {
  return {
    repository,
    runId: 987,
    runUrl: `https://github.com/${repository}/actions/runs/987`,
    prNumber: 9,
    prUrl: `https://github.com/${repository}/pull/9`,
    issueNumber: 4,
    issueUrl: `https://github.com/${repository}/issues/4`,
    baseSha,
    headSha,
    requestPath: "evidence/requests/issue-4.yaml",
    request: {
      schemaVersion: 1,
      issue: 4,
      scope,
      route: "/pruebas/guia",
      selector: scope === "section" ? "[data-evidence-id='hero']" : null,
      expectedStatus: { base: 404, candidate: 200 },
      viewports: ["desktop", "mobile"],
    },
  };
}

function releaseContext(): ReleaseCaptureContext {
  return {
    schemaVersion: 1,
    repository,
    issueNumber: 4,
    issueUrl: `https://github.com/${repository}/issues/4`,
    prNumber: 9,
    prUrl: `https://github.com/${repository}/pull/9`,
    runId: 1001,
    runUrl: `https://github.com/${repository}/actions/runs/1001`,
    sourceSha: releaseSha,
    requestPath: "evidence/requests/issue-4.yaml",
    request: prContext().request,
  };
}

async function createPrCapture(
  root: string,
  scope: "page" | "section" = "page",
): Promise<CaptureSet> {
  return await capturePullRequestEvidence(
    {
      context: prContext(scope),
      base: descriptor("base"),
      candidate: descriptor("candidate"),
      outputRoot: join(root, "capture"),
      runAttempt: 1,
    },
    new FakeBrowser(),
  );
}

async function snapshotDirectory(root: string): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  async function visit(current: string, prefix: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const info = await stat(path);
      if (info.isDirectory()) await visit(path, relative);
      else snapshot.set(relative, await readFile(path));
    }
  }
  await visit(root, "");
  return snapshot;
}

test("publishes exact PR paths and treats a stable rerun as idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-publish-pr-"));
  const checkout = join(root, "evidence-checkout");
  await mkdir(checkout);
  try {
    const capture = await createPrCapture(root);
    const first = await publishEvidenceToCheckout({
      capture,
      checkoutRoot: checkout,
      context: prContext(),
    });
    const expected = [
      `issue-4/baseline/${baseSha}/before-desktop.png`,
      `issue-4/baseline/${baseSha}/before-mobile.png`,
      `issue-4/baseline/${baseSha}/manifest.json`,
      `issue-4/candidates/${headSha}/after-desktop.png`,
      `issue-4/candidates/${headSha}/after-mobile.png`,
      `issue-4/candidates/${headSha}/manifest.json`,
    ];
    assert.deepEqual(first.addedPaths, expected);
    assert.deepEqual(first.existingPaths, []);
    assert.equal(
      first.commitMessage,
      "evidence: record issue 4 candidate bbbbbbb",
    );
    assert.deepEqual(
      first.entries.map((entry) => [entry.role, entry.relativeDirectory]),
      [
        ["base", `issue-4/baseline/${baseSha}`],
        ["candidate", `issue-4/candidates/${headSha}`],
      ],
    );
    assert.equal(
      first.entries.every((entry) =>
        entry.pngs.every(({ rawUrl }) =>
          rawUrl.startsWith(
            `https://raw.githubusercontent.com/${repository}/evidence/issue-4/`,
          ),
        ),
      ),
      true,
    );

    const originalManifestPath = join(
      checkout,
      `issue-4/candidates/${headSha}/manifest.json`,
    );
    const originalManifest = JSON.parse(
      await readFile(originalManifestPath, "utf8"),
    );
    const rerunManifest = structuredClone(capture.manifest);
    rerunManifest.capturedAt = "2099-01-01T00:00:00.000Z";
    rerunManifest.run.attempt = 7;
    await writeFile(
      capture.manifestPath,
      `${canonicalJson(rerunManifest)}\n`,
      "utf8",
    );
    const rerunCapture = await readCaptureSet(capture.root);
    const rerun = await publishEvidenceToCheckout({
      capture: rerunCapture,
      checkoutRoot: checkout,
      context: prContext(),
    });
    assert.deepEqual(rerun.addedPaths, []);
    assert.deepEqual(rerun.existingPaths, expected);
    const retained = JSON.parse(await readFile(originalManifestPath, "utf8"));
    assert.equal(retained.capturedAt, originalManifest.capturedAt);
    assert.equal(retained.run.attempt, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes a release only below its immutable release SHA", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-publish-release-"));
  const checkout = join(root, "evidence-checkout");
  await mkdir(checkout);
  try {
    const capture = await captureReleaseEvidence(
      {
        context: releaseContext(),
        release: descriptor("release"),
        sharedUrl:
          "https://comunidad-solar-preview.comunidadsolar-dev.workers.dev/",
        outputRoot: join(root, "capture"),
      },
      new FakeBrowser(),
    );
    const result = await publishEvidenceToCheckout({
      capture,
      checkoutRoot: checkout,
      context: releaseContext(),
    });
    assert.deepEqual(result.addedPaths, [
      `issue-4/releases/${releaseSha}/manifest.json`,
      `issue-4/releases/${releaseSha}/release-desktop.png`,
      `issue-4/releases/${releaseSha}/release-mobile.png`,
    ]);
    assert.equal(result.entries[0].role, "release");
    assert.equal(
      result.commitMessage,
      "evidence: record issue 4 release ccccccc",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects source tampering, extra files and non-canonical manifests", async () => {
  const cases: Array<[string, (capture: CaptureSet) => Promise<void>, RegExp]> =
    [
      [
        "changed PNG",
        async (capture) => {
          await writeFile(join(capture.root, "before-desktop.png"), "changed");
        },
        /PNG|hash|bytes|tamaño/i,
      ],
      [
        "extra source file",
        async (capture) => {
          await writeFile(join(capture.root, "not-in-manifest.png"), "extra");
        },
        /extra|inventario|manifest/i,
      ],
      [
        "ninth capture",
        async (capture) => {
          const manifest = structuredClone(capture.manifest);
          manifest.captures.push({
            ...manifest.captures[0],
            filename: "ninth.png",
          });
          await writeFile(
            capture.manifestPath,
            `${canonicalJson(manifest)}\n`,
            "utf8",
          );
        },
        /8|capturas|filename|canóni/i,
      ],
    ];

  for (const [label, mutate, expected] of cases) {
    const root = await mkdtemp(join(tmpdir(), "evidence-source-reject-"));
    const checkout = join(root, "evidence-checkout");
    await mkdir(checkout);
    try {
      const capture = await createPrCapture(root, "section");
      await mutate(capture);
      await assert.rejects(
        publishEvidenceToCheckout({
          capture,
          checkoutRoot: checkout,
          context: prContext("section"),
        }),
        expected,
        label,
      );
      assert.deepEqual(await readdir(checkout), [], label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects a tampered capture that aliases base and candidate previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-preview-alias-"));
  const checkout = join(root, "evidence-checkout");
  await mkdir(checkout);
  try {
    const capture = await createPrCapture(root);
    const manifest = structuredClone(capture.manifest);
    const base = manifest.captures.find((item) => item.role === "base");
    assert.ok(base);
    for (const candidate of manifest.captures.filter(
      (item) => item.role === "candidate",
    )) {
      candidate.versionId = base.versionId;
      candidate.origin = base.origin;
      candidate.url = base.url;
    }
    await writeFile(
      capture.manifestPath,
      `${canonicalJson(manifest)}\n`,
      "utf8",
    );
    await assert.rejects(async () => {
      const tampered = await readCaptureSet(capture.root);
      await publishEvidenceToCheckout({
        capture: tampered,
        checkoutRoot: checkout,
        context: prContext(),
      });
    }, /base.*candidate|preview.*distint|identidad/i);
    assert.deepEqual(await readdir(checkout), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never alters existing evidence when a destination differs", async () => {
  const mutations: Array<
    [string, (checkout: string) => Promise<void>, RegExp]
  > = [
    [
      "changed manifest",
      async (checkout) => {
        const path = join(
          checkout,
          `issue-4/candidates/${headSha}/manifest.json`,
        );
        const manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.captures[0].versionId = "99999999-9999-4999-8999-999999999999";
        await writeFile(path, `${canonicalJson(manifest)}\n`, "utf8");
      },
      /diferente|colisi|manifest/i,
    ],
    [
      "missing destination file",
      async (checkout) => {
        await rm(
          join(checkout, `issue-4/baseline/${baseSha}/before-mobile.png`),
        );
      },
      /falta|inventario|destino/i,
    ],
    [
      "extra destination file",
      async (checkout) => {
        await writeFile(
          join(checkout, `issue-4/baseline/${baseSha}/extra.png`),
          "extra",
        );
      },
      /extra|inventario|destino/i,
    ],
    [
      "destination file type",
      async (checkout) => {
        const path = join(
          checkout,
          `issue-4/baseline/${baseSha}/before-desktop.png`,
        );
        await rm(path);
        await mkdir(path);
      },
      /regular|tipo|destino/i,
    ],
  ];

  for (const [label, mutate, expected] of mutations) {
    const root = await mkdtemp(join(tmpdir(), "evidence-collision-"));
    const checkout = join(root, "evidence-checkout");
    await mkdir(checkout);
    try {
      const capture = await createPrCapture(root);
      await publishEvidenceToCheckout({
        capture,
        checkoutRoot: checkout,
        context: prContext(),
      });
      await mutate(checkout);
      const before = await snapshotDirectory(checkout);
      await assert.rejects(
        publishEvidenceToCheckout({
          capture,
          checkoutRoot: checkout,
          context: prContext(),
        }),
        expected,
        label,
      );
      assert.deepEqual(await snapshotDirectory(checkout), before, label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects symlinks and validates every existing role before adding another", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-links-"));
  const checkout = join(root, "evidence-checkout");
  await mkdir(checkout);
  try {
    const capture = await createPrCapture(root);
    const candidate = join(checkout, `issue-4/candidates/${headSha}`);
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, "unexpected.png"), "collision");
    await assert.rejects(
      publishEvidenceToCheckout({
        capture,
        checkoutRoot: checkout,
        context: prContext(),
      }),
      /inventario|extra|destino/i,
    );
    await assert.rejects(
      stat(join(checkout, `issue-4/baseline/${baseSha}`)),
      /ENOENT/u,
    );

    const linkedCheckout = join(root, "linked-checkout");
    await symlink(checkout, linkedCheckout);
    await assert.rejects(
      publishEvidenceToCheckout({
        capture,
        checkoutRoot: linkedCheckout,
        context: prContext(),
      }),
      /symlink|regular|checkout/i,
    );

    const sourceLink = join(root, "capture-link");
    await symlink(capture.root, sourceLink);
    await assert.rejects(readCaptureSet(sourceLink), /symlink|captura/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class PipelineGitHubApi implements GitHubApi {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];

  async get(path: string): Promise<unknown> {
    this.calls.push({ method: "GET", path });
    if (path.endsWith("/comments?per_page=100")) return [];
    if (path === `/repos/${repository}/pulls/9`) {
      return { number: 9, state: "open", head: { sha: headSha } };
    }
    throw new Error(`Unexpected GET ${path}`);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    this.calls.push({ method: "POST", path, body: structuredClone(body) });
    return { id: 1 };
  }

  async patch(path: string, body: unknown): Promise<unknown> {
    this.calls.push({ method: "PATCH", path, body: structuredClone(body) });
    return { id: 1 };
  }
}

test("CLI publishes, comments and approves only sealed PR evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-cli-"));
  const checkout = join(root, "evidence-checkout");
  await mkdir(checkout);
  try {
    const capture = await createPrCapture(root);
    const contextPath = join(root, "context.json");
    const publicationPath = join(root, "publication.json");
    const githubOutput = join(root, "github-output");
    const sealed = await writePullRequestContext(contextPath, prContext());
    await writeFile(githubOutput, "", "utf8");
    const messages: string[] = [];
    await runPreviewEvidenceCli(
      [
        "publish-evidence",
        "--capture",
        capture.root,
        "--checkout",
        checkout,
        "--context",
        contextPath,
        "--context-sha",
        sealed.sha256,
        "--output",
        publicationPath,
        "--github-output",
        githubOutput,
      ],
      {},
      { stdout: (message) => messages.push(message) },
    );
    const publication = JSON.parse(await readFile(publicationPath, "utf8"));
    assert.equal(publication.source.headSha, headSha);
    assert.equal(publication.addedPaths.length, 6);
    const publicationOutputs = await readFile(githubOutput, "utf8");
    assert.match(publicationOutputs, /added_count<<[^\n]+\n6\n/u);
    assert.match(
      publicationOutputs,
      new RegExp(
        `identity_manifest<<[^\\n]+\\nissue-4/candidates/${headSha}/manifest\\.json\\n`,
        "u",
      ),
    );

    const api = new PipelineGitHubApi();
    const environment = {
      GITHUB_TOKEN: "test-github-token",
      GITHUB_REPOSITORY: repository,
    };
    const dependencies = {
      createApi: () => api,
      stdout: (message: string) => messages.push(message),
    };
    const evidenceCommitSha = "e".repeat(40);
    await runPreviewEvidenceCli(
      [
        "comment-evidence",
        "--publication",
        publicationPath,
        "--context",
        contextPath,
        "--context-sha",
        sealed.sha256,
        "--evidence-sha",
        evidenceCommitSha,
      ],
      environment,
      dependencies,
    );
    await runPreviewEvidenceCli(
      [
        "approve-preview",
        "--context",
        contextPath,
        "--context-sha",
        sealed.sha256,
      ],
      environment,
      dependencies,
    );

    assert.equal(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === `/repos/${repository}/statuses/${headSha}`,
      ),
      true,
    );
    assert.deepEqual(messages, [
      "EVIDENCE_PUBLISHED_OK issue=4 added=6 existing=0\n",
      `EVIDENCE_COMMENTS_OK issue=4 sha=${headSha}\n`,
      `PREVIEW_APPROVED_OK sha=${headSha}\n`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI publishes and comments a sealed shared-preview release", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-release-cli-"));
  const checkout = join(root, "evidence-checkout");
  await mkdir(checkout);
  try {
    const contextValue = releaseContext();
    const capture = await captureReleaseEvidence(
      {
        context: contextValue,
        release: descriptor("release"),
        sharedUrl:
          "https://comunidad-solar-preview.comunidadsolar-dev.workers.dev/",
        outputRoot: join(root, "capture"),
      },
      new FakeBrowser(),
    );
    const contextPath = join(root, "context.json");
    const publicationPath = join(root, "publication.json");
    const githubOutput = join(root, "github-output");
    const sealed = await writeReleaseCaptureContext(contextPath, contextValue);
    await writeFile(githubOutput, "", "utf8");
    const messages: string[] = [];

    await runPreviewEvidenceCli(
      [
        "publish-release-evidence",
        "--capture",
        capture.root,
        "--checkout",
        checkout,
        "--context",
        contextPath,
        "--context-sha",
        sealed.sha256,
        "--output",
        publicationPath,
        "--github-output",
        githubOutput,
      ],
      {},
      { stdout: (message) => messages.push(message) },
    );
    const publication = JSON.parse(await readFile(publicationPath, "utf8"));
    assert.equal(publication.kind, "release");
    assert.equal(publication.source.releaseSha, releaseSha);
    const outputs = await readFile(githubOutput, "utf8");
    assert.match(
      outputs,
      new RegExp(
        `identity_manifest<<[^\\n]+\\nissue-4/releases/${releaseSha}/manifest\\.json\\n`,
        "u",
      ),
    );

    const api = new PipelineGitHubApi();
    await runPreviewEvidenceCli(
      [
        "comment-release-evidence",
        "--publication",
        publicationPath,
        "--context",
        contextPath,
        "--context-sha",
        sealed.sha256,
        "--evidence-sha",
        "e".repeat(40),
      ],
      {
        GITHUB_TOKEN: "test-github-token",
        GITHUB_REPOSITORY: repository,
      },
      {
        createApi: () => api,
        stdout: (message) => messages.push(message),
      },
    );
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 2);
    assert.deepEqual(messages, [
      "RELEASE_EVIDENCE_PUBLISHED_OK issue=4 added=3 existing=0\n",
      `RELEASE_EVIDENCE_COMMENTS_OK issue=4 sha=${releaseSha}\n`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
