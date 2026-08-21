import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { chromium } from "@playwright/test";

import {
  resolveDeploymentTopology,
  type DeploymentTopology,
} from "./parity-http.ts";
import {
  VISUAL_VIEWPORTS,
  captureDeterministicPage,
  compareVisuals,
  templateSelectors,
  type CaptureBrowserLike,
  type CaptureFixture,
  type CapturedVisual,
  type VisualComparison,
  type VisualResult,
  type ViewportContract,
} from "./lib/visual-contract.ts";
import {
  readExistingRouteMatrix,
  type RouteMatrixEntry,
} from "./lib/route-inventory.ts";
import { assertSourcePristine } from "./lib/source-reference.ts";
import {
  withTemporarySourceBuild,
  type TemporarySourceBuild,
} from "./lib/temporary-source-build.ts";

export interface VisualRuntime {
  origin: string;
  dispose(): Promise<void>;
}

export interface VisualArtifactPaths {
  root: string;
  json: string;
  html: string;
}

export interface VisualParitySummary {
  routes: number;
  results: number;
  matched: number;
  reviewRequired: number;
  pending: number;
}

export interface VisualParityResult {
  scope: "foundation";
  results: VisualComparison[];
  summary: VisualParitySummary;
  artifacts: VisualArtifactPaths;
}

export interface RunVisualParityOptions {
  scope: "foundation";
  allowPending: boolean;
  root?: string;
}

export interface VisualCaptureInput {
  browser: CaptureBrowserLike;
  side: "reference" | "candidate";
  runtime: VisualRuntime;
  route: RouteMatrixEntry;
  viewport: ViewportContract;
  localOrigins: string[];
  fixtures: CaptureFixture[];
}

export interface VisualReportInput {
  root: string;
  scope: "foundation";
  results: VisualComparison[];
  evidence: VisualEvidence[];
}

export interface VisualEvidence {
  result: VisualComparison;
  reference: CapturedVisual;
  candidate: CapturedVisual;
}

export interface VisualParityDependencies {
  assertSourcePristine?(): Promise<unknown>;
  buildCandidate?(root: string): Promise<void>;
  resolveCandidateTopology?(root: string): Promise<DeploymentTopology>;
  readMatrix?(root: string): Promise<RouteMatrixEntry[]>;
  readFixtures?(root: string): Promise<CaptureFixture[]>;
  startCandidate?(
    topology: DeploymentTopology,
    root: string,
  ): Promise<VisualRuntime>;
  withTemporarySourceBuild?<T>(
    callback: (build: TemporarySourceBuild) => Promise<T>,
  ): Promise<T>;
  startReference?(build: TemporarySourceBuild): Promise<VisualRuntime>;
  launchBrowser?(): Promise<CaptureBrowserLike & { close(): Promise<void> }>;
  capture?(input: VisualCaptureInput): Promise<CapturedVisual>;
  writeReports?(input: VisualReportInput): Promise<VisualArtifactPaths>;
}

interface WorkerHandler {
  fetch(
    request: Request,
    environment: Record<string, unknown>,
    context: {
      waitUntil(promise: Promise<unknown>): void;
      passThroughOnException(): void;
    },
  ): Promise<Response>;
}

interface StartedWranglerWorker {
  ready: Promise<unknown>;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

const sourceWorkerEntry = ["dist", "server", "index.js"] as const;
const visualFixtureFile = ["parity", "visual-fixtures.json"] as const;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function routeKey(route: Pick<RouteMatrixEntry, "kind" | "path">): string {
  return `${route.kind}:${route.path}`;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function resolveInside(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isWithin(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} debe permanecer dentro de ${resolvedRoot}`);
  }
  return resolvedCandidate;
}

function toPortableRelative(root: string, path: string): string {
  const portable = relative(resolve(root), resolve(path)).split(sep).join("/");
  if (
    !portable ||
    portable === ".." ||
    portable.startsWith("../") ||
    isAbsolute(portable)
  ) {
    throw new Error("El artefacto visual debe usar una ruta relativa portable");
  }
  return portable;
}

function safeArtifactSegment(value: string, label: string): string {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${label} visual inseguro: ${value}`);
  }
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!normalized || normalized === "." || normalized === "-") {
    throw new Error(`${label} visual inseguro: ${value}`);
  }
  return normalized;
}

function routeArtifactSegment(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`Ruta visual inválida: ${path}`);
  }
  if (
    !decoded.startsWith("/") ||
    decoded.includes("\0") ||
    decoded.split("/").includes("..") ||
    decoded.includes("\\")
  ) {
    throw new Error(`Ruta visual insegura: ${path}`);
  }
  if (decoded === "/") return "root";
  return safeArtifactSegment(
    decoded.split("/").filter(Boolean).join("-"),
    "Ruta",
  );
}

function artifactFiles(
  root: string,
  scope: "foundation",
  route: RouteMatrixEntry,
  viewport: ViewportContract,
): {
  reference: string;
  candidate: string;
  diff: string;
} {
  const template = route.visualTemplate;
  if (typeof template !== "string") {
    throw new Error(`La ruta visual no declara template: ${route.path}`);
  }
  const directory = resolveInside(
    resolve(root, ".artifacts", "visual"),
    join(
      resolve(root, ".artifacts", "visual"),
      safeArtifactSegment(scope, "Scope"),
      `${routeArtifactSegment(route.path)}-${safeArtifactSegment(template, "Template")}`,
      safeArtifactSegment(viewport.name, "Viewport"),
    ),
    "El artefacto visual",
  );
  return {
    reference: toPortableRelative(root, join(directory, "reference.png")),
    candidate: toPortableRelative(root, join(directory, "candidate.png")),
    diff: toPortableRelative(root, join(directory, "diff.png")),
  };
}

function resultForPendingRoute(
  route: RouteMatrixEntry,
  comparison: VisualComparison,
): VisualComparison {
  if (route.status !== "pending") return comparison;
  return { ...comparison, status: "pending" };
}

function summaryFor(results: VisualResult[]): VisualParitySummary {
  return {
    routes: new Set(results.map((result) => result.routeKey)).size,
    results: results.length,
    matched: results.filter((result) => result.status === "matched").length,
    reviewRequired: results.filter(
      (result) => result.status === "review-required",
    ).length,
    pending: results.filter((result) => result.status === "pending").length,
  };
}

export function selectFoundationVisualRoutes(
  matrix: RouteMatrixEntry[],
): RouteMatrixEntry[] {
  const home = matrix.filter(
    (entry) =>
      entry.kind === "page" &&
      entry.path === "/" &&
      entry.visualTemplate === "home",
  );
  if (home.length !== 1) {
    throw new Error(
      "Foundation visual debe contener exactamente la home smoke",
    );
  }
  return [...home].sort((left, right) =>
    compareText(routeKey(left), routeKey(right)),
  );
}

function parseFixture(value: unknown): CaptureFixture {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.status !== "number" ||
    !isRecord(value.headers) ||
    typeof value.bodyBase64 !== "string"
  ) {
    throw new Error("Fixture visual inválido");
  }
  const headers = Object.entries(value.headers).map(([name, header]) => {
    if (typeof header !== "string")
      throw new Error("Header de fixture visual inválido");
    return [name, header] as const;
  });
  return {
    url: value.url,
    status: value.status,
    headers: Object.fromEntries(headers),
    body: Buffer.from(value.bodyBase64, "base64"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readVisualFixtures(root: string): Promise<CaptureFixture[]> {
  const path = join(root, ...visualFixtureFile);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(contents);
  if (!Array.isArray(value))
    throw new Error("parity/visual-fixtures.json debe ser una lista");
  return value.map(parseFixture);
}

async function runCommand(
  command: string,
  arguments_: string[],
  root: string,
): Promise<void> {
  const child = spawn(command, arguments_, {
    cwd: root,
    shell: false,
    stdio: "inherit",
  });
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolveCode(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} falló con código ${code}`,
    );
  }
}

async function buildCandidate(root: string): Promise<void> {
  await runCommand(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    root,
  );
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function writeWorkerResponse(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  for (const [name, value] of response.headers) outgoing.setHeader(name, value);
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  if (response.body === null) {
    outgoing.end();
    return;
  }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function writeBridgeFailure(error: unknown, outgoing: ServerResponse): void {
  const message = error instanceof Error ? error.message : String(error);
  outgoing.statusCode = 500;
  outgoing.setHeader("content-type", "text/plain; charset=utf-8");
  outgoing.end(`Visual bridge failure: ${message}`);
}

async function startLoopbackBridge(
  fetchWorker: (request: Request) => Promise<Response>,
): Promise<VisualRuntime> {
  let origin = "";
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const target = new URL(incoming.url ?? "/", origin);
        if (target.origin !== origin)
          throw new Error("Solicitud bridge fuera de loopback");
        const request = new Request(target, {
          method: incoming.method ?? "GET",
          headers: requestHeaders(incoming),
        });
        await writeWorkerResponse(await fetchWorker(request), outgoing);
      } catch (error) {
        writeBridgeFailure(error, outgoing);
      }
    })();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.port <= 0) {
    await closeServer(server);
    throw new Error(
      "No se pudo asignar un puerto loopback para captura visual",
    );
  }
  origin = `http://127.0.0.1:${address.port}`;
  let disposed = false;
  return {
    origin,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await closeServer(server);
    },
  };
}

async function startCandidateRuntime(
  topology: DeploymentTopology,
): Promise<VisualRuntime> {
  const { unstable_startWorker } = await import("wrangler");
  const worker = (await unstable_startWorker({
    config: topology.wranglerConfigPath,
    entrypoint: topology.entryPath,
    dev: {
      server: { hostname: "127.0.0.1", port: 0, secure: false },
      logLevel: "error",
      persist: false,
      remote: false,
      watch: false,
    },
  } as Parameters<
    typeof unstable_startWorker
  >[0])) as unknown as StartedWranglerWorker;
  try {
    await worker.ready;
    const bridge = await startLoopbackBridge(async (request) =>
      worker.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      }),
    );
    return {
      origin: bridge.origin,
      async dispose() {
        try {
          await bridge.dispose();
        } finally {
          await worker.dispose();
        }
      },
    };
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}

function assetContentType(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function assetPath(
  root: string,
  assetRoot: string,
  pathname: string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.split("/").includes("..")
  ) {
    return null;
  }
  const resolvedRoot = resolve(root, assetRoot);
  const candidate = resolve(resolvedRoot, `.${decoded}`);
  return isWithin(resolvedRoot, candidate) ? candidate : null;
}

async function existingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface SourceAssetFetcher {
  fetch(request: Request): Promise<Response | null>;
}

export function sourceAssetFetcher(root: string): SourceAssetFetcher {
  const assetRoots = ["dist/client", "dist/public", "public"];
  return {
    async fetch(request) {
      const url = new URL(request.url);
      for (const assetRoot of assetRoots) {
        const path = assetPath(root, assetRoot, url.pathname);
        if (path === null || !(await existingFile(path))) continue;
        const body = await readFile(path);
        return new Response(request.method === "HEAD" ? null : body, {
          status: 200,
          headers: { "content-type": assetContentType(path) },
        });
      }
      return null;
    },
  };
}

export async function dispatchSourceRuntimeRequest(
  request: Request,
  assets: SourceAssetFetcher,
  fetchWorker: (request: Request) => Promise<Response>,
): Promise<Response> {
  const asset = await assets.fetch(request);
  return asset ?? fetchWorker(request);
}

async function startSourceRuntime(
  build: TemporarySourceBuild,
): Promise<VisualRuntime> {
  const entryPath = resolveInside(
    build.root,
    join(build.root, ...sourceWorkerEntry),
    "El Worker fuente construido",
  );
  await access(entryPath);
  const entryUrl = pathToFileURL(entryPath);
  entryUrl.searchParams.set("visual-parity", randomUUID());
  const module = (await import(entryUrl.href)) as { default?: WorkerHandler };
  if (
    module.default === undefined ||
    typeof module.default.fetch !== "function"
  ) {
    throw new Error("El Worker fuente construido no exporta default.fetch");
  }
  const assets = sourceAssetFetcher(build.root);
  const environment = {
    ASSETS: assets,
    DB: new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error(
              "La home visual no puede usar una base de datos sin fixture",
            );
          };
        },
      },
    ),
    IMAGES: {
      input() {
        throw new Error(
          "La home visual no puede usar optimización de imágenes sin fixture",
        );
      },
    },
  } satisfies Record<string, unknown>;
  const context = {
    waitUntil() {},
    passThroughOnException() {},
  };
  return startLoopbackBridge(async (request) =>
    dispatchSourceRuntimeRequest(
      request,
      assets,
      (workerRequest) =>
        module.default?.fetch(workerRequest, environment, context) ??
        Promise.reject(new Error("El Worker fuente no está disponible")),
    ),
  );
}

async function launchChromium(): Promise<
  CaptureBrowserLike & { close(): Promise<void> }
> {
  return (await chromium.launch({
    headless: true,
  })) as unknown as CaptureBrowserLike & {
    close(): Promise<void>;
  };
}

async function captureVisual(
  input: VisualCaptureInput,
): Promise<CapturedVisual> {
  const template = input.route.visualTemplate;
  if (template === null || template === undefined) {
    throw new Error(`La ruta ${input.route.path} no tiene template visual`);
  }
  const selectors = templateSelectors[template];
  if (selectors === undefined) {
    throw new Error(`No hay selectores visuales para template ${template}`);
  }
  return captureDeterministicPage({
    browser: input.browser,
    side: input.side,
    url: new URL(input.route.path, input.runtime.origin).href,
    viewport: input.viewport,
    selectors,
    localOrigins: input.localOrigins,
    fixtures: input.fixtures,
  });
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializableResult(result: VisualComparison): VisualResult & {
  dimensionMismatch: VisualComparison["dimensionMismatch"];
} {
  return {
    routeKey: result.routeKey,
    viewport: result.viewport,
    differentPixels: result.differentPixels,
    diffRatio: result.diffRatio,
    geometryDiffs: result.geometryDiffs,
    files: result.files,
    status: result.status,
    dimensionMismatch: result.dimensionMismatch,
  };
}

function reportHtml(
  scope: "foundation",
  results: VisualComparison[],
  summary: VisualParitySummary,
): string {
  const rows = results
    .map((result) => {
      const diff = result.files.diff ?? "—";
      const geometry = JSON.stringify(result.geometryDiffs);
      return `<tr><td>${escapeHtml(result.routeKey)}</td><td>${escapeHtml(result.viewport.name)}</td><td>${escapeHtml(result.status)}</td><td>${escapeHtml(result.differentPixels)}</td><td>${escapeHtml(result.diffRatio)}</td><td>${escapeHtml(result.files.reference)}</td><td>${escapeHtml(result.files.candidate)}</td><td>${escapeHtml(diff)}</td><td><code>${escapeHtml(geometry)}</code></td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual parity ${escapeHtml(scope)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#1f2937}table{border-collapse:collapse;width:100%;font-size:.875rem}th,td{border:1px solid #d1d5db;padding:.5rem;text-align:left;vertical-align:top}th{background:#f3f4f6}code{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>Visual parity: ${escapeHtml(scope)}</h1>
<p>routes=${escapeHtml(summary.routes)} results=${escapeHtml(summary.results)} pending=${escapeHtml(summary.pending)} review-required=${escapeHtml(summary.reviewRequired)} matched=${escapeHtml(summary.matched)}</p>
<table><thead><tr><th>route</th><th>viewport</th><th>status</th><th>different pixels</th><th>ratio</th><th>reference</th><th>candidate</th><th>diff</th><th>geometry diffs</th></tr></thead><tbody>${rows}</tbody></table>
</html>
`;
}

function artifactPath(root: string, portablePath: string): string {
  const artifactRoot = resolve(root, ".artifacts", "visual");
  const path = resolve(root, portablePath);
  if (!isWithin(artifactRoot, path)) {
    throw new Error(
      `El reporte visual intentó salir de .artifacts/visual: ${portablePath}`,
    );
  }
  return path;
}

async function writeVisualReports(
  input: VisualReportInput,
): Promise<VisualArtifactPaths> {
  const artifactRoot = resolve(input.root, ".artifacts", "visual");
  await mkdir(artifactRoot, { recursive: true });
  for (const evidence of input.evidence) {
    const referencePath = artifactPath(
      input.root,
      evidence.result.files.reference,
    );
    const candidatePath = artifactPath(
      input.root,
      evidence.result.files.candidate,
    );
    await mkdir(resolve(referencePath, ".."), { recursive: true });
    await writeFile(referencePath, evidence.reference.screenshot);
    await writeFile(candidatePath, evidence.candidate.screenshot);
    if (
      evidence.result.diffPng !== null &&
      evidence.result.files.diff !== null
    ) {
      await writeFile(
        artifactPath(input.root, evidence.result.files.diff),
        evidence.result.diffPng,
      );
    }
  }
  const summary = summaryFor(input.results);
  const jsonPath = resolve(artifactRoot, input.scope, "summary.json");
  const htmlPath = resolve(artifactRoot, input.scope, "summary.html");
  await mkdir(resolve(jsonPath, ".."), { recursive: true });
  const report = {
    schemaVersion: 1,
    scope: input.scope,
    summary,
    results: input.results.map(serializableResult),
  };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(htmlPath, reportHtml(input.scope, input.results, summary));
  return {
    root: toPortableRelative(input.root, artifactRoot),
    json: toPortableRelative(input.root, jsonPath),
    html: toPortableRelative(input.root, htmlPath),
  };
}

export async function runVisualParity(
  options: RunVisualParityOptions,
  dependencies: VisualParityDependencies = {},
): Promise<VisualParityResult> {
  if (options.scope !== "foundation") {
    throw new Error(`Scope visual no soportado: ${options.scope}`);
  }
  const root = resolve(options.root ?? process.cwd());
  const assertSource =
    dependencies.assertSourcePristine ?? assertSourcePristine;
  const build = dependencies.buildCandidate ?? buildCandidate;
  const resolveTopology =
    dependencies.resolveCandidateTopology ?? resolveDeploymentTopology;
  const readMatrix = dependencies.readMatrix ?? readExistingRouteMatrix;
  const readFixtures = dependencies.readFixtures ?? readVisualFixtures;
  const startCandidate = dependencies.startCandidate ?? startCandidateRuntime;
  const sourceBuild =
    dependencies.withTemporarySourceBuild ?? withTemporarySourceBuild;
  const startReference = dependencies.startReference ?? startSourceRuntime;
  const launchBrowser = dependencies.launchBrowser ?? launchChromium;
  const capture = dependencies.capture ?? captureVisual;
  const writeReports = dependencies.writeReports ?? writeVisualReports;

  await assertSource();
  try {
    const [matrix, fixtures] = await Promise.all([
      readMatrix(root),
      readFixtures(root),
    ]);
    const routes = selectFoundationVisualRoutes(matrix);
    await build(root);
    const topology = await resolveTopology(root);
    const candidate = await startCandidate(topology, root);
    try {
      return await sourceBuild(async (source) => {
        const reference = await startReference(source);
        try {
          const browser = await launchBrowser();
          try {
            const localOrigins = [reference.origin, candidate.origin];
            const evidence: VisualEvidence[] = [];
            for (const route of routes) {
              for (const viewport of VISUAL_VIEWPORTS) {
                const referenceCapture = await capture({
                  browser,
                  side: "reference",
                  runtime: reference,
                  route,
                  viewport,
                  localOrigins,
                  fixtures,
                });
                const candidateCapture = await capture({
                  browser,
                  side: "candidate",
                  runtime: candidate,
                  route,
                  viewport,
                  localOrigins,
                  fixtures,
                });
                const comparison = resultForPendingRoute(
                  route,
                  await compareVisuals(
                    referenceCapture.screenshot,
                    candidateCapture.screenshot,
                    {
                      routeKey: routeKey(route),
                      viewport,
                      referenceGeometry: referenceCapture.geometry,
                      candidateGeometry: candidateCapture.geometry,
                      files: artifactFiles(
                        root,
                        options.scope,
                        route,
                        viewport,
                      ),
                    },
                  ),
                );
                evidence.push({
                  result: comparison,
                  reference: referenceCapture,
                  candidate: candidateCapture,
                });
              }
            }
            const results = evidence.map((entry) => entry.result);
            const summary = summaryFor(results);
            const artifacts = await writeReports({
              root,
              scope: options.scope,
              results,
              evidence,
            });
            if (summary.pending > 0 && !options.allowPending) {
              throw new Error(
                "Visual parity contiene resultados pendiente; repita con --allow-pending para registrar evidencia sin afirmar paridad",
              );
            }
            return { scope: options.scope, results, summary, artifacts };
          } finally {
            await browser.close();
          }
        } finally {
          await reference.dispose();
        }
      });
    } finally {
      await candidate.dispose();
    }
  } finally {
    await assertSource();
  }
}

export function formatVisualParitySummary(result: VisualParityResult): string {
  const common = [
    `scope=${result.scope}`,
    `routes=${result.summary.routes}`,
    `results=${result.summary.results}`,
    `pending=${result.summary.pending}`,
    `review_required=${result.summary.reviewRequired}`,
    `artifacts=${result.artifacts.root}`,
  ].join(" ");
  if (result.summary.pending > 0) return `VISUAL_PARITY_PENDING ${common}`;
  if (result.summary.reviewRequired > 0)
    return `VISUAL_PARITY_REVIEW_REQUIRED ${common}`;
  return `VISUAL_PARITY_MATCHED ${common}`;
}

function parseArguments(args: string[]): RunVisualParityOptions {
  if (
    args.length === 3 &&
    args[0] === "--scope" &&
    args[1] === "foundation" &&
    args[2] === "--allow-pending"
  ) {
    return { scope: "foundation", allowPending: true };
  }
  if (args.length === 2 && args[0] === "--scope" && args[1] === "foundation") {
    return { scope: "foundation", allowPending: false };
  }
  throw new Error("Uso: parity-visual.ts --scope foundation [--allow-pending]");
}

async function main(args: string[]): Promise<void> {
  const result = await runVisualParity(parseArguments(args));
  process.stdout.write(`${formatVisualParitySummary(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
