import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  CAPTURE_CONTEXT_OPTIONS,
  VISUAL_VIEWPORTS,
  captureDeterministicPage,
  compareVisuals,
  installCaptureNetworkPolicy,
  templateSelectors,
  type GeometryBox,
} from "../../scripts/lib/visual-contract.ts";
import {
  dispatchSourceRuntimeRequest,
  formatVisualParitySummary,
  launchChromium,
  parseVisualArguments,
  readVisualFixtures,
  runVisualParity,
  resolveVisualAuthPlan,
  runVisualCommand,
  selectFoundationVisualRoutes,
  selectPublicVisualRoutes,
  selectVisualCaptureSelectors,
  selectVisualRoutes,
  sourceAssetFetcher,
  startCandidateRuntime,
  withVisualSourceEnvironment,
  writeVisualReports,
  type VisualCaptureInput,
  type VisualParityDependencies,
} from "../../scripts/parity-visual.ts";
import type {
  TemporarySourceBuild,
  TemporarySourceOptions,
} from "../../scripts/lib/temporary-source-build.ts";
import type { RouteMatrixEntry } from "../../scripts/lib/route-inventory.ts";

interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

interface PngConstructor {
  new (options: { width: number; height: number }): PngImage;
  sync: {
    read(input: Buffer): PngImage;
    write(input: PngImage): Buffer;
  };
}

const PNG = (
  createRequire(import.meta.url)("pngjs") as { PNG: PngConstructor }
).PNG;

const desktop = VISUAL_VIEWPORTS[0];

function createPng(
  width: number,
  height: number,
  pixels: ReadonlyArray<readonly [number, number, number, number]> = [],
): Buffer {
  const image = new PNG({ width, height });
  image.data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const pixel = pixels[index] ?? [0, 0, 0, 255];
    image.data.set(pixel, index * 4);
  }
  return PNG.sync.write(image);
}

function box(
  selector: string,
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
): GeometryBox {
  return { selector, index, x, y, width, height };
}

function comparisonOptions(
  referenceGeometry: GeometryBox[] = [],
  candidateGeometry: GeometryBox[] = referenceGeometry,
) {
  return {
    routeKey: "page:/",
    viewport: desktop,
    referenceGeometry,
    candidateGeometry,
    files: {
      reference: ".artifacts/visual/foundation/home/desktop/reference.png",
      candidate: ".artifacts/visual/foundation/home/desktop/candidate.png",
      diff: ".artifacts/visual/foundation/home/desktop/diff.png",
    },
  };
}

function readyCaptureContext(options: {
  close(): Promise<void>;
  goto?(): Promise<void>;
}) {
  const geometryElement = {
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1, height: 1 };
    },
  };
  return {
    async addInitScript() {},
    async route() {},
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        goto: options.goto ?? (async () => undefined),
        async evaluate() {},
        locator(selector: string) {
          return {
            async evaluateAll(
              callback: (
                items: unknown[],
                argument?: unknown,
              ) => Promise<unknown> | unknown,
              argument?: unknown,
            ) {
              if (selector === "img") {
                return callback(
                  [
                    {
                      loading: "eager",
                      complete: true,
                      naturalWidth: 1,
                    },
                  ],
                  argument,
                );
              }
              return callback([geometryElement], argument);
            },
          };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    close: options.close,
  };
}

test("reports zero for identical PNG bytes and identical geometry", async () => {
  const image = createPng(2, 2);
  const geometry = [box("body", 0, 0, 0, 1440, 900)];

  const result = await compareVisuals(
    image,
    image,
    comparisonOptions(geometry),
  );

  assert.equal(result.differentPixels, 0);
  assert.equal(result.diffRatio, 0);
  assert.deepEqual(result.geometryDiffs, []);
  assert.equal(result.diffPng, null);
  assert.equal(result.status, "matched");
});

test("reports exactly one one-channel pixel change without a tolerance escape", async () => {
  const reference = createPng(2, 2);
  const candidate = createPng(2, 2, [
    [1, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]);

  const result = await compareVisuals(
    reference,
    candidate,
    comparisonOptions(),
  );

  assert.equal(result.differentPixels, 1);
  assert.equal(result.diffRatio, 0.25);
  assert.ok(result.diffPng);
  assert.equal(result.status, "review-required");
});

test("treats alpha-only and edge-pixel differences as review-required", async () => {
  const reference = createPng(2, 2);
  const alphaOnly = createPng(2, 2, [
    [0, 0, 0, 254],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]);
  const edgePixel = createPng(2, 2, [
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 1, 255],
  ]);

  const alphaResult = await compareVisuals(
    reference,
    alphaOnly,
    comparisonOptions(),
  );
  const edgeResult = await compareVisuals(
    reference,
    edgePixel,
    comparisonOptions(),
  );

  assert.equal(alphaResult.differentPixels, 1);
  assert.equal(alphaResult.status, "review-required");
  assert.equal(edgeResult.differentPixels, 1);
  assert.equal(edgeResult.status, "review-required");
});

test("counts and visibly marks every raw RGBA delta including transparent and edge pixels", async () => {
  const reference = createPng(4, 1, [
    [48, 48, 48, 0],
    [48, 48, 48, 0],
    [48, 48, 48, 1],
    [0, 0, 0, 255],
  ]);
  const candidate = createPng(4, 1, [
    [48, 48, 48, 1],
    [49, 48, 48, 0],
    [48, 48, 49, 1],
    [0, 0, 1, 255],
  ]);

  const result = await compareVisuals(reference, candidate, comparisonOptions());

  assert.equal(result.differentPixels, 4);
  assert.equal(result.status, "review-required");
  assert.ok(result.diffPng);
  const diff = PNG.sync.read(result.diffPng);
  for (let pixel = 0; pixel < 4; pixel += 1) {
    assert.ok(
      diff.data[pixel * 4 + 3] > 0,
      `raw-different pixel ${pixel} must remain visible in the diff`,
    );
  }
});

test("makes a PNG dimension mismatch explicit and never calls it matched", async () => {
  const result = await compareVisuals(
    createPng(2, 2),
    createPng(3, 2),
    comparisonOptions(),
  );

  assert.deepEqual(result.dimensionMismatch, {
    reference: { width: 2, height: 2 },
    candidate: { width: 3, height: 2 },
  });
  assert.ok(result.differentPixels > 0);
  assert.equal(result.diffPng, null);
  assert.equal(result.status, "review-required");
});

test("counts dimension mismatches from the real coordinate union instead of max area", async () => {
  const reference = createPng(2, 3, [
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]);
  const candidate = createPng(3, 2, [
    [1, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]);

  const result = await compareVisuals(reference, candidate, comparisonOptions());

  // Four coordinates exist on only one canvas, plus one raw overlap delta.
  assert.equal(result.differentPixels, 5);
  assert.equal(result.diffRatio, 0.625);
  assert.equal(result.diffPng, null);
  assert.equal(result.status, "review-required");
});

test("rounds geometry to two decimals and reports deterministic field and presence diffs", async () => {
  const result = await compareVisuals(
    createPng(1, 1),
    createPng(1, 1),
    comparisonOptions(
      [
        box(".card", 0, 1.234, 2.234, 33.333, 44.444),
        box(".card", 1, 4, 5, 6, 7),
        box("main", 0, 0, 0, 10, 10),
      ],
      [
        box(".card", 0, 1.2336, 2.2336, 33.339, 44.444),
        box(".extra", 0, 0, 0, 1, 1),
        box("main", 0, 0, 0, 10, 10),
      ],
    ),
  );

  assert.deepEqual(result.geometryDiffs, [
    {
      selector: ".card",
      index: 0,
      field: "width",
      expected: 33.33,
      actual: 33.34,
    },
    {
      selector: ".card",
      index: 1,
      field: "presence",
      expected: true,
      actual: false,
    },
    {
      selector: ".extra",
      index: 0,
      field: "presence",
      expected: false,
      actual: true,
    },
  ]);
  assert.equal(result.status, "review-required");
});

test("keeps selectors missing on both sides as deterministic non-matched evidence", async () => {
  const result = await compareVisuals(
    createPng(1, 1),
    createPng(1, 1),
    {
      ...comparisonOptions(),
      referenceMissingSelectors: ["footer", "header"],
      candidateMissingSelectors: ["header", "footer"],
    },
  );

  assert.equal(result.status, "review-required");
  assert.deepEqual(result.geometryDiffs, []);
  assert.deepEqual(result.missingSelectors, {
    reference: ["footer", "header"],
    candidate: ["footer", "header"],
  });
  assert.equal(
    JSON.stringify(result.missingSelectors),
    '{"reference":["footer","header"],"candidate":["footer","header"]}',
  );
});

test("declares the three fixed capture viewports and structural selectors for home, generic, and community pages", () => {
  assert.deepEqual(VISUAL_VIEWPORTS, [
    { name: "desktop", width: 1440, height: 900 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
  ]);
  assert.deepEqual(CAPTURE_CONTEXT_OPTIONS(VISUAL_VIEWPORTS[1]), {
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 1,
    locale: "es-ES",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  assert.deepEqual(templateSelectors.home, ["body", "header", "main", "footer"]);
  assert.deepEqual(templateSelectors["generic-page"], [
    "body",
    "header",
    "main",
    "footer",
  ]);
  assert.deepEqual(templateSelectors["community-detail"], [
    "body",
    "header",
    "main.community-local-detail, main.community-network-detail",
    "footer",
  ]);
});

test("declares structural selectors for the remote and editorial templates", () => {
  assert.deepEqual(templateSelectors["remote-detail"], [
    "body",
    "header",
    "main.remote-commercial-page, main.remote-project-page, main",
    "footer",
  ]);
  assert.deepEqual(templateSelectors["blog-index"], [
    "body",
    "header",
    "main.blog-page",
    "footer",
  ]);
  assert.deepEqual(templateSelectors["blog-detail"], [
    "body",
    "header",
    "main.blog-detail",
    "footer",
  ]);
  assert.deepEqual(templateSelectors["legal-page"], [
    "body",
    "header",
    "main",
    "main .legal-document",
    "footer",
  ]);
  assert.deepEqual(templateSelectors["team-guide"], [
    "body",
    "header",
    "main.team-guide-page",
    "footer",
  ]);
});

test("serves exact archive assets before the source worker and delegates absent paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-source-assets-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "visual-source-escape-"));
  const css = Buffer.from("body{color:rgb(1,2,3)}\n", "utf8");
  const workerRequests: string[] = [];
  const worker = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    workerRequests.push(path);
    return new Response(`worker:${path}`, {
      status: path === "/" ? 201 : 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };
  try {
    await mkdir(join(root, "dist", "client", "assets", "directory"), {
      recursive: true,
    });
    await writeFile(join(root, "dist", "client", "assets", "layout.css"), css);
    const assets = sourceAssetFetcher(root);

    const get = await dispatchSourceRuntimeRequest(
      new Request("http://127.0.0.1:40132/assets/layout.css"),
      assets,
      worker,
    );
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "text/css; charset=utf-8");
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), css);
    assert.deepEqual(workerRequests, []);

    const head = await dispatchSourceRuntimeRequest(
      new Request("http://127.0.0.1:40132/assets/layout.css", {
        method: "HEAD",
      }),
      assets,
      worker,
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.deepEqual(workerRequests, []);

    const missing = await dispatchSourceRuntimeRequest(
      new Request("http://127.0.0.1:40132/assets/missing.css"),
      assets,
      worker,
    );
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "worker:/assets/missing.css");

    const directory = await dispatchSourceRuntimeRequest(
      new Request("http://127.0.0.1:40132/assets/directory"),
      assets,
      worker,
    );
    assert.equal(directory.status, 404);
    assert.equal(await directory.text(), "worker:/assets/directory");

    const page = await dispatchSourceRuntimeRequest(
      new Request("http://127.0.0.1:40132/"),
      assets,
      worker,
    );
    assert.equal(page.status, 201);
    assert.equal(await page.text(), "worker:/");
    assert.deepEqual(workerRequests, [
      "/assets/missing.css",
      "/assets/directory",
      "/",
    ]);

    await writeFile(
      join(outsideRoot, "escaped.css"),
      "body{background:magenta}\n",
    );
    await symlink(outsideRoot, join(root, "dist", "public"), "dir");
    await assert.rejects(
      dispatchSourceRuntimeRequest(
        new Request("http://127.0.0.1:40132/escaped.css"),
        assets,
        worker,
      ),
      /asset.*archive|archive.*asset/i,
    );
    assert.deepEqual(workerRequests, [
      "/assets/missing.css",
      "/assets/directory",
      "/",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects a source archive root symlink before reading its assets", async () => {
  const parent = await mkdtemp(join(tmpdir(), "visual-source-root-link-"));
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "visual-source-root-outside-"),
  );
  const linkedRoot = join(parent, "linked-archive");
  let workerCalls = 0;
  try {
    await mkdir(join(outsideRoot, "dist", "client", "assets"), {
      recursive: true,
    });
    await writeFile(
      join(outsideRoot, "dist", "client", "assets", "inside.css"),
      "body{color:teal}\n",
    );
    await symlink(outsideRoot, linkedRoot, "dir");
    const assets = sourceAssetFetcher(linkedRoot);

    await assert.rejects(
      dispatchSourceRuntimeRequest(
        new Request("http://127.0.0.1:40133/assets/inside.css"),
        assets,
        async () => {
          workerCalls += 1;
          return new Response("worker");
        },
      ),
      /raíz.*archive.*enlace|archive.*raíz.*enlace|symlink/i,
    );
    assert.equal(workerCalls, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("removes only the stale diff PNG when a later write has no pixel diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-stale-diff-"));
  const referencePng = createPng(1, 1);
  const mismatched = await compareVisuals(
    referencePng,
    createPng(1, 1, [[1, 0, 0, 255]]),
    comparisonOptions(),
  );
  const matched = await compareVisuals(
    referencePng,
    referencePng,
    comparisonOptions(),
  );
  const reference = {
    screenshot: referencePng,
    geometry: [],
    missingSelectors: [],
  };
  const candidate = {
    screenshot: referencePng,
    geometry: [],
    missingSelectors: [],
  };
  try {
    assert.ok(mismatched.files.diff);
    await writeVisualReports({
      root,
      scope: "foundation",
      results: [mismatched],
      evidence: [{ result: mismatched, reference, candidate }],
    });
    const stalePath = join(root, mismatched.files.diff);
    assert.equal(existsSync(stalePath), true);

    await writeVisualReports({
      root,
      scope: "foundation",
      results: [matched],
      evidence: [{ result: matched, reference, candidate }],
    });
    assert.equal(existsSync(stalePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an external .artifacts/visual symlink before writing visual reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-artifact-root-link-"));
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "visual-artifact-root-outside-"),
  );
  const screenshot = createPng(1, 1);
  const result = await compareVisuals(
    screenshot,
    createPng(1, 1, [[1, 0, 0, 255]]),
    comparisonOptions(),
  );
  const evidence = {
    result,
    reference: { screenshot, geometry: [], missingSelectors: [] },
    candidate: { screenshot, geometry: [], missingSelectors: [] },
  };
  try {
    await mkdir(join(root, ".artifacts"), { recursive: true });
    await symlink(outsideRoot, join(root, ".artifacts", "visual"), "dir");

    await assert.rejects(
      writeVisualReports({
        root,
        scope: "foundation",
        results: [result],
        evidence: [evidence],
      }),
      /artifacts.*visual.*enlace|enlace.*artifacts.*visual|symlink/i,
    );
    assert.equal(existsSync(join(outsideRoot, "foundation")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("refuses an external .artifacts parent symlink before writing visual reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-artifact-parent-link-"));
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "visual-artifact-parent-outside-"),
  );
  const screenshot = createPng(1, 1);
  const result = await compareVisuals(
    screenshot,
    createPng(1, 1, [[1, 0, 0, 255]]),
    comparisonOptions(),
  );
  const evidence = {
    result,
    reference: { screenshot, geometry: [], missingSelectors: [] },
    candidate: { screenshot, geometry: [], missingSelectors: [] },
  };
  try {
    await symlink(outsideRoot, join(root, ".artifacts"), "dir");

    await assert.rejects(
      writeVisualReports({
        root,
        scope: "foundation",
        results: [result],
        evidence: [evidence],
      }),
      /artifacts.*enlace|enlace.*artifacts|symlink/i,
    );
    assert.equal(existsSync(join(outsideRoot, "visual")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("refuses symlinked report components and final files", async () => {
  const screenshot = createPng(1, 1);
  const result = await compareVisuals(
    screenshot,
    createPng(1, 1, [[1, 0, 0, 255]]),
    comparisonOptions(),
  );
  const evidence = {
    result,
    reference: { screenshot, geometry: [], missingSelectors: [] },
    candidate: { screenshot, geometry: [], missingSelectors: [] },
  };
  const componentRoot = await mkdtemp(
    join(tmpdir(), "visual-artifact-component-link-"),
  );
  const componentOutside = await mkdtemp(
    join(tmpdir(), "visual-artifact-component-outside-"),
  );
  const finalRoot = await mkdtemp(join(tmpdir(), "visual-artifact-file-link-"));
  const finalOutside = await mkdtemp(
    join(tmpdir(), "visual-artifact-file-outside-"),
  );
  const outsideFile = join(finalOutside, "reference.png");
  try {
    await mkdir(join(componentRoot, ".artifacts", "visual"), {
      recursive: true,
    });
    await symlink(
      componentOutside,
      join(componentRoot, ".artifacts", "visual", "foundation"),
      "dir",
    );
    await assert.rejects(
      writeVisualReports({
        root: componentRoot,
        scope: "foundation",
        results: [result],
        evidence: [evidence],
      }),
      /artifacts.*enlace|enlace.*artifacts|symlink/i,
    );
    assert.equal(existsSync(join(componentOutside, "home")), false);

    await mkdir(
      join(finalRoot, ".artifacts", "visual", "foundation", "home", "desktop"),
      { recursive: true },
    );
    await writeFile(outsideFile, "outside sentinel");
    await symlink(
      outsideFile,
      join(
        finalRoot,
        ".artifacts",
        "visual",
        "foundation",
        "home",
        "desktop",
        "reference.png",
      ),
      "file",
    );
    await assert.rejects(
      writeVisualReports({
        root: finalRoot,
        scope: "foundation",
        results: [result],
        evidence: [evidence],
      }),
      /artifact.*enlace|enlace.*artifact|symlink/i,
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside sentinel");
  } finally {
    await rm(componentRoot, { recursive: true, force: true });
    await rm(componentOutside, { recursive: true, force: true });
    await rm(finalRoot, { recursive: true, force: true });
    await rm(finalOutside, { recursive: true, force: true });
  }
});

test("refuses symlinked summaries and stale diff files without touching their targets", async () => {
  const screenshot = createPng(1, 1);
  const mismatched = await compareVisuals(
    screenshot,
    createPng(1, 1, [[1, 0, 0, 255]]),
    comparisonOptions(),
  );
  const matched = await compareVisuals(
    screenshot,
    screenshot,
    comparisonOptions(),
  );
  const summaryEvidence = {
    result: mismatched,
    reference: { screenshot, geometry: [], missingSelectors: [] },
    candidate: { screenshot, geometry: [], missingSelectors: [] },
  };
  const staleEvidence = { ...summaryEvidence, result: matched };
  const summaryRoot = await mkdtemp(join(tmpdir(), "visual-summary-file-link-"));
  const staleRoot = await mkdtemp(join(tmpdir(), "visual-stale-file-link-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "visual-file-link-outside-"));
  const summaryOutside = join(outsideRoot, "summary.json");
  const staleOutside = join(outsideRoot, "diff.png");
  try {
    await mkdir(join(summaryRoot, ".artifacts", "visual", "foundation"), {
      recursive: true,
    });
    await writeFile(summaryOutside, "summary sentinel");
    await symlink(
      summaryOutside,
      join(
        summaryRoot,
        ".artifacts",
        "visual",
        "foundation",
        "summary.json",
      ),
      "file",
    );
    await assert.rejects(
      writeVisualReports({
        root: summaryRoot,
        scope: "foundation",
        results: [mismatched],
        evidence: [summaryEvidence],
      }),
      /artifact.*enlace|enlace.*artifact|symlink/i,
    );
    assert.equal(await readFile(summaryOutside, "utf8"), "summary sentinel");

    await mkdir(
      join(
        staleRoot,
        ".artifacts",
        "visual",
        "foundation",
        "home",
        "desktop",
      ),
      { recursive: true },
    );
    await writeFile(staleOutside, "diff sentinel");
    await symlink(
      staleOutside,
      join(
        staleRoot,
        ".artifacts",
        "visual",
        "foundation",
        "home",
        "desktop",
        "diff.png",
      ),
      "file",
    );
    await assert.rejects(
      writeVisualReports({
        root: staleRoot,
        scope: "foundation",
        results: [matched],
        evidence: [staleEvidence],
      }),
      /artifact.*enlace|enlace.*artifact|symlink/i,
    );
    assert.equal(await readFile(staleOutside, "utf8"), "diff sentinel");
  } finally {
    await rm(summaryRoot, { recursive: true, force: true });
    await rm(staleRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects invalid or non-canonical fixture base64 while accepting an explicit empty body", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-fixture-base64-"));
  const fixturePath = join(root, "parity", "visual-fixtures.json");
  const fixture = {
    url: "https://fixtures.example.test/font.woff2",
    status: 200,
    headers: { "content-type": "font/woff2" },
    bodyBase64: "",
  };
  try {
    await mkdir(join(root, "parity"), { recursive: true });
    await writeFile(
      fixturePath,
      JSON.stringify([{ ...fixture, bodyBase64: "%%%" }]),
    );
    await assert.rejects(readVisualFixtures(root), /base64.*inválido|inválido.*base64/i);

    await writeFile(
      fixturePath,
      JSON.stringify([{ ...fixture, bodyBase64: "AA" }]),
    );
    await assert.rejects(readVisualFixtures(root), /base64.*canónico|canónico.*base64/i);

    await writeFile(fixturePath, JSON.stringify([fixture]));
    const fixtures = await readVisualFixtures(root);
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0]?.body.byteLength, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds candidate worker readiness and disposes the worker after its deadline", async () => {
  let disposed = 0;
  const worker = {
    ready: new Promise<void>(() => undefined),
    async fetch() {
      return new Response("unused");
    },
    async dispose() {
      disposed += 1;
    },
    raw: {
      async teardown() {},
    },
  };

  await assert.rejects(
    startCandidateRuntime(
      {
        deployConfigPath: "/candidate/.wrangler/deploy/config.json",
        wranglerConfigPath: "/candidate/dist/server/wrangler.json",
        entryPath: "/candidate/dist/server/entry.mjs",
      },
      5,
      {
        async startWorker() {
          return worker;
        },
        async startBridge() {
          assert.fail("the bridge must not start before worker.ready");
        },
      },
    ),
    /5 ms.*Worker candidato listo/i,
  );
  assert.equal(disposed, 1);
});

test("falls back to Wrangler raw teardown after a bounded candidate dispose failure", async () => {
  let disposed = 0;
  let tornDown = 0;
  const worker = {
    ready: new Promise<void>(() => undefined),
    async fetch() {
      return new Response("unused");
    },
    async dispose() {
      disposed += 1;
      await new Promise<void>(() => undefined);
    },
    raw: {
      async teardown() {
        tornDown += 1;
      },
    },
  };

  await assert.rejects(
    startCandidateRuntime(
      {
        deployConfigPath: "/candidate/.wrangler/deploy/config.json",
        wranglerConfigPath: "/candidate/dist/server/wrangler.json",
        entryPath: "/candidate/dist/server/entry.mjs",
      },
      5,
      {
        async startWorker() {
          return worker;
        },
        async startBridge() {
          assert.fail("the bridge must not start before worker.ready");
        },
      },
    ),
    /5 ms.*Worker candidato listo/i,
  );
  assert.equal(disposed, 1);
  assert.equal(tornDown, 1);
});

test("preserves candidate dispose and raw teardown deadline failures", async () => {
  const worker = {
    ready: new Promise<void>(() => undefined),
    async fetch() {
      return new Response("unused");
    },
    async dispose() {
      await new Promise<void>(() => undefined);
    },
    raw: {
      async teardown() {
        await new Promise<void>(() => undefined);
      },
    },
  };

  await assert.rejects(
    Promise.race([
      startCandidateRuntime(
        {
          deployConfigPath: "/candidate/.wrangler/deploy/config.json",
          wranglerConfigPath: "/candidate/dist/server/wrangler.json",
          entryPath: "/candidate/dist/server/entry.mjs",
        },
        5,
        {
          async startWorker() {
            return worker;
          },
          async startBridge() {
            assert.fail("the bridge must not start before worker.ready");
          },
        },
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El fallback raw teardown no tuvo deadline")),
          100,
        );
      }),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /5 ms.*Worker candidato listo/i);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /1 ms.*cerrar el Worker candidato/i);
      assert.ok(error.cause.cause instanceof Error);
      assert.match(
        error.cause.cause.message,
        /1 ms.*forzar teardown del Worker candidato/i,
      );
      return true;
    },
  );
});

test("fails fast on Windows before spawning a visual candidate build", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-command-windows-"));
  const markerPath = join(root, "spawned.txt");
  try {
    await assert.rejects(
      runVisualCommand(
        process.execPath,
        [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "spawned")`,
        ],
        root,
        { platform: "win32" },
      ),
      /Windows.*árbol de procesos|árbol de procesos.*Windows/i,
    );
    assert.equal(existsSync(markerPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launches Chromium through BrowserServer and forces kill after a close deadline", async () => {
  const events: string[] = [];
  const browser = await launchChromium(5, {
    chromium: {
      async launchServer(options) {
        assert.deepEqual(options, { headless: true });
        events.push("launchServer");
        return {
          wsEndpoint() {
            events.push("wsEndpoint");
            return "ws://127.0.0.1:40151/playwright";
          },
          async close() {
            events.push("server:close");
            await new Promise<void>(() => undefined);
          },
          async kill() {
            events.push("server:kill");
          },
        };
      },
      async connect(endpoint) {
        events.push(`connect:${endpoint}`);
        return {
          async newContext() {
            throw new Error("not used by this lifecycle test");
          },
        };
      },
    },
  });

  await assert.rejects(
    Promise.race([
      browser.close(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El kill del BrowserServer no tuvo deadline")),
          100,
        );
      }),
    ]),
    /2 ms.*cerrar el servidor Chromium/i,
  );
  assert.deepEqual(events, [
    "launchServer",
    "wsEndpoint",
    "connect:ws://127.0.0.1:40151/playwright",
    "server:close",
    "server:kill",
  ]);
});

test("bounds a hanging BrowserServer kill without hiding its close deadline", async () => {
  const browser = await launchChromium(5, {
    chromium: {
      async launchServer() {
        return {
          wsEndpoint() {
            return "ws://127.0.0.1:40153/playwright";
          },
          async close() {
            await new Promise<void>(() => undefined);
          },
          async kill() {
            await new Promise<void>(() => undefined);
          },
        };
      },
      async connect() {
        return {
          async newContext() {
            throw new Error("not used by this lifecycle test");
          },
        };
      },
    },
  });

  await assert.rejects(
    Promise.race([
      browser.close(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El kill del BrowserServer no tuvo deadline")),
          100,
        );
      }),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /2 ms.*cerrar el servidor Chromium/i);
      assert.ok(error.cause instanceof Error);
      assert.match(
        error.cause.message,
        /2 ms.*forzar kill del servidor Chromium/i,
      );
      return true;
    },
  );
});

test("kills a BrowserServer that resolves after its launch deadline", async () => {
  const events: string[] = [];
  let releaseServer: (() => void) | undefined;
  let confirmKill: (() => void) | undefined;
  const killed = new Promise<void>((resolveKilled) => {
    confirmKill = resolveKilled;
  });
  const server = {
    wsEndpoint() {
      return "ws://127.0.0.1:40154/playwright";
    },
    async close() {},
    async kill() {
      events.push("server:kill");
      confirmKill?.();
    },
  };

  await assert.rejects(
    launchChromium(5, {
      chromium: {
        async launchServer() {
          return await new Promise<typeof server>((resolveServer) => {
            releaseServer = () => resolveServer(server);
          });
        },
        async connect() {
          assert.fail("a late BrowserServer must be killed before connect");
        },
      },
    }),
    /5 ms.*iniciar el servidor Chromium/i,
  );
  assert.ok(releaseServer);
  releaseServer();
  await Promise.race([
    killed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("El BrowserServer tardío no recibió kill")),
        100,
      );
    }),
  ]);
  assert.deepEqual(events, ["server:kill"]);
});

test("kills an acquired BrowserServer after a failed or late Chromium connection", async () => {
  for (const connection of ["failed", "late"] as const) {
    const events: string[] = [];
    await assert.rejects(
      Promise.race([
        launchChromium(5, {
          chromium: {
            async launchServer() {
              events.push("launchServer");
              return {
                wsEndpoint() {
                  events.push("wsEndpoint");
                  return "ws://127.0.0.1:40152/playwright";
                },
                async close() {
                  events.push("server:close");
                },
                async kill() {
                  events.push("server:kill");
                },
              };
            },
            async connect() {
              events.push("connect");
              if (connection === "failed") throw new Error("connect exploded");
              await new Promise<void>(() => undefined);
              throw new Error("unreachable");
            },
          },
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("La conexión Chromium no tuvo deadline")),
            100,
          );
        }),
      ]),
      connection === "failed"
        ? /connect exploded/
        : /5 ms.*conectar Chromium/i,
    );
    assert.deepEqual(events, ["launchServer", "wsEndpoint", "connect", "server:kill"]);
  }
});

test("finishes the BrowserServer kill before visual parity returns from browser cleanup", async () => {
  let killed = false;
  const browser = await launchChromium(30, {
    chromium: {
      async launchServer() {
        return {
          wsEndpoint() {
            return "ws://127.0.0.1:40155/playwright";
          },
          async close() {
            await new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("close root failure")), 25);
            });
          },
          async kill() {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            killed = true;
          },
        };
      },
      async connect() {
        return {
          async newContext() {
            throw new Error("the injected capture does not use newContext");
          },
        };
      },
    },
  });
  const events: string[] = [];
  const dependencies = lifecycleDependencies({ events });
  dependencies.launchBrowser = async () => browser;

  await assert.rejects(
    Promise.race([
      runVisualParity(
        {
          scope: "foundation",
          allowPending: true,
          root: "/candidate",
          lifecycleTimeoutMs: 30,
        },
        dependencies,
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El cleanup Chromium no terminó")),
          150,
        );
      }),
    ]),
  );
  assert.equal(killed, true);
  assert.ok(events.includes("archive:close"));
});

test("finishes raw Worker teardown before visual parity returns from candidate cleanup", async () => {
  let tornDown = false;
  const candidate = await startCandidateRuntime(
    {
      deployConfigPath: "/candidate/.wrangler/deploy/config.json",
      wranglerConfigPath: "/candidate/dist/server/wrangler.json",
      entryPath: "/candidate/dist/server/entry.mjs",
    },
    30,
    {
      async startWorker() {
        return {
          ready: Promise.resolve(),
          async fetch() {
            return new Response("unused");
          },
          async dispose() {
            await new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("dispose root failure")), 27);
            });
          },
          raw: {
            async teardown() {
              await new Promise((resolvePromise) =>
                setTimeout(resolvePromise, 5),
              );
              tornDown = true;
            },
          },
        };
      },
      async startBridge() {
        return {
          origin: "http://127.0.0.1:40156",
          async dispose() {},
        };
      },
    },
  );
  const events: string[] = [];
  const dependencies = lifecycleDependencies({ events });
  dependencies.startCandidate = async () => candidate;

  await assert.rejects(
    Promise.race([
      runVisualParity(
        {
          scope: "foundation",
          allowPending: true,
          root: "/candidate",
          lifecycleTimeoutMs: 30,
        },
        dependencies,
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El cleanup Worker no terminó")),
          150,
        );
      }),
    ]),
  );
  assert.equal(tornDown, true);
  assert.ok(events.includes("archive:close"));
});

test("waits for raw Worker teardown when candidate readiness fails during acquisition", async () => {
  let tornDown = false;
  const events: string[] = [];
  const dependencies = lifecycleDependencies({ events });
  dependencies.startCandidate = async (topology) =>
    startCandidateRuntime(topology, 30, {
      async startWorker() {
        return {
          ready: new Promise<void>(() => undefined),
          async fetch() {
            return new Response("unused");
          },
          async dispose() {
            await new Promise<void>(() => undefined);
          },
          raw: {
            async teardown() {
              await new Promise((resolvePromise) =>
                setTimeout(resolvePromise, 5),
              );
              tornDown = true;
            },
          },
        };
      },
      async startBridge() {
        throw new Error("the Worker must become ready before the bridge starts");
      },
    });

  await assert.rejects(
    Promise.race([
      runVisualParity(
        {
          scope: "foundation",
          allowPending: true,
          root: "/candidate",
          lifecycleTimeoutMs: 30,
        },
        dependencies,
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El teardown Worker no terminó durante adquisición")),
          250,
        );
      }),
    ]),
    /30 ms.*esperar el Worker candidato listo/i,
  );
  assert.equal(tornDown, true);
  assert.ok(events.includes("archive:close"));
});

test("waits for BrowserServer kill when Chromium connection fails during acquisition", async () => {
  let killed = false;
  const events: string[] = [];
  const dependencies = lifecycleDependencies({ events });
  dependencies.launchBrowser = () =>
    launchChromium(30, {
      chromium: {
        async launchServer() {
          return {
            wsEndpoint() {
              return "ws://127.0.0.1:40157/playwright";
            },
            async close() {},
            async kill() {
              await new Promise((resolvePromise) =>
                setTimeout(resolvePromise, 15),
              );
              killed = true;
            },
          };
        },
        async connect() {
          return new Promise<never>(() => undefined);
        },
      },
    });

  await assert.rejects(
    Promise.race([
      runVisualParity(
        {
          scope: "foundation",
          allowPending: true,
          root: "/candidate",
          lifecycleTimeoutMs: 30,
        },
        dependencies,
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El kill Chromium no terminó durante adquisición")),
          250,
        );
      }),
    ]),
    /30 ms.*conectar Chromium/i,
  );
  assert.equal(killed, true);
  assert.ok(events.includes("archive:close"));
});

test("terminates a timed-out candidate build process group including a TERM-resistant descendant", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "visual-command-timeout-"));
  const descendantPidPath = join(root, "descendant.pid");
  const markerPath = join(root, "descendant-survived.txt");
  let descendantPid: number | undefined;
  try {
    await writeFile(
      join(root, "parent.mjs"),
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, [new URL("./descendant.mjs", import.meta.url).pathname, process.argv[3]], { stdio: "ignore" });
writeFileSync(process.argv[2], String(child.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    );
    await writeFile(
      join(root, "descendant.mjs"),
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(process.argv[2], "descendant survived"), 2_500);
setInterval(() => {}, 1_000);
`,
    );

    await assert.rejects(
      runVisualCommand(
        process.execPath,
        ["parent.mjs", descendantPidPath, markerPath],
        root,
        { timeoutMs: 1_000, terminationGraceMs: 200 },
      ),
      /1000 ms.*construir el candidato visual/i,
    );
    const capturedDescendantPid = Number(
      await readFile(descendantPidPath, "utf8"),
    );
    assert.ok(
      Number.isInteger(capturedDescendantPid) && capturedDescendantPid > 0,
    );
    descendantPid = capturedDescendantPid;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
    assert.equal(existsSync(markerPath), false);
    assert.throws(() => process.kill(capturedDescendantPid, 0), {
      code: "ESRCH",
    });
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The bounded process-group termination already removed it.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("waits deterministically, injects consent before navigation, captures full page, and exposes missing selectors", async () => {
  const events: string[] = [];
  const storage = new Map<string, string>();
  let registeredRoute:
    | ((route: {
        request(): { url(): string };
        continue(): Promise<void>;
        fulfill(options: unknown): Promise<void>;
      }) => Promise<void>)
    | undefined;
  let contextClosed = false;
  let fontsReady = false;
  let imagesReady = false;
  let navigationTimeout: number | undefined;

  const image = {
    complete: false,
    addEventListener(name: string, listener: () => void) {
      if (name === "load") queueMicrotask(listener);
    },
  };
  const element = {
    getBoundingClientRect() {
      return { x: 1.236, y: 2.344, width: 30.009, height: 40.001 };
    },
  };
  const page = {
    setDefaultNavigationTimeout(timeout: number) {
      navigationTimeout = timeout;
    },
    async goto(
      url: string,
      options: { waitUntil: "networkidle" },
    ): Promise<void> {
      assert.equal(url, "http://127.0.0.1:40123/");
      assert.deepEqual(options, { waitUntil: "networkidle" });
      assert.equal(navigationTimeout, 30_000);
      assert.equal(storage.get("comunidad-solar-cookie-consent-v1"), "necessary");
      assert.ok(registeredRoute, "network policy must be active before goto");
      events.push("goto");
    },
    async evaluate(callback: () => Promise<unknown>): Promise<unknown> {
      assert.deepEqual(events, ["consent", "goto"]);
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { fonts: { ready: Promise.resolve() } },
      });
      try {
        const result = await callback();
        fontsReady = true;
        events.push("fonts");
        return result;
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
        else Reflect.deleteProperty(globalThis, "document");
      }
    },
    locator(selector: string) {
      return {
        async evaluateAll(
          callback: (
            items: unknown[],
            argument?: unknown,
          ) => Promise<unknown> | unknown,
          argument?: unknown,
        ): Promise<unknown> {
          if (selector === "img") {
            assert.ok(fontsReady, "images wait after document.fonts.ready");
            const result = await callback([image], argument);
            imagesReady = true;
            events.push("images");
            return result;
          }
          assert.ok(imagesReady, "geometry follows all image load/error waits");
          if (selector === "footer") return callback([], argument);
          return callback([element], argument);
        },
      };
    },
    async screenshot(options: { fullPage: true }): Promise<Buffer> {
      assert.deepEqual(options, { fullPage: true });
      assert.ok(imagesReady, "screenshot follows image completion");
      events.push("screenshot");
      return createPng(1, 1);
    },
  };
  const context = {
    async addInitScript(callback: () => void): Promise<void> {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { setItem: (key: string, value: string) => storage.set(key, value) },
      });
      try {
        callback();
        events.push("consent");
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
        else Reflect.deleteProperty(globalThis, "localStorage");
      }
    },
    async route(
      _pattern: string,
      handler: typeof registeredRoute,
    ): Promise<void> {
      registeredRoute = handler;
    },
    async newPage() {
      return page;
    },
    async close() {
      contextClosed = true;
    },
  };
  let receivedContextOptions: unknown;
  const browser = {
    async newContext(options: unknown) {
      receivedContextOptions = options;
      return context;
    },
  };

  const capture = await captureDeterministicPage({
    browser,
    side: "reference",
    url: "http://127.0.0.1:40123/",
    viewport: VISUAL_VIEWPORTS[1],
    selectors: ["body", "main", "footer"],
    localOrigins: ["http://127.0.0.1:40123"],
    headers: { "x-visual-z": "last", "x-visual-a": "first" },
    fixtures: [],
  });

  assert.deepEqual(
    receivedContextOptions,
    CAPTURE_CONTEXT_OPTIONS(VISUAL_VIEWPORTS[1], {
      "x-visual-z": "last",
      "x-visual-a": "first",
    }),
  );
  assert.deepEqual(capture.geometry, [
    box("body", 0, 1.24, 2.34, 30.01, 40),
    box("main", 0, 1.24, 2.34, 30.01, 40),
  ]);
  assert.deepEqual(capture.missingSelectors, ["footer"]);
  assert.equal(navigationTimeout, 30_000);
  assert.deepEqual(events, ["consent", "goto", "fonts", "images", "screenshot"]);
  assert.equal(contextClosed, true);
});

test("activates lazy images before waiting without mutating their source state", async () => {
  let contextClosed = false;
  let loading = "lazy";
  const source = "http://127.0.0.1:40128/media/lazy-image.jpg";
  const currentSrc = "http://127.0.0.1:40128/media/lazy-image.jpg";
  const events: string[] = [];
  const image = {
    src: source,
    currentSrc,
    complete: false,
    naturalWidth: 0,
    get loading() {
      return loading;
    },
    set loading(value: string) {
      loading = value;
      events.push(`loading:${value}`);
    },
    addEventListener(name: string, listener: () => void) {
      assert.equal(
        loading,
        "eager",
        "lazy image must be activated before waiting",
      );
      events.push(`${name}:listener`);
      if (name === "load") queueMicrotask(listener);
    },
  };
  const geometryElement = {
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1, height: 1 };
    },
  };
  const context = {
    async addInitScript() {},
    async route() {},
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        async goto() {},
        async evaluate() {},
        locator(selector: string) {
          return {
            async evaluateAll(
              callback: (
                items: unknown[],
                argument?: unknown,
              ) => Promise<unknown> | unknown,
              argument?: unknown,
            ) {
              return callback(
                selector === "img" ? [image] : [geometryElement],
                argument,
              );
            },
          };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    async close() {
      contextClosed = true;
    },
  };

  await captureDeterministicPage({
    browser: { async newContext() { return context; } },
    side: "reference",
    url: "http://127.0.0.1:40128/",
    viewport: desktop,
    selectors: ["body"],
    localOrigins: ["http://127.0.0.1:40128"],
    fixtures: [],
  });

  assert.equal(image.src, source);
  assert.equal(image.currentSrc, currentSrc);
  assert.equal(loading, "eager");
  assert.deepEqual(events, ["loading:eager", "load:listener", "error:listener"]);
  assert.equal(contextClosed, true);
});

test("passes the geometry selector explicitly so its Playwright callback survives serialization", async () => {
  let contextClosed = false;
  const geometryElement = {
    getBoundingClientRect() {
      return { x: 1.234, y: 2.345, width: 30.006, height: 40.007 };
    },
  };
  const context = {
    async addInitScript() {},
    async route() {},
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        async goto() {},
        async evaluate() {},
        locator(selector: string) {
          return {
            async evaluateAll(
              callback: (
                items: unknown[],
                argument?: unknown,
              ) => Promise<unknown> | unknown,
              argument?: unknown,
            ) {
              if (selector === "img") {
                return callback([
                  {
                    loading: "eager",
                    complete: true,
                    naturalWidth: 1,
                  },
                ]);
              }
              const reconstructed = runInNewContext(
                `(${callback.toString()})`,
              ) as (
                items: unknown[],
                argument?: unknown,
              ) => Promise<unknown> | unknown;
              return reconstructed([geometryElement], argument);
            },
          };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    async close() {
      contextClosed = true;
    },
  };

  const capture = await captureDeterministicPage({
    browser: { async newContext() { return context; } },
    side: "candidate",
    url: "http://127.0.0.1:40129/",
    viewport: desktop,
    selectors: ["main"],
    localOrigins: ["http://127.0.0.1:40129"],
    fixtures: [],
  });

  assert.deepEqual(capture.geometry, [
    box("main", 0, 1.23, 2.35, 30.01, 40.01),
  ]);
  assert.equal(contextClosed, true);
});

test("closes a capture context when bounded navigation times out", async () => {
  let contextClosed = false;
  const context = {
    async addInitScript() {},
    async route() {},
    async newPage() {
      return {
        async goto() {
          throw new Error("Navigation timeout of 30000 ms exceeded");
        },
      };
    },
    async close() {
      contextClosed = true;
    },
  };

  await assert.rejects(
    captureDeterministicPage({
      browser: { async newContext() { return context; } },
      side: "reference",
      url: "http://127.0.0.1:40124/",
      viewport: desktop,
      selectors: ["body"],
      localOrigins: ["http://127.0.0.1:40124"],
      fixtures: [],
    }),
    /Navigation timeout of 30000 ms exceeded/,
  );
  assert.equal(contextClosed, true);
});

test("closes a context that resolves after the bounded context-creation deadline", async () => {
  let resolveContext: (context: unknown) => void = () => undefined;
  const delayedContext = new Promise<unknown>((resolvePromise) => {
    resolveContext = resolvePromise;
  });
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const lateContext = {
    async close() {
      resolveClosed();
    },
  };

  await assert.rejects(
    captureDeterministicPage({
      browser: { async newContext() { return delayedContext; } },
      side: "reference",
      url: "http://127.0.0.1:40135/",
      viewport: desktop,
      selectors: ["body"],
      localOrigins: ["http://127.0.0.1:40135"],
      fixtures: [],
      timeoutMs: 5,
    }),
    /5 ms.*crear el contexto aislado/i,
  );

  resolveContext(lateContext);
  await Promise.race([
    closed,
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error("El contexto tardío no se cerró")), 100);
    }),
  ]);
});

test("bounds a hanging context close with the capture target", async () => {
  const context = readyCaptureContext({
    async close() {
      await new Promise<void>(() => undefined);
    },
  });

  await assert.rejects(
    Promise.race([
      captureDeterministicPage({
        browser: { async newContext() { return context; } },
        side: "candidate",
        url: "http://127.0.0.1:40136/",
        viewport: desktop,
        selectors: ["body"],
        localOrigins: ["http://127.0.0.1:40136"],
        fixtures: [],
        timeoutMs: 5,
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("La captura permaneció bloqueada al cerrar")),
          100,
        );
      }),
    ]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /5 ms.*cerrar el contexto aislado/i);
      assert.match(message, /url=http:\/\/127\.0\.0\.1:40136\//);
      assert.match(message, /viewport=desktop:1440x900/);
      return true;
    },
  );
});

test("preserves the capture failure when bounded context close also times out", async () => {
  const context = readyCaptureContext({
    async goto() {
      throw new Error("navigation root failure");
    },
    async close() {
      await new Promise<void>(() => undefined);
    },
  });

  await assert.rejects(
    Promise.race([
      captureDeterministicPage({
        browser: { async newContext() { return context; } },
        side: "reference",
        url: "http://127.0.0.1:40137/",
        viewport: desktop,
        selectors: ["body"],
        localOrigins: ["http://127.0.0.1:40137"],
        fixtures: [],
        timeoutMs: 5,
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("La captura ocultó el fallo de navegación")),
          100,
        );
      }),
    ]),
    /navigation root failure/,
  );
});

test("bounds document fonts and closes a capture context instead of hanging", async () => {
  let contextClosed = false;
  const context = {
    async addInitScript() {},
    async route() {},
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        async goto() {},
        async evaluate() {
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
        locator() {
          return { async evaluateAll() { return []; } };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    async close() {
      contextClosed = true;
    },
  };

  await assert.rejects(
    captureDeterministicPage({
      browser: { async newContext() { return context; } },
      side: "reference",
      url: "http://127.0.0.1:40125/",
      viewport: desktop,
      selectors: ["body"],
      localOrigins: ["http://127.0.0.1:40125"],
      fixtures: [],
      timeoutMs: 5,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /5 ms.*document\.fonts\.ready/i);
      assert.match(message, /url=http:\/\/127\.0\.0\.1:40125\//);
      assert.match(message, /viewport=desktop:1440x900/);
      return true;
    },
  );
  assert.equal(contextClosed, true);
});

test("surfaces an undeclared external image URL instead of timing out its wait", async () => {
  let contextClosed = false;
  let handler:
    | ((route: ReturnType<typeof createRoute>["route"]) => Promise<void>)
    | undefined;
  const absent = createRoute("https://absent.example.test/slow-image.png");
  const context = {
    async addInitScript() {},
    async route(
      _pattern: string,
      registered: typeof handler,
    ): Promise<void> {
      handler = registered;
    },
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        async goto() {},
        async evaluate() {},
        locator(selector: string) {
          return {
            async evaluateAll() {
              if (selector === "img") {
                assert.ok(handler);
                await assert.rejects(handler(absent.route), /Solicitud externa sin fixture visual/);
                await new Promise((resolve) => setTimeout(resolve, 30));
              }
              return [];
            },
          };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    async close() {
      contextClosed = true;
    },
  };

  await assert.rejects(
    captureDeterministicPage({
      browser: { async newContext() { return context; } },
      side: "reference",
      url: "http://127.0.0.1:40126/",
      viewport: desktop,
      selectors: ["body"],
      localOrigins: ["http://127.0.0.1:40126"],
      fixtures: [],
      timeoutMs: 5,
    }),
    /Solicitud externa sin fixture visual: https:\/\/absent\.example\.test\/slow-image\.png/,
  );
  assert.equal(contextClosed, true);
});

test("fails closed when an undeclared external request arrives during context close", async () => {
  let contextClosed = false;
  let handler:
    | ((route: ReturnType<typeof createRoute>["route"]) => Promise<void>)
    | undefined;
  const lateRequest = createRoute("https://late.example.test/close.js");
  const geometryElement = {
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1, height: 1 };
    },
  };
  const context = {
    async addInitScript() {},
    async route(
      _pattern: string,
      registered: typeof handler,
    ): Promise<void> {
      handler = registered;
    },
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        async goto() {},
        async evaluate() {},
        locator(selector: string) {
          return {
            async evaluateAll(
              callback: (
                items: unknown[],
                argument?: unknown,
              ) => Promise<unknown> | unknown,
              argument?: unknown,
            ) {
              if (selector === "img") {
                return callback(
                  [
                    {
                      loading: "eager",
                      complete: true,
                      naturalWidth: 1,
                    },
                  ],
                  argument,
                );
              }
              return callback([geometryElement], argument);
            },
          };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    async close() {
      contextClosed = true;
      assert.ok(handler);
      await assert.rejects(
        handler(lateRequest.route),
        /Solicitud externa sin fixture visual: https:\/\/late\.example\.test\/close\.js/,
      );
    },
  };

  await assert.rejects(
    captureDeterministicPage({
      browser: { async newContext() { return context; } },
      side: "candidate",
      url: "http://127.0.0.1:40130/",
      viewport: desktop,
      selectors: ["body"],
      localOrigins: ["http://127.0.0.1:40130"],
      fixtures: [],
    }),
    /Solicitud externa sin fixture visual: https:\/\/late\.example\.test\/close\.js/,
  );
  assert.equal(contextClosed, true);
});

test("keeps a late external request visible when context close also fails", async () => {
  let handler:
    | ((route: ReturnType<typeof createRoute>["route"]) => Promise<void>)
    | undefined;
  const lateRequest = createRoute("https://late.example.test/close-failure.js");
  const geometryElement = {
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1, height: 1 };
    },
  };
  const context = {
    async addInitScript() {},
    async route(
      _pattern: string,
      registered: typeof handler,
    ): Promise<void> {
      handler = registered;
    },
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        async goto() {},
        async evaluate() {},
        locator(selector: string) {
          return {
            async evaluateAll(
              callback: (
                items: unknown[],
                argument?: unknown,
              ) => Promise<unknown> | unknown,
              argument?: unknown,
            ) {
              if (selector === "img") {
                return callback(
                  [
                    {
                      loading: "eager",
                      complete: true,
                      naturalWidth: 1,
                    },
                  ],
                  argument,
                );
              }
              return callback([geometryElement], argument);
            },
          };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    async close() {
      assert.ok(handler);
      await assert.rejects(
        handler(lateRequest.route),
        /Solicitud externa sin fixture visual: https:\/\/late\.example\.test\/close-failure\.js/,
      );
      throw new Error("close root failure");
    },
  };

  await assert.rejects(
    captureDeterministicPage({
      browser: { async newContext() { return context; } },
      side: "candidate",
      url: "http://127.0.0.1:40131/",
      viewport: desktop,
      selectors: ["body"],
      localOrigins: ["http://127.0.0.1:40131"],
      fixtures: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Solicitud externa sin fixture visual: https:\/\/late\.example\.test\/close-failure\.js/,
      );
      const cause = (error as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.match(cause.message, /close root failure/);
      return true;
    },
  );
});

test("reports a bounded deterministic pending-image diagnostic with the capture side", async () => {
  let contextClosed = false;
  let imageEvaluation = 0;
  const excessivelyLongSource = `https://images.example.test/${"x".repeat(600)}\nunsafe`;
  const pendingImages = [
    {
      src: excessivelyLongSource,
      currentSrc: "",
      loading: "lazy",
      complete: false,
      naturalWidth: 0,
      addEventListener() {},
    },
    {
      src: "https://images.example.test/a.png",
      currentSrc: "https://cdn.example.test/a.png",
      loading: "eager",
      complete: false,
      naturalWidth: 0,
      addEventListener() {},
    },
  ];
  const context = {
    async addInitScript() {},
    async route() {},
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        async goto() {},
        async evaluate() {},
        locator(selector: string) {
          return {
            async evaluateAll(callback: (items: unknown[]) => Promise<unknown> | unknown) {
              if (selector !== "img") return callback([]);
              imageEvaluation += 1;
              return callback(pendingImages);
            },
          };
        },
        async screenshot() {
          return createPng(1, 1);
        },
      };
    },
    async close() {
      contextClosed = true;
    },
  };

  await assert.rejects(
    captureDeterministicPage({
      browser: { async newContext() { return context; } },
      side: "reference",
      url: "http://127.0.0.1:40127/",
      viewport: desktop,
      selectors: ["body"],
      localOrigins: ["http://127.0.0.1:40127"],
      fixtures: [],
      timeoutMs: 5,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /side=reference/);
      assert.match(message, /pendingImages=/);
      const serialized = message.split("pendingImages=")[1];
      assert.ok(serialized);
      const diagnostics = JSON.parse(serialized) as Array<Record<string, unknown>>;
      assert.equal(imageEvaluation, 2);
      assert.equal(diagnostics.length, 2);
      assert.deepEqual(
        diagnostics[0],
        {
          src: "https://images.example.test/a.png",
          currentSrc: "https://cdn.example.test/a.png",
          loading: "eager",
          complete: false,
          naturalWidth: 0,
        },
      );
      assert.ok(String(diagnostics[1]?.src).length <= 256);
      assert.doesNotMatch(JSON.stringify(diagnostics), /\nunsafe/);
      return true;
    },
  );
  assert.equal(contextClosed, true);
});

function createRoute(url: string) {
  const calls: { continued: boolean; fulfilled: unknown[] } = {
    continued: false,
    fulfilled: [],
  };
  return {
    calls,
    route: {
      request: () => ({ url: () => url }),
      continue: async () => {
        calls.continued = true;
      },
      fulfill: async (options: unknown) => {
        calls.fulfilled.push(options);
      },
    },
  };
}

test("fails closed for undeclared external requests and serves the same fixture on both sides", async () => {
  let handler: ((route: ReturnType<typeof createRoute>["route"]) => Promise<void>) | undefined;
  await installCaptureNetworkPolicy(
    {
      async route(
        _pattern: string,
        registered: typeof handler,
      ): Promise<void> {
        handler = registered;
      },
    },
    {
      localOrigins: ["http://127.0.0.1:40125", "http://127.0.0.1:40126"],
      fixtures: [
        {
          url: "https://fixtures.example.test/font.woff2",
          status: 203,
          headers: { "content-type": "font/woff2", "x-fixture": "exact" },
          body: Buffer.from([0, 1, 2, 3]),
        },
      ],
    },
  );
  assert.ok(handler);

  const absent = createRoute("https://absent.example.test/script.js");
  await assert.rejects(handler(absent.route), /fixture.*https:\/\/absent\.example\.test\/script\.js/i);

  const reference = createRoute("https://fixtures.example.test/font.woff2");
  const candidate = createRoute("https://fixtures.example.test/font.woff2");
  await handler(reference.route);
  await handler(candidate.route);
  assert.deepEqual(reference.calls.fulfilled, candidate.calls.fulfilled);
  assert.deepEqual(reference.calls.fulfilled, [
    {
      status: 203,
      headers: { "content-type": "font/woff2", "x-fixture": "exact" },
      body: Buffer.from([0, 1, 2, 3]),
    },
  ]);

  for (const allowed of [
    "http://127.0.0.1:40125/local.css",
    "http://127.0.0.1:40126/local.css",
    "data:text/plain,fixture",
    "blob:http://127.0.0.1:40125/fixture",
  ]) {
    const route = createRoute(allowed);
    await handler(route.route);
    assert.equal(route.calls.continued, true);
  }
});

function foundationMatrix(): RouteMatrixEntry[] {
  return [
    {
      path: "/",
      kind: "page",
      sourceFile: "app/page.tsx",
      fixtureId: null,
      expectedStatus: 200,
      expectedLocation: null,
      privateArea: null,
      visualTemplate: "home",
      status: "pending",
    },
    {
      path: "/blog",
      kind: "page",
      sourceFile: "app/blog/page.tsx",
      fixtureId: null,
      expectedStatus: 200,
      expectedLocation: null,
      privateArea: null,
      visualTemplate: "blog-list",
      status: "pending",
    },
  ];
}

function publicVisualMatrix(): RouteMatrixEntry[] {
  return [
    ...foundationMatrix(),
    {
      path: "/comunidades-energeticas/manganafer",
      kind: "page",
      sourceFile: "app/manganafer/page.tsx",
      fixtureId: null,
      expectedStatus: 200,
      expectedLocation: null,
      privateArea: null,
      visualTemplate: "manganafer",
      status: "pending",
    },
    {
      path: "/socios",
      kind: "private-page",
      sourceFile: "app/socios/page.tsx",
      fixtureId: null,
      expectedStatus: 200,
      expectedLocation: null,
      privateArea: "socios",
      visualTemplate: "private",
      status: "pending",
    },
  ];
}

function privateGuideVisualMatrix(): RouteMatrixEntry[] {
  return [
    {
      path: "/guia-equipo",
      kind: "private-page",
      sourceFile: "app/guia-equipo/page.tsx",
      fixtureId: null,
      expectedStatus: 200,
      expectedLocation: null,
      privateArea: "equipo",
      visualTemplate: "team-guide",
      status: "pending",
    },
  ];
}

function lifecycleDependencies(options: {
  failCapture?: boolean;
  failReport?: boolean;
  hangDispose?: "browser" | "candidate" | "reference";
  matrix?: RouteMatrixEntry[];
  events: string[];
}): VisualParityDependencies {
  const dispose = (name: string) => async () => {
    options.events.push(`${name}:dispose`);
    if (options.hangDispose === name) {
      await new Promise<void>(() => undefined);
    }
  };
  return {
    assertSourcePristine: async () => undefined,
    buildCandidate: async () => {
      options.events.push("candidate:build");
    },
    resolveCandidateTopology: async () => ({
      deployConfigPath: "/candidate/.wrangler/deploy/config.json",
      wranglerConfigPath: "/candidate/dist/server/wrangler.json",
      entryPath: "/candidate/dist/server/entry.mjs",
    }),
    readMatrix: async () => options.matrix ?? foundationMatrix(),
    startCandidate: async () => ({
      origin: "http://127.0.0.1:40127",
      dispose: dispose("candidate"),
    }),
    withTemporarySourceBuild: async <T>(
      callback: (build: { root: string; sourceRoot: string; commit: string; logRoot: string }) => Promise<T>,
    ): Promise<T> => {
      options.events.push("archive:open");
      try {
        return await callback({
          root: "/archive/source",
          sourceRoot: "/reference",
          commit: "68ea294c54dc5e15e20f470fc421a239927565a8",
          logRoot: "/logs",
        });
      } finally {
        options.events.push("archive:close");
      }
    },
    startReference: async () => ({
      origin: "http://127.0.0.1:40128",
      dispose: dispose("reference"),
    }),
    launchBrowser: async () => ({
      async newContext() {
        throw new Error("The injected capture must avoid a real browser context");
      },
      close: dispose("browser"),
    }),
    capture: async ({ route, side, viewport }: VisualCaptureInput) => {
      options.events.push(`capture:${route.path}:${side}:${viewport.name}`);
      if (options.failCapture && side === "candidate" && viewport.name === "desktop") {
        throw new Error("capture exploded");
      }
      return {
        screenshot: createPng(1, 1),
        geometry: [box("body", 0, 0, 0, 1, 1)],
        missingSelectors: [],
      };
    },
    writeReports: async () => {
      options.events.push("report:write");
      if (options.failReport) throw new Error("report exploded");
      return {
        root: ".artifacts/visual/foundation",
        json: ".artifacts/visual/foundation/summary.json",
        html: ".artifacts/visual/foundation/summary.html",
      };
    },
  };
}

test("selects only the pending home smoke, produces three pending results, and never calls it matched", async () => {
  assert.deepEqual(selectFoundationVisualRoutes(foundationMatrix()), [foundationMatrix()[0]]);

  const events: string[] = [];
  const result = await runVisualParity(
    { scope: "foundation", allowPending: true, root: "/candidate" },
    lifecycleDependencies({ events }),
  );

  assert.equal(result.results.length, 3);
  assert.deepEqual(
    result.results.map((entry) => entry.viewport),
    VISUAL_VIEWPORTS,
  );
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["pending", "pending", "pending"],
  );
  assert.deepEqual(result.summary, {
    routes: 1,
    results: 3,
    matched: 0,
    reviewRequired: 0,
    pending: 3,
  });
  const stdout = formatVisualParitySummary(result);
  assert.match(stdout, /^VISUAL_PARITY_PENDING /);
  assert.doesNotMatch(stdout, /matched|verified|ok/i);
  assert.ok(events.includes("archive:close"));
  assert.ok(events.includes("reference:dispose"));
  assert.ok(events.includes("candidate:dispose"));
  assert.ok(events.includes("browser:dispose"));
});

test("selects and captures every non-deferred public visual page scope", async () => {
  const matrix = publicVisualMatrix();
  assert.deepEqual(selectPublicVisualRoutes(matrix), [matrix[0], matrix[1]]);
  assert.deepEqual(parseVisualArguments(["--scope", "public", "--allow-pending"]), {
    scope: "public",
    routes: undefined,
    allowPending: true,
  });

  const events: string[] = [];
  const result = await runVisualParity(
    { scope: "public", allowPending: true, root: "/candidate" },
    lifecycleDependencies({ events, matrix }),
  );
  assert.equal(result.scope, "public");
  assert.equal(result.summary.routes, 2);
  assert.equal(result.results.length, 6);
  assert.equal(events.some((event) => event.includes("manganafer")), false);
});

test("selects exactly the requested pending visual routes and rejects an ambiguous route CLI", () => {
  const matrix = [
    ...foundationMatrix(),
    {
      path: "/baterias",
      kind: "page" as const,
      sourceFile: "app/[slug]/page.tsx",
      fixtureId: "baterias",
      expectedStatus: 200,
      expectedLocation: null,
      privateArea: null,
      visualTemplate: "generic-page",
      status: "pending",
    },
    {
      path: "/mantenimiento",
      kind: "page" as const,
      sourceFile: "app/[slug]/page.tsx",
      fixtureId: "mantenimiento",
      expectedStatus: 200,
      expectedLocation: null,
      privateArea: null,
      visualTemplate: "generic-page",
      status: "pending",
    },
  ];

  assert.deepEqual(
    selectVisualRoutes(matrix, ["/mantenimiento", "/baterias"]),
    [matrix[2], matrix[3]],
  );
  assert.deepEqual(
    parseVisualArguments([
      "--routes",
      "/mantenimiento,/baterias",
      "--allow-pending",
    ]),
    {
      scope: "foundation",
      routes: ["/mantenimiento", "/baterias"],
      allowPending: true,
    },
  );
  assert.throws(
    () => selectVisualRoutes(matrix, ["/baterias", "/baterias"]),
    /duplicada/i,
  );
  assert.throws(
    () => selectVisualRoutes(matrix, ["/ausente"]),
    /no declarada/i,
  );
  assert.throws(
    () => parseVisualArguments(["--scope", "foundation", "--routes", "/baterias"]),
    /no se pueden combinar/i,
  );
});

test("requires exact, separate auth fixtures for private visual routes", () => {
  const [guide] = privateGuideVisualMatrix();

  assert.throws(
    () => selectVisualRoutes([guide], [guide.path]),
    /no es una página/i,
  );
  assert.deepEqual(
    selectVisualRoutes([guide], [guide.path], { allowPrivate: true }),
    [guide],
  );
  assert.deepEqual(
    parseVisualArguments([
      "--routes",
      guide.path,
      "--fixtures",
      "anonymous,allowed",
      "--allow-pending",
    ]),
    {
      scope: "foundation",
      routes: [guide.path],
      authFixtures: ["anonymous", "allowed"],
      allowPending: true,
    },
  );
  assert.deepEqual(
    parseVisualArguments([
      "--routes",
      guide.path,
      "--fixtures",
      "allowed,anonymous",
      "--allow-pending",
    ]),
    {
      scope: "foundation",
      routes: [guide.path],
      authFixtures: ["anonymous", "allowed"],
      allowPending: true,
    },
  );
  assert.deepEqual(
    resolveVisualAuthPlan([guide], ["anonymous", "allowed"]),
    {
      privateArea: "equipo",
      environment: {
        TEAM_ALLOWED_EMAILS: "visual-parity-auth@example.test",
      },
      fixtures: [
        { name: "anonymous", headers: {} },
        {
          name: "allowed",
          headers: {
            "oai-authenticated-user-email": "visual-parity-auth@example.test",
          },
        },
      ],
    },
  );
  assert.throws(
    () => parseVisualArguments(["--routes", guide.path, "--fixtures", ""]),
    /fixture.*vac/i,
  );
  assert.throws(
    () =>
      parseVisualArguments([
        "--routes",
        guide.path,
        "--fixtures",
        "anonymous,anonymous",
      ]),
    /fixture.*duplicad/i,
  );
  assert.throws(
    () =>
      parseVisualArguments([
        "--routes",
        guide.path,
        "--fixtures",
        "anonymous,denied",
      ]),
    /fixture.*desconocid/i,
  );
  assert.throws(
    () =>
      resolveVisualAuthPlan(
        [foundationMatrix()[0]],
        ["anonymous", "allowed"],
      ),
    /privad/i,
  );
});

test("uses the access-wall selectors for an anonymous guide and restores source process bindings after a failed fetch", async () => {
  const [guide] = privateGuideVisualMatrix();
  assert.deepEqual(
    selectVisualCaptureSelectors(guide, { name: "anonymous", headers: {} }),
    ["body", "header", "main.private-access-page", "footer"],
  );
  assert.deepEqual(
    selectVisualCaptureSelectors(guide, {
      name: "allowed",
      headers: { "oai-authenticated-user-email": "visual-parity-auth@example.test" },
    }),
    ["body", "header", "main.team-guide-page", "footer"],
  );

  const key = "TEAM_ALLOWED_EMAILS";
  const previous = process.env[key];
  process.env[key] = "preexisting@example.test";
  try {
    await assert.rejects(
      withVisualSourceEnvironment(
        { [key]: "visual-parity-auth@example.test" },
        async () => {
          assert.equal(process.env[key], "visual-parity-auth@example.test");
          throw new Error("source fetch failed");
        },
      ),
      /source fetch failed/,
    );
    assert.equal(process.env[key], "preexisting@example.test");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("serializes overlapping source environment scopes before restoring process bindings", async () => {
  const key = "TEAM_ALLOWED_EMAILS";
  const previous = process.env[key];
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolveFirstStarted) => {
    signalFirstStarted = resolveFirstStarted;
  });
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolveFirstMayFinish) => {
    releaseFirst = resolveFirstMayFinish;
  });
  let secondEntered = false;
  process.env[key] = "preexisting@example.test";
  try {
    const first = withVisualSourceEnvironment(
      { [key]: "first@example.test" },
      async () => {
        assert.equal(process.env[key], "first@example.test");
        signalFirstStarted();
        await firstMayFinish;
        assert.equal(process.env[key], "first@example.test");
        return "first";
      },
    );
    await firstStarted;
    const second = withVisualSourceEnvironment(
      { [key]: "second@example.test" },
      async () => {
        secondEntered = true;
        assert.equal(process.env[key], "second@example.test");
        return "second";
      },
    );

    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
    assert.equal(secondEntered, false);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.equal(process.env[key], "preexisting@example.test");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("does not let an empty source environment observe another request's bindings", async () => {
  const key = "TEAM_ALLOWED_EMAILS";
  const previous = process.env[key];
  let signalPrivateStarted!: () => void;
  const privateStarted = new Promise<void>((resolvePrivateStarted) => {
    signalPrivateStarted = resolvePrivateStarted;
  });
  let releasePrivate!: () => void;
  const privateMayFinish = new Promise<void>((resolvePrivateMayFinish) => {
    releasePrivate = resolvePrivateMayFinish;
  });
  let emptyEntered = false;
  let emptyObserved: string | undefined;
  let privateFetch: Promise<string> | undefined;
  process.env[key] = "preexisting@example.test";
  try {
    privateFetch = withVisualSourceEnvironment(
      { [key]: "private@example.test" },
      async () => {
        signalPrivateStarted();
        await privateMayFinish;
        return "private";
      },
    );
    await privateStarted;
    const emptyFetch = withVisualSourceEnvironment({}, async () => {
      emptyEntered = true;
      emptyObserved = process.env[key];
      return "empty";
    });

    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
    assert.equal(emptyEntered, false);
    releasePrivate();
    assert.deepEqual(await Promise.all([privateFetch, emptyFetch]), [
      "private",
      "empty",
    ]);
    assert.equal(emptyObserved, "preexisting@example.test");
  } finally {
    releasePrivate();
    await privateFetch?.catch(() => undefined);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("bounds queued source environment callers without mutating a timed-out scope", async () => {
  const key = "TEAM_ALLOWED_EMAILS";
  const previous = process.env[key];
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolveFirstStarted) => {
    signalFirstStarted = resolveFirstStarted;
  });
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolveFirstMayFinish) => {
    releaseFirst = resolveFirstMayFinish;
  });
  let secondEntered = false;
  process.env[key] = "preexisting@example.test";
  try {
    const first = withVisualSourceEnvironment(
      { [key]: "first@example.test" },
      async () => {
        signalFirstStarted();
        await firstMayFinish;
      },
      5,
    );
    await firstStarted;
    await assert.rejects(first, /superó 5 ms.*fetch fuente con entorno/i);

    await assert.rejects(
      withVisualSourceEnvironment(
        { [key]: "second@example.test" },
        async () => {
          secondEntered = true;
        },
        5,
      ),
      /superó 5 ms.*fetch fuente con entorno/i,
    );
    assert.equal(secondEntered, false);
    assert.equal(process.env[key], "first@example.test");

    releaseFirst();
    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
    assert.equal(process.env[key], "preexisting@example.test");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("isolates private visual evidence by auth fixture and closes all resources on a later-fixture failure", async () => {
  const events: string[] = [];
  const candidateEnvironments: Array<Record<string, string> | undefined> = [];
  const referenceEnvironments: Array<Record<string, string> | undefined> = [];
  const captured: Array<{
    side: string;
    fixture: string | undefined;
    headers: Record<string, string> | undefined;
  }> = [];
  const dependencies = lifecycleDependencies({
    events,
    matrix: privateGuideVisualMatrix(),
  });
  dependencies.startCandidate = async (_topology, _root, environment) => {
    candidateEnvironments.push(environment);
    return {
      origin: "http://127.0.0.1:40127",
      dispose: async () => {
        events.push("candidate:dispose");
      },
    };
  };
  dependencies.startReference = async (_build, environment) => {
    referenceEnvironments.push(environment);
    return {
      origin: "http://127.0.0.1:40128",
      dispose: async () => {
        events.push("reference:dispose");
      },
    };
  };
  dependencies.capture = async (input) => {
    captured.push({
      side: input.side,
      fixture: input.authFixture?.name,
      headers: input.authFixture?.headers,
    });
    if (
      input.side === "candidate" &&
      input.authFixture?.name === "allowed" &&
      input.viewport.name === "desktop"
    ) {
      throw new Error("allowed capture exploded");
    }
    return {
      screenshot: createPng(1, 1),
      geometry: [box("body", 0, 0, 0, 1, 1)],
      missingSelectors: [],
    };
  };

  await assert.rejects(
    runVisualParity(
      {
        scope: "foundation",
        routes: ["/guia-equipo"],
        authFixtures: ["anonymous", "allowed"],
        allowPending: true,
        root: "/candidate",
      },
      dependencies,
    ),
    /allowed capture exploded/,
  );
  assert.deepEqual(candidateEnvironments, [
    { TEAM_ALLOWED_EMAILS: "visual-parity-auth@example.test" },
  ]);
  assert.deepEqual(referenceEnvironments, [
    { TEAM_ALLOWED_EMAILS: "visual-parity-auth@example.test" },
  ]);
  assert.deepEqual(captured.slice(0, 2), [
    { side: "reference", fixture: "anonymous", headers: {} },
    { side: "candidate", fixture: "anonymous", headers: {} },
  ]);
  assert.deepEqual(captured.at(-1), {
    side: "candidate",
    fixture: "allowed",
    headers: {
      "oai-authenticated-user-email": "visual-parity-auth@example.test",
    },
  });
  assert.ok(events.includes("browser:dispose"));
  assert.ok(events.includes("reference:dispose"));
  assert.ok(events.includes("candidate:dispose"));
  assert.ok(events.includes("archive:close"));
});

test("keeps successful private visual artifacts and route keys disjoint per auth fixture", async () => {
  const events: string[] = [];
  const result = await runVisualParity(
    {
      scope: "foundation",
      routes: ["/guia-equipo"],
      authFixtures: ["anonymous", "allowed"],
      allowPending: true,
      root: "/candidate",
    },
    lifecycleDependencies({
      events,
      matrix: privateGuideVisualMatrix(),
    }),
  );

  assert.equal(result.results.length, 6);
  assert.deepEqual(result.summary, {
    routes: 2,
    results: 6,
    matched: 0,
    reviewRequired: 0,
    pending: 6,
  });
  assert.deepEqual(
    [...new Set(result.results.map((entry) => entry.routeKey))],
    [
      "private-page:/guia-equipo|fixture=anonymous",
      "private-page:/guia-equipo|fixture=allowed",
    ],
  );
  assert.equal(
    new Set(result.results.map((entry) => entry.files.reference)).size,
    6,
  );
  assert.ok(
    result.results
      .filter((entry) => entry.routeKey.endsWith("fixture=anonymous"))
      .every((entry) => entry.files.reference.includes("/anonymous/")),
  );
  assert.ok(
    result.results
      .filter((entry) => entry.routeKey.endsWith("fixture=allowed"))
      .every((entry) => entry.files.reference.includes("/allowed/")),
  );
  assert.ok(events.includes("archive:close"));
});

test("rejects pending foundation output without --allow-pending", async () => {
  const events: string[] = [];
  await assert.rejects(
    runVisualParity(
      { scope: "foundation", allowPending: false, root: "/candidate" },
      lifecycleDependencies({ events }),
    ),
    /pendiente.*--allow-pending/i,
  );
  assert.ok(events.includes("archive:close"));
  assert.ok(events.includes("reference:dispose"));
  assert.ok(events.includes("candidate:dispose"));
  assert.ok(events.includes("browser:dispose"));
});

test("cleans browser, both local runtimes, and the temporary archive after capture and report failures", async () => {
  for (const failure of ["capture", "report"] as const) {
    const events: string[] = [];
    await assert.rejects(
      runVisualParity(
        { scope: "foundation", allowPending: true, root: "/candidate" },
        lifecycleDependencies({
          events,
          failCapture: failure === "capture",
          failReport: failure === "report",
        }),
      ),
      failure === "capture" ? /capture exploded/ : /report exploded/,
    );
    assert.ok(events.includes("archive:close"), `${failure} closes archive`);
    assert.ok(events.includes("reference:dispose"), `${failure} closes reference`);
    assert.ok(events.includes("candidate:dispose"), `${failure} closes candidate`);
    assert.ok(events.includes("browser:dispose"), `${failure} closes browser`);
  }
});

test("bounds a hanging browser close and still cleans every outer visual resource", async () => {
  const events: string[] = [];
  await assert.rejects(
    Promise.race([
      runVisualParity(
        {
          scope: "foundation",
          allowPending: true,
          root: "/candidate",
          lifecycleTimeoutMs: 30,
        },
        lifecycleDependencies({ events, hangDispose: "browser" }),
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El cierre del navegador no tuvo deadline")),
          250,
        );
      }),
    ]),
    /30 ms.*cerrar el navegador/i,
  );
  assert.ok(events.includes("browser:dispose"));
  assert.ok(events.includes("reference:dispose"));
  assert.ok(events.includes("candidate:dispose"));
  assert.ok(events.includes("archive:close"));
});

test("preserves a capture failure when a browser close deadline also expires", async () => {
  const events: string[] = [];
  await assert.rejects(
    Promise.race([
      runVisualParity(
        {
          scope: "foundation",
          allowPending: true,
          root: "/candidate",
          lifecycleTimeoutMs: 30,
        },
        lifecycleDependencies({
          events,
          failCapture: true,
          hangDispose: "browser",
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El cierre ocultó capture exploded")),
          250,
        );
      }),
    ]),
    /capture exploded/,
  );
  assert.ok(events.includes("reference:dispose"));
  assert.ok(events.includes("candidate:dispose"));
  assert.ok(events.includes("archive:close"));
});

test("does not apply the source preparation deadline after its callback begins", async () => {
  const events: string[] = [];
  const dependencies = lifecycleDependencies({ events });
  dependencies.writeReports = async () => {
    events.push("report:write");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    return {
      root: ".artifacts/visual/foundation",
      json: ".artifacts/visual/foundation/summary.json",
      html: ".artifacts/visual/foundation/summary.html",
    };
  };

  const result = await Promise.race([
    runVisualParity(
      {
        scope: "foundation",
        allowPending: true,
        root: "/candidate",
        sourceBuildTimeoutMs: 5,
      },
      dependencies,
    ),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("El callback fuente no terminó normalmente")),
        100,
      );
    }),
  ]);

  assert.equal(result.summary.pending, 3);
  assert.ok(events.includes("browser:dispose"));
  assert.ok(events.includes("reference:dispose"));
  assert.ok(events.includes("candidate:dispose"));
  assert.ok(events.includes("archive:close"));
});

test("does not start a candidate when the source build expires before its callback", async () => {
  const events: string[] = [];
  let candidateStarts = 0;
  let lateCallback: (() => Promise<unknown>) | undefined;
  let processTimeoutMs: number | undefined;
  const dependencies = lifecycleDependencies({ events });
  dependencies.startCandidate = async () => {
    candidateStarts += 1;
    return {
      origin: "http://127.0.0.1:40144",
      async dispose() {},
    };
  };
  dependencies.withTemporarySourceBuild = async <T>(
    callback: (build: TemporarySourceBuild) => Promise<T>,
    sourceOptions?: TemporarySourceOptions,
  ) => {
    processTimeoutMs = sourceOptions?.processTimeoutMs;
    lateCallback = () =>
      callback({
        root: "/archive/source",
        sourceRoot: "/reference",
        commit: "68ea294c54dc5e15e20f470fc421a239927565a8",
        logRoot: "/logs",
      });
    return new Promise<T>(() => undefined);
  };

  await assert.rejects(
    Promise.race([
      runVisualParity(
        {
          scope: "foundation",
          allowPending: true,
          root: "/candidate",
          sourceBuildTimeoutMs: 5,
        },
        dependencies,
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El build fuente no recibió deadline global")),
          100,
        );
      }),
    ]),
    /5 ms.*build fuente temporal/i,
  );
  assert.equal(candidateStarts, 0);
  assert.equal(processTimeoutMs, 5);
  assert.ok(lateCallback);
  await assert.rejects(lateCallback(), /5 ms.*build fuente temporal/i);
  assert.equal(candidateStarts, 0);
});
