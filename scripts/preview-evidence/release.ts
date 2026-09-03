import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { prepareCloudflareConfig } from "../prepare-cloudflare-config.ts";
import {
  validateProductionRollbackDescriptor,
  validateProductionVersionDescriptor,
  type ProductionRollbackDescriptor,
  type ProductionVersionDescriptor,
} from "./cloudflare.ts";
import {
  canonicalJson,
  EVIDENCE_REQUEST_PATH,
  PRIVATE_ROUTE_PREFIXES,
  sha256,
  type AllowedHttpStatus,
} from "./domain.ts";
import { validateCaptureManifest } from "./evidence.ts";
import type { GitHubApi } from "./github.ts";

type JsonRecord = Record<string, unknown>;

export interface ProductionReleaseInput {
  enabled: string | undefined;
  repository: string;
  sourceSha: string;
  runId: number;
  runUrl: string;
}

export interface ProductionReleaseContext {
  schemaVersion: 1;
  repository: string;
  runId: number;
  runUrl: string;
  sourceSha: string;
  prNumber: number;
  prUrl: string;
  issueNumber: number;
  requestPath: string;
  route: string;
  expectedStatus: AllowedHttpStatus;
  previewApprovedSha: string;
  releaseManifestPath: string;
  releaseManifestSha256: string;
  releaseVersionId: string;
}

export interface ProductionHttpResult {
  status: number;
  finalUrl: string;
}

export type ProductionHttpAdapter = (
  url: string,
) => Promise<ProductionHttpResult>;

export interface ProductionSmokeRecord {
  schemaVersion: 1;
  kind: "production";
  repository: string;
  issueNumber: number;
  prNumber: number;
  sourceSha: string;
  requestPath: string;
  route: string;
  expectedStatus: AllowedHttpStatus;
  productionUrl: string;
  status: AllowedHttpStatus;
  checkedAt: string;
  run: { id: number; url: string; attempt: number };
  cloudflare: {
    workerName: "comunidad-solar-production";
    versionId: string;
    tag: string;
  };
  releaseEvidence: {
    manifestPath: string;
    manifestSha256: string;
    versionId: string;
  };
  rollback: {
    previousDeploymentId: string;
    previousVersions: Array<{ versionId: string; percentage: number }>;
    newDeploymentId: string;
    newVersionId: string;
  };
}

export interface ProductionSmokeInput {
  context: ProductionReleaseContext;
  descriptor: ProductionVersionDescriptor;
  rollback: ProductionRollbackDescriptor;
  configuredOrigin: string;
  runAttempt: number;
}

const gitShaPattern = /^[a-f0-9]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const maxManifestBytes = 256 * 1024;
const maxProfileBytes = 64 * 1024;
const maxContextBytes = 128 * 1024;
const maxSmokeBytes = 128 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedStatuses = new Set<number>([200, 301, 302, 307, 308, 404, 410]);

export interface ProductionProfileArtifact {
  path: string;
  sha256: string;
  workerName: "comunidad-solar-production";
  databaseName: "comunidad-solar-production";
  databaseId: string;
  indexable: true;
}

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
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} contiene campos no permitidos`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maxLength = 2048,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} es inválido`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} debe ser un entero positivo`);
  }
  return value as number;
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function ensureSafeOutputDirectory(
  projectRoot: string,
  outputRoot: string,
): Promise<void> {
  const project = resolve(projectRoot);
  const output = resolve(outputRoot);
  if (!inside(project, output)) {
    throw new TypeError(
      "El directorio del perfil production debe estar dentro del proyecto",
    );
  }
  const projectStat = await lstat(project);
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    throw new TypeError("El proyecto del perfil production es inválido");
  }
  let current = project;
  for (const part of relative(project, output).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TypeError(
          "El directorio del perfil production no admite symlinks",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function decodeProductionProfile(encoded: string): Buffer {
  const normalized = encoded.trim();
  if (
    normalized.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      normalized,
    )
  ) {
    throw new TypeError("El perfil production debe usar base64 canónico");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (
    decoded.length > maxProfileBytes ||
    decoded.toString("base64") !== normalized
  ) {
    throw new RangeError("El perfil production supera 64 KiB o no es canónico");
  }
  return decoded;
}

export async function materializeProductionProfile(
  encoded: string,
  outputRoot: string,
  projectRoot: string,
): Promise<ProductionProfileArtifact> {
  const project = resolve(projectRoot);
  const output = resolve(outputRoot);
  await ensureSafeOutputDirectory(project, output);
  const decoded = decodeProductionProfile(encoded);
  const temporaryPath = resolve(
    output,
    `.production-operator-${randomUUID()}.jsonc`,
  );
  if (!inside(output, temporaryPath)) {
    throw new TypeError("El temporal del perfil production salió de artifacts");
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let sanitizedPath: string | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(decoded);
    await handle.close();
    handle = undefined;

    const prepared = await prepareCloudflareConfig(temporaryPath, undefined, {
      projectRoot: project,
      artifactRoot: resolve(output, "config"),
    });
    sanitizedPath = prepared.outputPath;
    if (
      !prepared.indexable ||
      prepared.destination.workerName !== "comunidad-solar-production" ||
      prepared.destination.database.name !== "comunidad-solar-production"
    ) {
      throw new Error(
        "El perfil production requiere SITE_INDEXABLE=true y destinos production aprobados",
      );
    }
    return {
      path: prepared.outputPath,
      sha256: prepared.sha256,
      workerName: "comunidad-solar-production",
      databaseName: "comunidad-solar-production",
      databaseId: prepared.destination.database.id,
      indexable: true,
    };
  } catch (error) {
    if (sanitizedPath !== undefined) {
      await rm(sanitizedPath, { force: true });
      try {
        await rmdir(dirname(sanitizedPath));
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
          throw new AggregateError(
            [error, cleanupError],
            "No se pudo limpiar el perfil production inválido",
          );
        }
      }
    }
    throw error;
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

function githubUrl(
  value: unknown,
  repository: string,
  expectedPath: string,
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(boundedString(value, label));
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
    url.pathname !== `/${repository}/${expectedPath}`
  ) {
    throw new TypeError(`${label} es inválida`);
  }
  return url.toString();
}

function githubActionsRunUrl(
  value: unknown,
  repository: string,
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(boundedString(value, label));
  } catch {
    throw new TypeError(`${label} es inválida`);
  }
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !new RegExp(
      `^/${escapedRepository}/actions/runs/[1-9][0-9]*(?:/job/[1-9][0-9]*)?$`,
      "u",
    ).test(url.pathname)
  ) {
    throw new TypeError(`${label} debe identificar un run de GitHub Actions`);
  }
  return url.toString();
}

export function validateProductionReleaseContext(
  value: unknown,
): ProductionReleaseContext {
  const context = record(value, "El contexto production");
  exactKeys(
    context,
    [
      "schemaVersion",
      "repository",
      "runId",
      "runUrl",
      "sourceSha",
      "prNumber",
      "prUrl",
      "issueNumber",
      "requestPath",
      "route",
      "expectedStatus",
      "previewApprovedSha",
      "releaseManifestPath",
      "releaseManifestSha256",
      "releaseVersionId",
    ],
    "El contexto production",
  );
  const repository = boundedString(
    context.repository,
    "El repositorio production",
  );
  if (!repositoryPattern.test(repository)) {
    throw new TypeError("El repositorio production es inválido");
  }
  const runId = positiveInteger(context.runId, "El run ID production");
  const sourceSha = boundedString(context.sourceSha, "El SHA production", 40);
  const previewApprovedSha = boundedString(
    context.previewApprovedSha,
    "El SHA aprobado",
    40,
  );
  const prNumber = positiveInteger(context.prNumber, "La PR production");
  const issueNumber = positiveInteger(
    context.issueNumber,
    "La issue production",
  );
  const requestPath = boundedString(
    context.requestPath,
    "El request path production",
  );
  const requestMatch = EVIDENCE_REQUEST_PATH.exec(requestPath);
  const route = boundedString(context.route, "La route production");
  validateReleaseRoute(route);
  const expectedManifestPath = `issue-${issueNumber}/releases/${sourceSha}/manifest.json`;
  if (
    context.schemaVersion !== 1 ||
    !gitShaPattern.test(sourceSha) ||
    !gitShaPattern.test(previewApprovedSha) ||
    requestMatch === null ||
    Number(requestMatch[1]) !== issueNumber ||
    !allowedStatuses.has(context.expectedStatus as number) ||
    context.releaseManifestPath !== expectedManifestPath ||
    typeof context.releaseManifestSha256 !== "string" ||
    !sha256Pattern.test(context.releaseManifestSha256) ||
    typeof context.releaseVersionId !== "string" ||
    !uuidPattern.test(context.releaseVersionId)
  ) {
    throw new TypeError("La identidad del contexto production es inválida");
  }
  return {
    schemaVersion: 1,
    repository,
    runId,
    runUrl: githubUrl(
      context.runUrl,
      repository,
      `actions/runs/${runId}`,
      "La URL del run production",
    ),
    sourceSha,
    prNumber,
    prUrl: githubUrl(
      context.prUrl,
      repository,
      `pull/${prNumber}`,
      "La URL de la PR production",
    ),
    issueNumber,
    requestPath,
    route,
    expectedStatus: context.expectedStatus as AllowedHttpStatus,
    previewApprovedSha,
    releaseManifestPath: expectedManifestPath,
    releaseManifestSha256: context.releaseManifestSha256,
    releaseVersionId: context.releaseVersionId,
  };
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > maxBytes
  ) {
    throw new TypeError(`${label} debe ser un archivo regular acotado`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== stat.size) {
      throw new TypeError(`${label} cambió durante la lectura`);
    }
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}

async function writeCanonicalExclusive(
  path: string,
  value: unknown,
): Promise<Buffer> {
  const contents = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new TypeError("El directorio del artefacto production es inválido");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents);
  } finally {
    await handle?.close();
  }
  return contents;
}

export async function writeProductionReleaseContext(
  path: string,
  value: ProductionReleaseContext,
): Promise<{ path: string; sha256: string }> {
  const context = validateProductionReleaseContext(value);
  const contents = await writeCanonicalExclusive(path, context);
  if (contents.length > maxContextBytes) {
    await rm(path, { force: true });
    throw new RangeError("El contexto production supera el tamaño máximo");
  }
  return { path, sha256: sha256(contents) };
}

export async function readProductionReleaseContext(
  path: string,
  expectedSha256: string,
): Promise<ProductionReleaseContext> {
  if (!sha256Pattern.test(expectedSha256)) {
    throw new TypeError("El hash del contexto production es inválido");
  }
  const contents = await readBoundedRegularFile(
    path,
    maxContextBytes,
    "El contexto production",
  );
  if (sha256(contents) !== expectedSha256) {
    throw new Error("Falló la integridad hash del contexto production");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new TypeError("El contexto production contiene JSON inválido");
  }
  const context = validateProductionReleaseContext(parsed);
  if (!contents.equals(Buffer.from(`${canonicalJson(context)}\n`, "utf8"))) {
    throw new TypeError("El contexto production no es JSON canónico");
  }
  return context;
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeCanonicalManifest(
  value: unknown,
  expectedPath: string,
): { parsed: unknown; bytes: Buffer } {
  const content = record(value, "El content de evidencia");
  if (
    content.type !== "file" ||
    content.path !== expectedPath ||
    content.encoding !== "base64" ||
    !Number.isSafeInteger(content.size) ||
    (content.size as number) < 1 ||
    (content.size as number) > maxManifestBytes ||
    typeof content.content !== "string" ||
    typeof content.sha !== "string" ||
    !gitShaPattern.test(content.sha)
  ) {
    throw new TypeError("El manifest de evidencia publicado es inválido");
  }
  const encoded = content.content.replace(/[\r\n]/gu, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw new TypeError("El manifest de evidencia no contiene base64 válido");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length !== content.size ||
    bytes.length > maxManifestBytes ||
    bytes.toString("base64") !== encoded
  ) {
    throw new TypeError("El manifest de evidencia tiene un tamaño inválido");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("El manifest de evidencia contiene JSON inválido");
  }
  if (!bytes.equals(Buffer.from(`${canonicalJson(parsed)}\n`, "utf8"))) {
    throw new TypeError("El manifest de evidencia no es JSON canónico");
  }
  return { parsed, bytes };
}

async function pullRequestFiles(
  api: GitHubApi,
  repository: string,
  prNumber: number,
  expectedCount: number,
): Promise<Array<{ filename: string; status: string }>> {
  if (expectedCount < 1 || expectedCount > 300) {
    throw new TypeError("La PR debe cambiar entre 1 y 300 archivos");
  }
  const files: Array<{ filename: string; status: string }> = [];
  for (let page = 1; page <= 3 && files.length < expectedCount; page += 1) {
    const response = await api.get(
      `/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(response) || response.length > 100) {
      throw new TypeError("GitHub devolvió archivos de PR inválidos");
    }
    for (const value of response) {
      const file = record(value, "Un archivo de la PR");
      files.push({
        filename: boundedString(file.filename, "El filename de PR"),
        status: boundedString(file.status, "El status de archivo"),
      });
    }
    if (response.length < 100) break;
  }
  if (files.length !== expectedCount) {
    throw new TypeError("GitHub devolvió un inventario de PR incompleto");
  }
  return files;
}

function validateReleaseRoute(route: string): void {
  if (
    !route.startsWith("/") ||
    route.includes("//") ||
    route.includes("?") ||
    route.includes("#") ||
    route.includes("\\") ||
    route.split("/").some((part) => part === "." || part === "..") ||
    PRIVATE_ROUTE_PREFIXES.some(
      (prefix) => route === prefix || route.startsWith(`${prefix}/`),
    )
  ) {
    throw new TypeError("La route del manifest no es publicable");
  }
}

export async function authorizeProductionRelease(
  input: ProductionReleaseInput,
  api: GitHubApi,
): Promise<ProductionReleaseContext> {
  if (input.enabled !== "true") {
    throw new Error(
      "Producción está cerrada: PRODUCTION_ENABLED debe ser literalmente true",
    );
  }
  if (!repositoryPattern.test(input.repository)) {
    throw new TypeError("El repositorio de producción es inválido");
  }
  if (!gitShaPattern.test(input.sourceSha)) {
    throw new TypeError("El SHA solicitado para producción es inválido");
  }
  const runId = positiveInteger(input.runId, "El run ID de producción");
  const runUrl = githubUrl(
    input.runUrl,
    input.repository,
    `actions/runs/${runId}`,
    "La URL del run de producción",
  );

  const comparison = record(
    await api.get(
      `/repos/${input.repository}/compare/${input.sourceSha}...main`,
    ),
    "La comparación con main",
  );
  const mergeBase = record(
    comparison.merge_base_commit,
    "El ancestro común con main",
  );
  if (
    (comparison.status !== "ahead" && comparison.status !== "identical") ||
    mergeBase.sha !== input.sourceSha
  ) {
    throw new Error("El SHA solicitado no es alcanzable desde main");
  }

  const associations = await api.get(
    `/repos/${input.repository}/commits/${input.sourceSha}/pulls?per_page=100`,
  );
  if (!Array.isArray(associations) || associations.length !== 1) {
    throw new TypeError(
      "El SHA debe pertenecer a exactamente una Pull Request fusionada",
    );
  }
  const association = record(associations[0], "La PR asociada");
  const prNumber = positiveInteger(association.number, "El número de PR");
  const pr = record(
    await api.get(`/repos/${input.repository}/pulls/${prNumber}`),
    "La Pull Request fusionada",
  );
  const head = record(pr.head, "El head de la Pull Request");
  const headRepo = record(head.repo, "El repositorio head de la Pull Request");
  const base = record(pr.base, "La base de la Pull Request");
  const candidateSha = boundedString(head.sha, "El SHA candidate", 40);
  if (
    pr.number !== prNumber ||
    pr.state !== "closed" ||
    pr.merged !== true ||
    typeof pr.merged_at !== "string" ||
    !Number.isFinite(Date.parse(pr.merged_at)) ||
    pr.merge_commit_sha !== input.sourceSha ||
    base.ref !== "main" ||
    headRepo.full_name !== input.repository ||
    !gitShaPattern.test(candidateSha)
  ) {
    throw new TypeError(
      "La Pull Request de producción no es una fusión interna válida a main",
    );
  }
  const prUrl = githubUrl(
    pr.html_url,
    input.repository,
    `pull/${prNumber}`,
    "La URL de la Pull Request",
  );
  const files = await pullRequestFiles(
    api,
    input.repository,
    prNumber,
    positiveInteger(pr.changed_files, "El número de archivos de la PR"),
  );
  if (files.some((file) => file.filename.startsWith("drizzle/"))) {
    throw new TypeError(
      "Una PR con migraciones drizzle requiere un flujo de producción separado",
    );
  }
  const requests = files.filter((file) =>
    EVIDENCE_REQUEST_PATH.test(file.filename),
  );
  if (
    requests.length !== 1 ||
    (requests[0].status !== "added" && requests[0].status !== "modified")
  ) {
    throw new TypeError(
      "La PR de producción debe cambiar exactamente una solicitud de evidencia",
    );
  }
  const requestPath = requests[0].filename;
  const match = EVIDENCE_REQUEST_PATH.exec(requestPath);
  if (match === null) {
    throw new TypeError("El request path de evidencia es inválido");
  }
  const issueNumber = Number(match[1]);
  const releaseManifestPath = `issue-${issueNumber}/releases/${input.sourceSha}/manifest.json`;
  const rawManifest = decodeCanonicalManifest(
    await api.get(
      `/repos/${input.repository}/contents/${encodedPath(releaseManifestPath)}?ref=evidence`,
    ),
    releaseManifestPath,
  );
  let manifest: ReturnType<typeof validateCaptureManifest>;
  try {
    manifest = validateCaptureManifest(rawManifest.parsed);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new TypeError(`El manifest release es inválido${detail}`);
  }
  if (
    manifest.kind !== "release" ||
    manifest.issue !== issueNumber ||
    manifest.prNumber !== prNumber ||
    manifest.requestPath !== requestPath ||
    manifest.source.baseSha !== null ||
    manifest.source.candidateSha !== null ||
    manifest.source.releaseSha !== input.sourceSha
  ) {
    throw new TypeError(
      "El manifest release no coincide con el SHA, la PR o la issue autorizada",
    );
  }
  validateReleaseRoute(manifest.route);
  const releaseCaptures = manifest.captures.filter(
    (capture) => capture.role === "release",
  );
  if (
    releaseCaptures.length === 0 ||
    releaseCaptures.some(
      (capture) =>
        capture.sourceSha !== input.sourceSha ||
        capture.status !== releaseCaptures[0].status ||
        capture.versionId !== releaseCaptures[0].versionId,
    )
  ) {
    throw new TypeError("Las capturas release del manifest son inconsistentes");
  }

  const combinedStatus = record(
    await api.get(
      `/repos/${input.repository}/commits/${candidateSha}/status?per_page=100`,
    ),
    "El status combinado de preview",
  );
  if (
    combinedStatus.sha !== candidateSha ||
    !Array.isArray(combinedStatus.statuses)
  ) {
    throw new TypeError("GitHub devolvió un status de preview inválido");
  }
  if (combinedStatus.statuses.length > 100) {
    throw new RangeError("GitHub devolvió demasiados status de preview");
  }
  const latestApproval = combinedStatus.statuses.find((value) => {
    return isRecord(value) && value.context === "preview-approved";
  });
  if (!isRecord(latestApproval) || latestApproval.state !== "success") {
    throw new Error(
      "El último status preview-approved del candidate no es success",
    );
  }
  githubActionsRunUrl(
    latestApproval.target_url,
    input.repository,
    "La URL de aprobación",
  );

  return {
    schemaVersion: 1,
    repository: input.repository,
    runId,
    runUrl,
    sourceSha: input.sourceSha,
    prNumber,
    prUrl,
    issueNumber,
    requestPath,
    route: manifest.route,
    expectedStatus: releaseCaptures[0].status as AllowedHttpStatus,
    previewApprovedSha: candidateSha,
    releaseManifestPath,
    releaseManifestSha256: sha256(rawManifest.bytes),
    releaseVersionId: releaseCaptures[0].versionId,
  };
}

export async function reauthorizeProductionRelease(
  value: ProductionReleaseContext,
  enabled: string | undefined,
  api: GitHubApi,
): Promise<ProductionReleaseContext> {
  const context = validateProductionReleaseContext(value);
  const current = await authorizeProductionRelease(
    {
      enabled,
      repository: context.repository,
      sourceSha: context.sourceSha,
      runId: context.runId,
      runUrl: context.runUrl,
    },
    api,
  );
  if (canonicalJson(current) !== canonicalJson(context)) {
    throw new Error(
      "La autorización production cambió desde el contexto sellado",
    );
  }
  return current;
}

export function validateProductionUrl(
  configuredOrigin: string,
  candidateUrl: string,
): string {
  let origin: URL;
  let candidate: URL;
  try {
    origin = new URL(configuredOrigin);
    candidate = new URL(candidateUrl);
  } catch {
    throw new TypeError("La URL de producción es inválida");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.port !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.hostname.length === 0 ||
    candidate.protocol !== "https:" ||
    candidate.origin !== origin.origin ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.port !== "" ||
    candidate.search !== "" ||
    candidate.hash !== "" ||
    !candidate.pathname.startsWith("/") ||
    candidate.pathname.includes("//")
  ) {
    throw new TypeError(
      "La URL de producción debe permanecer en el origen HTTPS configurado",
    );
  }
  return candidate.toString();
}

const defaultProductionHttpAdapter: ProductionHttpAdapter = async (url) => {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "comunidad-solar-production-smoke/1" },
  });
  const result = { status: response.status, finalUrl: response.url };
  await response.body?.cancel();
  return result;
};

export async function smokeProduction(
  input: ProductionSmokeInput,
  adapter: ProductionHttpAdapter = defaultProductionHttpAdapter,
  now: () => Date = () => new Date(),
): Promise<ProductionSmokeRecord> {
  const context = validateProductionReleaseContext(input.context);
  const descriptor = validateProductionVersionDescriptor(input.descriptor);
  const rollback = validateProductionRollbackDescriptor(input.rollback);
  const runAttempt = positiveInteger(
    input.runAttempt,
    "El intento del smoke production",
  );
  if (
    descriptor.sourceSha !== context.sourceSha ||
    rollback.sourceSha !== context.sourceSha ||
    rollback.newVersionId !== descriptor.versionId ||
    rollback.runUrl !== context.runUrl
  ) {
    throw new TypeError(
      "El contexto, la versión y el rollback production no coinciden",
    );
  }
  const origin = validateProductionUrl(
    input.configuredOrigin,
    input.configuredOrigin,
  );
  const productionUrl = validateProductionUrl(
    origin,
    new URL(context.route, origin).toString(),
  );
  const response = await adapter(productionUrl);
  if (
    !isRecord(response) ||
    !Number.isSafeInteger(response.status) ||
    response.status !== context.expectedStatus ||
    response.finalUrl !== productionUrl ||
    validateProductionUrl(origin, response.finalUrl) !== productionUrl
  ) {
    throw new Error(
      "El smoke production no confirmó la URL y el status esperados",
    );
  }
  const checkedAt = now().toISOString();
  return {
    schemaVersion: 1,
    kind: "production",
    repository: context.repository,
    issueNumber: context.issueNumber,
    prNumber: context.prNumber,
    sourceSha: context.sourceSha,
    requestPath: context.requestPath,
    route: context.route,
    expectedStatus: context.expectedStatus,
    productionUrl,
    status: response.status as AllowedHttpStatus,
    checkedAt,
    run: { id: context.runId, url: context.runUrl, attempt: runAttempt },
    cloudflare: {
      workerName: descriptor.workerName,
      versionId: descriptor.versionId,
      tag: descriptor.tag,
    },
    releaseEvidence: {
      manifestPath: context.releaseManifestPath,
      manifestSha256: context.releaseManifestSha256,
      versionId: context.releaseVersionId,
    },
    rollback: {
      previousDeploymentId: rollback.previousDeploymentId,
      previousVersions: rollback.previousVersions,
      newDeploymentId: rollback.newDeploymentId,
      newVersionId: rollback.newVersionId,
    },
  };
}

export function validateProductionSmokeRecord(
  value: unknown,
): ProductionSmokeRecord {
  const smoke = record(value, "El manifest production");
  exactKeys(
    smoke,
    [
      "schemaVersion",
      "kind",
      "repository",
      "issueNumber",
      "prNumber",
      "sourceSha",
      "requestPath",
      "route",
      "expectedStatus",
      "productionUrl",
      "status",
      "checkedAt",
      "run",
      "cloudflare",
      "releaseEvidence",
      "rollback",
    ],
    "El manifest production",
  );
  const repository = boundedString(
    smoke.repository,
    "El repositorio production",
  );
  const sourceSha = boundedString(smoke.sourceSha, "El SHA production", 40);
  const issueNumber = positiveInteger(smoke.issueNumber, "La issue production");
  const prNumber = positiveInteger(smoke.prNumber, "La PR production");
  const requestPath = boundedString(smoke.requestPath, "El request production");
  const requestMatch = EVIDENCE_REQUEST_PATH.exec(requestPath);
  const route = boundedString(smoke.route, "La route production");
  validateReleaseRoute(route);
  if (
    smoke.schemaVersion !== 1 ||
    smoke.kind !== "production" ||
    !repositoryPattern.test(repository) ||
    !gitShaPattern.test(sourceSha) ||
    requestMatch === null ||
    Number(requestMatch[1]) !== issueNumber ||
    !allowedStatuses.has(smoke.expectedStatus as number) ||
    smoke.status !== smoke.expectedStatus
  ) {
    throw new TypeError("La identidad del manifest production es inválida");
  }
  const run = record(smoke.run, "El run del manifest production");
  exactKeys(run, ["id", "url", "attempt"], "El run del manifest production");
  const runId = positiveInteger(run.id, "El run ID production");
  const runAttempt = positiveInteger(run.attempt, "El intento production");
  const runUrl = githubUrl(
    run.url,
    repository,
    `actions/runs/${runId}`,
    "La URL del run production",
  );
  const cloudflare = record(
    smoke.cloudflare,
    "Cloudflare del manifest production",
  );
  exactKeys(
    cloudflare,
    ["workerName", "versionId", "tag"],
    "Cloudflare del manifest production",
  );
  const descriptor = validateProductionVersionDescriptor({
    schemaVersion: 1,
    sourceSha,
    bundleSha256: "0".repeat(64),
    workerName: cloudflare.workerName,
    versionId: cloudflare.versionId,
    tag: cloudflare.tag,
  });
  const releaseEvidence = record(
    smoke.releaseEvidence,
    "La evidencia release del manifest production",
  );
  exactKeys(
    releaseEvidence,
    ["manifestPath", "manifestSha256", "versionId"],
    "La evidencia release del manifest production",
  );
  const expectedReleasePath = `issue-${issueNumber}/releases/${sourceSha}/manifest.json`;
  if (
    releaseEvidence.manifestPath !== expectedReleasePath ||
    typeof releaseEvidence.manifestSha256 !== "string" ||
    !sha256Pattern.test(releaseEvidence.manifestSha256) ||
    typeof releaseEvidence.versionId !== "string" ||
    !uuidPattern.test(releaseEvidence.versionId)
  ) {
    throw new TypeError(
      "La evidencia release del manifest production es inválida",
    );
  }
  const rollback = record(
    smoke.rollback,
    "El rollback del manifest production",
  );
  exactKeys(
    rollback,
    [
      "previousDeploymentId",
      "previousVersions",
      "newDeploymentId",
      "newVersionId",
    ],
    "El rollback del manifest production",
  );
  const validatedRollback = validateProductionRollbackDescriptor({
    schemaVersion: 1,
    workerName: descriptor.workerName,
    sourceSha,
    previousDeploymentId: rollback.previousDeploymentId,
    previousVersions: rollback.previousVersions,
    newDeploymentId: rollback.newDeploymentId,
    newVersionId: rollback.newVersionId,
    runUrl,
  });
  if (validatedRollback.newVersionId !== descriptor.versionId) {
    throw new TypeError("El rollback no coincide con la versión production");
  }
  const rawUrl = boundedString(smoke.productionUrl, "La URL production");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new TypeError("La URL production es inválida");
  }
  const productionUrl = validateProductionUrl(`${parsedUrl.origin}/`, rawUrl);
  if (parsedUrl.pathname !== route) {
    throw new TypeError("La URL production no coincide con la route");
  }
  const checkedAt = boundedString(smoke.checkedAt, "La fecha del smoke", 64);
  const checkedDate = new Date(checkedAt);
  if (
    !Number.isFinite(checkedDate.valueOf()) ||
    checkedDate.toISOString() !== checkedAt
  ) {
    throw new TypeError("La fecha del smoke production no es UTC canónica");
  }
  return {
    schemaVersion: 1,
    kind: "production",
    repository,
    issueNumber,
    prNumber,
    sourceSha,
    requestPath,
    route,
    expectedStatus: smoke.expectedStatus as AllowedHttpStatus,
    productionUrl,
    status: smoke.status as AllowedHttpStatus,
    checkedAt,
    run: { id: runId, url: runUrl, attempt: runAttempt },
    cloudflare: {
      workerName: descriptor.workerName,
      versionId: descriptor.versionId,
      tag: descriptor.tag,
    },
    releaseEvidence: {
      manifestPath: expectedReleasePath,
      manifestSha256: releaseEvidence.manifestSha256,
      versionId: releaseEvidence.versionId,
    },
    rollback: {
      previousDeploymentId: validatedRollback.previousDeploymentId,
      previousVersions: validatedRollback.previousVersions,
      newDeploymentId: validatedRollback.newDeploymentId,
      newVersionId: validatedRollback.newVersionId,
    },
  };
}

export async function writeProductionSmokeRecord(
  path: string,
  value: ProductionSmokeRecord,
): Promise<{ path: string; sha256: string }> {
  const smoke = validateProductionSmokeRecord(value);
  const contents = await writeCanonicalExclusive(path, smoke);
  if (contents.length > maxSmokeBytes) {
    await rm(path, { force: true });
    throw new RangeError("El manifest production supera el tamaño máximo");
  }
  return { path, sha256: sha256(contents) };
}

export async function readProductionSmokeRecord(
  path: string,
): Promise<ProductionSmokeRecord> {
  const contents = await readBoundedRegularFile(
    path,
    maxSmokeBytes,
    "El manifest production",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new TypeError("El manifest production contiene JSON inválido");
  }
  const smoke = validateProductionSmokeRecord(parsed);
  if (!contents.equals(Buffer.from(`${canonicalJson(smoke)}\n`, "utf8"))) {
    throw new TypeError("El manifest production no es JSON canónico");
  }
  return smoke;
}

async function ensureEvidenceParents(
  root: string,
  relativePath: string,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new TypeError("El checkout evidence production es inválido");
  }
  let current = resolvedRoot;
  for (const segment of dirname(relativePath).split("/")) {
    current = resolve(current, segment);
    if (!inside(resolvedRoot, current)) {
      throw new TypeError("El path evidence production salió del checkout");
    }
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TypeError("Evidence production no admite symlinks");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o755 });
    }
  }
}

async function existingEvidenceMatches(
  path: string,
  contents: Buffer,
): Promise<boolean> {
  try {
    return (
      await readBoundedRegularFile(path, maxSmokeBytes, "Evidence production")
    ).equals(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function publishProductionEvidence(
  value: ProductionSmokeRecord,
  checkoutRoot: string,
): Promise<{ relativePath: string; state: "new" | "existing" }> {
  const smoke = validateProductionSmokeRecord(value);
  const relativePath = `issue-${smoke.issueNumber}/production/${smoke.sourceSha}/manifest.json`;
  const root = resolve(checkoutRoot);
  const destination = resolve(root, relativePath);
  if (!inside(root, destination)) {
    throw new TypeError("El destino evidence production salió del checkout");
  }
  await ensureEvidenceParents(root, relativePath);
  const contents = Buffer.from(`${canonicalJson(smoke)}\n`, "utf8");
  if (await existingEvidenceMatches(destination, contents)) {
    return { relativePath, state: "existing" };
  }
  try {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        destination,
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await existingEvidenceMatches(destination, contents)) {
        return { relativePath, state: "existing" };
      }
      throw new Error(
        "Colisión append-only: evidence production ya existe con otros bytes",
      );
    }
    throw error;
  }
  return { relativePath, state: "new" };
}
