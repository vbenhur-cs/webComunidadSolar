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
import {
  validatePublishEvidenceResult,
  type PublishEvidenceResult,
} from "./evidence.ts";
import {
  validateReleaseCaptureContext,
  type ReleaseCaptureContext,
} from "./capture.ts";

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

export interface EvidenceCommentInput {
  context: PullRequestRunContext;
  publication: PublishEvidenceResult;
  evidenceCommitSha: string;
}

export interface ReleaseEvidenceCommentInput {
  context: ReleaseCaptureContext;
  publication: PublishEvidenceResult;
  evidenceCommitSha: string;
}

export type MainRunContext =
  | {
      kind: "release";
      context: ReleaseCaptureContext;
    }
  | {
      kind: "bootstrap";
      repository: string;
      runId: number;
      runUrl: string;
      prNumber: number;
      prUrl: string;
      sourceSha: string;
    };

const gitShaPattern = /^[a-f0-9]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const maxGitHubBodyBytes = 1024 * 1024;
const maxRequestBytes = 64 * 1024;
const maxContextBytes = 128 * 1024;
const bootstrapExactPaths = new Set([
  ".github/ISSUE_TEMPLATE/solicitud-cambio-web.yml",
  ".github/workflows/pr-preview.yml",
  ".github/workflows/production.yml",
  ".github/workflows/shared-preview.yml",
  "README.md",
  "evidence/requests/example-page.yaml",
  "evidence/requests/example-section.yaml",
  "package.json",
  "package-lock.json",
  "scripts/prepare-cloudflare-config.ts",
  "tests/foundation/preview-documentation.test.mjs",
  "tests/foundation/preview-workflows.test.mjs",
]);
const bootstrapPathPrefixes = [
  "docs/operations/",
  "docs/superpowers/plans/",
  "docs/superpowers/specs/",
  "scripts/preview-evidence/",
  "tests/preview-evidence/",
] as const;

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

function configuredBootstrapPr(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) {
    throw new TypeError(
      "La configuración numérica PREVIEW_PIPELINE_BOOTSTRAP_PR es inválida",
    );
  }
  return Number(value);
}

function isBootstrapPath(filename: string): boolean {
  return (
    bootstrapExactPaths.has(filename) ||
    bootstrapPathPrefixes.some((prefix) => filename.startsWith(prefix))
  );
}

function validMergedAt(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

async function requireCurrentMainSha(
  api: GitHubApi,
  repository: string,
  expectedSha: string,
): Promise<void> {
  const branch = requireRecord(
    await api.get(`/repos/${repository}/branches/main`),
    "rama main",
  );
  const branchCommit = requireRecord(branch.commit, "commit de rama main");
  const currentMainSha = requireString(
    branchCommit.sha,
    "SHA de rama main",
    gitShaPattern,
  );
  if (branch.name !== "main" || currentMainSha !== expectedSha) {
    throw new Error(
      "El SHA autorizado ya no es la punta actual de main; no se despliega",
    );
  }
}

export async function assertCurrentMainHead(
  api: GitHubApi,
  value: ReleaseCaptureContext,
): Promise<void> {
  const context = validateReleaseCaptureContext(value);
  await requireCurrentMainSha(api, context.repository, context.sourceSha);
}

export async function resolveMainRun(
  payload: unknown,
  api: GitHubApi,
  bootstrapPrValue?: string,
): Promise<MainRunContext> {
  const bootstrapPr = configuredBootstrapPr(bootstrapPrValue);
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
  if (run.event !== "push") {
    throw new TypeError("El workflow origen de release debe proceder de push");
  }
  if (run.head_branch !== "main") {
    throw new TypeError("El workflow de release debe corresponder a main");
  }
  const runId = requirePositiveInteger(run.id, "run id");
  const runUrl = requireGitHubUrl(run.html_url, repository, "workflow run");
  const sourceSha = requireString(run.head_sha, "head SHA", gitShaPattern);
  const headRepository = requireRecord(run.head_repository, "head repository");
  if (headRepository.full_name !== repository) {
    throw new TypeError(
      "El push de main debe pertenecer al repositorio actual",
    );
  }

  await requireCurrentMainSha(api, repository, sourceSha);

  const associations = await api.get(
    `/repos/${repository}/commits/${sourceSha}/pulls?per_page=100`,
  );
  if (!Array.isArray(associations) || associations.length !== 1) {
    throw new TypeError(
      "El commit de main debe estar asociado con exactamente una Pull Request fusionada",
    );
  }
  const association = requireRecord(
    associations[0],
    "Pull Request asociada al commit",
  );
  const prNumber = requirePositiveInteger(association.number, "PR number");
  const pr = requireRecord(
    await api.get(`/repos/${repository}/pulls/${prNumber}`),
    "Pull Request fusionada",
  );
  if (
    pr.number !== prNumber ||
    pr.state !== "closed" ||
    pr.merged !== true ||
    !validMergedAt(pr.merged_at)
  ) {
    throw new TypeError("La Pull Request asociada debe estar fusionada");
  }
  if (pr.merge_commit_sha !== sourceSha) {
    throw new TypeError(
      "El merge commit SHA de la Pull Request no coincide con main",
    );
  }
  const base = requireRecord(pr.base, "base de PR fusionada");
  const head = requireRecord(pr.head, "head de PR fusionada");
  const headRepo = requireRecord(head.repo, "repositorio head de PR fusionada");
  if (base.ref !== "main" || headRepo.full_name !== repository) {
    throw new TypeError(
      "La Pull Request fusionada debe ser interna y tener main como base",
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

  if (requests.length === 0) {
    if (bootstrapPr === null || bootstrapPr !== prNumber) {
      throw new TypeError(
        "La PR de main necesita una solicitud de evidencia o la excepción bootstrap exacta",
      );
    }
    if (
      files.some(
        (file) =>
          (file.status !== "added" && file.status !== "modified") ||
          !isBootstrapPath(file.filename),
      )
    ) {
      throw new TypeError(
        "La excepción bootstrap solo admite paths técnicos de la allowlist",
      );
    }
    return {
      kind: "bootstrap",
      repository,
      runId,
      runUrl,
      prNumber,
      prUrl,
      sourceSha,
    };
  }

  if (
    requests.length !== 1 ||
    (requests[0].status !== "added" && requests[0].status !== "modified")
  ) {
    throw new TypeError(
      "La PR fusionada debe cambiar exactamente una solicitud request de evidencia",
    );
  }
  const requestPath = requests[0].filename;
  const requestContents = decodeGitHubContent(
    await api.get(
      `/repos/${repository}/contents/${encodedContentPath(requestPath)}?ref=${sourceSha}`,
    ),
    requestPath,
  );
  const request = parseEvidenceRequest(requestContents, requestPath);
  if (!linkedIssue(pr.body, repository, request.issue)) {
    throw new TypeError("La Pull Request fusionada debe enlazar la issue");
  }
  const issue = requireRecord(
    await api.get(`/repos/${repository}/issues/${request.issue}`),
    "issue",
  );
  if (issue.number !== request.issue || issue.state !== "open") {
    throw new TypeError(
      "La issue de evidencia debe permanecer abierta hasta la release",
    );
  }
  const issueUrl = requireGitHubUrl(issue.html_url, repository, "issue");
  return {
    kind: "release",
    context: {
      schemaVersion: 1,
      repository,
      issueNumber: request.issue,
      issueUrl,
      prNumber,
      prUrl,
      runId,
      runUrl,
      sourceSha,
      requestPath,
      request,
    },
  };
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

function exactCommentMarker(body: string, marker: string): boolean {
  return body.split(/\r?\n/u).some((line) => line === marker);
}

function requireCommentBody(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 64 * 1024
  ) {
    throw new TypeError("GitHub devolvió comment body inválido");
  }
  return value;
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function evidenceCommentBody(
  context: PullRequestRunContext,
  publication: PublishEvidenceResult,
  evidenceCommitSha: string,
): string {
  const marker = `<!-- preview-evidence:issue-${context.issueNumber}:${context.headSha} -->`;
  const lines = [
    marker,
    "## Evidencia visual pendiente de revisión humana",
    "",
    `Solicitud: [issue #${context.issueNumber}](${context.issueUrl}) · [PR #${context.prNumber}](${context.prUrl})`,
    "",
    `- SHA base completo: \`${context.baseSha}\``,
    `- SHA candidato completo: \`${context.headSha}\``,
    `- Ejecución verificada: [GitHub Actions](${context.runUrl})`,
    `- Commit inmutable de evidencia: [${evidenceCommitSha.slice(0, 12)}](https://github.com/${context.repository}/commit/${evidenceCommitSha})`,
    "",
  ];
  for (const entry of publication.entries) {
    const title =
      entry.role === "base"
        ? "Antes (base)"
        : entry.role === "candidate"
          ? "Después (candidato)"
          : "Release";
    lines.push(
      `### ${title}`,
      "",
      `- SHA: \`${entry.sourceSha}\``,
      `- [Abrir Preview URL](${entry.previewUrl})`,
      `- [Abrir manifest.json](${entry.manifestUrl})`,
      "",
    );
    for (const png of entry.pngs) {
      const label = escapeMarkdownLabel(png.filename);
      lines.push(`[![${label}](${png.rawUrl})](${png.rawUrl})`, "");
    }
  }
  lines.push(
    "Las comprobaciones automáticas terminaron correctamente: status HTTP, documento visible, ausencia de errores de página y recursos del mismo origen, dimensiones y hashes PNG.",
    "",
    "⏳ Estado: pendiente de revisión humana. Revisa ambas Preview URLs y las capturas; después aprueba el environment `premerge-review` o solicita correcciones en la PR.",
  );
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > 64 * 1024) {
    throw new RangeError("El comentario de evidencia supera 64 KiB");
  }
  return body;
}

function validateEvidenceCommentInput(input: EvidenceCommentInput): {
  context: PullRequestRunContext;
  publication: PublishEvidenceResult;
  evidenceCommitSha: string;
  body: string;
  marker: string;
} {
  const context = validateStoredPullRequestContext(input.context);
  const publication = validatePublishEvidenceResult(input.publication);
  const evidenceCommitSha = requireString(
    input.evidenceCommitSha,
    "evidence commit SHA",
    gitShaPattern,
  );
  if (
    publication.kind !== "pull-request" ||
    publication.repository !== context.repository ||
    publication.issueNumber !== context.issueNumber ||
    publication.prNumber !== context.prNumber ||
    publication.source.baseSha !== context.baseSha ||
    publication.source.headSha !== context.headSha ||
    publication.source.releaseSha !== null ||
    publication.runUrl !== context.runUrl
  ) {
    throw new TypeError(
      "La publicación no coincide con el contexto PR autorizado",
    );
  }
  const marker = `<!-- preview-evidence:issue-${context.issueNumber}:${context.headSha} -->`;
  return {
    context,
    publication,
    evidenceCommitSha,
    marker,
    body: evidenceCommentBody(context, publication, evidenceCommitSha),
  };
}

export async function upsertEvidenceComments(
  api: GitHubApi,
  input: EvidenceCommentInput,
): Promise<void> {
  const validated = validateEvidenceCommentInput(input);
  await upsertMarkedComments(
    api,
    validated.context.repository,
    [validated.context.prNumber, validated.context.issueNumber],
    validated.marker,
    validated.body,
  );
}

async function upsertMarkedComments(
  api: GitHubApi,
  repository: string,
  rawTargetNumbers: readonly number[],
  marker: string,
  body: string,
): Promise<void> {
  const targetNumbers = rawTargetNumbers.filter(
    (value, index, all) => all.indexOf(value) === index,
  );
  const planned: Array<{ target: number; commentId: number | null }> = [];

  // Preflight both targets before mutating either one.
  for (const target of targetNumbers) {
    const response = await api.get(
      `/repos/${repository}/issues/${target}/comments?per_page=100`,
    );
    if (!Array.isArray(response) || response.length > 100) {
      throw new TypeError("GitHub devolvió una lista de comentarios inválida");
    }
    const matching: number[] = [];
    for (const value of response) {
      const comment = requireRecord(value, "comentario");
      const id = requirePositiveInteger(comment.id, "comment id");
      const body = requireCommentBody(comment.body);
      if (exactCommentMarker(body, marker)) matching.push(id);
    }
    if (matching.length > 1) {
      throw new Error(
        `GitHub contiene múltiples comentarios con el marcador de evidencia en #${target}`,
      );
    }
    planned.push({ target, commentId: matching[0] ?? null });
  }

  for (const operation of planned) {
    const payload = { body };
    if (operation.commentId === null) {
      await api.post(
        `/repos/${repository}/issues/${operation.target}/comments`,
        payload,
      );
    } else {
      await api.patch(
        `/repos/${repository}/issues/comments/${operation.commentId}`,
        payload,
      );
    }
  }
}

function releaseEvidenceCommentBody(
  context: ReleaseCaptureContext,
  publication: PublishEvidenceResult,
  evidenceCommitSha: string,
): string {
  const entry = publication.entries[0];
  const marker = `<!-- preview-release:issue-${context.issueNumber}:${context.sourceSha} -->`;
  const lines = [
    marker,
    "## Release desplegada en la preview compartida",
    "",
    `Solicitud: [issue #${context.issueNumber}](${context.issueUrl}) · [PR #${context.prNumber}](${context.prUrl})`,
    "",
    `- SHA integrado completo: \`${context.sourceSha}\``,
    `- Ejecución verificada: [GitHub Actions](${context.runUrl})`,
    `- [Abrir preview compartida](${entry.previewUrl})`,
    `- [Abrir manifest.json](${entry.manifestUrl})`,
    `- Commit inmutable de evidencia: [${evidenceCommitSha.slice(0, 12)}](https://github.com/${context.repository}/commit/${evidenceCommitSha})`,
    "",
  ];
  for (const png of entry.pngs) {
    const label = escapeMarkdownLabel(png.filename);
    lines.push(`[![${label}](${png.rawUrl})](${png.rawUrl})`, "");
  }
  lines.push(
    "✅ Estado: el mismo SHA verde de `main` quedó desplegado al 100% en el Worker de preview compartida y sus comprobaciones terminaron correctamente.",
    "",
    "Si esta release no es aceptable, crea una PR con `git revert` para conservar el historial; producción y DNS no han sido modificados.",
  );
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > 64 * 1024) {
    throw new RangeError("El comentario de release supera 64 KiB");
  }
  return body;
}

function validateReleaseEvidenceCommentInput(
  input: ReleaseEvidenceCommentInput,
): {
  context: ReleaseCaptureContext;
  publication: PublishEvidenceResult;
  evidenceCommitSha: string;
  marker: string;
  body: string;
} {
  const context = validateReleaseCaptureContext(input.context);
  const publication = validatePublishEvidenceResult(input.publication);
  const evidenceCommitSha = requireString(
    input.evidenceCommitSha,
    "evidence commit SHA",
    gitShaPattern,
  );
  if (
    publication.kind !== "release" ||
    publication.repository !== context.repository ||
    publication.issueNumber !== context.issueNumber ||
    publication.prNumber !== context.prNumber ||
    publication.source.baseSha !== null ||
    publication.source.headSha !== null ||
    publication.source.releaseSha !== context.sourceSha ||
    publication.runUrl !== context.runUrl ||
    publication.entries.length !== 1 ||
    publication.entries[0].role !== "release"
  ) {
    throw new TypeError(
      "La publicación release no coincide con el contexto main autorizado",
    );
  }
  const marker = `<!-- preview-release:issue-${context.issueNumber}:${context.sourceSha} -->`;
  return {
    context,
    publication,
    evidenceCommitSha,
    marker,
    body: releaseEvidenceCommentBody(context, publication, evidenceCommitSha),
  };
}

export async function upsertReleaseEvidenceComments(
  api: GitHubApi,
  input: ReleaseEvidenceCommentInput,
): Promise<void> {
  const validated = validateReleaseEvidenceCommentInput(input);
  await upsertMarkedComments(
    api,
    validated.context.repository,
    [validated.context.prNumber, validated.context.issueNumber],
    validated.marker,
    validated.body,
  );
}

export async function setPreviewApprovalStatus(
  api: GitHubApi,
  repository: string,
  headSha: string,
  state: "success",
  targetUrl: string,
): Promise<void> {
  if (!repositoryPattern.test(repository)) {
    throw new TypeError("El repositorio del status es inválido");
  }
  if (!gitShaPattern.test(headSha)) {
    throw new TypeError("El SHA del status preview-approved es inválido");
  }
  if (state !== "success") {
    throw new TypeError("preview-approved solo admite el estado success");
  }
  const match = new RegExp(
    `^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/actions/runs/([1-9][0-9]*)$`,
    "u",
  ).exec(targetUrl);
  if (match === null) {
    throw new TypeError("La URL del run para preview-approved es inválida");
  }
  const trustedUrl = requireGitHubUrl(targetUrl, repository, "workflow run");
  await api.post(`/repos/${repository}/statuses/${headSha}`, {
    state,
    context: "preview-approved",
    description: "Preview y evidencia aprobadas por una persona",
    target_url: trustedUrl,
  });
}

export async function approvePreviewForCurrentPullRequest(
  api: GitHubApi,
  inputContext: PullRequestRunContext,
): Promise<void> {
  const context = validateStoredPullRequestContext(inputContext);
  const response = requireRecord(
    await api.get(`/repos/${context.repository}/pulls/${context.prNumber}`),
    "Pull Request antes de aprobar preview",
  );
  const head = requireRecord(response.head, "head de Pull Request");
  if (
    response.number !== context.prNumber ||
    response.state !== "open" ||
    head.sha !== context.headSha
  ) {
    throw new Error(
      "La Pull Request se cerró o su head SHA cambió antes de la aprobación",
    );
  }
  await setPreviewApprovalStatus(
    api,
    context.repository,
    context.headSha,
    "success",
    context.runUrl,
  );
}
