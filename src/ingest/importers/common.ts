import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { isAlias, parseDocument, visit } from "yaml";

import { sha256Canonical } from "../canonical-json.ts";
import { type NormalizedRequest, type RequestInput } from "../domain.ts";
import { validateSchema } from "../schema-validator.ts";

export const maxRequestBytes = 1024 * 1024;
export const maxNormalizedContentBytes = 100 * 1024;

export function normalizeIngestionText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function normalizedData(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeIngestionText(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizedData(item));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("La solicitud debe contener datos planos");
  }

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError("La solicitud no admite claves simbólicas");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError("La solicitud debe contener propiedades de datos");
    }
    const normalizedKey = normalizeIngestionText(key);
    if (Object.hasOwn(result, normalizedKey)) {
      throw new TypeError(
        "La solicitud contiene claves normalizadas repetidas",
      );
    }
    result[normalizedKey] = normalizedData(descriptor.value);
  }
  return result;
}

const yamlCoreTags = new Set([
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
]);

function hasNonCoreYamlTag(value: unknown): boolean {
  return typeof value === "string" && !yamlCoreTags.has(value);
}

export function parseSafeYaml(source: string): unknown {
  const document = parseDocument(source, {
    customTags: null,
    resolveKnownTags: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    throw new TypeError("YAML no permitido");
  }

  let unsafe = false;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || hasNonCoreYamlTag(node.tag)) {
        unsafe = true;
      }
    },
  });
  if (unsafe) {
    throw new TypeError("YAML no permitido");
  }

  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new TypeError("YAML no permitido");
  }
}

export function normalizeRequestInput(value: unknown): NormalizedRequest {
  const input = validateSchema<RequestInput>(
    "request-input",
    normalizedData(value),
  );
  const content = input.content ?? "";
  if (Buffer.byteLength(content, "utf8") > maxNormalizedContentBytes) {
    throw new RangeError("El contenido normalizado supera 100 KiB");
  }

  const withoutHash = {
    schemaVersion: 1 as const,
    changeId: input.changeId,
    inputKind: "request" as const,
    intent: input.intent,
    audience: input.audience ?? null,
    targetPath: input.targetPath,
    mode: input.mode ?? "auto",
    content,
    claims: input.claims ?? [],
    references: input.references ?? [],
    assets: input.assets ?? [],
    seo: {
      title: input.seo?.title ?? null,
      description: input.seo?.description ?? null,
      index: input.seo?.index ?? true,
    },
    privacy: {
      private: input.privacy?.private ?? false,
      area: input.privacy?.area ?? null,
    },
    allowedExternalLinks: input.allowedExternalLinks ?? [],
    acceptanceCriteria: input.acceptanceCriteria,
  };
  const normalized: NormalizedRequest = {
    ...withoutHash,
    inputSha256: sha256Canonical(withoutHash),
  };
  return assertNormalizedRequest(normalized);
}

export function assertNormalizedRequest(value: unknown): NormalizedRequest {
  const normalized = validateSchema<NormalizedRequest>(
    "normalized-request",
    value,
  );
  const { inputSha256, ...withoutHash } = normalized;
  if (inputSha256 !== sha256Canonical(withoutHash)) {
    throw new TypeError("El hash de la solicitud normalizada no coincide");
  }
  return normalized;
}

function rawArtifactName(bytes: Uint8Array, extension: string): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `${hash}${extension}`;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function unsafeArtifactPath(path: string): TypeError {
  return new TypeError(
    `El artefacto crudo no puede atravesar enlaces simbólicos: ${path}`,
  );
}

async function ensureArtifactRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw unsafeArtifactPath(absolute);
    }
    return realpath(absolute);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) {
      throw unsafeArtifactPath(absolute);
    }
    existing = parent;
    try {
      const entry = await lstat(existing);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw unsafeArtifactPath(existing);
      }
      break;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
  }

  let current = await realpath(existing);
  for (const segment of missing) {
    const next = resolve(current, segment);
    try {
      await mkdir(next);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }
    const entry = await lstat(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw unsafeArtifactPath(next);
    }
    current = await realpath(next);
  }
  return current;
}

async function ensureArtifactChild(
  parent: string,
  segment: string,
): Promise<string> {
  const candidate = resolve(parent, segment);
  if (!isWithin(parent, candidate)) {
    throw unsafeArtifactPath(candidate);
  }
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(candidate);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
    try {
      await mkdir(candidate);
    } catch (mkdirError) {
      if (!isNodeError(mkdirError, "EEXIST")) {
        throw mkdirError;
      }
    }
    entry = await lstat(candidate);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw unsafeArtifactPath(candidate);
  }
  const canonical = await realpath(candidate);
  if (!isWithin(parent, canonical)) {
    throw unsafeArtifactPath(candidate);
  }
  return canonical;
}

async function rawArtifactDirectory(
  artifactRoot: string,
  request: NormalizedRequest,
): Promise<string> {
  let directory = await ensureArtifactRoot(artifactRoot);
  for (const segment of [
    "intake",
    request.changeId,
    request.inputSha256,
    "raw",
  ]) {
    directory = await ensureArtifactChild(directory, segment);
  }
  return directory;
}

async function readExistingRawArtifact(
  path: string,
  expected: Uint8Array,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error, "ELOOP")) {
        throw unsafeArtifactPath(path);
      }
      throw error;
    }
    const opened = await handle.stat();
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !opened.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== expected.byteLength
    ) {
      throw unsafeArtifactPath(path);
    }
    const existing = await handle.readFile();
    if (!existing.equals(expected)) {
      throw new TypeError("El artefacto crudo no coincide con su hash");
    }
  } finally {
    await handle?.close();
  }
}

async function syncArtifactDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ELOOP") || isNodeError(error, "ENOTDIR")) {
        throw unsafeArtifactPath(directory);
      }
      throw error;
    }
    if (!(await handle.stat()).isDirectory()) {
      throw unsafeArtifactPath(directory);
    }
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeRawArtifact(
  directory: string,
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = resolve(directory, `.intake-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let primary: unknown;
  try {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      temporaryCreated = true;
      await handle.writeFile(bytes);
      await handle.sync();
      const entry = await handle.stat();
      if (!entry.isFile() || entry.size !== bytes.byteLength) {
        throw new TypeError("El temporal de intake no es un archivo regular");
      }
    } finally {
      await handle?.close();
    }

    try {
      await link(temporary, target);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      await readExistingRawArtifact(target, bytes);
    }
  } catch (error) {
    primary = error;
  }

  let cleanupError: unknown;
  if (temporaryCreated) {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        cleanupError = error;
      }
    }
    try {
      await syncArtifactDirectory(directory);
    } catch (error) {
      cleanupError =
        cleanupError === undefined
          ? error
          : new AggregateError(
              [cleanupError, error],
              "No se pudo limpiar el temporal del artefacto crudo",
            );
    }
  }
  if (primary !== undefined) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [primary, cleanupError],
        "No se pudo limpiar el temporal del artefacto crudo",
      );
    }
    throw primary;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
}

export interface RawArtifactOptions {
  artifactRoot?: string;
}

export async function copyRawRequest(
  bytes: Uint8Array,
  request: NormalizedRequest,
  extension: string,
  options: RawArtifactOptions = {},
): Promise<void> {
  const rawDirectory = await rawArtifactDirectory(
    options.artifactRoot ?? resolve(process.cwd(), ".artifacts"),
    request,
  );
  const target = resolve(rawDirectory, rawArtifactName(bytes, extension));
  await writeRawArtifact(rawDirectory, target, bytes);
}

export interface ReadRequestBytesOptions {
  /** @internal Exercises a deterministic mutation after the opened file is verified. */
  afterOpenStat?: () => Promise<void>;
}

async function readAtMostRequestBytes(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(maxRequestBytes + 1);
  let offset = 0;

  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  if (offset > maxRequestBytes) {
    throw new RangeError("La solicitud supera 1 MiB");
  }
  return buffer.subarray(0, offset);
}

export async function readRequestBytes(
  path: string,
  options: ReadRequestBytesOptions = {},
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (isNodeError(error, "ELOOP") || isNodeError(error, "EISDIR")) {
        throw new TypeError("La solicitud debe ser un archivo regular");
      }
      throw error;
    }

    const entry = await handle.stat();
    if (!entry.isFile()) {
      throw new TypeError("La solicitud debe ser un archivo regular");
    }
    if (entry.size > maxRequestBytes) {
      throw new RangeError("La solicitud supera 1 MiB");
    }

    await options.afterOpenStat?.();
    return await readAtMostRequestBytes(handle);
  } finally {
    await handle?.close();
  }
}
