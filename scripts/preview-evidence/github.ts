import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

import {
  canonicalJson,
  EVIDENCE_REQUEST_PATH,
  sha256,
  type EvidenceRequest,
} from "./domain.ts";
import {
  parseEvidenceRequest,
  validateNormalizedEvidenceRequest,
} from "./request.ts";

type JsonRecord = Record<string, unknown>;

export interface GitHubApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
}

export interface PullRequestRunContext {
  repository: string;
  runId: number;
  runUrl: string;
  prNumber: number;
  prUrl: string;
  issueNumber: number;
  issueUrl: string;
  baseSha: string;
  headSha: string;
  requestPath: string;
  request: EvidenceRequest;
}

const gitShaPattern = /^[a-f0-9]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const maxGitHubBodyBytes = 1024 * 1024;
const maxRequestBytes = 64 * 1024;
const maxContextBytes = 128 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError(`GitHub devolvió ${label} inválido`);
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    value.includes("\0") ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new TypeError(`GitHub devolvió ${label} inválido`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`GitHub devolvió ${label} inválido`);
  }
  return value as number;
}

function requireGitHubUrl(
  value: unknown,
  repository: string,
  kind: string,
): string {
  const raw = requireString(value, `URL de ${kind}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`GitHub devolvió URL de ${kind} inválida`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(`/${repository}/`)
  ) {
    throw new TypeError(`GitHub devolvió URL de ${kind} inválida`);
  }
  return url.toString();
}

function encodedContentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function linkedIssue(
  body: unknown,
  repository: string,
  issue: number,
): boolean {
  if (typeof body !== "string" || body.length > 64 * 1024) return false;
  const short = new RegExp(`(?:^|[^0-9])#${issue}(?:[^0-9]|$)`, "u");
  const full = `https://github.com/${repository}/issues/${issue}`;
  return short.test(body) || body.includes(full);
}

function decodeGitHubContent(value: unknown, expectedPath: string): string {
  const content = requireRecord(value, "content");
  if (
    content.type !== "file" ||
    content.path !== expectedPath ||
    content.encoding !== "base64" ||
    !Number.isSafeInteger(content.size) ||
    typeof content.content !== "string"
  ) {
    throw new TypeError("GitHub devolvió content base64 o path inválido");
  }
  if (
    (content.size as number) < 0 ||
    (content.size as number) > maxRequestBytes
  ) {
    throw new RangeError(
      "El content de GitHub supera 64 KiB o tiene tamaño inválido",
    );
  }
  const encoded = content.content.replace(/[\r\n]/gu, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw new TypeError("GitHub devolvió content base64 inválido");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length !== content.size ||
    decoded.length > maxRequestBytes ||
    decoded.toString("base64") !== encoded
  ) {
    throw new TypeError("GitHub devolvió content base64 con tamaño inválido");
  }
  return decoded.toString("utf8");
}

async function changedFiles(
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
    for (const entry of response) {
      const record = requireRecord(entry, "archivo de PR");
      files.push({
        filename: requireString(record.filename, "filename"),
        status: requireString(record.status, "status"),
      });
    }
    if (response.length < 100) break;
  }
  if (files.length !== expectedCount) {
    throw new TypeError("GitHub devolvió un inventario de PR incompleto");
  }
  return files;
}

export async function resolvePullRequestRun(
  payload: unknown,
  api: GitHubApi,
): Promise<PullRequestRunContext> {
  const event = requireRecord(payload, "evento workflow_run");
  const repositoryRecord = requireRecord(event.repository, "repositorio");
  const repository = requireString(
    repositoryRecord.full_name,
    "repositorio",
    repositoryPattern,
  );
  if (repositoryRecord.default_branch !== "main") {
    throw new TypeError("La rama por defecto de GitHub debe ser main");
  }
  const run = requireRecord(event.workflow_run, "workflow_run");
  if (event.action !== "completed" || run.conclusion !== "success") {
    throw new TypeError("El workflow de CI debe terminar de forma exitosa");
  }
  if (run.event !== "pull_request") {
    throw new TypeError("El workflow origen debe proceder de pull_request");
  }
  const runId = requirePositiveInteger(run.id, "run id");
  const runUrl = requireGitHubUrl(run.html_url, repository, "workflow run");
  const eventHeadSha = requireString(run.head_sha, "head SHA", gitShaPattern);
  const headRepository = requireRecord(run.head_repository, "head repository");
  if (headRepository.full_name !== repository) {
    throw new TypeError(
      "Solo una PR interna del repositorio puede tener preview",
    );
  }
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) {
    throw new TypeError(
      "El workflow debe identificar exactamente una Pull Request",
    );
  }
  const runPullRequest = requireRecord(
    run.pull_requests[0],
    "Pull Request del workflow",
  );
  const prNumber = requirePositiveInteger(runPullRequest.number, "PR number");

  const pr = requireRecord(
    await api.get(`/repos/${repository}/pulls/${prNumber}`),
    "Pull Request",
  );
  if (pr.number !== prNumber || pr.state !== "open") {
    throw new TypeError("La Pull Request debe permanecer abierta");
  }
  const base = requireRecord(pr.base, "base de PR");
  const head = requireRecord(pr.head, "head de PR");
  const headRepo = requireRecord(head.repo, "repositorio head de PR");
  if (base.ref !== "main") {
    throw new TypeError("La base de la Pull Request debe ser main");
  }
  const baseSha = requireString(base.sha, "base SHA", gitShaPattern);
  const headSha = requireString(head.sha, "head SHA", gitShaPattern);
  if (headSha !== eventHeadSha) {
    throw new TypeError("El head SHA de la Pull Request cambió");
  }
  if (headRepo.full_name !== repository) {
    throw new TypeError(
      "Solo una PR interna del repositorio puede tener preview",
    );
  }
  const prUrl = requireGitHubUrl(pr.html_url, repository, "Pull Request");
  const fileCount = requirePositiveInteger(pr.changed_files, "changed_files");
  const files = await changedFiles(api, repository, prNumber, fileCount);
  if (files.some((file) => file.filename.startsWith("drizzle/"))) {
    throw new TypeError(
      "Una PR con migraciones drizzle requiere un flujo separado",
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
      "La PR debe cambiar exactamente una solicitud request de evidencia",
    );
  }
  const requestPath = requests[0].filename;
  const requestContents = decodeGitHubContent(
    await api.get(
      `/repos/${repository}/contents/${encodedContentPath(requestPath)}?ref=${headSha}`,
    ),
    requestPath,
  );
  const request = parseEvidenceRequest(requestContents, requestPath);
  if (!linkedIssue(pr.body, repository, request.issue)) {
    throw new TypeError("La Pull Request debe enlazar la issue de evidencia");
  }
  const issue = requireRecord(
    await api.get(`/repos/${repository}/issues/${request.issue}`),
    "issue",
  );
  if (issue.number !== request.issue || issue.state !== "open") {
    throw new TypeError("La issue de evidencia debe permanecer abierta");
  }
  const issueUrl = requireGitHubUrl(issue.html_url, repository, "issue");

  return {
    repository,
    runId,
    runUrl,
    prNumber,
    prUrl,
    issueNumber: request.issue,
    issueUrl,
    baseSha,
    headSha,
    requestPath,
    request,
  };
}

export async function writeGitHubOutputs(
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new TypeError(
      "El destino de GitHub output debe ser un archivo regular",
    );
  }
  let output = "";
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(key)) {
      throw new TypeError("La key de GitHub output es inválida");
    }
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      value.length > maxGitHubBodyBytes
    ) {
      throw new TypeError("El valor de GitHub output es inválido");
    }
    let delimiter: string;
    do {
      delimiter = `ghadelimiter_${randomUUID().replaceAll("-", "")}`;
    } while (value.includes(delimiter));
    output += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    await handle.writeFile(output, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError(
        "El destino de GitHub output no puede ser un symlink",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateStoredPullRequestContext(
  value: unknown,
): PullRequestRunContext {
  const context = requireRecord(value, "contexto de Pull Request");
  const expectedKeys = new Set([
    "repository",
    "runId",
    "runUrl",
    "prNumber",
    "prUrl",
    "issueNumber",
    "issueUrl",
    "baseSha",
    "headSha",
    "requestPath",
    "request",
  ]);
  if (
    Object.keys(context).length !== expectedKeys.size ||
    Object.keys(context).some((key) => !expectedKeys.has(key))
  ) {
    throw new TypeError("El contexto GitHub contiene campos no permitidos");
  }
  const repository = requireString(
    context.repository,
    "repositorio",
    repositoryPattern,
  );
  const requestPath = requireString(context.requestPath, "request path");
  const request = validateNormalizedEvidenceRequest(
    context.request,
    requestPath,
  );
  const issueNumber = requirePositiveInteger(
    context.issueNumber,
    "issue number",
  );
  if (issueNumber !== request.issue) {
    throw new TypeError("La issue del contexto GitHub no coincide");
  }
  return {
    repository,
    runId: requirePositiveInteger(context.runId, "run id"),
    runUrl: requireGitHubUrl(context.runUrl, repository, "workflow run"),
    prNumber: requirePositiveInteger(context.prNumber, "PR number"),
    prUrl: requireGitHubUrl(context.prUrl, repository, "Pull Request"),
    issueNumber,
    issueUrl: requireGitHubUrl(context.issueUrl, repository, "issue"),
    baseSha: requireString(context.baseSha, "base SHA", gitShaPattern),
    headSha: requireString(context.headSha, "head SHA", gitShaPattern),
    requestPath,
    request,
  };
}

async function readRegularBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    throw new TypeError(`${label} debe ser un archivo regular acotado`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new TypeError(`${label} debe ser un archivo regular acotado`);
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

export async function writePullRequestContext(
  path: string,
  context: PullRequestRunContext,
): Promise<{ path: string; sha256: string }> {
  const validated = validateStoredPullRequestContext(context);
  const contents = Buffer.from(`${canonicalJson(validated)}\n`, "utf8");
  if (contents.length > maxContextBytes) {
    throw new RangeError("El contexto GitHub supera el límite permitido");
  }
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new TypeError("El directorio del contexto GitHub es inválido");
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
  return { path, sha256: sha256(contents) };
}

export async function readPullRequestContext(
  path: string,
  expectedSha256: string,
): Promise<PullRequestRunContext> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new TypeError("El hash del contexto GitHub es inválido");
  }
  const contents = await readRegularBoundedFile(
    path,
    maxContextBytes,
    "El contexto GitHub",
  );
  if (sha256(contents) !== expectedSha256) {
    throw new Error("Falló la integridad hash del contexto GitHub");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new TypeError("El contexto GitHub contiene JSON inválido");
  }
  return validateStoredPullRequestContext(parsed);
}

export function createGitHubApi(
  token: string,
  repository: string,
  fetchImplementation: typeof fetch = fetch,
): GitHubApi {
  if (!token || token.length > 512 || !repositoryPattern.test(repository)) {
    throw new TypeError("La configuración de GitHub API es inválida");
  }

  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!path.startsWith(`/repos/${repository}/`) || path.includes("\0")) {
      throw new TypeError("El path de GitHub API es inválido");
    }
    const response = await fetchImplementation(
      `https://api.github.com${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "comunidad-solar-preview-evidence",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      },
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxGitHubBodyBytes) {
      throw new Error("GitHub API devolvió una respuesta demasiado grande");
    }
    if (!response.ok) {
      throw new Error(
        `GitHub API rechazó la operación con status ${response.status}`,
      );
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("GitHub API devolvió JSON inválido");
    }
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
  };
}
