import { createRequire } from "node:module";

import pixelmatch from "pixelmatch";

export type VisualStatus = "matched" | "review-required" | "pending";

export interface ViewportContract {
  name: "desktop" | "tablet" | "mobile";
  width: number;
  height: number;
}

export interface GeometryBox {
  selector: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GeometryDiff {
  selector: string;
  index: number;
  field: "presence" | "x" | "y" | "width" | "height";
  expected: number | boolean | null;
  actual: number | boolean | null;
}

export interface VisualResult {
  routeKey: string;
  viewport: ViewportContract;
  differentPixels: number;
  diffRatio: number;
  geometryDiffs: GeometryDiff[];
  files: {
    reference: string;
    candidate: string;
    diff: string | null;
  };
  status: VisualStatus;
}

export interface PngDimensions {
  width: number;
  height: number;
}

export interface VisualComparison extends VisualResult {
  dimensionMismatch: {
    reference: PngDimensions;
    candidate: PngDimensions;
  } | null;
  missingSelectors: MissingSelectorEvidence;
  diffPng: Buffer | null;
}

export interface MissingSelectorEvidence {
  reference: string[];
  candidate: string[];
}

export interface CompareVisualsOptions {
  routeKey: string;
  viewport: ViewportContract;
  referenceGeometry: GeometryBox[];
  candidateGeometry: GeometryBox[];
  referenceMissingSelectors?: readonly string[];
  candidateMissingSelectors?: readonly string[];
  files: {
    reference: string;
    candidate: string;
    diff: string;
  };
}

export interface CaptureFixture {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface CaptureNetworkPolicy {
  localOrigins: string[];
  fixtures: CaptureFixture[];
}

export interface CaptureRouteLike {
  request(): { url(): string };
  continue(): Promise<void>;
  abort?(errorCode?: string): Promise<void>;
  fulfill(options: {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }): Promise<void>;
}

export interface CaptureContextLike {
  addInitScript(callback: () => void): Promise<void>;
  route(
    pattern: string,
    handler: (route: CaptureRouteLike) => Promise<void>,
  ): Promise<void>;
  newPage(): Promise<CapturePageLike>;
  close(): Promise<void>;
}

export interface CaptureBrowserLike {
  newContext(options: CaptureContextOptions): Promise<unknown>;
}

export interface CapturePageLike {
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
  goto(url: string, options: { waitUntil: "networkidle" }): Promise<unknown>;
  evaluate<T>(callback: () => T | Promise<T>): Promise<T>;
  locator(selector: string): {
    evaluateAll<T, TArgument = undefined>(
      callback: (elements: unknown[], argument: TArgument) => T | Promise<T>,
      argument?: TArgument,
    ): Promise<T>;
  };
  screenshot(options: { fullPage: true }): Promise<Buffer>;
}

export interface CapturedVisual {
  screenshot: Buffer;
  geometry: GeometryBox[];
  missingSelectors: string[];
}

export interface CaptureDeterministicPageOptions extends CaptureNetworkPolicy {
  browser: CaptureBrowserLike;
  side: "reference" | "candidate";
  url: string;
  viewport: ViewportContract;
  selectors: readonly string[];
  timeoutMs?: number;
}

export interface CaptureContextOptions {
  viewport: { width: number; height: number };
  deviceScaleFactor: 1;
  locale: "es-ES";
  colorScheme: "light";
  reducedMotion: "reduce";
  serviceWorkers: "block";
}

export interface CaptureNetworkPolicyHandle {
  externalRequestFailure: Promise<never>;
  assertNoExternalRequest(): void;
}

interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

interface PngConstructor {
  new (options: PngDimensions): PngImage;
  sync: {
    read(input: Buffer): PngImage;
    write(input: PngImage): Buffer;
  };
}

const PNG = (createRequire(import.meta.url)("pngjs") as { PNG: PngConstructor })
  .PNG;

const geometryFields = ["x", "y", "width", "height"] as const;
const fixedCaptureTimeoutMs = 30_000;
const pendingImageDiagnosticLimit = 20;
const pendingImageValueLimit = 256;

interface PendingImageDiagnostic {
  src: string;
  currentSrc: string;
  loading: string;
  complete: boolean;
  naturalWidth: number;
}

export const VISUAL_VIEWPORTS: readonly ViewportContract[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

export const templateSelectors: Readonly<Record<string, readonly string[]>> = {
  home: ["body", "header", "main", "footer"],
  "generic-page": ["body", "header", "main", "footer"],
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function roundCoordinate(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("La geometría debe usar números finitos");
  }
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeGeometryBox(box: GeometryBox): GeometryBox {
  if (!box.selector || !Number.isInteger(box.index) || box.index < 0) {
    throw new Error("Caja geométrica inválida");
  }
  return {
    selector: box.selector,
    index: box.index,
    x: roundCoordinate(box.x),
    y: roundCoordinate(box.y),
    width: roundCoordinate(box.width),
    height: roundCoordinate(box.height),
  };
}

function geometryKey(box: Pick<GeometryBox, "selector" | "index">): string {
  return `${box.selector}\u0000${box.index}`;
}

function geometryComparator(left: GeometryBox, right: GeometryBox): number {
  return compareText(left.selector, right.selector) || left.index - right.index;
}

function normalizedGeometryMap(boxes: GeometryBox[]): Map<string, GeometryBox> {
  const geometry = new Map<string, GeometryBox>();
  for (const sourceBox of boxes) {
    const box = normalizeGeometryBox(sourceBox);
    const key = geometryKey(box);
    if (geometry.has(key)) {
      throw new Error(
        `Caja geométrica duplicada: ${box.selector}[${box.index}]`,
      );
    }
    geometry.set(key, box);
  }
  return geometry;
}

export function compareGeometry(
  referenceGeometry: GeometryBox[],
  candidateGeometry: GeometryBox[],
): GeometryDiff[] {
  const reference = normalizedGeometryMap(referenceGeometry);
  const candidate = normalizedGeometryMap(candidateGeometry);
  const keys = [...new Set([...reference.keys(), ...candidate.keys()])].sort(
    (left, right) => {
      const leftBox = reference.get(left) ?? candidate.get(left);
      const rightBox = reference.get(right) ?? candidate.get(right);
      if (leftBox === undefined || rightBox === undefined)
        return compareText(left, right);
      return geometryComparator(leftBox, rightBox);
    },
  );
  const diffs: GeometryDiff[] = [];

  for (const key of keys) {
    const expected = reference.get(key);
    const actual = candidate.get(key);
    const box = expected ?? actual;
    if (box === undefined) continue;
    if (expected === undefined || actual === undefined) {
      diffs.push({
        selector: box.selector,
        index: box.index,
        field: "presence",
        expected: expected !== undefined,
        actual: actual !== undefined,
      });
      continue;
    }
    for (const field of geometryFields) {
      if (expected[field] !== actual[field]) {
        diffs.push({
          selector: box.selector,
          index: box.index,
          field,
          expected: expected[field],
          actual: actual[field],
        });
      }
    }
  }

  return diffs;
}

function decodePng(input: Buffer, side: "reference" | "candidate"): PngImage {
  let image: PngImage;
  try {
    image = PNG.sync.read(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PNG ${side} inválido: ${message}`);
  }
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.data.length !== image.width * image.height * 4
  ) {
    throw new Error(`PNG ${side} tiene dimensiones o buffer inválidos`);
  }
  return image;
}

function ratio(differentPixels: number, pixelCount: number): number {
  if (differentPixels === 0) return 0;
  return Number((differentPixels / pixelCount).toFixed(12));
}

function rawRgbaDifference(
  reference: PngImage,
  referenceOffset: number,
  candidate: PngImage,
  candidateOffset: number,
): boolean {
  return (
    reference.data[referenceOffset] !== candidate.data[candidateOffset] ||
    reference.data[referenceOffset + 1] !==
      candidate.data[candidateOffset + 1] ||
    reference.data[referenceOffset + 2] !==
      candidate.data[candidateOffset + 2] ||
    reference.data[referenceOffset + 3] !== candidate.data[candidateOffset + 3]
  );
}

function normalizeMissingSelectors(
  selectors: readonly string[] | undefined,
  side: "reference" | "candidate",
): string[] {
  const normalized = [...(selectors ?? [])];
  const seen = new Set<string>();
  for (const selector of normalized) {
    if (!selector || seen.has(selector)) {
      throw new Error(`Selector ausente ${side} inválido: ${selector}`);
    }
    seen.add(selector);
  }
  return normalized.sort(compareText);
}

function markRawRgbaDifferences(
  reference: PngImage,
  candidate: PngImage,
  diff: PngImage,
): number {
  let differentPixels = 0;
  for (let offset = 0; offset < reference.data.length; offset += 4) {
    if (!rawRgbaDifference(reference, offset, candidate, offset)) continue;
    differentPixels += 1;
    diff.data[offset] = 255;
    diff.data[offset + 1] = 0;
    diff.data[offset + 2] = 0;
    diff.data[offset + 3] = 255;
  }
  return differentPixels;
}

function countDimensionMismatchDifferences(
  reference: PngImage,
  candidate: PngImage,
): { differentPixels: number; unionPixelCount: number } {
  const overlapWidth = Math.min(reference.width, candidate.width);
  const overlapHeight = Math.min(reference.height, candidate.height);
  const overlapPixels = overlapWidth * overlapHeight;
  const referencePixels = reference.width * reference.height;
  const candidatePixels = candidate.width * candidate.height;
  const unionPixelCount = referencePixels + candidatePixels - overlapPixels;
  let differentPixels = referencePixels + candidatePixels - overlapPixels * 2;
  for (let y = 0; y < overlapHeight; y += 1) {
    for (let x = 0; x < overlapWidth; x += 1) {
      const referenceOffset = (y * reference.width + x) * 4;
      const candidateOffset = (y * candidate.width + x) * 4;
      if (
        rawRgbaDifference(
          reference,
          referenceOffset,
          candidate,
          candidateOffset,
        )
      ) {
        differentPixels += 1;
      }
    }
  }
  return { differentPixels, unionPixelCount };
}

export async function compareVisuals(
  referencePng: Buffer,
  candidatePng: Buffer,
  options: CompareVisualsOptions,
): Promise<VisualComparison> {
  const reference = decodePng(referencePng, "reference");
  const candidate = decodePng(candidatePng, "candidate");
  const geometryDiffs = compareGeometry(
    options.referenceGeometry,
    options.candidateGeometry,
  );
  const missingSelectors: MissingSelectorEvidence = {
    reference: normalizeMissingSelectors(
      options.referenceMissingSelectors,
      "reference",
    ),
    candidate: normalizeMissingSelectors(
      options.candidateMissingSelectors,
      "candidate",
    ),
  };
  const sameDimensions =
    reference.width === candidate.width &&
    reference.height === candidate.height;
  const dimensionMismatch = sameDimensions
    ? null
    : {
        reference: { width: reference.width, height: reference.height },
        candidate: { width: candidate.width, height: candidate.height },
      };
  let pixelCount = reference.width * reference.height;
  let differentPixels = 0;
  let diffPng: Buffer | null = null;

  if (sameDimensions) {
    const diff = new PNG({ width: reference.width, height: reference.height });
    pixelmatch(
      reference.data,
      candidate.data,
      diff.data,
      reference.width,
      reference.height,
      { threshold: 0, includeAA: true },
    );
    differentPixels = markRawRgbaDifferences(reference, candidate, diff);
    if (differentPixels > 0) diffPng = PNG.sync.write(diff);
  } else {
    const mismatch = countDimensionMismatchDifferences(reference, candidate);
    differentPixels = mismatch.differentPixels;
    pixelCount = mismatch.unionPixelCount;
  }

  const status: VisualStatus =
    differentPixels > 0 ||
    geometryDiffs.length > 0 ||
    missingSelectors.reference.length > 0 ||
    missingSelectors.candidate.length > 0 ||
    dimensionMismatch !== null
      ? "review-required"
      : "matched";
  return {
    routeKey: options.routeKey,
    viewport: { ...options.viewport },
    differentPixels,
    diffRatio: ratio(differentPixels, pixelCount),
    geometryDiffs,
    files: {
      reference: options.files.reference,
      candidate: options.files.candidate,
      diff: diffPng === null ? null : options.files.diff,
    },
    status,
    dimensionMismatch,
    missingSelectors,
    diffPng,
  };
}

export function CAPTURE_CONTEXT_OPTIONS(
  viewport: ViewportContract,
): CaptureContextOptions {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    locale: "es-ES",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  };
}

function assertLoopbackOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Origen local de captura inválido: ${origin}`);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Origen local de captura inválido: ${origin}`);
  }
  return parsed.origin;
}

function fixtureMap(fixtures: CaptureFixture[]): Map<string, CaptureFixture> {
  const result = new Map<string, CaptureFixture>();
  for (const fixture of fixtures) {
    let parsed: URL;
    try {
      parsed = new URL(fixture.url);
    } catch {
      throw new Error(`URL de fixture visual inválida: ${fixture.url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`URL de fixture visual inválida: ${fixture.url}`);
    }
    if (
      !Number.isInteger(fixture.status) ||
      fixture.status < 100 ||
      fixture.status > 599
    ) {
      throw new Error(`Status de fixture visual inválido: ${fixture.url}`);
    }
    if (result.has(fixture.url)) {
      throw new Error(`Fixture visual duplicado: ${fixture.url}`);
    }
    result.set(fixture.url, {
      url: fixture.url,
      status: fixture.status,
      headers: Object.fromEntries(
        Object.entries(fixture.headers).sort(([a], [b]) => compareText(a, b)),
      ),
      body: Buffer.from(fixture.body),
    });
  }
  return result;
}

function isAllowedLocalRequest(
  url: string,
  localOrigins: ReadonlySet<string>,
): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  try {
    return localOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

export async function installCaptureNetworkPolicy(
  context: Pick<CaptureContextLike, "route">,
  policy: CaptureNetworkPolicy,
): Promise<CaptureNetworkPolicyHandle> {
  const localOrigins = new Set(policy.localOrigins.map(assertLoopbackOrigin));
  const fixtures = fixtureMap(policy.fixtures);
  let rejectExternalRequest: (error: Error) => void = () => undefined;
  let firstExternalRequest: Error | undefined;
  const externalRequestFailure = new Promise<never>((_resolve, reject) => {
    rejectExternalRequest = reject;
  });
  void externalRequestFailure.catch(() => undefined);
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (isAllowedLocalRequest(url, localOrigins)) {
      await route.continue();
      return;
    }
    const fixture = fixtures.get(url);
    if (fixture === undefined) {
      const error = new Error(`Solicitud externa sin fixture visual: ${url}`);
      if (firstExternalRequest === undefined) {
        firstExternalRequest = error;
        rejectExternalRequest(error);
      }
      await route.abort?.("blockedbyclient");
      throw error;
    }
    await route.fulfill({
      status: fixture.status,
      headers: { ...fixture.headers },
      body: Buffer.from(fixture.body),
    });
  });
  return {
    externalRequestFailure,
    assertNoExternalRequest() {
      if (firstExternalRequest !== undefined) throw firstExternalRequest;
    },
  };
}

function assertSelectors(selectors: readonly string[]): void {
  const seen = new Set<string>();
  for (const selector of selectors) {
    if (!selector || seen.has(selector)) {
      throw new Error("Los selectores visuales deben ser únicos y no vacíos");
    }
    seen.add(selector);
  }
}

function captureTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? fixedCaptureTimeoutMs;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error("El timeout de captura visual debe ser un entero positivo");
  }
  return resolved;
}

function boundedDiagnosticValue(value: unknown): string {
  return String(value ?? "")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, pendingImageValueLimit);
}

function boundedNaturalWidth(value: unknown): number {
  const width = Number(value);
  if (!Number.isFinite(width)) return 0;
  return Math.max(0, Math.floor(width));
}

function normalizePendingImageDiagnostics(
  value: unknown,
): PendingImageDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (image): image is Record<string, unknown> =>
        image !== null && typeof image === "object",
    )
    .map((image) => ({
      src: boundedDiagnosticValue(image.src),
      currentSrc: boundedDiagnosticValue(image.currentSrc),
      loading: boundedDiagnosticValue(image.loading),
      complete: Boolean(image.complete),
      naturalWidth: boundedNaturalWidth(image.naturalWidth),
    }))
    .sort(
      (left, right) =>
        compareText(left.src, right.src) ||
        compareText(left.currentSrc, right.currentSrc) ||
        compareText(left.loading, right.loading) ||
        Number(left.complete) - Number(right.complete) ||
        left.naturalWidth - right.naturalWidth,
    )
    .slice(0, pendingImageDiagnosticLimit);
}

async function withinCaptureTimeout<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs: number,
  target: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `La captura visual superó ${timeoutMs} ms durante ${stage}; ${target}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeCaptureContext(
  context: CaptureContextLike,
  timeoutMs: number,
  target: string,
): Promise<void> {
  await withinCaptureTimeout(
    "cerrar el contexto aislado",
    context.close(),
    timeoutMs,
    target,
  );
}

function preserveCaptureFailure(
  captureFailure: unknown,
  cleanupFailure: unknown,
): void {
  if (!(captureFailure instanceof Error)) return;
  try {
    const existingCause = (captureFailure as Error & { cause?: unknown }).cause;
    Object.defineProperty(captureFailure, "cause", {
      configurable: true,
      value:
        existingCause === undefined
          ? cleanupFailure
          : new AggregateError(
              [existingCause, cleanupFailure],
              "También falló la limpieza de captura visual",
            ),
    });
  } catch {
    // The primary capture error remains more useful than a cleanup timeout.
  }
}

async function capturePendingImageDiagnostics(
  page: CapturePageLike,
  timeoutMs: number,
  target: string,
): Promise<PendingImageDiagnostic[]> {
  try {
    const pendingImages = await withinCaptureTimeout(
      "el diagnóstico de imágenes pendientes",
      page.locator("img").evaluateAll((images) =>
        images
          .map((image) => {
            const element = image as HTMLImageElement;
            return {
              src: element.src,
              currentSrc: element.currentSrc,
              loading: element.loading,
              complete: element.complete,
              naturalWidth: element.naturalWidth,
            };
          })
          .filter((image) => !image.complete),
      ),
      Math.min(timeoutMs, 1_000),
      target,
    );
    return normalizePendingImageDiagnostics(pendingImages);
  } catch {
    return [];
  }
}

function captureGeometry(
  page: CapturePageLike,
  selectors: readonly string[],
): Promise<{ geometry: GeometryBox[]; missingSelectors: string[] }> {
  return Promise.all(
    selectors.map(async (selector) => {
      const boxes = await page.locator(selector).evaluateAll(
        (elements, selectorArgument) =>
          elements.map((element, index) => {
            const rect = (element as Element).getBoundingClientRect();
            return {
              selector: selectorArgument,
              index,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            } satisfies GeometryBox;
          }),
        selector,
      );
      return { selector, boxes };
    }),
  ).then((captured) => {
    const geometry: GeometryBox[] = [];
    const missingSelectors: string[] = [];
    for (const { selector, boxes } of captured) {
      if (boxes.length === 0) missingSelectors.push(selector);
      geometry.push(...boxes.map(normalizeGeometryBox));
    }
    return { geometry, missingSelectors };
  });
}

export async function captureDeterministicPage(
  options: CaptureDeterministicPageOptions,
): Promise<CapturedVisual> {
  assertSelectors(options.selectors);
  const timeoutMs = captureTimeout(options.timeoutMs);
  const target = `url=${options.url} viewport=${options.viewport.name}:${options.viewport.width}x${options.viewport.height}`;
  const contextPromise = options.browser.newContext(
    CAPTURE_CONTEXT_OPTIONS(options.viewport),
  ) as Promise<CaptureContextLike>;
  let context: CaptureContextLike;
  try {
    context = await withinCaptureTimeout(
      "crear el contexto aislado",
      contextPromise,
      timeoutMs,
      target,
    );
  } catch (error) {
    void contextPromise.then(
      async (lateContext) => {
        try {
          await closeCaptureContext(lateContext, timeoutMs, target);
        } catch {
          // The original context-creation timeout remains the actionable error.
        }
      },
      () => undefined,
    );
    throw error;
  }
  let networkPolicy: CaptureNetworkPolicyHandle | undefined;
  let capturedVisual!: CapturedVisual;
  let captureFailure: unknown;
  let captureFailed = false;
  try {
    await withinCaptureTimeout(
      "inyectar el consentimiento necesario",
      context.addInitScript(() => {
        localStorage.setItem("comunidad-solar-cookie-consent-v1", "necessary");
      }),
      timeoutMs,
      target,
    );
    const installedNetworkPolicy = await withinCaptureTimeout(
      "instalar la política de red",
      installCaptureNetworkPolicy(context, options),
      timeoutMs,
      target,
    );
    networkPolicy = installedNetworkPolicy;
    const withExternalRequestFailure = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, installedNetworkPolicy.externalRequestFailure]);
    const page = await withinCaptureTimeout(
      "crear una página aislada",
      withExternalRequestFailure(context.newPage()),
      timeoutMs,
      target,
    );
    page.setDefaultTimeout?.(timeoutMs);
    page.setDefaultNavigationTimeout?.(timeoutMs);
    await withinCaptureTimeout(
      "la navegación networkidle",
      withExternalRequestFailure(
        page.goto(options.url, { waitUntil: "networkidle" }),
      ),
      timeoutMs,
      target,
    );
    await withinCaptureTimeout(
      "document.fonts.ready",
      withExternalRequestFailure(
        page.evaluate(async () => document.fonts.ready),
      ),
      timeoutMs,
      target,
    );
    try {
      await withinCaptureTimeout(
        "la carga de imágenes",
        withExternalRequestFailure(
          page.locator("img").evaluateAll(async (images) =>
            Promise.all(
              images.map((image) => {
                const target = image as HTMLImageElement;
                if (target.loading === "lazy") target.loading = "eager";
                if (target.complete) return undefined;
                return new Promise<void>((resolve) => {
                  target.addEventListener("load", () => resolve(), {
                    once: true,
                  });
                  target.addEventListener("error", () => resolve(), {
                    once: true,
                  });
                });
              }),
            ),
          ),
        ),
        timeoutMs,
        target,
      );
    } catch (error) {
      const pendingImages = await capturePendingImageDiagnostics(
        page,
        timeoutMs,
        target,
      );
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; side=${options.side}; pendingImages=${JSON.stringify(pendingImages)}`,
      );
    }
    const screenshot = await withinCaptureTimeout(
      "la captura full-page",
      withExternalRequestFailure(page.screenshot({ fullPage: true })),
      timeoutMs,
      target,
    );
    const { geometry, missingSelectors } = await withinCaptureTimeout(
      "la geometría declarada",
      withExternalRequestFailure(captureGeometry(page, options.selectors)),
      timeoutMs,
      target,
    );
    capturedVisual = { screenshot, geometry, missingSelectors };
  } catch (error) {
    captureFailed = true;
    captureFailure = error;
  }
  let cleanupFailure: unknown;
  try {
    await closeCaptureContext(context, timeoutMs, target);
  } catch (error) {
    cleanupFailure = error;
  }
  let externalRequestFailure: unknown;
  try {
    networkPolicy?.assertNoExternalRequest();
  } catch (error) {
    externalRequestFailure = error;
  }
  if (externalRequestFailure !== undefined) {
    if (cleanupFailure !== undefined) {
      preserveCaptureFailure(externalRequestFailure, cleanupFailure);
    }
    if (captureFailed) {
      const externalMessage =
        externalRequestFailure instanceof Error
          ? externalRequestFailure.message
          : String(externalRequestFailure);
      throw new AggregateError(
        [captureFailure, externalRequestFailure],
        `La captura visual falló y recibió una solicitud externa durante el cierre: ${externalMessage}`,
      );
    }
    throw externalRequestFailure;
  }
  if (captureFailed) {
    if (cleanupFailure !== undefined) {
      preserveCaptureFailure(captureFailure, cleanupFailure);
    }
    throw captureFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return capturedVisual;
}
