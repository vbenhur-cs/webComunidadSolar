import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  captureHttpContract,
  type BodyComparison,
  type CapturedHttpContract,
  type DeferredHttpContract,
  type HtmlSemantics,
  type HttpBaseline,
  type HttpContract,
  type JsonShape,
  type SuppressedHttpContract,
} from "./capture-http-baseline.ts";
import {
  serializeRouteMatrix,
  type RouteMatrixEntry,
} from "./lib/route-inventory.ts";
import type { SourceRef } from "./lib/source-reference.ts";

const foundationKinds = new Set(["gone", "redirect"]);
const localWorkerOrigin = "http://localhost";

export interface HttpDiff {
  routeKey: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface DeploymentTopology {
  deployConfigPath: string;
  wranglerConfigPath: string;
  entryPath: string;
}

export interface FoundationRuntime {
  fetch(request: Request): Promise<Response>;
  dispose(): Promise<void>;
}

export interface FoundationParityResult {
  checkedContracts: number;
  diffs: HttpDiff[];
  verifiedRouteKeys: ReadonlySet<string>;
}

export interface HttpParityResult {
  scope: "foundation";
  topology: DeploymentTopology;
  checkedContracts: number;
  verifiedRoutes: number;
  pendingRoutes: number;
  diffs: HttpDiff[];
  runtimeDisposed: true;
}

export interface RunHttpParityOptions {
  scope: "foundation";
  root?: string;
}

export interface HttpParityDependencies {
  build?(root: string): Promise<void>;
  resolveTopology?(root: string): Promise<DeploymentTopology>;
  readBaseline?(root: string): Promise<HttpBaseline>;
  readMatrix?(root: string): Promise<RouteMatrixEntry[]>;
  startRuntime?(
    topology: DeploymentTopology,
    root: string,
  ): Promise<FoundationRuntime>;
  writeMatrix?(entries: RouteMatrixEntry[]): Promise<void>;
  matrixFileSystem?: MatrixFileSystem;
}

export interface MatrixFileSystem {
  writeFile(
    path: string,
    contents: string,
    options?: { flag?: string },
  ): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  randomUUID(): string;
}

interface ParsedHttpRouteKey {
  kind: string;
  path: string;
  search: string;
  method: string;
  identity: string;
  variant: string;
}

type JsonRecord = Record<string, unknown>;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function resolveInside(root: string, candidate: string, label: string): string {
  const resolved = resolve(candidate);
  if (!isWithin(root, resolved)) {
    throw new Error(`${label} debe permanecer dentro del directorio de build`);
  }
  return resolved;
}

function compareUnknown(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function compareHeaderValues(
  routeKey: string,
  expected: Record<string, string>,
  actual: Record<string, string>,
): HttpDiff[] {
  const names = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort(compareText);
  return names.flatMap((name) => {
    const expectedValue = expected[name] ?? null;
    const actualValue = actual[name] ?? null;
    return expectedValue === actualValue
      ? []
      : [
          {
            routeKey,
            field: `headers.${name}`,
            expected: expectedValue,
            actual: actualValue,
          },
        ];
  });
}

function diffValue(
  routeKey: string,
  field: string,
  expected: unknown,
  actual: unknown,
): HttpDiff[] {
  return compareUnknown(expected, actual)
    ? []
    : [{ routeKey, field, expected, actual }];
}

function compareHtmlSemantics(
  routeKey: string,
  expected: HtmlSemantics | null,
  actual: HtmlSemantics | null,
): HttpDiff[] {
  return [
    ...diffValue(
      routeKey,
      "canonical",
      expected?.canonical ?? null,
      actual?.canonical ?? null,
    ),
    ...diffValue(
      routeKey,
      "robots",
      expected?.robots ?? null,
      actual?.robots ?? null,
    ),
    ...diffValue(
      routeKey,
      "normalizedText",
      expected?.normalizedText ?? null,
      actual?.normalizedText ?? null,
    ),
  ];
}

/**
 * Compares the captured contract fields without ever reading body fields from a
 * suppressed private-success contract. The discriminant is checked before any
 * captured-body field is accessed.
 */
export function compareHttpContract(
  expected: HttpContract,
  actual: HttpContract,
): HttpDiff[] {
  const routeKey = expected.routeKey;
  const diffs = [
    ...diffValue(routeKey, "routeKey", expected.routeKey, actual.routeKey),
    ...diffValue(routeKey, "status", expected.status, actual.status),
    ...compareHeaderValues(routeKey, expected.headers, actual.headers),
    ...diffValue(
      routeKey,
      "bodyCapture",
      expected.bodyCapture,
      actual.bodyCapture,
    ),
  ];

  if (
    expected.bodyCapture !== "captured" ||
    actual.bodyCapture !== "captured"
  ) {
    return diffs;
  }

  return [
    ...diffs,
    ...diffValue(
      routeKey,
      "bodyComparison",
      expected.bodyComparison,
      actual.bodyComparison,
    ),
    ...(expected.bodyComparison === "exact"
      ? diffValue(
          routeKey,
          "bodySha256",
          expected.bodySha256,
          actual.bodySha256,
        )
      : []),
    ...compareHtmlSemantics(
      routeKey,
      expected.htmlSemantics,
      actual.htmlSemantics,
    ),
    ...diffValue(routeKey, "bodyText", expected.bodyText, actual.bodyText),
    ...diffValue(
      routeKey,
      "bodyJsonShape",
      expected.bodyJsonShape,
      actual.bodyJsonShape,
    ),
  ];
}

export function selectFoundationContracts(
  baseline: Pick<HttpBaseline, "contracts">,
): HttpContract[] {
  return baseline.contracts.filter((contract) =>
    foundationKinds.has(parseHttpRouteKey(contract.routeKey).kind),
  );
}

function routeMatrixKey(
  entry: Pick<RouteMatrixEntry, "kind" | "path">,
): string {
  return `${entry.kind}:${entry.path}`;
}

export function applyFoundationMatrixResults(
  matrix: RouteMatrixEntry[],
  verifiedRouteKeys: ReadonlySet<string>,
): RouteMatrixEntry[] {
  return matrix.map((entry) => {
    const key = routeMatrixKey(entry);
    if (!foundationKinds.has(entry.kind) || !verifiedRouteKeys.has(key)) {
      return { ...entry };
    }
    return { ...entry, status: "verified" };
  });
}

function parseHttpRouteKey(routeKey: string): ParsedHttpRouteKey {
  const [route, method, identity, variant, extra] = routeKey.split("|");
  const separator = route?.indexOf(":") ?? -1;
  if (
    route === undefined ||
    method === undefined ||
    identity === undefined ||
    variant === undefined ||
    extra !== undefined ||
    separator <= 0
  ) {
    throw new Error(`routeKey HTTP inválido: ${routeKey}`);
  }

  const kind = route.slice(0, separator);
  const requestTarget = route.slice(separator + 1);
  let url: URL;
  try {
    url = new URL(requestTarget, localWorkerOrigin);
  } catch {
    throw new Error(`path HTTP inválido: ${routeKey}`);
  }
  if (url.origin !== localWorkerOrigin || !url.pathname.startsWith("/")) {
    throw new Error(`path HTTP fuera de loopback: ${routeKey}`);
  }

  return {
    kind,
    path: url.pathname,
    search: url.search,
    method,
    identity,
    variant,
  };
}

function requestForFoundationContract(contract: HttpContract): Request {
  const parsed = parseHttpRouteKey(contract.routeKey);
  if (!foundationKinds.has(parsed.kind) || parsed.method !== "GET") {
    throw new Error(
      `Contrato fuera del scope foundation: ${contract.routeKey}`,
    );
  }
  return new Request(`${localWorkerOrigin}${parsed.path}${parsed.search}`, {
    method: parsed.method,
  });
}

function contractRouteKey(contract: HttpContract): string {
  const parsed = parseHttpRouteKey(contract.routeKey);
  return `${parsed.kind}:${parsed.path}`;
}

export async function runFoundationParity(
  baseline: Pick<HttpBaseline, "contracts">,
  runtime: FoundationRuntime,
  options: { root?: string } = {},
): Promise<FoundationParityResult> {
  const contracts = selectFoundationContracts(baseline);
  const diffs: HttpDiff[] = [];
  const failedRouteKeys = new Set<string>();

  try {
    for (const expected of contracts) {
      if (expected.bodyCapture !== "captured") {
        throw new Error(
          `Contrato foundation sin body capturado: ${expected.routeKey}`,
        );
      }
      const response = await runtime.fetch(
        requestForFoundationContract(expected),
      );
      const actual = await captureHttpContract(expected.routeKey, response, {
        root: options.root,
        bodyComparison: expected.bodyComparison,
        artifactNamespace: "candidate",
      });
      const contractDiffs = compareHttpContract(expected, actual);
      diffs.push(...contractDiffs);
      if (contractDiffs.length > 0) {
        failedRouteKeys.add(contractRouteKey(expected));
      }
    }
  } finally {
    await runtime.dispose();
  }

  const verifiedRouteKeys = new Set(
    contracts.map(contractRouteKey).filter((key) => !failedRouteKeys.has(key)),
  );
  return { checkedContracts: contracts.length, diffs, verifiedRouteKeys };
}

function asHeaders(value: unknown, routeKey: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`headers HTTP inválidos para ${routeKey}`);
  }
  const headers = Object.entries(value);
  if (headers.some(([, header]) => typeof header !== "string")) {
    throw new Error(`headers HTTP inválidos para ${routeKey}`);
  }
  return Object.fromEntries(headers) as Record<string, string>;
}

function asBodyComparison(value: unknown): BodyComparison {
  if (value === "exact" || value === "semantic") return value;
  throw new Error("bodyComparison HTTP desconocido");
}

function asHtmlSemantics(value: unknown): HtmlSemantics | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !Array.isArray(value.canonical) ||
    !Array.isArray(value.robots) ||
    typeof value.normalizedText !== "string" ||
    value.canonical.some((entry) => typeof entry !== "string") ||
    value.robots.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Semántica HTML HTTP inválida");
  }
  return {
    canonical: [...value.canonical] as string[],
    robots: [...value.robots] as string[],
    normalizedText: value.normalizedText,
  };
}

function asCapturedContract(value: JsonRecord): CapturedHttpContract {
  const routeKey = value.routeKey;
  if (
    typeof routeKey !== "string" ||
    typeof value.status !== "number" ||
    value.bodyCapture !== "captured" ||
    !("bodyComparison" in value) ||
    typeof value.bodySha256 !== "string" ||
    (value.normalizedHtmlPath !== null &&
      typeof value.normalizedHtmlPath !== "string") ||
    !("htmlSemantics" in value) ||
    (value.bodyText !== null && typeof value.bodyText !== "string") ||
    !("bodyJsonShape" in value)
  ) {
    throw new Error("Contrato HTTP captured inválido");
  }
  return {
    routeKey,
    status: value.status,
    headers: asHeaders(value.headers, routeKey),
    bodyCapture: "captured",
    bodyComparison: asBodyComparison(value.bodyComparison),
    bodySha256: value.bodySha256,
    normalizedHtmlPath: value.normalizedHtmlPath,
    htmlSemantics: asHtmlSemantics(value.htmlSemantics),
    bodyText: value.bodyText,
    bodyJsonShape: value.bodyJsonShape as JsonShape | null,
  };
}

function asSuppressedContract(value: JsonRecord): SuppressedHttpContract {
  const routeKey = value.routeKey;
  if (
    typeof routeKey !== "string" ||
    typeof value.status !== "number" ||
    value.bodyCapture !== "suppressed-private-success"
  ) {
    throw new Error("Contrato HTTP suppressed inválido");
  }
  for (const bodyField of [
    "bodyComparison",
    "bodySha256",
    "normalizedHtmlPath",
    "htmlSemantics",
    "bodyText",
    "bodyJsonShape",
  ]) {
    if (Object.hasOwn(value, bodyField)) {
      throw new Error(
        `Contrato HTTP suppressed no puede incluir ${bodyField}: ${routeKey}`,
      );
    }
  }
  return {
    routeKey,
    status: value.status,
    headers: asHeaders(value.headers, routeKey),
    bodyCapture: "suppressed-private-success",
  };
}

function asHttpContract(value: unknown): HttpContract {
  if (!isRecord(value)) throw new Error("Contrato HTTP inválido");
  if (value.bodyCapture === "captured") return asCapturedContract(value);
  if (value.bodyCapture === "suppressed-private-success") {
    return asSuppressedContract(value);
  }
  throw new Error("bodyCapture HTTP desconocido");
}

function asDeferredContract(value: unknown): DeferredHttpContract {
  if (
    !isRecord(value) ||
    typeof value.routeKey !== "string" ||
    (value.deferredToPhase !== 2 && value.deferredToPhase !== 3) ||
    typeof value.reason !== "string"
  ) {
    throw new Error("Deferred HTTP inválido");
  }
  return {
    routeKey: value.routeKey,
    deferredToPhase: value.deferredToPhase,
    reason: value.reason,
  };
}

function asSourceRef(value: unknown): SourceRef {
  if (
    !isRecord(value) ||
    value.repository !== "../comunidadsolarweb" ||
    value.branch !== "main" ||
    typeof value.commit !== "string"
  ) {
    throw new Error("Referencia fuente HTTP inválida");
  }
  return value as unknown as SourceRef;
}

function parseHttpBaseline(value: unknown): HttpBaseline {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !Array.isArray(value.contracts) ||
    !Array.isArray(value.deferred)
  ) {
    throw new Error("parity/http-contracts.json inválido");
  }
  return {
    schemaVersion: 2,
    source: asSourceRef(value.source),
    contracts: value.contracts.map(asHttpContract),
    deferred: value.deferred.map(asDeferredContract),
  };
}

function parseRouteMatrix(value: unknown): RouteMatrixEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("parity/route-matrix.json debe contener una lista");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.kind !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.status !== "string"
    ) {
      throw new Error("parity/route-matrix.json contiene una entrada inválida");
    }
    return entry as RouteMatrixEntry;
  });
}

async function readBaselineFromDisk(root: string): Promise<HttpBaseline> {
  return parseHttpBaseline(
    JSON.parse(
      await readFile(join(root, "parity", "http-contracts.json"), "utf8"),
    ),
  );
}

async function readMatrixFromDisk(root: string): Promise<RouteMatrixEntry[]> {
  return parseRouteMatrix(
    JSON.parse(
      await readFile(join(root, "parity", "route-matrix.json"), "utf8"),
    ),
  );
}

const defaultMatrixFileSystem: MatrixFileSystem = {
  writeFile: async (path, contents, options) =>
    writeFile(path, contents, options),
  rename,
  rm: async (path, options) => rm(path, options),
  randomUUID,
};

export async function writeMatrixToDisk(
  root: string,
  entries: RouteMatrixEntry[],
  fileSystem: MatrixFileSystem = defaultMatrixFileSystem,
): Promise<void> {
  const destination = join(root, "parity", "route-matrix.json");
  const temporary = join(
    dirname(destination),
    `.route-matrix-${fileSystem.randomUUID()}.tmp`,
  );
  let cleanupTemporary = false;
  try {
    try {
      await fileSystem.writeFile(temporary, serializeRouteMatrix(entries), {
        flag: "wx",
      });
      cleanupTemporary = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        cleanupTemporary = true;
      }
      throw error;
    }
    await fileSystem.rename(temporary, destination);
    cleanupTemporary = false;
  } finally {
    if (cleanupTemporary) {
      await fileSystem.rm(temporary, { force: true });
    }
  }
}

export async function resolveDeploymentTopology(
  root: string = process.cwd(),
): Promise<DeploymentTopology> {
  const resolvedRoot = resolve(root);
  const deployConfigPath = resolveInside(
    resolvedRoot,
    join(resolvedRoot, ".wrangler", "deploy", "config.json"),
    "El config de deploy",
  );
  const deploy = JSON.parse(
    await readFile(deployConfigPath, "utf8"),
  ) as unknown;
  if (!isRecord(deploy) || typeof deploy.configPath !== "string") {
    throw new Error(".wrangler/deploy/config.json no define configPath");
  }

  const wranglerConfigPath = resolveInside(
    resolvedRoot,
    resolve(dirname(deployConfigPath), deploy.configPath),
    "El config de Wrangler generado",
  );
  const wrangler = JSON.parse(
    await readFile(wranglerConfigPath, "utf8"),
  ) as unknown;
  if (!isRecord(wrangler) || typeof wrangler.main !== "string") {
    throw new Error("El config de Wrangler generado no define main");
  }

  const entryPath = resolveInside(
    resolvedRoot,
    resolve(dirname(wranglerConfigPath), wrangler.main),
    "El entry generado",
  );
  await access(entryPath);
  return { deployConfigPath, wranglerConfigPath, entryPath };
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

async function startBuiltWorker(
  topology: DeploymentTopology,
): Promise<FoundationRuntime> {
  const { unstable_startWorker } = await import("wrangler");
  const worker = await unstable_startWorker({
    config: topology.wranglerConfigPath,
    entrypoint: topology.entryPath,
    dev: {
      server: { hostname: "127.0.0.1", port: 0, secure: false },
      logLevel: "error",
      persist: false,
      remote: false,
      watch: false,
    },
  } as Parameters<typeof unstable_startWorker>[0]);
  try {
    await worker.ready;
  } catch (error) {
    await worker.dispose();
    throw error;
  }
  return {
    fetch: async (request) => {
      if (request.method !== "GET") {
        throw new Error("El runtime foundation solo admite solicitudes GET");
      }
      // The harness is a fetch client, so redirects would otherwise be followed
      // and conceal the response contract emitted by the built Worker.
      return (await worker.fetch(request.url, {
        redirect: "manual",
      })) as unknown as Response;
    },
    dispose: async () => worker.dispose(),
  };
}

function countStatus(matrix: RouteMatrixEntry[], status: string): number {
  return matrix.filter((entry) => entry.status === status).length;
}

export async function runHttpParity(
  options: RunHttpParityOptions,
  dependencies: HttpParityDependencies = {},
): Promise<HttpParityResult> {
  if (options.scope !== "foundation") {
    throw new Error(`Scope HTTP no soportado: ${options.scope}`);
  }
  const root = resolve(options.root ?? process.cwd());
  const build = dependencies.build ?? buildCandidate;
  const resolveTopology =
    dependencies.resolveTopology ?? resolveDeploymentTopology;
  const readBaseline = dependencies.readBaseline ?? readBaselineFromDisk;
  const readMatrix = dependencies.readMatrix ?? readMatrixFromDisk;
  const startRuntime = dependencies.startRuntime ?? startBuiltWorker;
  const writeMatrix =
    dependencies.writeMatrix ??
    (async (entries: RouteMatrixEntry[]) =>
      writeMatrixToDisk(root, entries, dependencies.matrixFileSystem));

  await build(root);
  const [topology, baseline, matrix] = await Promise.all([
    resolveTopology(root),
    readBaseline(root),
    readMatrix(root),
  ]);
  const runtime = await startRuntime(topology, root);
  const foundation = await runFoundationParity(baseline, runtime, { root });
  const updatedMatrix = applyFoundationMatrixResults(
    matrix,
    foundation.verifiedRouteKeys,
  );

  if (foundation.diffs.length === 0) {
    await writeMatrix(updatedMatrix);
  }

  return {
    scope: "foundation",
    topology,
    checkedContracts: foundation.checkedContracts,
    verifiedRoutes: countStatus(updatedMatrix, "verified"),
    pendingRoutes: countStatus(updatedMatrix, "pending"),
    diffs: foundation.diffs,
    runtimeDisposed: true,
  };
}

function formatDiffValue(field: string, value: unknown): string {
  if (field === "bodyText") return "[redacted body text]";
  return JSON.stringify(value);
}

function formatDiff(diff: HttpDiff): string {
  return [
    diff.routeKey,
    diff.field,
    `expected=${formatDiffValue(diff.field, diff.expected)}`,
    `actual=${formatDiffValue(diff.field, diff.actual)}`,
  ].join(" ");
}

function parseArguments(args: string[]): RunHttpParityOptions {
  if (args.length === 0) return { scope: "foundation" };
  if (args.length === 2 && args[0] === "--scope" && args[1] === "foundation") {
    return { scope: "foundation" };
  }
  throw new Error("Uso: parity-http.ts --scope foundation");
}

async function main(args: string[]): Promise<void> {
  const result = await runHttpParity(parseArguments(args));
  if (result.diffs.length > 0) {
    for (const diff of result.diffs) {
      process.stderr.write(`HTTP_DIFF ${formatDiff(diff)}\n`);
    }
    throw new Error(`HTTP parity falló con ${result.diffs.length} diferencias`);
  }
  process.stdout.write(
    [
      "HTTP_PARITY_OK",
      `scope=${result.scope}`,
      `contracts=${result.checkedContracts}`,
      `verified=${result.verifiedRoutes}`,
      `pending=${result.pendingRoutes}`,
      `deploy=${result.topology.deployConfigPath}`,
      `config=${result.topology.wranglerConfigPath}`,
      `entry=${result.topology.entryPath}`,
      "disposed=true",
    ].join(" ") + "\n",
  );
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
