import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  stableCaptureProjection,
  type CaptureManifest,
  type CaptureRecord,
  type CaptureSet,
  type ReleaseCaptureContext,
} from "./capture.ts";
import {
  canonicalJson,
  EVIDENCE_REQUEST_PATH,
  EVIDENCE_VIEWPORTS,
  sha256,
  type AllowedHttpStatus,
  type EvidenceRole,
} from "./domain.ts";
import type { PullRequestRunContext } from "./github.ts";
import { validateNormalizedEvidenceRequest } from "./request.ts";

type JsonRecord = Record<string, unknown>;

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

export type EvidencePublicationContext =
  PullRequestRunContext | ReleaseCaptureContext;

export interface PublishEvidenceInput {
  capture: CaptureSet;
  checkoutRoot: string;
  context: EvidencePublicationContext;
}

export interface PublishedPng {
  filename: string;
  rawUrl: string;
}

export interface PublishedEvidenceEntry {
  role: EvidenceRole;
  sourceSha: string;
  relativeDirectory: string;
  previewUrl: string;
  manifestUrl: string;
  pngs: PublishedPng[];
}

export interface PublishEvidenceResult {
  schemaVersion: 1;
  kind: "pull-request" | "release";
  repository: string;
  issueNumber: number;
  prNumber: number;
  source: {
    baseSha: string | null;
    headSha: string | null;
    releaseSha: string | null;
  };
  runUrl: string;
  entries: PublishedEvidenceEntry[];
  addedPaths: string[];
  existingPaths: string[];
  commitMessage: string;
}

interface LoadedCapture {
  set: CaptureSet;
  files: Map<string, Buffer>;
}

interface ValidatedContext {
  kind: "pull-request" | "release";
  repository: string;
  issueNumber: number;
  prNumber: number;
  runId: number;
  runUrl: string;
  requestPath: string;
  route: string;
  selector: string | null;
  expectedStatus: { base: AllowedHttpStatus; candidate: AllowedHttpStatus };
  source: PublishEvidenceResult["source"];
}

interface RolePlan {
  role: EvidenceRole;
  sourceSha: string;
  relativeDirectory: string;
  destination: string;
  manifest: CaptureManifest;
  files: Map<string, Buffer>;
  state: "new" | "existing";
}

const gitShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const maxManifestBytes = 256 * 1024;
const maxPngBytes = 8 * 1024 * 1024;
const maxTotalBytes = 40 * 1024 * 1024;
const maxHeight = 30_000;
const allowedStatuses = new Set<number>([200, 301, 302, 307, 308, 404, 410]);
const roles = new Set<EvidenceRole>(["base", "candidate", "release"]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${label} es inválido`);
  return value;
}

function exactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} contiene campos no permitidos`);
  }
}

function containsForbiddenControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (
      (codePoint >= 0x01 && codePoint <= 0x08) ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function boundedText(value: unknown, label: string, max = 2048): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\0") ||
    containsForbiddenControls(value)
  ) {
    throw new TypeError(`${label} contiene texto inválido`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} debe ser un entero positivo`);
  }
  return value as number;
}

function nullableSha(value: unknown, label: string): string | null {
  if (value === null) return null;
  const result = boundedText(value, label, 40);
  if (!gitShaPattern.test(result)) throw new TypeError(`${label} es inválido`);
  return result;
}

function validatedDate(value: unknown): string {
  const text = boundedText(value, "La fecha de captura", 64);
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) {
    throw new TypeError("La fecha de captura no es UTC canónica");
  }
  return text;
}

function validatedGitHubRunUrl(
  value: unknown,
  repository: string | null,
  runId: number,
): string {
  let url: URL;
  try {
    url = new URL(boundedText(value, "La URL del run GitHub"));
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
    !url.pathname.endsWith(`/actions/runs/${runId}`) ||
    (repository !== null &&
      url.pathname !== `/${repository}/actions/runs/${runId}`)
  ) {
    throw new TypeError("La URL del run GitHub es inválida");
  }
  return url.toString();
}

function validatedPreviewLocation(
  rawUrl: unknown,
  rawOrigin: unknown,
  route: string,
): { url: string; origin: string } {
  let url: URL;
  try {
    url = new URL(boundedText(rawUrl, "La URL preview"));
  } catch {
    throw new TypeError("La URL preview es inválida");
  }
  const origin = boundedText(rawOrigin, "El origen preview");
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.hostname === "workers.dev" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== origin ||
    url.pathname !== route
  ) {
    throw new TypeError("La URL preview está fuera del origen workers.dev");
  }
  return { url: url.toString(), origin };
}

function canonicalFilename(
  role: EvidenceRole,
  viewport: "desktop" | "mobile",
  kind: "page" | "section",
): string {
  const prefix =
    role === "base" ? "before" : role === "candidate" ? "after" : "release";
  return kind === "page"
    ? `${prefix}-${viewport}.png`
    : `${prefix}-section-${viewport}.png`;
}

function validateCaptureRecord(
  value: unknown,
  manifest: {
    route: string;
    selector: string | null;
  },
): CaptureRecord {
  const capture = record(value, "Una captura del manifest");
  exactKeys(
    capture,
    [
      "role",
      "kind",
      "sourceSha",
      "versionId",
      "origin",
      "url",
      "route",
      "status",
      "viewport",
      "selector",
      "filename",
      "bytes",
      "width",
      "height",
      "sha256",
      "pageErrors",
      "sameOriginFailures",
      "crossOriginFailures",
    ],
    "Una captura del manifest",
  );
  if (!roles.has(capture.role as EvidenceRole)) {
    throw new TypeError("El rol de captura es inválido");
  }
  const role = capture.role as EvidenceRole;
  if (capture.kind !== "page" && capture.kind !== "section") {
    throw new TypeError("El tipo de captura es inválido");
  }
  const kind = capture.kind;
  const sourceSha = boundedText(capture.sourceSha, "El SHA de captura", 40);
  if (!gitShaPattern.test(sourceSha)) {
    throw new TypeError("El SHA de captura es inválido");
  }
  const versionId = boundedText(capture.versionId, "El Version ID", 36);
  if (!uuidPattern.test(versionId)) {
    throw new TypeError("El Version ID de captura es inválido");
  }
  if (
    capture.route !== manifest.route ||
    capture.selector !== manifest.selector
  ) {
    throw new TypeError("La captura no coincide con route o selector");
  }
  if (kind === "section" && manifest.selector === null) {
    throw new TypeError("Una captura section requiere selector");
  }
  const viewport = record(capture.viewport, "El viewport de captura");
  exactKeys(
    viewport,
    ["name", "width", "height", "deviceScaleFactor"],
    "El viewport de captura",
  );
  const expectedViewport = EVIDENCE_VIEWPORTS.find(
    (candidate) => candidate.name === viewport.name,
  );
  if (
    expectedViewport === undefined ||
    viewport.width !== expectedViewport.width ||
    viewport.height !== expectedViewport.height ||
    viewport.deviceScaleFactor !== expectedViewport.deviceScaleFactor
  ) {
    throw new TypeError("El viewport de captura es inválido");
  }
  const filename = boundedText(capture.filename, "El filename de captura", 128);
  if (filename !== canonicalFilename(role, expectedViewport.name, kind)) {
    throw new TypeError("El filename de captura no es canónico");
  }
  const bytes = positiveInteger(capture.bytes, "Los bytes de captura");
  const width = positiveInteger(capture.width, "El ancho de captura");
  const height = positiveInteger(capture.height, "El alto de captura");
  if (
    bytes > maxPngBytes ||
    height > maxHeight ||
    (kind === "page" && width !== expectedViewport.width) ||
    (kind === "section" && width > expectedViewport.width)
  ) {
    throw new RangeError("Las dimensiones o bytes de captura son inválidos");
  }
  const digest = boundedText(capture.sha256, "El hash PNG", 64);
  if (!sha256Pattern.test(digest))
    throw new TypeError("El hash PNG es inválido");
  if (
    !allowedStatuses.has(capture.status as number) ||
    capture.pageErrors !== 0 ||
    capture.sameOriginFailures !== 0
  ) {
    throw new TypeError("El estado operativo de captura es inválido");
  }
  const crossOrigin = record(
    capture.crossOriginFailures,
    "Los fallos cross-origin",
  );
  if (Object.keys(crossOrigin).length > 100) {
    throw new RangeError("Hay demasiados orígenes externos fallidos");
  }
  const normalizedCrossOrigin: Record<string, number> = {};
  for (const [origin, count] of Object.entries(crossOrigin).sort()) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError("Un origen externo fallido es inválido");
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.origin !== origin ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !Number.isSafeInteger(count) ||
      (count as number) < 1
    ) {
      throw new TypeError("Un origen externo fallido es inválido");
    }
    normalizedCrossOrigin[origin] = count as number;
  }
  const location = validatedPreviewLocation(
    capture.url,
    capture.origin,
    manifest.route,
  );
  return {
    role,
    kind,
    sourceSha,
    versionId,
    origin: location.origin,
    url: location.url,
    route: manifest.route,
    status: capture.status as AllowedHttpStatus,
    viewport: { ...expectedViewport },
    selector: manifest.selector,
    filename,
    bytes,
    width,
    height,
    sha256: digest,
    pageErrors: 0,
    sameOriginFailures: 0,
    crossOriginFailures: normalizedCrossOrigin,
  };
}

export function validateCaptureManifest(value: unknown): CaptureManifest {
  const manifest = record(value, "El manifest de captura");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "kind",
      "issue",
      "prNumber",
      "requestPath",
      "route",
      "selector",
      "source",
      "capturedAt",
      "run",
      "tools",
      "captures",
    ],
    "El manifest de captura",
  );
  if (
    manifest.schemaVersion !== 1 ||
    (manifest.kind !== "pull-request" && manifest.kind !== "release")
  ) {
    throw new TypeError("El schema o tipo del manifest es inválido");
  }
  const issue = positiveInteger(manifest.issue, "La issue del manifest");
  const prNumber = positiveInteger(manifest.prNumber, "La PR del manifest");
  const requestPath = boundedText(
    manifest.requestPath,
    "El request path del manifest",
  );
  const requestMatch = EVIDENCE_REQUEST_PATH.exec(requestPath);
  if (requestMatch === null || Number(requestMatch[1]) !== issue) {
    throw new TypeError("El request path del manifest es inválido");
  }
  const route = boundedText(manifest.route, "La route del manifest");
  if (
    !route.startsWith("/") ||
    route.includes("//") ||
    route.includes("?") ||
    route.includes("#")
  ) {
    throw new TypeError("La route del manifest es inválida");
  }
  const selector =
    manifest.selector === null
      ? null
      : boundedText(manifest.selector, "El selector del manifest", 512);
  const source = record(manifest.source, "La fuente del manifest");
  exactKeys(
    source,
    ["baseSha", "candidateSha", "releaseSha"],
    "La fuente del manifest",
  );
  const baseSha = nullableSha(source.baseSha, "El SHA base");
  const candidateSha = nullableSha(source.candidateSha, "El SHA candidate");
  const releaseSha = nullableSha(source.releaseSha, "El SHA release");
  const activeRoles: EvidenceRole[] = [];
  if (baseSha !== null) activeRoles.push("base");
  if (candidateSha !== null) activeRoles.push("candidate");
  if (releaseSha !== null) activeRoles.push("release");
  if (
    activeRoles.length === 0 ||
    (manifest.kind === "pull-request" &&
      (releaseSha !== null || (baseSha === null && candidateSha === null))) ||
    (manifest.kind === "release" &&
      (releaseSha === null || baseSha !== null || candidateSha !== null))
  ) {
    throw new TypeError("La fuente del manifest no coincide con su tipo");
  }
  const run = record(manifest.run, "El run del manifest");
  exactKeys(run, ["id", "url", "attempt"], "El run del manifest");
  const runId = positiveInteger(run.id, "El run ID del manifest");
  const runAttempt = positiveInteger(run.attempt, "El intento del manifest");
  const tools = record(manifest.tools, "Las tools del manifest");
  exactKeys(tools, ["node", "playwright", "browser"], "Las tools del manifest");
  const normalizedTools = {
    node: boundedText(tools.node, "La versión Node", 256),
    playwright: boundedText(tools.playwright, "La versión Playwright", 256),
    browser: boundedText(tools.browser, "La versión browser", 256),
  };
  if (!Array.isArray(manifest.captures) || manifest.captures.length > 8) {
    throw new RangeError("El manifest debe contener entre 1 y 8 capturas");
  }
  const captures = manifest.captures.map((capture) =>
    validateCaptureRecord(capture, { route, selector }),
  );
  const expectedNames: string[] = [];
  for (const role of activeRoles) {
    for (const viewport of EVIDENCE_VIEWPORTS) {
      expectedNames.push(canonicalFilename(role, viewport.name, "page"));
      if (selector !== null) {
        expectedNames.push(canonicalFilename(role, viewport.name, "section"));
      }
    }
  }
  const actualNames = captures.map((capture) => capture.filename);
  if (
    captures.length === 0 ||
    new Set(actualNames).size !== actualNames.length ||
    canonicalJson([...actualNames].sort()) !==
      canonicalJson([...expectedNames].sort())
  ) {
    throw new TypeError("El inventario de capturas no es canónico");
  }
  const sourceByRole: Record<EvidenceRole, string | null> = {
    base: baseSha,
    candidate: candidateSha,
    release: releaseSha,
  };
  for (const role of activeRoles) {
    const roleCaptures = captures.filter((capture) => capture.role === role);
    if (
      roleCaptures.length === 0 ||
      roleCaptures.some(
        (capture) =>
          capture.sourceSha !== sourceByRole[role] ||
          capture.versionId !== roleCaptures[0].versionId ||
          capture.url !== roleCaptures[0].url ||
          capture.origin !== roleCaptures[0].origin ||
          capture.status !== roleCaptures[0].status,
      )
    ) {
      throw new TypeError("La identidad de capturas por rol es inconsistente");
    }
  }
  if (activeRoles.includes("base") && activeRoles.includes("candidate")) {
    const baseCapture = captures.find((capture) => capture.role === "base");
    const candidateCapture = captures.find(
      (capture) => capture.role === "candidate",
    );
    if (
      baseCapture === undefined ||
      candidateCapture === undefined ||
      baseCapture.versionId === candidateCapture.versionId ||
      baseCapture.url === candidateCapture.url
    ) {
      throw new TypeError(
        "Base y candidate deben conservar identidades preview distintas",
      );
    }
  }
  if (captures.some((capture) => !activeRoles.includes(capture.role))) {
    throw new TypeError("Una captura no pertenece a la fuente declarada");
  }
  return {
    schemaVersion: 1,
    kind: manifest.kind,
    issue,
    prNumber,
    requestPath,
    route,
    selector,
    source: { baseSha, candidateSha, releaseSha },
    capturedAt: validatedDate(manifest.capturedAt),
    run: {
      id: runId,
      url: validatedGitHubRunUrl(run.url, null, runId),
      attempt: runAttempt,
    },
    tools: normalizedTools,
    captures,
  };
}

async function readRegular(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > maxBytes
  ) {
    throw new TypeError(`${label} debe ser un archivo regular acotado`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== info.size) {
      throw new TypeError(`${label} cambió durante la lectura`);
    }
    return await handle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError(`${label} no puede ser un symlink`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function loadCapture(rootInput: string): Promise<LoadedCapture> {
  const root = resolve(rootInput);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new TypeError(
      "El root de captura no puede ser symlink y debe existir",
    );
  }
  const manifestPath = join(root, "manifest.json");
  const manifestContents = await readRegular(
    manifestPath,
    maxManifestBytes,
    "El manifest de captura",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestContents.toString("utf8"));
  } catch {
    throw new TypeError("El manifest de captura contiene JSON inválido");
  }
  const manifest = validateCaptureManifest(parsed);
  const expectedManifest = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  if (!manifestContents.equals(expectedManifest)) {
    throw new TypeError("El manifest de captura no usa JSON canónico");
  }
  const expectedNames = [
    "manifest.json",
    ...manifest.captures.map((capture) => capture.filename),
  ].sort();
  const actualNames = (await readdir(root)).sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
    throw new TypeError(
      "El inventario de captura contiene archivos extra o falta alguno",
    );
  }
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const capture of manifest.captures) {
    const contents = await readRegular(
      join(root, capture.filename),
      maxPngBytes,
      `El PNG ${capture.filename}`,
    );
    totalBytes += contents.length;
    if (
      totalBytes > maxTotalBytes ||
      contents.length !== capture.bytes ||
      sha256(contents) !== capture.sha256 ||
      contents.length < 24 ||
      !contents.subarray(0, 8).equals(pngSignature)
    ) {
      throw new Error(`El PNG ${capture.filename} no coincide en bytes o hash`);
    }
    let image: PngImage;
    try {
      image = PNG.sync.read(contents);
    } catch {
      throw new TypeError(`El PNG ${capture.filename} es inválido`);
    }
    if (image.width !== capture.width || image.height !== capture.height) {
      throw new Error(`El PNG ${capture.filename} no coincide en dimensiones`);
    }
    files.set(capture.filename, contents);
  }
  return {
    set: { root, manifestPath, manifest },
    files,
  };
}

export async function readCaptureSet(root: string): Promise<CaptureSet> {
  return (await loadCapture(root)).set;
}

function validateContext(
  context: EvidencePublicationContext,
): ValidatedContext {
  const value = record(context, "El contexto de publicación");
  const repository = boundedText(value.repository, "El repositorio");
  if (!repositoryPattern.test(repository)) {
    throw new TypeError("El repositorio de publicación es inválido");
  }
  const issueNumber = positiveInteger(value.issueNumber, "La issue");
  const prNumber = positiveInteger(value.prNumber, "La PR");
  const runId = positiveInteger(value.runId, "El run ID");
  const requestPath = boundedText(value.requestPath, "El request path");
  const request = validateNormalizedEvidenceRequest(value.request, requestPath);
  if (request.issue !== issueNumber) {
    throw new TypeError("La issue del contexto no coincide con el request");
  }
  const runUrl = validatedGitHubRunUrl(value.runUrl, repository, runId);
  if ("baseSha" in value && "headSha" in value) {
    const baseSha = nullableSha(value.baseSha, "El SHA base");
    const headSha = nullableSha(value.headSha, "El SHA candidate");
    if (baseSha === null || headSha === null) {
      throw new TypeError("El contexto PR requiere SHAs base y candidate");
    }
    return {
      kind: "pull-request",
      repository,
      issueNumber,
      prNumber,
      runId,
      runUrl,
      requestPath,
      route: request.route,
      selector: request.selector,
      expectedStatus: request.expectedStatus,
      source: { baseSha, headSha, releaseSha: null },
    };
  }
  const releaseSha = nullableSha(value.sourceSha, "El SHA release");
  if (releaseSha === null) {
    throw new TypeError("El contexto release requiere source SHA");
  }
  return {
    kind: "release",
    repository,
    issueNumber,
    prNumber,
    runId,
    runUrl,
    requestPath,
    route: request.route,
    selector: request.selector,
    expectedStatus: request.expectedStatus,
    source: { baseSha: null, headSha: null, releaseSha },
  };
}

function assertManifestMatchesContext(
  manifest: CaptureManifest,
  context: ValidatedContext,
): void {
  const expectedSource = {
    baseSha: context.source.baseSha,
    candidateSha: context.source.headSha,
    releaseSha: context.source.releaseSha,
  };
  if (
    manifest.kind !== context.kind ||
    manifest.issue !== context.issueNumber ||
    manifest.prNumber !== context.prNumber ||
    manifest.requestPath !== context.requestPath ||
    manifest.route !== context.route ||
    manifest.selector !== context.selector ||
    manifest.run.id !== context.runId ||
    manifest.run.url !== context.runUrl ||
    canonicalJson(manifest.source) !== canonicalJson(expectedSource)
  ) {
    throw new TypeError("La captura no coincide con el contexto sellado");
  }
  for (const capture of manifest.captures) {
    const expected =
      capture.role === "base"
        ? context.expectedStatus.base
        : context.expectedStatus.candidate;
    if (capture.status !== expected) {
      throw new TypeError("El status de captura no coincide con el request");
    }
  }
}

function roleManifest(
  manifest: CaptureManifest,
  role: EvidenceRole,
): CaptureManifest {
  const source = {
    baseSha: role === "base" ? manifest.source.baseSha : null,
    candidateSha: role === "candidate" ? manifest.source.candidateSha : null,
    releaseSha: role === "release" ? manifest.source.releaseSha : null,
  };
  return validateCaptureManifest({
    ...structuredClone(manifest),
    source,
    captures: manifest.captures.filter((capture) => capture.role === role),
  });
}

function relativeRoleDirectory(
  issue: number,
  role: EvidenceRole,
  sourceSha: string,
): string {
  const group =
    role === "base"
      ? "baseline"
      : role === "candidate"
        ? "candidates"
        : "releases";
  return `issue-${issue}/${group}/${sourceSha}`;
}

function safeDestination(root: string, relativePath: string): string {
  if (
    relativePath.startsWith("/") ||
    relativePath.split("/").some((part) => !/^[A-Za-z0-9._-]+$/u.test(part))
  ) {
    throw new TypeError("La ruta de evidencia es inválida");
  }
  const destination = resolve(root, ...relativePath.split("/"));
  if (!destination.startsWith(`${root}${sep}`)) {
    throw new TypeError("La ruta de evidencia salió del checkout");
  }
  return destination;
}

async function classifyDestination(
  checkoutRoot: string,
  relativeDirectory: string,
): Promise<"new" | "existing"> {
  let current = checkoutRoot;
  for (const part of relativeDirectory.split("/")) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new TypeError("Una ruta del destino no es directorio regular");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "new";
      throw error;
    }
  }
  return "existing";
}

async function readPublishedDirectory(
  directory: string,
): Promise<LoadedCapture> {
  return await loadCapture(directory);
}

function rolePaths(plan: RolePlan): string[] {
  return [
    ...plan.manifest.captures.map(
      (capture) => `${plan.relativeDirectory}/${capture.filename}`,
    ),
    `${plan.relativeDirectory}/manifest.json`,
  ].sort();
}

async function verifyExistingPlan(plan: RolePlan): Promise<void> {
  let existing: LoadedCapture;
  try {
    existing = await readPublishedDirectory(plan.destination);
  } catch (error) {
    throw new Error(
      `El manifest o inventario del destino ${plan.relativeDirectory} es inválido: ${
        error instanceof Error ? error.message : "error desconocido"
      }`,
    );
  }
  if (
    canonicalJson(stableCaptureProjection(existing.set.manifest)) !==
    canonicalJson(stableCaptureProjection(plan.manifest))
  ) {
    throw new Error(
      `El manifest existente en ${plan.relativeDirectory} es diferente`,
    );
  }
  for (const [filename, source] of plan.files) {
    const destination = existing.files.get(filename);
    if (destination === undefined || !destination.equals(source)) {
      throw new Error(
        `La evidencia existente ${plan.relativeDirectory}/${filename} es diferente`,
      );
    }
  }
}

async function ensureSafeDirectory(
  root: string,
  relativeDirectory: string,
): Promise<string> {
  let current = root;
  for (const part of relativeDirectory.split("/")) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Una ruta del checkout de evidencia no es segura");
    }
  }
  return current;
}

async function writeExclusive(path: string, contents: Buffer): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(contents);
  } finally {
    await handle?.close();
  }
}

async function stagePlan(
  plan: RolePlan,
  checkoutRoot: string,
): Promise<string> {
  const parentRelative = plan.relativeDirectory
    .split("/")
    .slice(0, -1)
    .join("/");
  const parent = await ensureSafeDirectory(checkoutRoot, parentRelative);
  const staging = join(parent, `.preview-evidence-${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const [filename, contents] of plan.files) {
      await writeExclusive(join(staging, filename), contents);
    }
    await writeExclusive(
      join(staging, "manifest.json"),
      Buffer.from(`${canonicalJson(plan.manifest)}\n`, "utf8"),
    );
    const staged = await readPublishedDirectory(staging);
    if (canonicalJson(staged.set.manifest) !== canonicalJson(plan.manifest)) {
      throw new Error("La evidencia staged no coincide con el manifest");
    }
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function installStagedPlan(
  plan: RolePlan,
  staging: string,
): Promise<void> {
  await mkdir(plan.destination, { mode: 0o755 });
  try {
    const names = (await readdir(staging)).sort();
    for (const name of names) {
      await rename(join(staging, name), join(plan.destination, name));
    }
    await rm(staging, { recursive: true, force: false });
  } catch (error) {
    await rm(plan.destination, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function publicationEntry(
  repository: string,
  plan: RolePlan,
): PublishedEvidenceEntry {
  const encoded = encodedPath(plan.relativeDirectory);
  return {
    role: plan.role,
    sourceSha: plan.sourceSha,
    relativeDirectory: plan.relativeDirectory,
    previewUrl: plan.manifest.captures[0].url,
    manifestUrl: `https://github.com/${repository}/blob/evidence/${encoded}/manifest.json`,
    pngs: plan.manifest.captures.map((capture) => ({
      filename: capture.filename,
      rawUrl: `https://raw.githubusercontent.com/${repository}/evidence/${encoded}/${encodeURIComponent(capture.filename)}`,
    })),
  };
}

function validatePublicationUrl(value: unknown, label: string): string {
  let url: URL;
  try {
    url = new URL(boundedText(value, label));
  } catch {
    throw new TypeError(`${label} es inválida`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.hostname === "workers.dev" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} debe pertenecer a workers.dev`);
  }
  return url.toString();
}

function validatePublishedEntry(
  value: unknown,
  repository: string,
  issueNumber: number,
  expectedRole: EvidenceRole,
  expectedSha: string,
): PublishedEvidenceEntry {
  const entry = record(value, "Una entrada de publicación");
  exactKeys(
    entry,
    [
      "role",
      "sourceSha",
      "relativeDirectory",
      "previewUrl",
      "manifestUrl",
      "pngs",
    ],
    "Una entrada de publicación",
  );
  if (entry.role !== expectedRole || entry.sourceSha !== expectedSha) {
    throw new TypeError("La entrada de publicación no coincide con su fuente");
  }
  const relativeDirectory = relativeRoleDirectory(
    issueNumber,
    expectedRole,
    expectedSha,
  );
  if (entry.relativeDirectory !== relativeDirectory) {
    throw new TypeError("La ruta de publicación no es canónica");
  }
  const encoded = encodedPath(relativeDirectory);
  const manifestUrl = `https://github.com/${repository}/blob/evidence/${encoded}/manifest.json`;
  if (entry.manifestUrl !== manifestUrl) {
    throw new TypeError("La URL del manifest publicado es inválida");
  }
  if (!Array.isArray(entry.pngs) || ![2, 4].includes(entry.pngs.length)) {
    throw new TypeError(
      "La publicación debe contener desktop/mobile y sección opcional",
    );
  }
  const pngs: PublishedPng[] = entry.pngs.map((value) => {
    const png = record(value, "Un PNG publicado");
    exactKeys(png, ["filename", "rawUrl"], "Un PNG publicado");
    const filename = boundedText(png.filename, "El filename publicado", 128);
    const rawUrl = `https://raw.githubusercontent.com/${repository}/evidence/${encoded}/${encodeURIComponent(filename)}`;
    if (png.rawUrl !== rawUrl) {
      throw new TypeError("La URL raw de evidencia es inválida");
    }
    return { filename, rawUrl };
  });
  const expectedPageNames = EVIDENCE_VIEWPORTS.map((viewport) =>
    canonicalFilename(expectedRole, viewport.name, "page"),
  );
  const expectedSectionNames = EVIDENCE_VIEWPORTS.map((viewport) =>
    canonicalFilename(expectedRole, viewport.name, "section"),
  );
  const expectedNames =
    pngs.length === 4
      ? EVIDENCE_VIEWPORTS.flatMap((viewport) => [
          canonicalFilename(expectedRole, viewport.name, "page"),
          canonicalFilename(expectedRole, viewport.name, "section"),
        ])
      : expectedPageNames;
  if (
    canonicalJson(pngs.map((png) => png.filename)) !==
      canonicalJson(expectedNames) ||
    (pngs.length === 4 &&
      !expectedSectionNames.every((name) =>
        pngs.some((png) => png.filename === name),
      ))
  ) {
    throw new TypeError("Los PNG publicados no tienen nombres canónicos");
  }
  return {
    role: expectedRole,
    sourceSha: expectedSha,
    relativeDirectory,
    previewUrl: validatePublicationUrl(entry.previewUrl, "La Preview URL"),
    manifestUrl,
    pngs,
  };
}

export function validatePublishEvidenceResult(
  value: unknown,
): PublishEvidenceResult {
  const publication = record(value, "La publicación de evidencia");
  exactKeys(
    publication,
    [
      "schemaVersion",
      "kind",
      "repository",
      "issueNumber",
      "prNumber",
      "source",
      "runUrl",
      "entries",
      "addedPaths",
      "existingPaths",
      "commitMessage",
    ],
    "La publicación de evidencia",
  );
  if (
    publication.schemaVersion !== 1 ||
    (publication.kind !== "pull-request" && publication.kind !== "release")
  ) {
    throw new TypeError("El schema o tipo de publicación es inválido");
  }
  const repository = boundedText(publication.repository, "El repositorio");
  if (!repositoryPattern.test(repository)) {
    throw new TypeError("El repositorio de publicación es inválido");
  }
  const issueNumber = positiveInteger(publication.issueNumber, "La issue");
  const prNumber = positiveInteger(publication.prNumber, "La PR");
  const source = record(publication.source, "La fuente de publicación");
  exactKeys(
    source,
    ["baseSha", "headSha", "releaseSha"],
    "La fuente de publicación",
  );
  const baseSha = nullableSha(source.baseSha, "El SHA base publicado");
  const headSha = nullableSha(source.headSha, "El SHA candidate publicado");
  const releaseSha = nullableSha(source.releaseSha, "El SHA release publicado");
  const expectedRoles: Array<[EvidenceRole, string]> = [];
  if (publication.kind === "pull-request") {
    if (baseSha === null || headSha === null || releaseSha !== null) {
      throw new TypeError("Una publicación PR requiere base y candidate");
    }
    expectedRoles.push(["base", baseSha], ["candidate", headSha]);
  } else {
    if (releaseSha === null || baseSha !== null || headSha !== null) {
      throw new TypeError("Una publicación release requiere solo release SHA");
    }
    expectedRoles.push(["release", releaseSha]);
  }
  if (
    !Array.isArray(publication.entries) ||
    publication.entries.length !== expectedRoles.length
  ) {
    throw new TypeError("La publicación no contiene las entradas esperadas");
  }
  const entries = publication.entries.map((entry, index) => {
    const [role, sourceSha] = expectedRoles[index];
    return validatePublishedEntry(
      entry,
      repository,
      issueNumber,
      role,
      sourceSha,
    );
  });
  if (entries.length === 2 && entries[0].previewUrl === entries[1].previewUrl) {
    throw new TypeError("Base y candidate deben tener Preview URLs distintas");
  }
  const runUrlText = boundedText(publication.runUrl, "La URL del run");
  const runMatch = new RegExp(
    `^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/actions/runs/([1-9][0-9]*)$`,
    "u",
  ).exec(runUrlText);
  if (runMatch === null) {
    throw new TypeError("La URL del run de publicación es inválida");
  }
  const runUrl = validatedGitHubRunUrl(
    runUrlText,
    repository,
    Number(runMatch[1]),
  );
  const expectedPaths = entries
    .flatMap((entry) => [
      ...entry.pngs.map((png) => `${entry.relativeDirectory}/${png.filename}`),
      `${entry.relativeDirectory}/manifest.json`,
    ])
    .sort();
  function validatedPaths(raw: unknown, label: string): string[] {
    if (!Array.isArray(raw)) throw new TypeError(`${label} debe ser una lista`);
    const paths = raw.map((path) => boundedText(path, label));
    if (
      new Set(paths).size !== paths.length ||
      canonicalJson(paths) !== canonicalJson([...paths].sort()) ||
      paths.some(
        (path) =>
          path.startsWith("/") ||
          path.split("/").some((part) => !/^[A-Za-z0-9._-]+$/u.test(part)),
      )
    ) {
      throw new TypeError(`${label} contiene paths inválidos`);
    }
    return paths;
  }
  const addedPaths = validatedPaths(publication.addedPaths, "addedPaths");
  const existingPaths = validatedPaths(
    publication.existingPaths,
    "existingPaths",
  );
  if (
    addedPaths.some((path) => existingPaths.includes(path)) ||
    canonicalJson([...addedPaths, ...existingPaths].sort()) !==
      canonicalJson(expectedPaths)
  ) {
    throw new TypeError("Los paths publicados no coinciden con las entradas");
  }
  const identitySha =
    publication.kind === "pull-request"
      ? (headSha as string)
      : (releaseSha as string);
  const identityLabel =
    publication.kind === "pull-request" ? "candidate" : "release";
  const commitMessage = `evidence: record issue ${issueNumber} ${identityLabel} ${identitySha.slice(0, 7)}`;
  if (publication.commitMessage !== commitMessage) {
    throw new TypeError("El mensaje de commit de evidencia es inválido");
  }
  return {
    schemaVersion: 1,
    kind: publication.kind,
    repository,
    issueNumber,
    prNumber,
    source: { baseSha, headSha, releaseSha },
    runUrl,
    entries,
    addedPaths,
    existingPaths,
    commitMessage,
  };
}

export async function writePublishEvidenceResult(
  path: string,
  value: PublishEvidenceResult,
): Promise<void> {
  const publication = validatePublishEvidenceResult(value);
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new TypeError("El directorio de publication output es inválido");
  }
  const contents = Buffer.from(`${canonicalJson(publication)}\n`, "utf8");
  if (contents.length > maxManifestBytes) {
    throw new RangeError("La publicación supera el tamaño máximo");
  }
  await writeExclusive(path, contents);
}

export async function readPublishEvidenceResult(
  path: string,
): Promise<PublishEvidenceResult> {
  const contents = await readRegular(
    path,
    maxManifestBytes,
    "La publicación de evidencia",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new TypeError("La publicación contiene JSON inválido");
  }
  const publication = validatePublishEvidenceResult(parsed);
  if (
    !contents.equals(Buffer.from(`${canonicalJson(publication)}\n`, "utf8"))
  ) {
    throw new TypeError("La publicación no usa JSON canónico");
  }
  return publication;
}

export async function publishEvidenceToCheckout(
  input: PublishEvidenceInput,
): Promise<PublishEvidenceResult> {
  const context = validateContext(input.context);
  const checkoutRoot = resolve(input.checkoutRoot);
  const checkoutInfo = await lstat(checkoutRoot);
  if (checkoutInfo.isSymbolicLink() || !checkoutInfo.isDirectory()) {
    throw new TypeError(
      "El checkout evidence debe ser un directorio, no symlink",
    );
  }
  const loaded = await loadCapture(input.capture.root);
  if (
    resolve(input.capture.root) !== loaded.set.root ||
    resolve(input.capture.manifestPath) !== loaded.set.manifestPath ||
    canonicalJson(input.capture.manifest) !== canonicalJson(loaded.set.manifest)
  ) {
    throw new TypeError("El objeto CaptureSet no coincide con su manifest");
  }
  assertManifestMatchesContext(loaded.set.manifest, context);
  const activeRoles: EvidenceRole[] =
    context.kind === "pull-request" ? ["base", "candidate"] : ["release"];
  const plans: RolePlan[] = [];
  for (const role of activeRoles) {
    const manifest = roleManifest(loaded.set.manifest, role);
    const sourceSha = manifest.captures[0].sourceSha;
    const relativeDirectory = relativeRoleDirectory(
      context.issueNumber,
      role,
      sourceSha,
    );
    const destination = safeDestination(checkoutRoot, relativeDirectory);
    const files = new Map<string, Buffer>();
    for (const capture of manifest.captures) {
      const contents = loaded.files.get(capture.filename);
      if (contents === undefined) {
        throw new Error("Falta un PNG declarado por el manifest");
      }
      files.set(capture.filename, contents);
    }
    plans.push({
      role,
      sourceSha,
      relativeDirectory,
      destination,
      manifest,
      files,
      state: await classifyDestination(checkoutRoot, relativeDirectory),
    });
  }

  // Validate every existing destination before staging or creating any role.
  for (const plan of plans) {
    if (plan.state === "existing") await verifyExistingPlan(plan);
  }

  const addedPaths = plans
    .filter((plan) => plan.state === "new")
    .flatMap(rolePaths)
    .sort();
  const existingPaths = plans
    .filter((plan) => plan.state === "existing")
    .flatMap(rolePaths)
    .sort();
  const identitySha =
    context.kind === "pull-request"
      ? (context.source.headSha as string)
      : (context.source.releaseSha as string);
  const identityLabel =
    context.kind === "pull-request" ? "candidate" : "release";
  const result = validatePublishEvidenceResult({
    schemaVersion: 1,
    kind: context.kind,
    repository: context.repository,
    issueNumber: context.issueNumber,
    prNumber: context.prNumber,
    source: { ...context.source },
    runUrl: context.runUrl,
    entries: plans.map((plan) => publicationEntry(context.repository, plan)),
    addedPaths,
    existingPaths,
    commitMessage: `evidence: record issue ${context.issueNumber} ${identityLabel} ${identitySha.slice(0, 7)}`,
  });

  const staged = new Map<RolePlan, string>();
  const installed: RolePlan[] = [];
  try {
    for (const plan of plans) {
      if (plan.state === "new") {
        staged.set(plan, await stagePlan(plan, checkoutRoot));
      }
    }
    for (const plan of plans) {
      const staging = staged.get(plan);
      if (staging !== undefined) {
        await installStagedPlan(plan, staging);
        staged.delete(plan);
        installed.push(plan);
      }
    }
    for (const plan of installed) await verifyExistingPlan(plan);
  } catch (error) {
    for (const staging of staged.values()) {
      await rm(staging, { recursive: true, force: true });
    }
    for (const plan of installed.reverse()) {
      await rm(plan.destination, { recursive: true, force: true });
    }
    throw error;
  }

  return result;
}
