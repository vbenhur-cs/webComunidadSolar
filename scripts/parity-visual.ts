import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
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
  type PrivateArea,
  type RouteMatrixEntry,
} from "./lib/route-inventory.ts";
import { assertSourcePristine } from "./lib/source-reference.ts";
import {
  withTemporarySourceBuild,
  type TemporarySourceBuild,
  type TemporarySourceOptions,
} from "./lib/temporary-source-build.ts";
import { isPhase2PublicRoute } from "../src/lib/site/public-route-closure.ts";

export type VisualParityScope = "foundation" | "public";

/**
 * Deliberately separate from CaptureFixture: these fixtures vary only the
 * authenticated request headers of a private visual capture. Network fixtures
 * remain the external-resource policy used for every capture.
 */
export type VisualAuthFixtureName = "anonymous" | "allowed";

export interface VisualAuthFixture {
  name: VisualAuthFixtureName;
  headers: Record<string, string>;
}

export interface VisualAuthPlan {
  privateArea: PrivateArea;
  environment: Record<string, string>;
  fixtures: VisualAuthFixture[];
}

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
  scope: VisualParityScope;
  results: VisualComparison[];
  summary: VisualParitySummary;
  artifacts: VisualArtifactPaths;
}

export interface RunVisualParityOptions {
  scope: VisualParityScope;
  allowPending: boolean;
  /** An exact, fail-closed subset of matrix paths to capture. */
  routes?: string[];
  /** Exact private auth fixtures, valid only with an explicit private route. */
  authFixtures?: VisualAuthFixtureName[];
  root?: string;
  lifecycleTimeoutMs?: number;
  sourceBuildTimeoutMs?: number;
}

export interface VisualCaptureInput {
  browser: CaptureBrowserLike;
  side: "reference" | "candidate";
  runtime: VisualRuntime;
  route: RouteMatrixEntry;
  viewport: ViewportContract;
  localOrigins: string[];
  /** Separate from external CaptureFixture network fixtures. */
  authFixture?: VisualAuthFixture;
  fixtures: CaptureFixture[];
}

export interface VisualReportInput {
  root: string;
  scope: VisualParityScope;
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
    environment: Record<string, string>,
  ): Promise<VisualRuntime>;
  withTemporarySourceBuild?<T>(
    callback: (build: TemporarySourceBuild) => Promise<T>,
    options?: TemporarySourceOptions,
  ): Promise<T>;
  startReference?(
    build: TemporarySourceBuild,
    environment: Record<string, string>,
  ): Promise<VisualRuntime>;
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

interface WranglerDevEnvironment {
  teardown(): Promise<void>;
}

interface StartedWranglerWorker {
  ready: Promise<unknown>;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
  raw: WranglerDevEnvironment;
}

export interface CandidateRuntimeDependencies {
  startWorker?(
    topology: DeploymentTopology,
    environment: Record<string, string>,
  ): Promise<StartedWranglerWorker>;
  startBridge?(
    fetchWorker: (request: Request) => Promise<Response>,
    timeoutMs: number,
  ): Promise<VisualRuntime>;
}

const sourceWorkerEntry = ["dist", "server", "index.js"] as const;
const visualFixtureFile = ["parity", "visual-fixtures.json"] as const;
const defaultVisualLifecycleTimeoutMs = 30_000;
const defaultCandidateBuildTimeoutMs = 120_000;
const defaultProcessTerminationGraceMs = 5_000;
const defaultSourceBuildTimeoutMs = 300_000;
const visualAuthEmail = "visual-parity-auth@example.test";
const visualAuthEmailHeader = "oai-authenticated-user-email";
const visualAuthFixtureNames = ["anonymous", "allowed"] as const;
const visualAuthEnvironmentKey: Record<
  PrivateArea,
  keyof Record<string, string>
> = {
  socios: "SOCIOS_ALLOWED_EMAILS",
  equipo: "TEAM_ALLOWED_EMAILS",
  manganafer: "MANGANAFER_ALLOWED_EMAILS",
};
const visualSourceEnvironmentKeys = new Set(
  Object.values(visualAuthEnvironmentKey),
);
let visualSourceEnvironmentTail: Promise<void> = Promise.resolve();

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function visualLifecycleTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? defaultVisualLifecycleTimeoutMs;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(
      "El timeout de ciclo de vida visual debe ser un entero positivo",
    );
  }
  return resolved;
}

function cleanupTimeoutBudget(timeoutMs: number, phaseCount: number): number {
  return Math.max(timeoutMs, phaseCount);
}

function cleanupPhaseTimeout(timeoutMs: number, phaseCount: number): number {
  const budget = cleanupTimeoutBudget(timeoutMs, phaseCount);
  return Math.max(1, Math.floor((budget - 1) / phaseCount));
}

function acquisitionTimeoutBudget(
  timeoutMs: number,
  phaseCount: number,
): number {
  if (!Number.isInteger(phaseCount) || phaseCount <= 0) {
    throw new Error(
      "Las fases de adquisición visual deben ser enteros positivos",
    );
  }
  const budget = timeoutMs * phaseCount + 1;
  if (!Number.isSafeInteger(budget)) {
    throw new Error(
      "El presupuesto de adquisición visual excede un entero seguro",
    );
  }
  return budget;
}

async function withinVisualTimeout<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs: number,
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
                `El ciclo de vida visual superó ${timeoutMs} ms durante ${stage}`,
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

function sourceBuildDeadlineFailure(timeoutMs: number): Error {
  return new Error(
    `El ciclo de vida visual superó ${timeoutMs} ms durante preparar el build fuente temporal`,
  );
}

async function withSourceBuildDeadline<T>(
  sourceBuild: NonNullable<
    VisualParityDependencies["withTemporarySourceBuild"]
  >,
  callback: (build: TemporarySourceBuild) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let deadlineExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operation: Promise<T> | undefined;
  const helperOwnsProcessDeadline = sourceBuild === withTemporarySourceBuild;
  // An injected runner has no declared cancellation surface. Its deadline can
  // only guarantee that no late callback starts a candidate; the real helper
  // owns its npm process group and waits for archive cleanup before rejecting.
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  timer = setTimeout(() => {
    deadlineExpired = true;
    if (!helperOwnsProcessDeadline) {
      rejectDeadline?.(sourceBuildDeadlineFailure(timeoutMs));
    }
  }, timeoutMs);
  try {
    operation = sourceBuild(
      async (build) => {
        if (deadlineExpired) throw sourceBuildDeadlineFailure(timeoutMs);
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        return callback(build);
      },
      {
        deadlineMs: timeoutMs,
        processTimeoutMs: timeoutMs,
        processKillAfterMs: defaultProcessTerminationGraceMs,
      },
    );
    return await (helperOwnsProcessDeadline
      ? operation
      : Promise.race([operation, deadline]));
  } catch (error) {
    if (deadlineExpired && helperOwnsProcessDeadline) {
      const deadlineFailure = sourceBuildDeadlineFailure(timeoutMs);
      preserveVisualFailure(deadlineFailure, error);
      throw deadlineFailure;
    }
    if (deadlineExpired && operation !== undefined) {
      void operation.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function preserveVisualFailure(
  primaryFailure: unknown,
  cleanupFailure: unknown,
): void {
  if (!(primaryFailure instanceof Error)) return;
  try {
    const existingCause = (primaryFailure as Error & { cause?: unknown }).cause;
    Object.defineProperty(primaryFailure, "cause", {
      configurable: true,
      value:
        existingCause === undefined
          ? cleanupFailure
          : new AggregateError(
              [existingCause, cleanupFailure],
              "También falló la limpieza visual",
            ),
    });
  } catch {
    // Keep the primary error actionable even if it cannot carry a cause.
  }
}

async function acquireVisualResource<T>(
  acquisitionStage: string,
  operation: Promise<T>,
  cleanupStage: string,
  cleanup: (resource: T) => Promise<void>,
  timeoutMs: number,
  cleanupTimeoutMs = timeoutMs,
): Promise<T> {
  try {
    return await withinVisualTimeout(acquisitionStage, operation, timeoutMs);
  } catch (error) {
    void operation.then(
      async (lateResource) => {
        try {
          await withinVisualTimeout(
            cleanupStage,
            cleanup(lateResource),
            cleanupTimeoutMs,
          );
        } catch {
          // The acquisition deadline is the actionable failure for this run.
        }
      },
      () => undefined,
    );
    throw error;
  }
}

async function withVisualResource<T, TResult>(
  acquisitionStage: string,
  acquire: () => Promise<T>,
  cleanupStage: string,
  cleanup: (resource: T) => Promise<void>,
  timeoutMs: number,
  use: (resource: T) => Promise<TResult>,
  cleanupTimeoutMs = timeoutMs,
): Promise<TResult> {
  const resource = await acquireVisualResource(
    acquisitionStage,
    acquire(),
    cleanupStage,
    cleanup,
    timeoutMs,
    cleanupTimeoutMs,
  );
  let result!: TResult;
  let primaryFailure: unknown;
  let failed = false;
  try {
    result = await use(resource);
  } catch (error) {
    failed = true;
    primaryFailure = error;
  }
  let cleanupFailure: unknown;
  try {
    await withinVisualTimeout(
      cleanupStage,
      cleanup(resource),
      cleanupTimeoutMs,
    );
  } catch (error) {
    cleanupFailure = error;
  }
  if (failed) {
    if (cleanupFailure !== undefined) {
      preserveVisualFailure(primaryFailure, cleanupFailure);
    }
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result;
}

function routeKey(
  route: Pick<RouteMatrixEntry, "kind" | "path">,
  authFixture?: Pick<VisualAuthFixture, "name">,
): string {
  return `${route.kind}:${route.path}${
    authFixture === undefined ? "" : `|fixture=${authFixture.name}`
  }`;
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
  scope: VisualParityScope,
  route: RouteMatrixEntry,
  viewport: ViewportContract,
  authFixture?: Pick<VisualAuthFixture, "name">,
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
      ...(authFixture === undefined
        ? []
        : [safeArtifactSegment(authFixture.name, "Fixture de autenticación")]),
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

/** Selects all currently-owned public page templates, excluding Phase 3. */
export function selectPublicVisualRoutes(
  matrix: RouteMatrixEntry[],
): RouteMatrixEntry[] {
  const routes = matrix.filter(
    (entry) =>
      entry.kind === "page" &&
      typeof entry.visualTemplate === "string" &&
      entry.visualTemplate.length > 0 &&
      isPhase2PublicRoute(entry),
  );
  if (routes.length === 0) {
    throw new Error("Public visual no contiene páginas capturables");
  }
  return [...routes].sort((left, right) =>
    compareText(routeKey(left), routeKey(right)),
  );
}

function assertVisualRoutePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").includes("..") ||
    path.trim() !== path
  ) {
    throw new Error(`Ruta visual inválida: ${path}`);
  }
}

/**
 * Selects only explicitly requested page routes. This is intentionally
 * fail-closed: a typo, duplicate, non-page, or a row without a visual
 * template must never broaden a visual capture to a different route set.
 */
export interface SelectVisualRoutesOptions {
  allowPrivate?: boolean;
}

export function selectVisualRoutes(
  matrix: RouteMatrixEntry[],
  requestedPaths: readonly string[],
  options: SelectVisualRoutesOptions = {},
): RouteMatrixEntry[] {
  if (requestedPaths.length === 0) {
    throw new Error("--routes visual debe declarar al menos una ruta");
  }
  const seen = new Set<string>();
  const selected = requestedPaths.map((path) => {
    assertVisualRoutePath(path);
    if (seen.has(path)) {
      throw new Error(`Ruta visual duplicada: ${path}`);
    }
    seen.add(path);
    const matches = matrix.filter((entry) => entry.path === path);
    if (matches.length !== 1) {
      throw new Error(`Ruta visual no declarada exactamente una vez: ${path}`);
    }
    const [route] = matches;
    if (
      route.kind !== "page" &&
      !(options.allowPrivate === true && route.kind === "private-page")
    ) {
      throw new Error(`Ruta visual no es una página: ${path}`);
    }
    if (route.kind === "private-page" && route.privateArea === null) {
      throw new Error(`Ruta visual privada no declara área: ${path}`);
    }
    if (typeof route.visualTemplate !== "string" || !route.visualTemplate) {
      throw new Error(`La ruta visual no declara template: ${path}`);
    }
    return route;
  });
  return selected.sort((left, right) =>
    compareText(routeKey(left), routeKey(right)),
  );
}

function parseVisualAuthFixtures(value: string): VisualAuthFixtureName[] {
  const fixtures = value.split(",");
  if (fixtures.some((fixture) => fixture.length === 0)) {
    throw new Error("--fixtures visual no admite fixtures vacíos");
  }
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture)) {
      throw new Error(`Fixture visual duplicado: ${fixture}`);
    }
    seen.add(fixture);
    if (!visualAuthFixtureNames.includes(fixture as VisualAuthFixtureName)) {
      throw new Error(`Fixture visual desconocido: ${fixture}`);
    }
  }
  if (
    fixtures.length !== visualAuthFixtureNames.length ||
    !visualAuthFixtureNames.every((fixture) => seen.has(fixture))
  ) {
    throw new Error(
      "--fixtures visual privado debe declarar anonymous,allowed exactamente una vez",
    );
  }
  return [...visualAuthFixtureNames];
}

/**
 * Resolves the synthetic authentication setup without mixing it with network
 * fixtures. A private visual run has one explicit area and captures both
 * anonymous and allowed states against the same two runtimes.
 */
export function resolveVisualAuthPlan(
  routes: readonly RouteMatrixEntry[],
  requestedFixtures: readonly VisualAuthFixtureName[] | undefined,
): VisualAuthPlan | undefined {
  const privateRoutes = routes.filter((route) => route.kind === "private-page");
  if (requestedFixtures === undefined) {
    if (privateRoutes.length > 0) {
      throw new Error(
        "Una ruta visual privada requiere --fixtures anonymous,allowed",
      );
    }
    return undefined;
  }
  if (routes.length === 0 || privateRoutes.length !== routes.length) {
    throw new Error("--fixtures visual solo admite rutas privadas");
  }
  const areas = new Set(privateRoutes.map((route) => route.privateArea));
  if (areas.size !== 1 || areas.has(null)) {
    throw new Error(
      "--fixtures visual requiere una sola área privada explícita",
    );
  }
  const [privateArea] = [...areas];
  if (privateArea === null) {
    throw new Error(
      "--fixtures visual requiere una sola área privada explícita",
    );
  }
  const normalizedFixtures = parseVisualAuthFixtures(
    [...requestedFixtures].join(","),
  );
  return {
    privateArea,
    environment: {
      [visualAuthEnvironmentKey[privateArea]]: visualAuthEmail,
    },
    fixtures: normalizedFixtures.map((name): VisualAuthFixture => ({
      name,
      headers:
        name === "allowed" ? { [visualAuthEmailHeader]: visualAuthEmail } : {},
    })),
  };
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
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.bodyBase64)) {
    throw new Error("Body base64 de fixture visual inválido");
  }
  const body = Buffer.from(value.bodyBase64, "base64");
  if (body.toString("base64") !== value.bodyBase64) {
    throw new Error("Body base64 de fixture visual no es canónico");
  }
  return {
    url: value.url,
    status: value.status,
    headers: Object.fromEntries(headers),
    body,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readVisualFixtures(
  root: string,
): Promise<CaptureFixture[]> {
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

export interface VisualCommandOptions {
  timeoutMs?: number;
  terminationGraceMs?: number;
  /** Test seam: visual build cleanup is intentionally POSIX-only. */
  platform?: NodeJS.Platform;
}

interface VisualCommandCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function signalVisualProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // A single child kill cannot promise tree cleanup; the POSIX group may
    // already have gone away while its close event is pending.
  }
}

async function terminateVisualProcessGroup(
  child: ReturnType<typeof spawn>,
  completion: Promise<VisualCommandCompletion>,
  graceMs: number,
): Promise<void> {
  const settled = completion.then(
    () => undefined,
    () => undefined,
  );
  signalVisualProcessGroup(child, "SIGTERM");
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolveGrace) => {
        graceTimer = setTimeout(resolveGrace, graceMs);
      }),
    ]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
  // A leader can close before descendants that inherited its process group.
  // Signal the whole group again so that a TERM-resistant descendant cannot
  // survive merely because the leader's close event resolved first.
  signalVisualProcessGroup(child, "SIGKILL");
  try {
    await withinVisualTimeout(
      "esperar la terminación SIGKILL del build candidato",
      settled,
      graceMs,
    );
  } catch {
    // The original build deadline remains actionable after bounded kill attempts.
  }
}

export async function runVisualCommand(
  command: string,
  arguments_: string[],
  root: string,
  options: VisualCommandOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error(
      "Visual parity no se ejecuta en Windows: no hay terminación de árbol de procesos POSIX verificada",
    );
  }
  const timeoutMs = visualLifecycleTimeout(
    options.timeoutMs ?? defaultCandidateBuildTimeoutMs,
  );
  const terminationGraceMs = visualLifecycleTimeout(
    options.terminationGraceMs ?? defaultProcessTerminationGraceMs,
  );
  const child = spawn(command, arguments_, {
    cwd: root,
    detached: true,
    shell: false,
    stdio: "inherit",
  });
  const completion = new Promise<VisualCommandCompletion>(
    (resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveCode({ code, signal }));
    },
  );
  try {
    const result = await withinVisualTimeout(
      "construir el candidato visual",
      completion,
      timeoutMs,
    );
    if (result.code !== 0) {
      throw new Error(
        `${command} ${arguments_.join(" ")} falló con código ${result.code ?? "desconocido"}${result.signal === null ? "" : ` (${result.signal})`}`,
      );
    }
  } catch (error) {
    await terminateVisualProcessGroup(child, completion, terminationGraceMs);
    throw error;
  }
}

async function buildCandidate(root: string): Promise<void> {
  await runVisualCommand(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    root,
  );
}

async function closeServer(
  server: ReturnType<typeof createServer>,
  timeoutMs = defaultVisualLifecycleTimeoutMs,
): Promise<void> {
  try {
    await withinVisualTimeout(
      "cerrar el bridge loopback",
      new Promise<void>((resolveClose, reject) => {
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
      }),
      visualLifecycleTimeout(timeoutMs),
    );
  } catch (error) {
    server.closeAllConnections?.();
    throw error;
  }
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
  timeoutMs = defaultVisualLifecycleTimeoutMs,
): Promise<VisualRuntime> {
  const boundedTimeoutMs = visualLifecycleTimeout(timeoutMs);
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
  const listening = new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  try {
    await withinVisualTimeout(
      "escuchar el bridge loopback",
      listening,
      boundedTimeoutMs,
    );
  } catch (error) {
    void listening.then(
      async () => {
        try {
          await closeServer(server, boundedTimeoutMs);
        } catch {
          // The bridge readiness deadline is the actionable failure.
        }
      },
      () => undefined,
    );
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string" || address.port <= 0) {
    await closeServer(server, boundedTimeoutMs);
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
      await closeServer(server, boundedTimeoutMs);
    },
  };
}

async function defaultStartCandidateWorker(
  topology: DeploymentTopology,
  environment: Record<string, string> = {},
): Promise<StartedWranglerWorker> {
  const { unstable_startWorker } = await import("wrangler");
  const bindings = Object.fromEntries(
    Object.entries(environment)
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, value]) => [name, { type: "secret_text", value } as const]),
  );
  return (await unstable_startWorker({
    config: topology.wranglerConfigPath,
    entrypoint: topology.entryPath,
    ...(Object.keys(bindings).length === 0 ? {} : { bindings }),
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
}

async function disposeCandidateWorker(
  worker: StartedWranglerWorker,
  timeoutMs: number,
): Promise<void> {
  const phaseTimeoutMs = cleanupPhaseTimeout(timeoutMs, 2);
  let disposeFailure: unknown;
  try {
    await withinVisualTimeout(
      "cerrar el Worker candidato",
      worker.dispose(),
      phaseTimeoutMs,
    );
  } catch (error) {
    disposeFailure = error;
  }
  if (disposeFailure === undefined) return;

  try {
    await withinVisualTimeout(
      "forzar teardown del Worker candidato",
      worker.raw.teardown(),
      phaseTimeoutMs,
    );
  } catch (teardownFailure) {
    preserveVisualFailure(disposeFailure, teardownFailure);
  }
  throw disposeFailure;
}

async function disposeCandidateRuntimeParts(
  worker: StartedWranglerWorker,
  bridge: VisualRuntime | undefined,
  timeoutMs: number,
): Promise<void> {
  const phaseTimeoutMs = cleanupPhaseTimeout(timeoutMs, 3);
  let cleanupFailure: unknown;
  if (bridge !== undefined) {
    try {
      await withinVisualTimeout(
        "cerrar el bridge loopback candidato",
        bridge.dispose(),
        phaseTimeoutMs,
      );
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    await disposeCandidateWorker(worker, phaseTimeoutMs * 2);
  } catch (error) {
    if (cleanupFailure === undefined) cleanupFailure = error;
    else preserveVisualFailure(cleanupFailure, error);
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

export async function startCandidateRuntime(
  topology: DeploymentTopology,
  timeoutMs = defaultVisualLifecycleTimeoutMs,
  dependencies: CandidateRuntimeDependencies = {},
  environment: Record<string, string> = {},
): Promise<VisualRuntime> {
  const boundedTimeoutMs = visualLifecycleTimeout(timeoutMs);
  const workerCleanupTimeoutMs = cleanupTimeoutBudget(boundedTimeoutMs, 2);
  const runtimeCleanupTimeoutMs = cleanupTimeoutBudget(boundedTimeoutMs, 3);
  const startWorker = dependencies.startWorker ?? defaultStartCandidateWorker;
  const startBridge = dependencies.startBridge ?? startLoopbackBridge;
  const worker = await acquireVisualResource(
    "iniciar el Worker candidato",
    startWorker(topology, environment),
    "cerrar el Worker candidato",
    (candidateWorker) =>
      disposeCandidateWorker(candidateWorker, workerCleanupTimeoutMs),
    boundedTimeoutMs,
    workerCleanupTimeoutMs,
  );
  let bridge: VisualRuntime | undefined;
  try {
    await withinVisualTimeout(
      "esperar el Worker candidato listo",
      worker.ready,
      boundedTimeoutMs,
    );
    bridge = await acquireVisualResource(
      "iniciar el bridge loopback candidato",
      startBridge(
        async (request) =>
          worker.fetch(request.url, {
            method: request.method,
            headers: request.headers,
            redirect: "manual",
          }),
        boundedTimeoutMs,
      ),
      "cerrar el bridge loopback candidato",
      (candidateBridge) => candidateBridge.dispose(),
      boundedTimeoutMs,
    );
    return {
      origin: bridge.origin,
      async dispose() {
        await disposeCandidateRuntimeParts(
          worker,
          bridge,
          runtimeCleanupTimeoutMs,
        );
      },
    };
  } catch (error) {
    try {
      await disposeCandidateRuntimeParts(
        worker,
        bridge,
        runtimeCleanupTimeoutMs,
      );
    } catch (cleanupFailure) {
      preserveVisualFailure(error, cleanupFailure);
    }
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

async function resolveArchiveRoot(root: string): Promise<string> {
  const expectedRoot = resolve(root);
  const rootEntry = await lstat(expectedRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error(
      `La raíz de assets del archive debe ser un directorio sin enlaces: ${root}`,
    );
  }
  const expectedCanonicalRoot = join(
    await realpath(dirname(expectedRoot)),
    basename(expectedRoot),
  );
  const resolvedRoot = await realpath(expectedRoot);
  if (resolvedRoot !== expectedCanonicalRoot) {
    throw new Error(
      `La raíz canónica de assets del archive no coincide con la esperada: ${root}`,
    );
  }
  if (!(await stat(resolvedRoot)).isDirectory()) {
    throw new Error(
      `La raíz de assets del archive no es un directorio: ${root}`,
    );
  }
  return resolvedRoot;
}

async function existingArchiveFile(
  archiveRoot: string,
  candidate: string,
): Promise<string | null> {
  let resolvedParent: string;
  try {
    resolvedParent = await realpath(dirname(candidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!isWithin(archiveRoot, resolvedParent)) {
    throw new Error(`El asset del archive sale de su raíz: ${candidate}`);
  }
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) return null;
  let resolvedFile: string;
  try {
    resolvedFile = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!isWithin(archiveRoot, resolvedFile)) {
    throw new Error(`El asset del archive sale de su raíz: ${candidate}`);
  }
  return (await stat(resolvedFile)).isFile() ? resolvedFile : null;
}

async function readArchiveFile(
  archiveRoot: string,
  resolvedFile: string,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      resolvedFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`El asset del archive es un enlace: ${resolvedFile}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(
        `El asset del archive no es un archivo regular: ${resolvedFile}`,
      );
    }
    const currentEntry = await lstat(resolvedFile);
    const currentPath = await realpath(resolvedFile);
    if (
      !currentEntry.isFile() ||
      opened.dev !== currentEntry.dev ||
      opened.ino !== currentEntry.ino ||
      !isWithin(archiveRoot, currentPath)
    ) {
      throw new Error(
        `El asset del archive cambió o sale de su raíz: ${resolvedFile}`,
      );
    }
    // The temporary archive is private and immutable while capture runs. Node
    // has no openat/dirfd API, so this validates each path and opened inode but
    // deliberately does not promise to defeat an adversarial parent rename.
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export interface SourceAssetFetcher {
  fetch(request: Request): Promise<Response | null>;
}

export function sourceAssetFetcher(root: string): SourceAssetFetcher {
  const assetRoots = ["dist/client", "dist/public", "public"];
  const archiveRoot = resolveArchiveRoot(root);
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const resolvedArchiveRoot = await archiveRoot;
      for (const assetRoot of assetRoots) {
        const path = assetPath(root, assetRoot, url.pathname);
        if (path === null) continue;
        const resolvedFile = await existingArchiveFile(
          resolvedArchiveRoot,
          path,
        );
        if (resolvedFile === null) continue;
        const body = await readArchiveFile(resolvedArchiveRoot, resolvedFile);
        const responseBody =
          request.method === "HEAD" ? null : Uint8Array.from(body).buffer;
        return new Response(responseBody, {
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
  timeoutMs = defaultVisualLifecycleTimeoutMs,
  bindings: Record<string, string> = {},
): Promise<VisualRuntime> {
  const archiveRoot = await resolveArchiveRoot(build.root);
  const entryPath = resolveInside(
    archiveRoot,
    join(archiveRoot, ...sourceWorkerEntry),
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
  const assets = sourceAssetFetcher(archiveRoot);
  const environment = {
    ...bindings,
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
  return startLoopbackBridge(
    async (request) =>
      dispatchSourceRuntimeRequest(request, assets, (workerRequest) =>
        withVisualSourceEnvironment(
          bindings,
          () =>
            module.default?.fetch(workerRequest, environment, context) ??
            Promise.reject(new Error("El Worker fuente no está disponible")),
          timeoutMs,
        ),
      ),
    timeoutMs,
  );
}

/**
 * The frozen source Worker reads private allowlists from process.env instead
 * of its Worker environment. Scope the synthetic allowlist to one source
 * fetch, then restore every touched key even when that fetch fails. A timed
 * out fetch retains its lease until it truly settles, so no later fetch can
 * interleave a different process-wide environment while it still runs.
 */
export async function withVisualSourceEnvironment<T>(
  bindings: Readonly<Record<string, string>>,
  run: () => Promise<T>,
  timeoutMs = defaultVisualLifecycleTimeoutMs,
): Promise<T> {
  const entries = Object.entries(bindings).sort(([left], [right]) =>
    compareText(left, right),
  );
  for (const [key] of entries) {
    if (!visualSourceEnvironmentKeys.has(key)) {
      throw new Error(`Binding fuente visual no permitido: ${key}`);
    }
  }
  const boundedTimeoutMs = visualLifecycleTimeout(timeoutMs);
  const previousLease = visualSourceEnvironmentTail;
  let releaseLease!: () => void;
  const lease = new Promise<void>((resolveLease) => {
    releaseLease = resolveLease;
  });
  visualSourceEnvironmentTail = previousLease.then(() => lease);

  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolveResultPromise, rejectResultPromise) => {
    resolveResult = resolveResultPromise;
    rejectResult = rejectResultPromise;
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    rejectResult(
      new Error(
        `El ciclo de vida visual superó ${boundedTimeoutMs} ms durante ejecutar el fetch fuente con entorno`,
      ),
    );
  }, boundedTimeoutMs);

  void previousLease.then(() => {
    if (timedOut) {
      releaseLease();
      return;
    }
    try {
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of entries) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      const restore = () => {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        releaseLease();
      };
      const operation = Promise.resolve().then(run);
      void operation.then(
        (value) => {
          restore();
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          if (!timedOut) resolveResult(value);
        },
        (error) => {
          restore();
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          if (!timedOut) rejectResult(error);
        },
      );
    } catch (error) {
      releaseLease();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!timedOut) rejectResult(error);
    }
  });
  return result;
}

interface ChromiumBrowserServer {
  wsEndpoint(): string;
  close(): Promise<void>;
  kill(): Promise<void>;
}

interface ChromiumController {
  launchServer(options: { headless: boolean }): Promise<ChromiumBrowserServer>;
  connect(wsEndpoint: string): Promise<CaptureBrowserLike>;
}

export interface ChromiumLaunchDependencies {
  chromium?: ChromiumController;
}

async function closeChromiumServer(
  server: ChromiumBrowserServer,
  timeoutMs: number,
): Promise<void> {
  const phaseTimeoutMs = cleanupPhaseTimeout(timeoutMs, 2);
  let closeFailure: unknown;
  try {
    await withinVisualTimeout(
      "cerrar el servidor Chromium",
      server.close(),
      phaseTimeoutMs,
    );
  } catch (error) {
    closeFailure = error;
  }
  if (closeFailure === undefined) return;

  try {
    await withinVisualTimeout(
      "forzar kill del servidor Chromium",
      server.kill(),
      phaseTimeoutMs,
    );
  } catch (killFailure) {
    preserveVisualFailure(closeFailure, killFailure);
  }
  throw closeFailure;
}

export async function launchChromium(
  timeoutMs = defaultVisualLifecycleTimeoutMs,
  dependencies: ChromiumLaunchDependencies = {},
): Promise<CaptureBrowserLike & { close(): Promise<void> }> {
  const boundedTimeoutMs = visualLifecycleTimeout(timeoutMs);
  const cleanupTimeoutMs = cleanupTimeoutBudget(boundedTimeoutMs, 2);
  const browserType =
    dependencies.chromium ?? (chromium as unknown as ChromiumController);
  const server = await acquireVisualResource(
    "iniciar el servidor Chromium",
    browserType.launchServer({ headless: true }),
    "forzar kill del servidor Chromium",
    (candidateServer) => candidateServer.kill(),
    boundedTimeoutMs,
  );
  let browser: CaptureBrowserLike;
  try {
    browser = await withinVisualTimeout(
      "conectar Chromium",
      browserType.connect(server.wsEndpoint()),
      boundedTimeoutMs,
    );
  } catch (error) {
    try {
      await withinVisualTimeout(
        "forzar kill del servidor Chromium",
        server.kill(),
        boundedTimeoutMs,
      );
    } catch (killFailure) {
      preserveVisualFailure(error, killFailure);
    }
    throw error;
  }
  let disposed = false;
  return {
    newContext(options) {
      return browser.newContext(options);
    },
    async close() {
      if (disposed) return;
      disposed = true;
      await closeChromiumServer(server, cleanupTimeoutMs);
    },
  };
}

export function selectVisualCaptureSelectors(
  route: RouteMatrixEntry,
  authFixture: VisualAuthFixture | undefined,
): readonly string[] {
  const template = route.visualTemplate;
  if (template === null || template === undefined) {
    throw new Error(`La ruta ${route.path} no tiene template visual`);
  }
  const selectedTemplate =
    template === "team-guide" && authFixture?.name === "anonymous"
      ? "private-access"
      : template;
  const selectors = templateSelectors[selectedTemplate];
  if (selectors === undefined) {
    throw new Error(
      `No hay selectores visuales para template ${selectedTemplate}`,
    );
  }
  return selectors;
}

async function captureVisual(
  input: VisualCaptureInput,
): Promise<CapturedVisual> {
  const selectors = selectVisualCaptureSelectors(
    input.route,
    input.authFixture,
  );
  return captureDeterministicPage({
    browser: input.browser,
    side: input.side,
    url: new URL(input.route.path, input.runtime.origin).href,
    viewport: input.viewport,
    selectors,
    localOrigins: input.localOrigins,
    headers: input.authFixture?.headers,
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
  missingSelectors: VisualComparison["missingSelectors"];
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
    missingSelectors: result.missingSelectors,
  };
}

function reportHtml(
  scope: VisualParityScope,
  results: VisualComparison[],
  summary: VisualParitySummary,
): string {
  const rows = results
    .map((result) => {
      const diff = result.files.diff ?? "—";
      const geometry = JSON.stringify(result.geometryDiffs);
      const missingSelectors = JSON.stringify(result.missingSelectors);
      return `<tr><td>${escapeHtml(result.routeKey)}</td><td>${escapeHtml(result.viewport.name)}</td><td>${escapeHtml(result.status)}</td><td>${escapeHtml(result.differentPixels)}</td><td>${escapeHtml(result.diffRatio)}</td><td>${escapeHtml(result.files.reference)}</td><td>${escapeHtml(result.files.candidate)}</td><td>${escapeHtml(diff)}</td><td><code>${escapeHtml(geometry)}</code></td><td><code>${escapeHtml(missingSelectors)}</code></td></tr>`;
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
<table><thead><tr><th>route</th><th>viewport</th><th>status</th><th>different pixels</th><th>ratio</th><th>reference</th><th>candidate</th><th>diff</th><th>geometry diffs</th><th>missing selectors</th></tr></thead><tbody>${rows}</tbody></table>
</html>
`;
}

interface ArtifactWorkspace {
  lexicalRoot: string;
  canonicalRoot: string;
  logicalArtifactRoot: string;
  artifactRoot: string;
}

async function ensureArtifactDirectory(
  workspace: ArtifactWorkspace,
  directory: string,
): Promise<void> {
  const directoryRelative = relative(workspace.canonicalRoot, directory);
  if (
    directoryRelative === ".." ||
    directoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(directoryRelative)
  ) {
    throw new Error(`El directorio de artifacts sale de su raíz: ${directory}`);
  }
  let current = workspace.canonicalRoot;
  for (const component of directoryRelative.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `El componente de artifacts es un enlace o no directorio: ${current}`,
      );
    }
    if (!isWithin(workspace.canonicalRoot, await realpath(current))) {
      throw new Error(`El componente de artifacts sale de su raíz: ${current}`);
    }
  }
}

async function resolveArtifactWorkspace(
  root: string,
): Promise<ArtifactWorkspace> {
  const lexicalRoot = resolve(root);
  const rootEntry = await lstat(lexicalRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error(
      `La raíz de artifacts debe ser un directorio sin enlaces: ${root}`,
    );
  }
  const canonicalRoot = await realpath(lexicalRoot);
  const expectedCanonicalRoot = join(
    await realpath(dirname(lexicalRoot)),
    basename(lexicalRoot),
  );
  if (canonicalRoot !== expectedCanonicalRoot) {
    throw new Error(
      `La raíz canónica de artifacts no coincide con la esperada: ${root}`,
    );
  }
  const logicalArtifactRoot = resolve(lexicalRoot, ".artifacts", "visual");
  const artifactRoot = resolve(
    canonicalRoot,
    relative(lexicalRoot, logicalArtifactRoot),
  );
  const workspace = {
    lexicalRoot,
    canonicalRoot,
    logicalArtifactRoot,
    artifactRoot,
  } satisfies ArtifactWorkspace;
  await ensureArtifactDirectory(workspace, artifactRoot);
  return workspace;
}

function artifactPath(
  workspace: ArtifactWorkspace,
  portablePath: string,
): string {
  const logicalPath = resolve(workspace.lexicalRoot, portablePath);
  if (!isWithin(workspace.logicalArtifactRoot, logicalPath)) {
    throw new Error(
      `El reporte visual intentó salir de .artifacts/visual: ${portablePath}`,
    );
  }
  const path = resolve(
    workspace.canonicalRoot,
    relative(workspace.lexicalRoot, logicalPath),
  );
  if (!isWithin(workspace.artifactRoot, path)) {
    throw new Error(
      `El reporte visual intentó salir de .artifacts/visual: ${portablePath}`,
    );
  }
  return path;
}

async function assertArtifactFileTarget(
  workspace: ArtifactWorkspace,
  path: string,
): Promise<void> {
  await ensureArtifactDirectory(workspace, dirname(path));
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `El archivo de artifacts es un enlace o no regular: ${path}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeArtifactFile(
  workspace: ArtifactWorkspace,
  path: string,
  contents: Buffer | string,
): Promise<void> {
  await assertArtifactFileTarget(workspace, path);
  const temporaryPath = join(dirname(path), `.visual-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(contents);
      if (!(await handle.stat()).isFile()) {
        throw new Error(
          `El temporal de artifacts no es un archivo regular: ${temporaryPath}`,
        );
      }
    } finally {
      await handle.close();
    }
    await assertArtifactFileTarget(workspace, path);
    await rename(temporaryPath, path);
    temporaryCreated = false;
  } catch (error) {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupFailure) {
        if ((cleanupFailure as NodeJS.ErrnoException).code !== "ENOENT") {
          preserveVisualFailure(error, cleanupFailure);
        }
      }
    }
    throw error;
  }
}

async function removeArtifactFile(
  workspace: ArtifactWorkspace,
  path: string,
): Promise<void> {
  await assertArtifactFileTarget(workspace, path);
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function writeVisualReports(
  input: VisualReportInput,
): Promise<VisualArtifactPaths> {
  const workspace = await resolveArtifactWorkspace(input.root);
  for (const evidence of input.evidence) {
    const referencePath = artifactPath(
      workspace,
      evidence.result.files.reference,
    );
    const candidatePath = artifactPath(
      workspace,
      evidence.result.files.candidate,
    );
    await writeArtifactFile(
      workspace,
      referencePath,
      evidence.reference.screenshot,
    );
    await writeArtifactFile(
      workspace,
      candidatePath,
      evidence.candidate.screenshot,
    );
    if (
      evidence.result.diffPng !== null &&
      evidence.result.files.diff !== null
    ) {
      await writeArtifactFile(
        workspace,
        artifactPath(workspace, evidence.result.files.diff),
        evidence.result.diffPng,
      );
    } else {
      await removeArtifactFile(
        workspace,
        join(dirname(referencePath), "diff.png"),
      );
    }
  }
  const summary = summaryFor(input.results);
  const jsonPath = artifactPath(
    workspace,
    join(".artifacts", "visual", input.scope, "summary.json"),
  );
  const htmlPath = artifactPath(
    workspace,
    join(".artifacts", "visual", input.scope, "summary.html"),
  );
  const report = {
    schemaVersion: 1,
    scope: input.scope,
    summary,
    results: input.results.map(serializableResult),
  };
  await writeArtifactFile(
    workspace,
    jsonPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeArtifactFile(
    workspace,
    htmlPath,
    reportHtml(input.scope, input.results, summary),
  );
  return {
    root: toPortableRelative(input.root, workspace.logicalArtifactRoot),
    json: toPortableRelative(
      input.root,
      resolve(input.root, ".artifacts", "visual", input.scope, "summary.json"),
    ),
    html: toPortableRelative(
      input.root,
      resolve(input.root, ".artifacts", "visual", input.scope, "summary.html"),
    ),
  };
}

export async function runVisualParity(
  options: RunVisualParityOptions,
  dependencies: VisualParityDependencies = {},
): Promise<VisualParityResult> {
  if (options.scope !== "foundation" && options.scope !== "public") {
    throw new Error(`Scope visual no soportado: ${options.scope}`);
  }
  const root = resolve(options.root ?? process.cwd());
  const lifecycleTimeoutMs = visualLifecycleTimeout(options.lifecycleTimeoutMs);
  const sourceBuildTimeoutMs = visualLifecycleTimeout(
    options.sourceBuildTimeoutMs ?? defaultSourceBuildTimeoutMs,
  );
  // These factories own sequential bounded stages. The outer owner keeps a
  // composed deadline so their terminal cleanup can finish before it reports
  // an acquisition failure.
  const candidateAcquisitionTimeoutMs = acquisitionTimeoutBudget(
    lifecycleTimeoutMs,
    4,
  );
  const browserAcquisitionTimeoutMs = acquisitionTimeoutBudget(
    lifecycleTimeoutMs,
    3,
  );
  const assertSource =
    dependencies.assertSourcePristine ?? assertSourcePristine;
  const build = dependencies.buildCandidate ?? buildCandidate;
  const resolveTopology =
    dependencies.resolveCandidateTopology ?? resolveDeploymentTopology;
  const readMatrix = dependencies.readMatrix ?? readExistingRouteMatrix;
  const readFixtures = dependencies.readFixtures ?? readVisualFixtures;
  const startCandidate =
    dependencies.startCandidate ??
    ((
      topology: DeploymentTopology,
      _root: string,
      environment: Record<string, string>,
    ) => startCandidateRuntime(topology, lifecycleTimeoutMs, {}, environment));
  const sourceBuild =
    dependencies.withTemporarySourceBuild ?? withTemporarySourceBuild;
  const startReference =
    dependencies.startReference ??
    ((build: TemporarySourceBuild, environment: Record<string, string>) =>
      startSourceRuntime(build, lifecycleTimeoutMs, environment));
  const launchBrowser =
    dependencies.launchBrowser ?? (() => launchChromium(lifecycleTimeoutMs));
  const capture = dependencies.capture ?? captureVisual;
  const writeReports = dependencies.writeReports ?? writeVisualReports;

  await withinVisualTimeout(
    "verificar la referencia antes de captura",
    assertSource(),
    lifecycleTimeoutMs,
  );
  let visualResult!: VisualParityResult;
  let primaryFailure: unknown;
  let failed = false;
  try {
    const [matrix, fixtures] = await withinVisualTimeout(
      "leer matriz y fixtures visuales",
      Promise.all([readMatrix(root), readFixtures(root)]),
      lifecycleTimeoutMs,
    );
    const routes =
      options.routes === undefined
        ? options.scope === "foundation"
          ? selectFoundationVisualRoutes(matrix)
          : selectPublicVisualRoutes(matrix)
        : selectVisualRoutes(matrix, options.routes, {
            allowPrivate: options.authFixtures !== undefined,
          });
    const authPlan = resolveVisualAuthPlan(routes, options.authFixtures);
    const authFixtures = authPlan?.fixtures ?? [undefined];
    const runtimeEnvironment = authPlan?.environment ?? {};
    await build(root);
    const topology = await withinVisualTimeout(
      "resolver la topología del candidato visual",
      resolveTopology(root),
      lifecycleTimeoutMs,
    );
    visualResult = await withSourceBuildDeadline(
      sourceBuild,
      async (source) =>
        withVisualResource(
          "iniciar el runtime candidato",
          () => startCandidate(topology, root, runtimeEnvironment),
          "cerrar el runtime candidato",
          (candidate) => candidate.dispose(),
          candidateAcquisitionTimeoutMs,
          async (candidate) =>
            withVisualResource(
              "iniciar el runtime de referencia",
              () => startReference(source, runtimeEnvironment),
              "cerrar el runtime de referencia",
              (reference) => reference.dispose(),
              lifecycleTimeoutMs,
              async (reference) =>
                withVisualResource(
                  "abrir Chromium para captura visual",
                  () => launchBrowser(),
                  "cerrar el navegador",
                  (browser) => browser.close(),
                  browserAcquisitionTimeoutMs,
                  async (browser) => {
                    const localOrigins = [reference.origin, candidate.origin];
                    const evidence: VisualEvidence[] = [];
                    for (const route of routes) {
                      for (const authFixture of authFixtures) {
                        for (const viewport of VISUAL_VIEWPORTS) {
                          const referenceCapture = await capture({
                            browser,
                            side: "reference",
                            runtime: reference,
                            route,
                            viewport,
                            localOrigins,
                            authFixture,
                            fixtures,
                          });
                          const candidateCapture = await capture({
                            browser,
                            side: "candidate",
                            runtime: candidate,
                            route,
                            viewport,
                            localOrigins,
                            authFixture,
                            fixtures,
                          });
                          const comparison = resultForPendingRoute(
                            route,
                            await compareVisuals(
                              referenceCapture.screenshot,
                              candidateCapture.screenshot,
                              {
                                routeKey: routeKey(route, authFixture),
                                viewport,
                                referenceGeometry: referenceCapture.geometry,
                                candidateGeometry: candidateCapture.geometry,
                                referenceMissingSelectors:
                                  referenceCapture.missingSelectors,
                                candidateMissingSelectors:
                                  candidateCapture.missingSelectors,
                                files: artifactFiles(
                                  root,
                                  options.scope,
                                  route,
                                  viewport,
                                  authFixture,
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
                    }
                    const results = evidence.map((entry) => entry.result);
                    const summary = summaryFor(results);
                    const artifacts = await withinVisualTimeout(
                      "escribir los reportes visuales",
                      writeReports({
                        root,
                        scope: options.scope,
                        results,
                        evidence,
                      }),
                      lifecycleTimeoutMs,
                    );
                    if (summary.pending > 0 && !options.allowPending) {
                      throw new Error(
                        "Visual parity contiene resultados pendiente; repita con --allow-pending para registrar evidencia sin afirmar paridad",
                      );
                    }
                    return {
                      scope: options.scope,
                      results,
                      summary,
                      artifacts,
                    };
                  },
                  cleanupTimeoutBudget(lifecycleTimeoutMs, 2),
                ),
            ),
          cleanupTimeoutBudget(lifecycleTimeoutMs, 3),
        ),
      sourceBuildTimeoutMs,
    );
  } catch (error) {
    failed = true;
    primaryFailure = error;
  }
  let sourceCheckFailure: unknown;
  try {
    await withinVisualTimeout(
      "verificar la referencia después de captura",
      assertSource(),
      lifecycleTimeoutMs,
    );
  } catch (error) {
    sourceCheckFailure = error;
  }
  if (failed) {
    if (sourceCheckFailure !== undefined) {
      preserveVisualFailure(primaryFailure, sourceCheckFailure);
    }
    throw primaryFailure;
  }
  if (sourceCheckFailure !== undefined) throw sourceCheckFailure;
  return visualResult;
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

export function parseVisualArguments(args: string[]): RunVisualParityOptions {
  let scope: VisualParityScope | undefined;
  let routes: string[] | undefined;
  let authFixtures: VisualAuthFixtureName[] | undefined;
  let allowPending = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-pending") {
      if (allowPending) throw new Error("--allow-pending visual está repetido");
      allowPending = true;
      continue;
    }
    if (argument === "--scope") {
      const value = args[index + 1];
      if (
        scope !== undefined ||
        (value !== "foundation" && value !== "public")
      ) {
        throw new Error(
          "El scope visual debe ser foundation o public una sola vez",
        );
      }
      scope = value;
      index += 1;
      continue;
    }
    if (argument === "--routes") {
      const value = args[index + 1];
      if (routes !== undefined || value === undefined) {
        throw new Error("--routes visual debe aparecer una sola vez con rutas");
      }
      routes = value.split(",");
      if (routes.some((path) => path.length === 0)) {
        throw new Error("--routes visual no admite rutas vacías");
      }
      index += 1;
      continue;
    }
    if (argument === "--fixtures") {
      const value = args[index + 1];
      if (authFixtures !== undefined || value === undefined) {
        throw new Error(
          "--fixtures visual debe aparecer una sola vez con fixtures",
        );
      }
      authFixtures = parseVisualAuthFixtures(value);
      index += 1;
      continue;
    }
    throw new Error(`Argumento visual desconocido: ${argument}`);
  }
  if (scope !== undefined && routes !== undefined) {
    throw new Error("--scope y --routes visual no se pueden combinar");
  }
  if (authFixtures !== undefined && routes === undefined) {
    throw new Error("--fixtures visual requiere --routes privado explícito");
  }
  if (scope === undefined && routes === undefined) {
    throw new Error(
      "Uso: parity-visual.ts --scope foundation|public [--allow-pending] | --routes /ruta,/ruta [--fixtures anonymous,allowed] [--allow-pending]",
    );
  }
  return {
    scope: scope ?? "foundation",
    routes,
    ...(authFixtures === undefined ? {} : { authFixtures }),
    allowPending,
  };
}

async function main(args: string[]): Promise<void> {
  const result = await runVisualParity(parseVisualArguments(args));
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
