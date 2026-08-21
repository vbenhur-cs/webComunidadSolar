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
  readVisualFixtures,
  runVisualParity,
  runVisualCommand,
  selectFoundationVisualRoutes,
  sourceAssetFetcher,
  startCandidateRuntime,
  writeVisualReports,
  type VisualCaptureInput,
  type VisualParityDependencies,
} from "../../scripts/parity-visual.ts";
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

test("declares the three fixed capture viewports and home structural selectors", () => {
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
setTimeout(() => writeFileSync(process.argv[2], "descendant survived"), 250);
setInterval(() => {}, 1_000);
`,
    );

    await assert.rejects(
      runVisualCommand(
        process.execPath,
        ["parent.mjs", descendantPidPath, markerPath],
        root,
        { timeoutMs: 100, terminationGraceMs: 30 },
      ),
      /100 ms.*construir el candidato visual/i,
    );
    const capturedDescendantPid = Number(
      await readFile(descendantPidPath, "utf8"),
    );
    assert.ok(
      Number.isInteger(capturedDescendantPid) && capturedDescendantPid > 0,
    );
    descendantPid = capturedDescendantPid;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
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
    fixtures: [],
  });

  assert.deepEqual(receivedContextOptions, CAPTURE_CONTEXT_OPTIONS(VISUAL_VIEWPORTS[1]));
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

function lifecycleDependencies(options: {
  failCapture?: boolean;
  failReport?: boolean;
  hangDispose?: "browser" | "candidate" | "reference";
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
    readMatrix: async () => foundationMatrix(),
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
    capture: async ({ side, viewport }: VisualCaptureInput) => {
      options.events.push(`capture:${side}:${viewport.name}`);
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
          lifecycleTimeoutMs: 5,
        },
        lifecycleDependencies({ events, hangDispose: "browser" }),
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("El cierre del navegador no tuvo deadline")),
          100,
        );
      }),
    ]),
    /5 ms.*cerrar el navegador/i,
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
          lifecycleTimeoutMs: 5,
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
          100,
        );
      }),
    ]),
    /capture exploded/,
  );
  assert.ok(events.includes("reference:dispose"));
  assert.ok(events.includes("candidate:dispose"));
  assert.ok(events.includes("archive:close"));
});
