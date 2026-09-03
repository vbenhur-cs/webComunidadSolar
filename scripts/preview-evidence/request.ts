import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseSafeYaml } from "../../src/ingest/importers/common.ts";
import {
  EVIDENCE_REQUEST_PATH,
  PRIVATE_ROUTE_PREFIXES,
  type AllowedHttpStatus,
  type EvidenceRequest,
  type EvidenceScope,
} from "./domain.ts";

const maxRequestBytes = 64 * 1024;
const allowedStatuses = new Set<AllowedHttpStatus>([
  200, 301, 302, 307, 308, 404, 410,
]);
const allowedRootKeys = new Set([
  "schema_version",
  "issue",
  "scope",
  "route",
  "selector",
  "expected_status",
  "viewports",
]);
const stableSelector =
  /^(?:#[a-z][a-z0-9_-]{0,158}|\.[a-z][a-z0-9_-]{0,158}|\[data-evidence-id='[a-z0-9]+(?:-[a-z0-9]+)*'\])$/u;
const publicRoute = /^\/(?:[a-z0-9][a-z0-9-]*\/)*$/u;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`El ${label} contiene un campo fuera del schema`);
  }
}

function requireIssue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError("La issue de evidencia es inválida");
  }
  return value as number;
}

function requireScope(value: unknown): EvidenceScope {
  if (value !== "page" && value !== "section") {
    throw new TypeError("El scope de evidencia es inválido");
  }
  return value;
}

function requireRoute(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    !publicRoute.test(value)
  ) {
    throw new TypeError("La ruta de evidencia no es un path público canónico");
  }
  if (
    PRIVATE_ROUTE_PREFIXES.some(
      (prefix) => value === `${prefix}/` || value.startsWith(`${prefix}/`),
    )
  ) {
    throw new TypeError("La ruta de evidencia debe ser pública");
  }
  return value;
}

function requireStatus(value: unknown): AllowedHttpStatus {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !allowedStatuses.has(value as AllowedHttpStatus)
  ) {
    throw new TypeError("El estado HTTP de evidencia es inválido");
  }
  return value as AllowedHttpStatus;
}

function requireExpectedStatus(
  value: unknown,
): EvidenceRequest["expectedStatus"] {
  if (!isRecord(value)) {
    throw new TypeError("El estado HTTP de evidencia es inválido");
  }
  assertExactKeys(value, new Set(["base", "candidate"]), "estado HTTP");
  if (!Object.hasOwn(value, "base") || !Object.hasOwn(value, "candidate")) {
    throw new TypeError("El estado HTTP de evidencia es incompleto");
  }
  return {
    base: requireStatus(value.base),
    candidate: requireStatus(value.candidate),
  };
}

function requireViewports(value: unknown): EvidenceRequest["viewports"] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== "desktop" ||
    value[1] !== "mobile"
  ) {
    throw new TypeError("Los viewports deben ser exactamente desktop y mobile");
  }
  return ["desktop", "mobile"];
}

function requireSelector(
  value: unknown,
  scope: EvidenceScope,
  supplied: boolean,
): string | null {
  if (scope === "page") {
    if (supplied && value !== null) {
      throw new TypeError("Una evidencia page no admite selector");
    }
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    !stableSelector.test(value)
  ) {
    throw new TypeError("El selector de evidencia es inválido");
  }
  return value;
}

function issueFromPath(requestPath: string): number {
  const normalized = requestPath.replaceAll("\\", "/");
  if (normalized !== requestPath || isAbsolute(requestPath)) {
    throw new TypeError("El path de la solicitud de evidencia es inválido");
  }
  const match = EVIDENCE_REQUEST_PATH.exec(requestPath);
  if (!match) {
    throw new TypeError("El path de la solicitud de evidencia es inválido");
  }
  return Number(match[1]);
}

export function parseEvidenceRequest(
  contents: string,
  requestPath: string,
): EvidenceRequest {
  if (Buffer.byteLength(contents, "utf8") > maxRequestBytes) {
    throw new RangeError("La solicitud de evidencia supera 64 KiB");
  }
  const pathIssue = issueFromPath(requestPath);
  const parsed = parseSafeYaml(contents);
  return validateEvidenceRequestValue(parsed, requestPath, pathIssue);
}

export function validateEvidenceRequestValue(
  parsed: unknown,
  requestPath: string,
  knownPathIssue = issueFromPath(requestPath),
): EvidenceRequest {
  if (!isRecord(parsed)) {
    throw new TypeError("La solicitud de evidencia debe ser un objeto YAML");
  }
  assertExactKeys(parsed, allowedRootKeys, "request de evidencia");
  if (
    parsed.schema_version !== 1 ||
    !Object.hasOwn(parsed, "issue") ||
    !Object.hasOwn(parsed, "scope") ||
    !Object.hasOwn(parsed, "route") ||
    !Object.hasOwn(parsed, "expected_status") ||
    !Object.hasOwn(parsed, "viewports")
  ) {
    throw new TypeError("La solicitud de evidencia no cumple el schema");
  }
  const issue = requireIssue(parsed.issue);
  if (issue !== knownPathIssue) {
    throw new TypeError("La issue no coincide con el path de evidencia");
  }
  const scope = requireScope(parsed.scope);
  return {
    schemaVersion: 1,
    issue,
    scope,
    route: requireRoute(parsed.route),
    selector: requireSelector(
      parsed.selector,
      scope,
      Object.hasOwn(parsed, "selector"),
    ),
    expectedStatus: requireExpectedStatus(parsed.expected_status),
    viewports: requireViewports(parsed.viewports),
  };
}

export function validateNormalizedEvidenceRequest(
  value: unknown,
  requestPath: string,
): EvidenceRequest {
  if (!isRecord(value)) {
    throw new TypeError("El request normalizado debe ser un objeto");
  }
  const normalizedKeys = new Set([
    "schemaVersion",
    "issue",
    "scope",
    "route",
    "selector",
    "expectedStatus",
    "viewports",
  ]);
  assertExactKeys(value, normalizedKeys, "request normalizado");
  if (!isRecord(value.expectedStatus)) {
    throw new TypeError("El estado HTTP normalizado es inválido");
  }
  assertExactKeys(
    value.expectedStatus,
    new Set(["base", "candidate"]),
    "estado HTTP normalizado",
  );
  return validateEvidenceRequestValue(
    {
      schema_version: value.schemaVersion,
      issue: value.issue,
      scope: value.scope,
      route: value.route,
      selector: value.selector,
      expected_status: value.expectedStatus,
      viewports: value.viewports,
    },
    requestPath,
  );
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function assertNoSymlinkPath(
  root: string,
  candidate: string,
): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new TypeError("El root de evidencia debe ser un directorio regular");
  }
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new TypeError("La solicitud de evidencia no puede ser un symlink");
    }
  }
}

export async function loadEvidenceRequest(
  requestPath: string,
  root = process.cwd(),
): Promise<EvidenceRequest> {
  issueFromPath(requestPath);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, requestPath);
  if (!isInside(resolvedRoot, resolvedPath)) {
    throw new TypeError("El path de la solicitud de evidencia es inválido");
  }
  await assertNoSymlinkPath(resolvedRoot, resolvedPath);
  const stat = await lstat(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new TypeError(
      "La solicitud de evidencia debe ser un archivo regular",
    );
  }
  if (stat.size > maxRequestBytes) {
    throw new RangeError("La solicitud de evidencia supera 64 KiB");
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxRequestBytes) {
      throw new TypeError(
        "La solicitud de evidencia debe ser un archivo regular",
      );
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    return parseEvidenceRequest(contents, requestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError("La solicitud de evidencia no puede ser un symlink");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
