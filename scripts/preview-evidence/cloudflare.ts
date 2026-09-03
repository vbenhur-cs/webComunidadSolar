import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type BundleManifest, verifySealedBundle } from "./bundle.ts";
import { canonicalJson, type EvidenceRole } from "./domain.ts";

type JsonRecord = Record<string, unknown>;

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

export interface WranglerInvocation {
  argv: readonly string[];
  cwd: string;
  environment: Readonly<{
    CI: "true";
    NO_COLOR: "1";
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_API_TOKEN: string;
  }>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface WranglerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export type WranglerRunner = (
  invocation: WranglerInvocation,
) => Promise<WranglerResult>;

export interface UploadInput {
  bundleRoot: string;
  profilePath: string;
  profileSha256: string;
  role: EvidenceRole;
  sourceSha: string;
  prNumber?: number;
  credentials: CloudflareCredentials;
}

export interface CloudflareVersionDescriptor {
  schemaVersion: 1;
  role: EvidenceRole;
  sourceSha: string;
  bundleSha256: string;
  workerName: "comunidad-solar-preview";
  versionId: string;
  tag: string;
  alias: string;
  url: string;
}

export interface DeployVersionInput {
  bundleRoot: string;
  profilePath: string;
  profileSha256: string;
  descriptor: CloudflareVersionDescriptor;
  credentials: CloudflareCredentials;
}

const workerName = "comunidad-solar-preview" as const;
const maxOutputBytes = 1024 * 1024;
const maxDescriptorBytes = 32 * 1024;
const timeoutMs = 10 * 60 * 1000;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const accountIdPattern = /^[A-Fa-f0-9]{32}$/u;
const apiTokenPattern = /^[A-Za-z0-9._-]{20,512}$/u;
const roles = new Set<EvidenceRole>(["base", "candidate", "release"]);
const wranglerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/.bin/wrangler",
);

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsForbiddenControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (
      codePoint <= 0x08 ||
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

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${label} inválido`);
  return value;
}

function assertAllowedKeys(
  value: JsonRecord,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contiene un campo no permitido`);
  }
}

function assertExactKeys(
  value: JsonRecord,
  expectedKeys: readonly string[],
  label: string,
): void {
  assertAllowedKeys(value, expectedKeys, label);
  if (Object.keys(value).length !== expectedKeys.length) {
    throw new TypeError(`${label} no contiene todos los campos requeridos`);
  }
}

function safeText(value: unknown, label: string, maxLength = 2048): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    containsForbiddenControls(value)
  ) {
    throw new TypeError(`${label} contiene texto o controles inválidos`);
  }
  return value;
}

function validateCredentials(
  credentials: CloudflareCredentials,
): CloudflareCredentials {
  if (
    !isRecord(credentials) ||
    !accountIdPattern.test(credentials.accountId) ||
    !apiTokenPattern.test(credentials.apiToken) ||
    containsForbiddenControls(credentials.apiToken)
  ) {
    throw new TypeError("Las credenciales Cloudflare requeridas son inválidas");
  }
  return credentials;
}

function versionIdentity(input: {
  role: EvidenceRole;
  sourceSha: string;
  prNumber?: number;
}): { tag: string; alias: string; message: string } {
  if (!roles.has(input.role) || !gitShaPattern.test(input.sourceSha)) {
    throw new TypeError("La identidad de la versión Cloudflare es inválida");
  }
  const shortSha = input.sourceSha.slice(0, 7);
  if (input.role === "release") {
    if (input.prNumber !== undefined) {
      throw new TypeError("Una release Cloudflare no admite número de PR");
    }
    const tag = `main-${shortSha}`;
    return { tag, alias: tag, message: `main release ${shortSha}` };
  }
  if (
    !Number.isSafeInteger(input.prNumber) ||
    (input.prNumber as number) <= 0 ||
    (input.prNumber as number) > 999_999_999
  ) {
    throw new TypeError(
      "La versión Cloudflare de PR requiere un número válido",
    );
  }
  const tag = `pr-${input.prNumber}-${input.role === "base" ? "base" : "head"}-${shortSha}`;
  return {
    tag,
    alias: tag,
    message: `PR ${input.prNumber} ${input.role} ${shortSha}`,
  };
}

function invocation(
  argv: readonly string[],
  cwd: string,
  credentials: CloudflareCredentials,
): WranglerInvocation {
  if (
    argv.length === 0 ||
    argv.some(
      (part) =>
        typeof part !== "string" ||
        part.length === 0 ||
        part.includes("\0") ||
        containsForbiddenControls(part),
    )
  ) {
    throw new TypeError("Los argumentos Wrangler son inválidos");
  }
  return {
    argv: [...argv],
    cwd: resolve(cwd),
    environment: {
      CI: "true",
      NO_COLOR: "1",
      CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
      CLOUDFLARE_API_TOKEN: credentials.apiToken,
    },
    timeoutMs,
    maxOutputBytes,
  };
}

function terminateProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export const runWrangler: WranglerRunner = async (
  command,
): Promise<WranglerResult> => {
  const resolvedCwd = resolve(command.cwd);
  if (
    command.timeoutMs !== timeoutMs ||
    command.maxOutputBytes !== maxOutputBytes ||
    Object.keys(command.environment).sort().join(",") !==
      "CI,CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_API_TOKEN,NO_COLOR" ||
    command.environment.CI !== "true" ||
    command.environment.NO_COLOR !== "1"
  ) {
    throw new TypeError("La capacidad del proceso Wrangler es inválida");
  }
  validateCredentials({
    accountId: command.environment.CLOUDFLARE_ACCOUNT_ID,
    apiToken: command.environment.CLOUDFLARE_API_TOKEN,
  });

  return await new Promise<WranglerResult>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wranglerPath, ...command.argv], {
      cwd: resolvedCwd,
      detached: process.platform !== "win32",
      env: { ...command.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = (reason: "timeout" | "output"): void => {
      if (reason === "timeout") timedOut = true;
      else outputLimitExceeded = true;
      terminateProcessGroup(child, "SIGTERM");
      killTimer ??= setTimeout(() => {
        terminateProcessGroup(child, "SIGKILL");
      }, 5_000);
      killTimer.unref();
    };
    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes <= command.maxOutputBytes) target.push(chunk);
      else if (!outputLimitExceeded) stop("output");
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));
    child.once("error", reject);
    const deadline = setTimeout(() => stop("timeout"), command.timeoutMs);
    deadline.unref();
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolvePromise({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        outputLimitExceeded,
      });
    });
  });
};

function redactSensitive(
  message: string,
  credentials: CloudflareCredentials,
): string {
  let redacted = message.replaceAll(credentials.apiToken, "[REDACTED]");
  redacted = redacted.replace(
    /\b(?:Bearer\s+)?[A-Za-z0-9._-]{24,}\b/giu,
    "[REDACTED]",
  );
  return redacted.slice(0, 512);
}

async function runChecked(
  runner: WranglerRunner,
  command: WranglerInvocation,
  credentials: CloudflareCredentials,
): Promise<WranglerResult> {
  let outcome: WranglerResult;
  try {
    outcome = await runner(command);
  } catch (error) {
    const safe = redactSensitive(
      error instanceof Error ? error.message : "error desconocido",
      credentials,
    );
    throw new Error(`Wrangler no pudo iniciarse de forma segura: ${safe}`);
  }
  if (
    !isRecord(outcome) ||
    (outcome.exitCode !== null &&
      (!Number.isSafeInteger(outcome.exitCode) || outcome.exitCode < 0)) ||
    (outcome.signal !== null && typeof outcome.signal !== "string") ||
    typeof outcome.stdout !== "string" ||
    typeof outcome.stderr !== "string" ||
    typeof outcome.timedOut !== "boolean" ||
    typeof outcome.outputLimitExceeded !== "boolean"
  ) {
    throw new TypeError("Wrangler devolvió un resultado inválido");
  }
  const bytes =
    Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr);
  if (outcome.outputLimitExceeded || bytes > command.maxOutputBytes) {
    throw new RangeError("Wrangler superó el límite de output permitido");
  }
  if (outcome.timedOut) {
    throw new Error("Wrangler superó el tiempo máximo permitido");
  }
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    throw new Error("Cloudflare rechazó la operación Wrangler");
  }
  if (
    containsForbiddenControls(outcome.stdout) ||
    containsForbiddenControls(outcome.stderr)
  ) {
    throw new TypeError("La salida Wrangler contiene controles no permitidos");
  }
  return outcome;
}

function exactlyOneLine(stdout: string, label: string): string {
  const prefix = `${label}: `;
  const matches = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (matches.length !== 1) {
    throw new TypeError(`La salida Cloudflare contiene ${label} ambiguo`);
  }
  const value = safeText(matches[0], label);
  if (value !== value.trim()) {
    throw new TypeError(`La salida Cloudflare contiene ${label} inválido`);
  }
  return value;
}

function validatePreviewUrl(
  raw: string,
  expectedPrefix: string,
  label: string,
): URL {
  const value = safeText(raw, label);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Cloudflare devolvió ${label} inválida`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/" ||
    !url.hostname.endsWith(".workers.dev") ||
    !url.hostname.startsWith(`${expectedPrefix}.`)
  ) {
    throw new TypeError(`Cloudflare devolvió ${label} fuera de workers.dev`);
  }
  return url;
}

function parseUploadOutput(
  stdout: string,
  identity: { tag: string; alias: string },
): { versionId: string; url: string } {
  const versionId = exactlyOneLine(stdout, "Worker Version ID");
  if (!uuidPattern.test(versionId)) {
    throw new TypeError("Cloudflare devolvió un Version ID UUID inválido");
  }
  const versionUrl = validatePreviewUrl(
    exactlyOneLine(stdout, "Version Preview URL"),
    `${versionId.slice(0, 8)}-${workerName}`,
    "Version Preview URL",
  );
  const aliasUrl = validatePreviewUrl(
    exactlyOneLine(stdout, "Version Preview Alias URL"),
    `${identity.alias}-${workerName}`,
    "Version Preview Alias URL",
  );
  const versionSuffix = versionUrl.hostname.slice(
    `${versionId.slice(0, 8)}-${workerName}.`.length,
  );
  const aliasSuffix = aliasUrl.hostname.slice(
    `${identity.alias}-${workerName}.`.length,
  );
  if (versionSuffix !== aliasSuffix) {
    throw new TypeError(
      "Las URLs preview Cloudflare no comparten el mismo dominio",
    );
  }
  return { versionId, url: aliasUrl.toString() };
}

function validateVersionMetadata(value: unknown): void {
  const metadata = requireRecord(value, "La metadata de versión Cloudflare");
  assertAllowedKeys(
    metadata,
    [
      "author_email",
      "author_id",
      "created_on",
      "hasPreview",
      "modified_on",
      "source",
    ],
    "La metadata de versión Cloudflare",
  );
  for (const [key, child] of Object.entries(metadata)) {
    if (key === "hasPreview") {
      if (typeof child !== "boolean") {
        throw new TypeError("Cloudflare devolvió hasPreview inválido");
      }
    } else {
      safeText(child, `metadata.${key}`, 1024);
    }
  }
  if (metadata.hasPreview !== true) {
    throw new TypeError("La versión Cloudflare no habilitó Preview URLs");
  }
}

function validateAnnotations(value: unknown): JsonRecord {
  const annotations = requireRecord(value, "Las annotations Cloudflare");
  assertAllowedKeys(
    annotations,
    [
      "workers/alias",
      "workers/commit_sha",
      "workers/message",
      "workers/pull_request_number",
      "workers/pull_request_title",
      "workers/pull_request_url",
      "workers/repository_url",
      "workers/tag",
      "workers/triggered_by",
    ],
    "Las annotations Cloudflare",
  );
  for (const [key, child] of Object.entries(annotations)) {
    safeText(child, `annotation ${key}`, 1024);
  }
  return annotations;
}

function verifyListedVersion(
  stdout: string,
  expected: {
    versionId: string;
    tag: string;
    alias: string;
    message: string;
  },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new TypeError("Cloudflare versions list devolvió JSON inválido");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10) {
    throw new TypeError("Cloudflare versions list devolvió una lista inválida");
  }
  const matching: Array<{ id: string; annotations: JsonRecord }> = [];
  for (const entry of parsed) {
    const version = requireRecord(entry, "Una versión Cloudflare");
    assertAllowedKeys(
      version,
      ["id", "number", "metadata", "annotations"],
      "Una versión Cloudflare",
    );
    const id = safeText(version.id, "Version ID Cloudflare");
    if (!uuidPattern.test(id)) {
      throw new TypeError("Cloudflare listó un Version ID UUID inválido");
    }
    if (
      !Number.isSafeInteger(version.number) ||
      (version.number as number) < 1
    ) {
      throw new TypeError("Cloudflare listó un número de versión inválido");
    }
    validateVersionMetadata(version.metadata);
    const annotations = validateAnnotations(version.annotations);
    if (annotations["workers/tag"] === expected.tag) {
      matching.push({ id, annotations });
    }
  }
  if (matching.length !== 1) {
    throw new TypeError(
      "Cloudflare no listó exactamente una versión con el tag esperado",
    );
  }
  const [match] = matching;
  if (
    match.id !== expected.versionId ||
    match.annotations["workers/message"] !== expected.message ||
    match.annotations["workers/alias"] !== expected.alias
  ) {
    throw new TypeError(
      "La versión Cloudflare listada no coincide con la subida",
    );
  }
}

export function validateCloudflareVersionDescriptor(
  value: unknown,
): CloudflareVersionDescriptor {
  const descriptor = requireRecord(value, "El descriptor Cloudflare");
  assertExactKeys(
    descriptor,
    [
      "schemaVersion",
      "role",
      "sourceSha",
      "bundleSha256",
      "workerName",
      "versionId",
      "tag",
      "alias",
      "url",
    ],
    "El descriptor Cloudflare",
  );
  if (
    descriptor.schemaVersion !== 1 ||
    !roles.has(descriptor.role as EvidenceRole) ||
    typeof descriptor.sourceSha !== "string" ||
    !gitShaPattern.test(descriptor.sourceSha) ||
    typeof descriptor.bundleSha256 !== "string" ||
    !sha256Pattern.test(descriptor.bundleSha256) ||
    descriptor.workerName !== workerName ||
    typeof descriptor.versionId !== "string" ||
    !uuidPattern.test(descriptor.versionId) ||
    typeof descriptor.tag !== "string" ||
    typeof descriptor.alias !== "string" ||
    descriptor.tag !== descriptor.alias ||
    typeof descriptor.url !== "string"
  ) {
    throw new TypeError(
      "El descriptor Cloudflare contiene una identidad inválida",
    );
  }
  const expected = versionIdentity({
    role: descriptor.role as EvidenceRole,
    sourceSha: descriptor.sourceSha,
    prNumber:
      descriptor.role === "release"
        ? undefined
        : Number(/^pr-([1-9][0-9]*)-/u.exec(descriptor.tag)?.[1]),
  });
  if (descriptor.tag !== expected.tag) {
    throw new TypeError("El descriptor Cloudflare contiene un tag inválido");
  }
  validatePreviewUrl(
    descriptor.url,
    `${descriptor.alias}-${workerName}`,
    "URL del descriptor",
  );
  return descriptor as unknown as CloudflareVersionDescriptor;
}

async function verifiedBundle(
  input: Pick<
    UploadInput,
    "bundleRoot" | "profilePath" | "profileSha256" | "role" | "sourceSha"
  >,
): Promise<BundleManifest> {
  return await verifySealedBundle(input.bundleRoot, {
    role: input.role,
    sourceSha: input.sourceSha,
    profilePath: input.profilePath,
    profileSha256: input.profileSha256,
  });
}

export async function uploadPreviewVersion(
  input: UploadInput,
  runner: WranglerRunner = runWrangler,
): Promise<CloudflareVersionDescriptor> {
  const identity = versionIdentity(input);
  const manifest = await verifiedBundle(input);
  const credentials = validateCredentials(input.credentials);
  const bundleRoot = resolve(input.bundleRoot);
  const config = resolve(bundleRoot, "dist", "server", "wrangler.json");
  const uploaded = await runChecked(
    runner,
    invocation(
      [
        "versions",
        "upload",
        "--config",
        config,
        "--no-bundle",
        "--strict",
        "--tag",
        identity.tag,
        "--message",
        identity.message,
        "--preview-alias",
        identity.alias,
      ],
      bundleRoot,
      credentials,
    ),
    credentials,
  );
  const parsed = parseUploadOutput(uploaded.stdout, identity);
  const listed = await runChecked(
    runner,
    invocation(
      ["versions", "list", "--json", "--config", config],
      bundleRoot,
      credentials,
    ),
    credentials,
  );
  verifyListedVersion(listed.stdout, { ...parsed, ...identity });
  return validateCloudflareVersionDescriptor({
    schemaVersion: 1,
    role: input.role,
    sourceSha: input.sourceSha,
    bundleSha256: manifest.bundleSha256,
    workerName,
    versionId: parsed.versionId,
    tag: identity.tag,
    alias: identity.alias,
    url: parsed.url,
  });
}

export async function deployExactVersion(
  input: DeployVersionInput,
  runner: WranglerRunner = runWrangler,
): Promise<void> {
  const descriptor = validateCloudflareVersionDescriptor(input.descriptor);
  if (descriptor.role !== "release") {
    throw new TypeError(
      "Solo una versión release puede activar el preview compartido",
    );
  }
  const manifest = await verifiedBundle({
    bundleRoot: input.bundleRoot,
    profilePath: input.profilePath,
    profileSha256: input.profileSha256,
    role: descriptor.role,
    sourceSha: descriptor.sourceSha,
  });
  if (manifest.bundleSha256 !== descriptor.bundleSha256) {
    throw new Error(
      "El descriptor Cloudflare no coincide con el bundle sellado",
    );
  }
  const credentials = validateCredentials(input.credentials);
  const bundleRoot = resolve(input.bundleRoot);
  const config = resolve(bundleRoot, "dist", "server", "wrangler.json");
  await runChecked(
    runner,
    invocation(
      [
        "versions",
        "deploy",
        `${descriptor.versionId}@100%`,
        "--yes",
        "--config",
        config,
        "--message",
        `Shared preview release ${descriptor.sourceSha.slice(0, 7)}`,
      ],
      bundleRoot,
      credentials,
    ),
    credentials,
  );
}

export async function writeCloudflareVersionDescriptor(
  path: string,
  value: CloudflareVersionDescriptor,
): Promise<void> {
  const descriptor = validateCloudflareVersionDescriptor(value);
  const contents = Buffer.from(`${canonicalJson(descriptor)}\n`, "utf8");
  if (contents.length > maxDescriptorBytes) {
    throw new RangeError("El descriptor Cloudflare supera el tamaño permitido");
  }
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new TypeError("El directorio del descriptor Cloudflare es inválido");
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
}

export async function readCloudflareVersionDescriptor(
  path: string,
): Promise<CloudflareVersionDescriptor> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > maxDescriptorBytes
  ) {
    throw new TypeError(
      "El descriptor Cloudflare debe ser un archivo regular acotado",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new TypeError("El descriptor Cloudflare contiene JSON inválido");
  }
  return validateCloudflareVersionDescriptor(parsed);
}
