import { constants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Response as PlaywrightResponse,
} from "playwright";

import {
  type CloudflareVersionDescriptor,
  validateCloudflareVersionDescriptor,
} from "./cloudflare.ts";
import {
  canonicalJson,
  EVIDENCE_VIEWPORTS,
  sha256,
  type AllowedHttpStatus,
  type EvidenceRequest,
  type EvidenceRole,
} from "./domain.ts";
import type { PullRequestRunContext } from "./github.ts";
import { validateNormalizedEvidenceRequest } from "./request.ts";

interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

interface PngConstructor {
  sync: { read(input: Buffer): PngImage };
}

const PNG = (createRequire(import.meta.url)("pngjs") as { PNG: PngConstructor })
  .PNG;
const playwrightVersion = (
  createRequire(import.meta.url)("playwright/package.json") as {
    version: string;
  }
).version;

export type EvidenceViewport = (typeof EVIDENCE_VIEWPORTS)[number];

export interface BrowserCaptureRequest {
  role: EvidenceRole;
  sourceSha: string;
  versionId: string;
  url: string;
  expectedStatus: AllowedHttpStatus;
  viewport: EvidenceViewport;
  selector: string | null;
}

export interface BrowserSectionCapture {
  count: number;
  visible: boolean;
  width: number;
  height: number;
  png: Buffer;
}

export interface BrowserCaptureResult {
  status: number;
  finalUrl: string;
  documentVisible: boolean;
  pagePng: Buffer;
  section: BrowserSectionCapture | null;
  pageErrors: string[];
  failedRequests: Array<{ url: string }>;
}

export interface BrowserAdapter {
  readonly toolVersions: {
    browser: string;
    playwright: string;
  };
  capture(request: BrowserCaptureRequest): Promise<BrowserCaptureResult>;
  close(): Promise<void>;
}

export interface CaptureLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxHeight: number;
}

export interface CaptureRecord {
  role: EvidenceRole;
  kind: "page" | "section";
  sourceSha: string;
  versionId: string;
  origin: string;
  url: string;
  route: string;
  status: number;
  viewport: EvidenceViewport;
  selector: string | null;
  filename: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  pageErrors: 0;
  sameOriginFailures: 0;
  crossOriginFailures: Record<string, number>;
}

export interface CaptureManifest {
  schemaVersion: 1;
  kind: "pull-request" | "release";
  issue: number;
  prNumber: number;
  requestPath: string;
  route: string;
  selector: string | null;
  source: {
    baseSha: string | null;
    candidateSha: string | null;
    releaseSha: string | null;
  };
  capturedAt: string;
  run: {
    id: number;
    url: string;
    attempt: number;
  };
  tools: {
    node: string;
    playwright: string;
    browser: string;
  };
  captures: CaptureRecord[];
}

export interface CaptureSet {
  root: string;
  manifestPath: string;
  manifest: CaptureManifest;
}

export interface CaptureInput {
  context: PullRequestRunContext;
  base: CloudflareVersionDescriptor;
  candidate: CloudflareVersionDescriptor;
  outputRoot: string;
  runAttempt?: number;
}

export interface ReleaseCaptureContext {
  schemaVersion: 1;
  repository: string;
  issueNumber: number;
  issueUrl: string;
  prNumber: number;
  prUrl: string;
  runId: number;
  runUrl: string;
  sourceSha: string;
  requestPath: string;
  request: EvidenceRequest;
}

export interface ReleaseCaptureInput {
  context: ReleaseCaptureContext;
  runAttempt?: number;
  release: CloudflareVersionDescriptor;
  outputRoot: string;
}

interface CaptureOptions {
  limits?: CaptureLimits;
}

interface CaptureCommon {
  kind: "pull-request" | "release";
  issue: number;
  prNumber: number;
  runId: number;
  runUrl: string;
  runAttempt: number;
  requestPath: string;
  request: EvidenceRequest;
  source: CaptureManifest["source"];
  outputRoot: string;
}

interface Variant {
  role: EvidenceRole;
  descriptor: CloudflareVersionDescriptor;
  expectedStatus: AllowedHttpStatus;
  prefix: "before" | "after" | "release";
}

interface PendingPng {
  filename: string;
  contents: Buffer;
}

const defaultLimits: CaptureLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxHeight: 30_000,
};
const pageTimeoutMs = 30_000;
const cleanupTimeoutMs = 5_000;
const maxContextBytes = 128 * 1024;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Keep this as plain JavaScript text. Passing a TypeScript callback through
// Playwright can expose transpiler helpers (for example `__name`) that do not
// exist inside the browser's isolated init-script context.
export const DETERMINISTIC_INIT_SCRIPT = `(() => {
  const disableMotion = () => {
    if (document.querySelector("style[data-preview-evidence-motion]") !== null) {
      return;
    }
    const style = document.createElement("style");
    style.dataset.previewEvidenceMotion = "disabled";
    style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}";
    (document.head || document.documentElement).appendChild(style);
  };
  try {
    localStorage.setItem("comunidad-solar-cookie-consent-v1", "necessary");
  } catch {}
  if (document.documentElement !== null) {
    disableMotion();
  } else {
    document.addEventListener("DOMContentLoaded", disableMotion, { once: true });
  }
})();`;

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} debe ser un entero positivo`);
  }
  return value as number;
}

function boundedText(value: unknown, label: string, maxLength = 2048): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} inválido`);
  }
  return value;
}

function validateRunUrl(value: string, runId: number): string {
  let url: URL;
  try {
    url = new URL(boundedText(value, "La URL del run"));
  } catch {
    throw new TypeError("La URL del run GitHub es inválida");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(`/actions/runs/${runId}`)
  ) {
    throw new TypeError("La URL del run GitHub es inválida");
  }
  return url.toString();
}

function validateRunAttempt(value: number | undefined): number {
  return value === undefined ? 1 : positiveInteger(value, "El run attempt");
}

function validateGitHubUrl(
  raw: unknown,
  repository: string,
  suffix: string,
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(boundedText(raw, label));
  } catch {
    throw new TypeError(`${label} es inválida`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== `/${repository}/${suffix}`
  ) {
    throw new TypeError(`${label} es inválida`);
  }
  return url.toString();
}

function validateReleaseCaptureContext(value: unknown): ReleaseCaptureContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("El contexto release es inválido");
  }
  const context = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "schemaVersion",
    "repository",
    "issueNumber",
    "issueUrl",
    "prNumber",
    "prUrl",
    "runId",
    "runUrl",
    "sourceSha",
    "requestPath",
    "request",
  ]);
  if (
    Object.keys(context).length !== expectedKeys.size ||
    Object.keys(context).some((key) => !expectedKeys.has(key)) ||
    context.schemaVersion !== 1
  ) {
    throw new TypeError("El contexto release contiene campos no permitidos");
  }
  const repository = boundedText(context.repository, "El repositorio release");
  if (!repositoryPattern.test(repository)) {
    throw new TypeError("El repositorio release es inválido");
  }
  const issueNumber = positiveInteger(context.issueNumber, "La issue release");
  const prNumber = positiveInteger(context.prNumber, "La PR release");
  const runId = positiveInteger(context.runId, "El run release");
  const sourceSha = boundedText(context.sourceSha, "El SHA release");
  if (!gitShaPattern.test(sourceSha)) {
    throw new TypeError("El SHA release es inválido");
  }
  const requestPath = boundedText(
    context.requestPath,
    "El request path release",
  );
  const request = validateNormalizedEvidenceRequest(
    context.request,
    requestPath,
  );
  if (request.issue !== issueNumber) {
    throw new TypeError("La issue release no coincide con el request");
  }
  return {
    schemaVersion: 1,
    repository,
    issueNumber,
    issueUrl: validateGitHubUrl(
      context.issueUrl,
      repository,
      `issues/${issueNumber}`,
      "La URL de issue release",
    ),
    prNumber,
    prUrl: validateGitHubUrl(
      context.prUrl,
      repository,
      `pull/${prNumber}`,
      "La URL de PR release",
    ),
    runId,
    runUrl: validateRunUrl(
      boundedText(context.runUrl, "La URL del run"),
      runId,
    ),
    sourceSha,
    requestPath,
    request,
  };
}

export async function writeReleaseCaptureContext(
  path: string,
  value: ReleaseCaptureContext,
): Promise<{ path: string; sha256: string }> {
  const context = validateReleaseCaptureContext(value);
  const contents = Buffer.from(`${canonicalJson(context)}\n`, "utf8");
  if (contents.length > maxContextBytes) {
    throw new RangeError("El contexto release supera el tamaño permitido");
  }
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new TypeError("El directorio del contexto release es inválido");
  }
  await writeExclusive(path, contents, 0o600);
  return { path, sha256: sha256(contents) };
}

export async function readReleaseCaptureContext(
  path: string,
  expectedSha256: string,
): Promise<ReleaseCaptureContext> {
  if (!sha256Pattern.test(expectedSha256)) {
    throw new TypeError("El hash del contexto release es inválido");
  }
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > maxContextBytes
  ) {
    throw new TypeError(
      "El contexto release debe ser un archivo regular acotado",
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const contents = await handle.readFile();
    if (
      contents.length > maxContextBytes ||
      sha256(contents) !== expectedSha256
    ) {
      throw new Error("Falló la integridad hash del contexto release");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new TypeError("El contexto release contiene JSON inválido");
    }
    return validateReleaseCaptureContext(parsed);
  } finally {
    await handle?.close();
  }
}

function effectiveLimits(options: CaptureOptions): CaptureLimits {
  const value = options.limits ?? defaultLimits;
  if (
    !Number.isSafeInteger(value.maxFileBytes) ||
    value.maxFileBytes < 1 ||
    value.maxFileBytes > defaultLimits.maxFileBytes ||
    !Number.isSafeInteger(value.maxTotalBytes) ||
    value.maxTotalBytes < 1 ||
    value.maxTotalBytes > defaultLimits.maxTotalBytes ||
    !Number.isSafeInteger(value.maxHeight) ||
    value.maxHeight < 1 ||
    value.maxHeight > defaultLimits.maxHeight
  ) {
    throw new TypeError("Los límites de captura son inválidos");
  }
  return { ...value };
}

function checkedDescriptor(
  value: CloudflareVersionDescriptor,
  role: EvidenceRole,
  sourceSha: string,
): CloudflareVersionDescriptor {
  const descriptor = validateCloudflareVersionDescriptor(value);
  if (descriptor.role !== role || descriptor.sourceSha !== sourceSha) {
    throw new TypeError(
      "El descriptor no coincide con el rol o SHA de captura",
    );
  }
  return descriptor;
}

async function assertFreshOutput(outputRoot: string): Promise<void> {
  const parent = await lstat(dirname(outputRoot));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new TypeError("El directorio padre de capturas es inválido");
  }
  try {
    const existing = await lstat(outputRoot);
    if (existing.isSymbolicLink()) {
      throw new TypeError("El output de capturas no puede ser un symlink");
    }
    throw new TypeError("El output de capturas ya existe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function validateFinalUrl(raw: string, expectedOrigin: string): string {
  let url: URL;
  try {
    url = new URL(boundedText(raw, "La URL final"));
  } catch {
    throw new TypeError("La URL final de captura es inválida");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("La URL final salió del origen preview esperado");
  }
  return url.toString();
}

function failedOrigins(
  failures: Array<{ url: string }>,
  expectedOrigin: string,
): { sameOrigin: number; crossOrigin: Record<string, number> } {
  if (!Array.isArray(failures) || failures.length > 1_000) {
    throw new TypeError("La lista de requests fallidas es inválida");
  }
  let sameOrigin = 0;
  const crossOrigin: Record<string, number> = {};
  for (const failure of failures) {
    if (
      typeof failure !== "object" ||
      failure === null ||
      Array.isArray(failure) ||
      Object.keys(failure).length !== 1
    ) {
      throw new TypeError("Un request fallido es inválido");
    }
    let url: URL;
    try {
      url = new URL(boundedText(failure.url, "La URL de request fallido"));
    } catch {
      throw new TypeError("La URL de request fallido es inválida");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new TypeError("La URL de request fallido es inválida");
    }
    if (url.origin === expectedOrigin) sameOrigin += 1;
    else crossOrigin[url.origin] = (crossOrigin[url.origin] ?? 0) + 1;
  }
  return {
    sameOrigin,
    crossOrigin: Object.fromEntries(
      Object.entries(crossOrigin).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  };
}

function validatePng(
  input: Buffer,
  expectedWidth: number,
  limits: CaptureLimits,
  label: string,
): {
  contents: Buffer;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
} {
  if (!Buffer.isBuffer(input) || input.length > limits.maxFileBytes) {
    throw new RangeError(`${label} supera 8 MiB o no es un archivo PNG`);
  }
  if (
    input.length < 24 ||
    !input.subarray(0, 8).equals(pngSignature) ||
    input.readUInt32BE(8) !== 13 ||
    input.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new TypeError(`${label} es un PNG inválido o truncado`);
  }
  const headerWidth = input.readUInt32BE(16);
  const headerHeight = input.readUInt32BE(20);
  if (
    headerWidth !== expectedWidth ||
    headerWidth < 1 ||
    headerHeight < 1 ||
    headerHeight > limits.maxHeight
  ) {
    throw new RangeError(`${label} tiene ancho o alto fuera de dimensión`);
  }
  let parsed: PngImage;
  try {
    parsed = PNG.sync.read(input);
  } catch {
    throw new TypeError(`${label} es un PNG inválido o truncado`);
  }
  if (parsed.width !== headerWidth || parsed.height !== headerHeight) {
    throw new TypeError(`${label} tiene dimensiones PNG inconsistentes`);
  }
  const contents = Buffer.from(input);
  return {
    contents,
    bytes: contents.length,
    width: parsed.width,
    height: parsed.height,
    sha256: sha256(contents),
  };
}

function filename(
  prefix: Variant["prefix"],
  viewport: EvidenceViewport["name"],
  kind: "page" | "section",
): string {
  return kind === "page"
    ? `${prefix}-${viewport}.png`
    : `${prefix}-section-${viewport}.png`;
}

function captureRecord(
  request: BrowserCaptureRequest,
  result: BrowserCaptureResult,
  variant: Variant,
  common: CaptureCommon,
  limits: CaptureLimits,
): { records: CaptureRecord[]; files: PendingPng[] } {
  if (
    !Number.isSafeInteger(result.status) ||
    result.status !== request.expectedStatus
  ) {
    throw new Error(
      `La captura devolvió status HTTP distinto del esperado para ${request.role}`,
    );
  }
  if (result.documentVisible !== true) {
    throw new Error("La captura no contiene un documento visible");
  }
  if (!Array.isArray(result.pageErrors) || result.pageErrors.length > 0) {
    throw new Error("La captura registró un page error");
  }
  const origin = new URL(variant.descriptor.url).origin;
  validateFinalUrl(result.finalUrl, origin);
  const failures = failedOrigins(result.failedRequests, origin);
  if (failures.sameOrigin > 0) {
    throw new Error("La captura registró un request fallido del mismo origen");
  }
  const page = validatePng(
    result.pagePng,
    request.viewport.width,
    limits,
    "La captura full-page",
  );
  const shared = {
    role: request.role,
    sourceSha: request.sourceSha,
    versionId: request.versionId,
    origin,
    url: request.url,
    route: common.request.route,
    status: result.status,
    viewport: { ...request.viewport },
    selector: request.selector,
    pageErrors: 0 as const,
    sameOriginFailures: 0 as const,
    crossOriginFailures: failures.crossOrigin,
  };
  const pageFilename = filename(variant.prefix, request.viewport.name, "page");
  const records: CaptureRecord[] = [
    {
      ...shared,
      kind: "page",
      filename: pageFilename,
      bytes: page.bytes,
      width: page.width,
      height: page.height,
      sha256: page.sha256,
    },
  ];
  const files: PendingPng[] = [
    { filename: pageFilename, contents: page.contents },
  ];

  if (request.selector === null) {
    if (result.section !== null) {
      throw new TypeError("Una captura page no admite resultado de selector");
    }
    return { records, files };
  }
  const section = result.section;
  if (
    section === null ||
    section.count !== 1 ||
    section.visible !== true ||
    !Number.isFinite(section.width) ||
    !Number.isFinite(section.height) ||
    section.width <= 0 ||
    section.height <= 0 ||
    section.width > request.viewport.width ||
    section.height > limits.maxHeight
  ) {
    throw new Error(
      "El selector debe resolver a un elemento único, visible y acotado",
    );
  }
  const sectionPng = validatePng(
    section.png,
    Math.ceil(section.width),
    limits,
    "La captura del selector",
  );
  if (sectionPng.height !== Math.ceil(section.height)) {
    throw new RangeError("La captura del selector tiene alto inconsistente");
  }
  const sectionFilename = filename(
    variant.prefix,
    request.viewport.name,
    "section",
  );
  records.push({
    ...shared,
    kind: "section",
    filename: sectionFilename,
    bytes: sectionPng.bytes,
    width: sectionPng.width,
    height: sectionPng.height,
    sha256: sectionPng.sha256,
  });
  files.push({ filename: sectionFilename, contents: sectionPng.contents });
  return { records, files };
}

function validateToolVersion(value: unknown, label: string): string {
  const text = boundedText(value, label, 256);
  if (/\s{2,}/u.test(text) || text !== text.trim()) {
    throw new TypeError(`${label} inválida`);
  }
  return text;
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} superó el tiempo máximo`)),
          milliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function writeExclusive(
  path: string,
  contents: Buffer,
  mode: number,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(contents);
  } finally {
    await handle?.close();
  }
}

async function writeCaptureSet(
  outputRoot: string,
  manifest: CaptureManifest,
  files: PendingPng[],
): Promise<CaptureSet> {
  await assertFreshOutput(outputRoot);
  await mkdir(outputRoot, { mode: 0o700 });
  try {
    for (const file of files) {
      await writeExclusive(
        resolve(outputRoot, file.filename),
        file.contents,
        0o644,
      );
    }
    const manifestPath = resolve(outputRoot, "manifest.json");
    await writeExclusive(
      manifestPath,
      Buffer.from(`${canonicalJson(manifest)}\n`, "utf8"),
      0o644,
    );
    return { root: outputRoot, manifestPath, manifest };
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

async function captureEvidence(
  common: CaptureCommon,
  variants: Variant[],
  suppliedAdapter: BrowserAdapter | undefined,
  options: CaptureOptions,
): Promise<CaptureSet> {
  const limits = effectiveLimits(options);
  await assertFreshOutput(common.outputRoot);
  const adapter = suppliedAdapter ?? (await createPlaywrightAdapter());
  const capturedAt = new Date().toISOString();
  let tools: CaptureManifest["tools"] | undefined;
  const captures: CaptureRecord[] = [];
  const files: PendingPng[] = [];
  let totalBytes = 0;
  let captureFailure: unknown;
  try {
    tools = {
      node: validateToolVersion(process.versions.node, "La versión Node"),
      playwright: validateToolVersion(
        adapter.toolVersions.playwright,
        "La versión Playwright",
      ),
      browser: validateToolVersion(
        adapter.toolVersions.browser,
        "La versión del browser",
      ),
    };
    for (const variant of variants) {
      for (const viewport of EVIDENCE_VIEWPORTS) {
        const request: BrowserCaptureRequest = {
          role: variant.role,
          sourceSha: variant.descriptor.sourceSha,
          versionId: variant.descriptor.versionId,
          url: new URL(common.request.route, variant.descriptor.url).toString(),
          expectedStatus: variant.expectedStatus,
          viewport,
          selector: common.request.selector,
        };
        const result = await adapter.capture(request);
        const captured = captureRecord(
          request,
          result,
          variant,
          common,
          limits,
        );
        for (const file of captured.files) {
          totalBytes += file.contents.length;
          if (totalBytes > limits.maxTotalBytes) {
            throw new RangeError("El tamaño total de capturas supera 40 MiB");
          }
          files.push(file);
        }
        captures.push(...captured.records);
      }
    }
  } catch (error) {
    captureFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await withTimeout(
      adapter.close(),
      cleanupTimeoutMs,
      "El cierre del browser",
    );
  } catch (error) {
    cleanupFailure = error;
  }
  if (captureFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [captureFailure, cleanupFailure],
      "Fallaron la captura y el cierre del browser",
    );
  }
  if (captureFailure !== undefined) throw captureFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (tools === undefined) {
    throw new Error("No se pudieron resolver las versiones de captura");
  }

  const manifest: CaptureManifest = {
    schemaVersion: 1,
    kind: common.kind,
    issue: common.issue,
    prNumber: common.prNumber,
    requestPath: common.requestPath,
    route: common.request.route,
    selector: common.request.selector,
    source: common.source,
    capturedAt,
    run: {
      id: common.runId,
      url: common.runUrl,
      attempt: common.runAttempt,
    },
    tools,
    captures,
  };
  return await writeCaptureSet(resolve(common.outputRoot), manifest, files);
}

export async function capturePullRequestEvidence(
  input: CaptureInput,
  adapter?: BrowserAdapter,
  options: CaptureOptions = {},
): Promise<CaptureSet> {
  const request = validateNormalizedEvidenceRequest(
    input.context.request,
    input.context.requestPath,
  );
  const issue = positiveInteger(input.context.issueNumber, "La issue");
  if (issue !== request.issue) {
    throw new TypeError("La issue de captura no coincide con el request");
  }
  const base = checkedDescriptor(input.base, "base", input.context.baseSha);
  const candidate = checkedDescriptor(
    input.candidate,
    "candidate",
    input.context.headSha,
  );
  if (base.versionId === candidate.versionId || base.url === candidate.url) {
    throw new TypeError(
      "Base y candidate deben ser versiones preview distintas",
    );
  }
  const runId = positiveInteger(input.context.runId, "El run ID");
  return await captureEvidence(
    {
      kind: "pull-request",
      issue,
      prNumber: positiveInteger(input.context.prNumber, "La PR"),
      runId,
      runUrl: validateRunUrl(input.context.runUrl, runId),
      runAttempt: validateRunAttempt(input.runAttempt),
      requestPath: input.context.requestPath,
      request,
      source: {
        baseSha: input.context.baseSha,
        candidateSha: input.context.headSha,
        releaseSha: null,
      },
      outputRoot: resolve(input.outputRoot),
    },
    [
      {
        role: "base",
        descriptor: base,
        expectedStatus: request.expectedStatus.base,
        prefix: "before",
      },
      {
        role: "candidate",
        descriptor: candidate,
        expectedStatus: request.expectedStatus.candidate,
        prefix: "after",
      },
    ],
    adapter,
    options,
  );
}

export async function captureReleaseEvidence(
  input: ReleaseCaptureInput,
  adapter?: BrowserAdapter,
  options: CaptureOptions = {},
): Promise<CaptureSet> {
  const context = validateReleaseCaptureContext(input.context);
  const release = checkedDescriptor(
    input.release,
    "release",
    context.sourceSha,
  );
  return await captureEvidence(
    {
      kind: "release",
      issue: context.issueNumber,
      prNumber: context.prNumber,
      runId: context.runId,
      runUrl: context.runUrl,
      runAttempt: validateRunAttempt(input.runAttempt),
      requestPath: context.requestPath,
      request: context.request,
      source: {
        baseSha: null,
        candidateSha: null,
        releaseSha: context.sourceSha,
      },
      outputRoot: resolve(input.outputRoot),
    },
    [
      {
        role: "release",
        descriptor: release,
        expectedStatus: context.request.expectedStatus.candidate,
        prefix: "release",
      },
    ],
    adapter,
    options,
  );
}

export function stableCaptureProjection(manifest: CaptureManifest): Omit<
  CaptureManifest,
  "capturedAt" | "run"
> & {
  run: Omit<CaptureManifest["run"], "attempt">;
} {
  const projection = structuredClone(manifest) as unknown as Record<
    string,
    unknown
  >;
  Reflect.deleteProperty(projection, "capturedAt");
  const run = projection.run as Record<string, unknown>;
  Reflect.deleteProperty(run, "attempt");
  return projection as unknown as Omit<
    CaptureManifest,
    "capturedAt" | "run"
  > & { run: Omit<CaptureManifest["run"], "attempt"> };
}

async function earliestStatus(response: PlaywrightResponse): Promise<number> {
  let request = response.request();
  let status = response.status();
  while (true) {
    const previousRequest = request.redirectedFrom();
    if (previousRequest === null) break;
    request = previousRequest;
    const previousResponse = await request.response();
    if (previousResponse !== null) status = previousResponse.status();
  }
  return status;
}

async function closeContext(context: BrowserContext): Promise<void> {
  await withTimeout(
    context.close(),
    cleanupTimeoutMs,
    "El cierre del contexto",
  );
}

class PlaywrightBrowserAdapter implements BrowserAdapter {
  readonly toolVersions: BrowserAdapter["toolVersions"];

  constructor(private readonly browser: Browser) {
    this.toolVersions = {
      browser: `Chromium ${browser.version()}`,
      playwright: playwrightVersion,
    };
  }

  async capture(request: BrowserCaptureRequest): Promise<BrowserCaptureResult> {
    const startedAt = Date.now();
    const remaining = (): number => {
      const value = pageTimeoutMs - (Date.now() - startedAt);
      if (value <= 0) throw new Error("La captura superó 30 segundos");
      return value;
    };
    const contextPromise = this.browser.newContext({
      viewport: {
        width: request.viewport.width,
        height: request.viewport.height,
      },
      deviceScaleFactor: 1,
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      colorScheme: "light",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const context = await withTimeout(
      contextPromise,
      remaining(),
      "La creación del contexto Playwright",
    );
    let captureFailure: unknown;
    let captured: BrowserCaptureResult | undefined;
    try {
      await withTimeout(
        context.addInitScript(DETERMINISTIC_INIT_SCRIPT),
        remaining(),
        "La inicialización determinista",
      );
      const page = await withTimeout(
        context.newPage(),
        remaining(),
        "La creación de página Playwright",
      );
      page.setDefaultTimeout(remaining());
      page.setDefaultNavigationTimeout(remaining());
      const pageErrors: string[] = [];
      const failedRequests: Array<{ url: string }> = [];
      page.on("pageerror", (error) => {
        if (pageErrors.length < 100)
          pageErrors.push(error.message.slice(0, 1024));
      });
      page.on("requestfailed", (failedRequest) => {
        if (failedRequests.length < 1_001) {
          failedRequests.push({ url: failedRequest.url() });
        }
      });
      const response = await withTimeout(
        page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: remaining(),
        }),
        remaining(),
        "La navegación Playwright",
      );
      if (response === null) {
        throw new Error("La navegación no devolvió una respuesta HTTP");
      }
      const status = await withTimeout(
        earliestStatus(response),
        remaining(),
        "La resolución del status HTTP",
      );
      await withTimeout(
        page.evaluate(async () => {
          await document.fonts.ready;
        }),
        remaining(),
        "document.fonts.ready",
      );
      const documentDimensions = await withTimeout(
        page.evaluate(() => ({
          width: Math.max(
            document.documentElement.scrollWidth,
            document.body?.scrollWidth ?? 0,
          ),
          height: Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0,
          ),
        })),
        remaining(),
        "Las dimensiones del documento",
      );
      if (
        documentDimensions.width > request.viewport.width ||
        documentDimensions.height > defaultLimits.maxHeight
      ) {
        throw new RangeError(
          "El documento supera el ancho del viewport o 30.000 px de alto",
        );
      }
      await withTimeout(
        page.evaluate(async () => {
          const step = Math.max(window.innerHeight, 1);
          const height = Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0,
          );
          for (let y = 0; y < height; y += step) {
            window.scrollTo(0, y);
            await new Promise<void>((resolveFrame) =>
              requestAnimationFrame(() => resolveFrame()),
            );
          }
          window.scrollTo(0, 0);
          const images = Array.from(document.images);
          await Promise.all(
            images.map(async (image) => {
              image.loading = "eager";
              if (!image.complete) {
                await new Promise<void>((resolveImage) => {
                  image.addEventListener("load", () => resolveImage(), {
                    once: true,
                  });
                  image.addEventListener("error", () => resolveImage(), {
                    once: true,
                  });
                });
              }
              try {
                await image.decode();
              } catch {
                // Broken cross-origin images are classified from requestfailed.
              }
            }),
          );
        }),
        remaining(),
        "La carga estable de imágenes",
      );
      await withTimeout(
        page.waitForTimeout(250),
        remaining(),
        "La estabilización de la página",
      );
      const documentVisible = await withTimeout(
        page.evaluate(() => {
          const root = document.documentElement;
          const body = document.body;
          return (
            root !== null &&
            body !== null &&
            root.getBoundingClientRect().width > 0 &&
            root.getBoundingClientRect().height > 0
          );
        }),
        remaining(),
        "La comprobación del documento",
      );
      const pagePng = await withTimeout(
        page.screenshot({
          fullPage: true,
          type: "png",
          animations: "disabled",
        }),
        remaining(),
        "La captura full-page",
      );
      let section: BrowserSectionCapture | null = null;
      if (request.selector !== null) {
        const locator = page.locator(request.selector);
        const count = await withTimeout(
          locator.count(),
          remaining(),
          "El conteo del selector",
        );
        const visible =
          count === 1
            ? await withTimeout(
                locator.isVisible(),
                remaining(),
                "La visibilidad del selector",
              )
            : false;
        const box =
          count === 1 && visible
            ? await withTimeout(
                locator.boundingBox(),
                remaining(),
                "La geometría del selector",
              )
            : null;
        const png =
          box === null
            ? Buffer.alloc(0)
            : await withTimeout(
                locator.screenshot({ type: "png", animations: "disabled" }),
                remaining(),
                "La captura del selector",
              );
        section = {
          count,
          visible,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
          png,
        };
      }
      captured = {
        status,
        finalUrl: page.url(),
        documentVisible,
        pagePng,
        section,
        pageErrors,
        failedRequests,
      };
    } catch (error) {
      captureFailure = error;
    }
    let cleanupFailure: unknown;
    try {
      await closeContext(context);
    } catch (error) {
      cleanupFailure = error;
    }
    if (captureFailure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError(
        [captureFailure, cleanupFailure],
        "Fallaron la página y el cierre del contexto",
      );
    }
    if (captureFailure !== undefined) throw captureFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
    return captured as BrowserCaptureResult;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

export async function createPlaywrightAdapter(): Promise<BrowserAdapter> {
  const browser = await withTimeout(
    chromium.launch({ headless: true }),
    pageTimeoutMs,
    "El lanzamiento de Chromium",
  );
  return new PlaywrightBrowserAdapter(browser);
}
