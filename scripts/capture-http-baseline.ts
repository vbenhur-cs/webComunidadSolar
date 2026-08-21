import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  PrivateArea,
  RouteContract,
  SourceManifest,
} from "./lib/route-inventory.ts";
import {
  assertSourcePristine,
  resolveSourceRoot,
  type SourceRef,
} from "./lib/source-reference.ts";
import { withTemporarySourceBuild } from "./lib/temporary-source-build.ts";

const headerAllowlist = [
  "allow",
  "cache-control",
  "content-disposition",
  "content-type",
  "location",
  "referrer-policy",
  "www-authenticate",
  "x-content-type-options",
  "x-robots-tag",
] as const;

const identities = ["allowed", "anonymous", "denied", "unconfigured"] as const;
const controlledEnvironmentKeys = [
  "SOCIOS_ALLOWED_EMAILS",
  "TEAM_ALLOWED_EMAILS",
  "MANGANAFER_ALLOWED_EMAILS",
  "MANGANAFER_QUOTING_BEARER_TOKEN",
  "MANGANAFER_PANEL_MONTHLY_FEE",
  "MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT",
  "MANGANAFER_PANEL_FEE_VAT",
  "MANGANAFER_AVAILABLE_PANELS",
  "MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH",
  "MANGANAFER_DISCOUNT",
  "MANGANAFER_PANEL_POWER_W",
  "MANGANAFER_ANNUAL_DEGRADATION",
  "MANGANAFER_MAXIMUM_PANELS_PER_QUOTE",
] as const;

const volatileTimestamp =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/g;

export type HttpIdentity = (typeof identities)[number];

export interface HttpContract {
  routeKey: string;
  status: number;
  headers: Record<string, string>;
  bodySha256: string;
  normalizedHtmlPath: string | null;
  bodyText: string | null;
  bodyJsonShape: JsonShape | null;
}

export type JsonShape =
  | "array"
  | "boolean"
  | "invalid-json"
  | "null"
  | "number"
  | "string"
  | { [key: string]: JsonShape };

export interface DeferredHttpContract {
  routeKey: string;
  deferredToPhase: 2 | 3;
  reason: string;
}

export interface HttpBaseline {
  schemaVersion: 1;
  source: SourceRef;
  contracts: HttpContract[];
  deferred: DeferredHttpContract[];
}

export interface CaptureRequest {
  routeKey: string;
  path: string;
  search: string;
  method: "GET" | "POST";
  identity: HttpIdentity;
  variant: string;
  privateArea: PrivateArea | null;
  body?: string;
}

export interface CapturePlan {
  requests: CaptureRequest[];
  deferred: DeferredHttpContract[];
}

export interface CaptureHttpBaselineOptions {
  root?: string;
  sourceRoot?: string;
  logRoot?: string;
}

interface SourceWorker {
  fetch(
    request: Request,
    environment: Record<string, unknown>,
    context: {
      waitUntil(promise: Promise<unknown>): void;
      passThroughOnException(): void;
    },
  ): Promise<Response>;
}

type CaptureMode = "--check" | "--write";

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRoute(left: RouteContract, right: RouteContract): number {
  return (
    compareText(left.kind, right.kind) ||
    compareText(left.path, right.path) ||
    compareText(left.sourceFile, right.sourceFile)
  );
}

function routeKey(
  route: Pick<RouteContract, "kind" | "path">,
  method: CaptureRequest["method"],
  identity: HttpIdentity,
  variant: string,
  search = "",
): string {
  return `${route.kind}:${route.path}${search}|${method}|${identity}|${variant}`;
}

function requestFor(
  route: RouteContract,
  options: {
    method?: CaptureRequest["method"];
    identity?: HttpIdentity;
    variant?: string;
    search?: string;
    body?: string;
  } = {},
): CaptureRequest {
  const method = options.method ?? "GET";
  const identity = options.identity ?? "anonymous";
  const variant = options.variant ?? "default";
  const search = options.search ?? "";
  return {
    routeKey: routeKey(route, method, identity, variant, search),
    path: route.path,
    search,
    method,
    identity,
    variant,
    privateArea: route.privateArea,
    ...(options.body === undefined ? {} : { body: options.body }),
  };
}

function deferredFor(
  route: RouteContract,
  options: {
    deferredToPhase: 2 | 3;
    method?: CaptureRequest["method"];
    identity?: HttpIdentity;
    variant: string;
    reason: string;
  },
): DeferredHttpContract {
  const method = options.method ?? "GET";
  const identity = options.identity ?? "anonymous";
  return {
    routeKey: routeKey(route, method, identity, options.variant),
    deferredToPhase: options.deferredToPhase,
    reason: options.reason,
  };
}

function addPrivateRequests(
  requests: CaptureRequest[],
  deferred: DeferredHttpContract[],
  route: RouteContract,
): void {
  for (const identity of identities) {
    if (identity === "allowed" && route.path === "/manganafer/interesados") {
      deferred.push(
        deferredFor(route, {
          deferredToPhase: 3,
          identity,
          variant: "database-read",
          reason:
            "La vista autorizada necesita una instantánea D1 determinista, definida en la fase 3.",
        }),
      );
      continue;
    }
    requests.push(requestFor(route, { identity }));
  }
}

function addApiRequests(
  requests: CaptureRequest[],
  deferred: DeferredHttpContract[],
  route: RouteContract,
): void {
  if (route.path === "/api/manganafer-interest") {
    requests.push(
      requestFor(route, {
        method: "POST",
        variant: "invalid-form",
        body: "{",
      }),
    );
    deferred.push(
      deferredFor(route, {
        deferredToPhase: 3,
        method: "POST",
        variant: "persistence",
        reason:
          "La persistencia correcta requiere una base D1 de fixture, definida en la fase 3.",
      }),
    );
    return;
  }

  if (route.path === "/api/manganafer-interest/export") {
    for (const identity of identities) {
      if (identity === "allowed") {
        deferred.push(
          deferredFor(route, {
            deferredToPhase: 3,
            identity,
            variant: "database-read",
            reason:
              "La exportación autorizada necesita una instantánea D1 determinista, definida en la fase 3.",
          }),
        );
      } else {
        requests.push(requestFor(route, { identity }));
      }
    }
    return;
  }

  if (route.path === "/api/manganafer-quote") {
    requests.push(
      requestFor(route, {
        method: "POST",
        variant: "invalid-cups",
        body: JSON.stringify({ cups: "ES123" }),
      }),
      requestFor(route, {
        method: "POST",
        variant: "unconfigured",
        body: JSON.stringify({ cups: "ES1234567890123456AB" }),
      }),
    );
    deferred.push(
      deferredFor(route, {
        deferredToPhase: 3,
        method: "POST",
        variant: "external-quote",
        reason:
          "La cotización válida depende de fixtures para los dos upstreams de CUPS y simulación, definidos en la fase 3.",
      }),
    );
    return;
  }

  throw new Error(`No hay una captura segura definida para ${route.path}`);
}

export function buildCapturePlan(manifest: SourceManifest): CapturePlan {
  const requests: CaptureRequest[] = [];
  const deferred: DeferredHttpContract[] = [];

  for (const route of [...manifest.routes].sort(compareRoute)) {
    if (route.kind === "asset") {
      deferred.push(
        deferredFor(route, {
          deferredToPhase: 2,
          variant: "asset-delivery",
          reason:
            "La entrega de assets se valida contra el inventario con hash y se porta en la fase 2.",
        }),
      );
      continue;
    }

    if (route.kind === "redirect") {
      requests.push(
        requestFor(route),
        requestFor(route, {
          variant: "redirect-query",
          search: "?utm_source=http-baseline",
        }),
      );
      continue;
    }

    if (route.kind === "api") {
      addApiRequests(requests, deferred, route);
      continue;
    }

    if (route.privateArea !== null) {
      addPrivateRequests(requests, deferred, route);
      continue;
    }

    requests.push(requestFor(route));
  }

  return {
    requests: requests.sort(compareCaptureRequest),
    deferred: deferred.sort((left, right) =>
      compareText(left.routeKey, right.routeKey),
    ),
  };
}

export function normalizeHtml(html: string): string {
  return html.replace(volatileTimestamp, "__TIMESTAMP__");
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const selected = Object.fromEntries(
    headerAllowlist.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
  return Object.fromEntries(
    Object.entries(selected).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
}

function isHtmlResponse(response: Response): boolean {
  return (
    response.headers.get("content-type")?.toLowerCase().includes("text/html") ??
    false
  );
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json") ?? false
  );
}

function describeJson(value: unknown): JsonShape {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, describeJson(entry)]),
    );
  }
  return "string";
}

function jsonShape(body: string): JsonShape {
  try {
    return describeJson(JSON.parse(body));
  } catch {
    return "invalid-json";
  }
}

function artifactFileName(routeKeyValue: string): string {
  const readable = routeKeyValue
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  const hash = createHash("sha256")
    .update(routeKeyValue)
    .digest("hex")
    .slice(0, 12);
  return `${readable || "response"}-${hash}.html`;
}

function compareCaptureRequest(
  left: CaptureRequest,
  right: CaptureRequest,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.method, right.method) ||
    compareText(left.identity, right.identity) ||
    compareText(left.variant, right.variant) ||
    compareText(left.search, right.search)
  );
}

export async function captureHttpContract(
  routeKeyValue: string,
  response: Response,
  options: { root?: string } = {},
): Promise<HttpContract> {
  const root = resolve(options.root ?? process.cwd());
  const body = await response.text();
  const html = isHtmlResponse(response);
  const json = isJsonResponse(response);
  const normalizedBody = html ? normalizeHtml(body) : body;
  let normalizedHtmlPath: string | null = null;

  if (html) {
    const artifactRoot = resolve(root, ".artifacts", "http-baseline");
    const destination = resolve(artifactRoot, artifactFileName(routeKeyValue));
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(destination, normalizedBody);
    normalizedHtmlPath = relative(root, destination).split(sep).join("/");
  }

  return {
    routeKey: routeKeyValue,
    status: response.status,
    headers: selectedHeaders(response.headers),
    bodySha256: createHash("sha256").update(normalizedBody).digest("hex"),
    normalizedHtmlPath,
    bodyText: response.status >= 400 && !html && !json ? body : null,
    bodyJsonShape: json ? jsonShape(body) : null,
  };
}

function uniqueValues(values: string[]): string[] {
  const duplicates = values.filter(
    (value, index) => values.indexOf(value) !== index,
  );
  return [...new Set(duplicates)].sort(compareText);
}

export function assertHttpBaselineCoverage(
  manifest: SourceManifest,
  baseline: Pick<HttpBaseline, "contracts" | "deferred">,
): void {
  const plan = buildCapturePlan(manifest);
  const contractKeys = baseline.contracts.map((contract) => contract.routeKey);
  const deferredByKey = new Map(
    baseline.deferred.map((entry) => [entry.routeKey, entry]),
  );
  const duplicateContracts = uniqueValues(contractKeys);
  const duplicateDeferred = uniqueValues(
    baseline.deferred.map((entry) => entry.routeKey),
  );
  const missingContracts = plan.requests
    .map((request) => request.routeKey)
    .filter((key) => !contractKeys.includes(key));
  const missingDeferred = plan.deferred.filter((expected) => {
    const actual = deferredByKey.get(expected.routeKey);
    return actual?.deferredToPhase !== expected.deferredToPhase;
  });
  const expectedKeys = new Set([
    ...plan.requests.map((request) => request.routeKey),
    ...plan.deferred.map((entry) => entry.routeKey),
  ]);
  const unexpected = [
    ...contractKeys,
    ...baseline.deferred.map((entry) => entry.routeKey),
  ].filter((key) => !expectedKeys.has(key));

  if (duplicateContracts.length > 0 || duplicateDeferred.length > 0) {
    throw new Error(
      `Hay routeKey HTTP duplicados: ${[...duplicateContracts, ...duplicateDeferred].join(", ")}`,
    );
  }
  if (missingContracts.length > 0) {
    throw new Error(`Faltan contratos HTTP: ${missingContracts.join(", ")}`);
  }
  if (missingDeferred.length > 0) {
    throw new Error(
      `Faltan deferrals HTTP: ${missingDeferred.map((entry) => entry.routeKey).join(", ")}`,
    );
  }
  if (unexpected.length > 0) {
    throw new Error(
      `Hay contratos HTTP no planificados: ${unexpected.join(", ")}`,
    );
  }
}

function sortContract(contract: HttpContract): HttpContract {
  return {
    ...contract,
    headers: Object.fromEntries(
      Object.entries(contract.headers).sort(([left], [right]) =>
        compareText(left, right),
      ),
    ),
  };
}

export function serializeHttpBaseline(baseline: HttpBaseline): string {
  return `${JSON.stringify(
    {
      schemaVersion: baseline.schemaVersion,
      source: baseline.source,
      contracts: [...baseline.contracts]
        .sort((left, right) => compareText(left.routeKey, right.routeKey))
        .map(sortContract),
      deferred: [...baseline.deferred].sort((left, right) =>
        compareText(left.routeKey, right.routeKey),
      ),
    },
    null,
    2,
  )}\n`;
}

function parseMode(args: string[]): CaptureMode {
  if (args.length === 0) return "--check";
  if (args.length === 1 && (args[0] === "--check" || args[0] === "--write")) {
    return args[0];
  }
  throw new Error("capture-http-baseline solo acepta --check o --write");
}

async function readManifest(root: string): Promise<SourceManifest> {
  return JSON.parse(
    await readFile(resolve(root, "parity", "source-manifest.json"), "utf8"),
  ) as SourceManifest;
}

function assertManifestSource(
  manifest: SourceManifest,
  source: SourceRef,
): void {
  assert.deepEqual(
    manifest.source,
    source,
    "parity/source-manifest.json no corresponde a la referencia fuente actual",
  );
}

function identityHeaders(identity: HttpIdentity): Record<string, string> {
  if (identity === "anonymous") return {};
  const email =
    identity === "allowed" ? "allowed@example.test" : "denied@example.test";
  return {
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": "Fixture%20User",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}

function accessVariable(area: PrivateArea): string {
  return {
    socios: "SOCIOS_ALLOWED_EMAILS",
    equipo: "TEAM_ALLOWED_EMAILS",
    manganafer: "MANGANAFER_ALLOWED_EMAILS",
  }[area];
}

function environmentForRequest(
  request: CaptureRequest,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = Object.fromEntries(
    controlledEnvironmentKeys.map((key) => [key, undefined]),
  );
  if (
    request.privateArea !== null &&
    (request.identity === "allowed" || request.identity === "denied")
  ) {
    environment[accessVariable(request.privateArea)] = "allowed@example.test";
  }
  return environment;
}

async function withEnvironment<T>(
  environment: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function requestFromPlan(request: CaptureRequest): Request {
  const headers = new Headers({
    accept: request.path.startsWith("/api/") ? "application/json" : "text/html",
    ...identityHeaders(request.identity),
  });
  if (request.body !== undefined)
    headers.set("content-type", "application/json");
  return new Request(
    new URL(`${request.path}${request.search}`, "http://localhost"),
    {
      method: request.method,
      headers,
      body: request.body,
    },
  );
}

function sourceEnvironment(): Record<string, unknown> {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  };
}

function blockExternalQuoteRequests(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (
      url.startsWith("https://api-contratacion.comunidadsolar.es/") ||
      url.startsWith("https://quoting-new.51.44.13.132.nip.io/")
    ) {
      return Response.json(
        { ok: false, error: "External quotation fixture deferred to phase 3." },
        { status: 503 },
      );
    }
    throw new Error(`La captura HTTP bloqueó una petición externa: ${url}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function importBuiltWorker(root: string): Promise<SourceWorker> {
  const workerUrl = pathToFileURL(resolve(root, "dist", "server", "index.js"));
  workerUrl.searchParams.set("http-baseline", randomUUID());
  const loaded = (await import(workerUrl.href)) as { default?: unknown };
  if (
    !loaded.default ||
    typeof loaded.default !== "object" ||
    !("fetch" in loaded.default) ||
    typeof loaded.default.fetch !== "function"
  ) {
    throw new Error("El Worker fuente construido no exporta fetch");
  }
  return loaded.default as SourceWorker;
}

async function createBaseline(
  manifest: SourceManifest,
  sourceRoot: string,
  source: SourceRef,
  root: string,
  logRoot?: string,
): Promise<HttpBaseline> {
  const plan = buildCapturePlan(manifest);
  const contracts = await withTemporarySourceBuild(
    async ({ root: temporaryRoot }) => {
      const worker = await importBuiltWorker(temporaryRoot);
      const restoreFetch = blockExternalQuoteRequests();
      const contracts: HttpContract[] = [];
      try {
        for (const request of plan.requests) {
          const response = await withEnvironment(
            environmentForRequest(request),
            () =>
              worker.fetch(requestFromPlan(request), sourceEnvironment(), {
                waitUntil() {},
                passThroughOnException() {},
              }),
          );
          contracts.push(
            await captureHttpContract(request.routeKey, response, { root }),
          );
        }
      } finally {
        restoreFetch();
      }
      return contracts;
    },
    {
      sourceRoot,
      commit: source.commit,
      ...(logRoot === undefined ? {} : { logRoot }),
    },
  );

  const baseline: HttpBaseline = {
    schemaVersion: 1,
    source,
    contracts,
    deferred: plan.deferred,
  };
  assertHttpBaselineCoverage(manifest, baseline);
  return baseline;
}

export async function captureHttpBaseline(
  args: string[],
  options: CaptureHttpBaselineOptions = {},
): Promise<HttpBaseline> {
  const mode = parseMode(args);
  const root = resolve(options.root ?? process.cwd());
  const manifest = await readManifest(root);
  const contractsPath = resolve(root, "parity", "http-contracts.json");

  if (mode === "--check") {
    const baseline = JSON.parse(
      await readFile(contractsPath, "utf8"),
    ) as HttpBaseline;
    assertHttpBaselineCoverage(manifest, baseline);
    assert.deepEqual(
      JSON.parse(serializeHttpBaseline(baseline)),
      baseline,
      "parity/http-contracts.json no está serializado de forma determinista",
    );
    process.stdout.write(
      `HTTP_BASELINE_OK ${baseline.contracts.length} ${baseline.deferred.length}\n`,
    );
    return baseline;
  }

  const sourceRoot = await resolveSourceRoot(options.sourceRoot);
  const source = await assertSourcePristine(sourceRoot);
  assertManifestSource(manifest, source);
  try {
    const baseline = await createBaseline(
      manifest,
      sourceRoot,
      source,
      root,
      options.logRoot,
    );
    await writeFile(contractsPath, serializeHttpBaseline(baseline));
    process.stdout.write(
      `HTTP_BASELINE_WRITTEN ${baseline.contracts.length} ${baseline.deferred.length}\n`,
    );
    return baseline;
  } finally {
    await assertSourcePristine(sourceRoot);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  captureHttpBaseline(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
