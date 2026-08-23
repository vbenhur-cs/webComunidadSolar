import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import * as yauzl from "yauzl";

import {
  assertNoSuppliedSecrets,
  assertNoSuppliedSecretsBytes,
} from "./secret-scan.ts";

export const maxCompressedArchiveBytes = 25 * 1024 * 1024;
export const maxExtractedArchiveBytes = 100 * 1024 * 1024;
export const maxArchiveEntries = 500;
export const maxGeneralFileBytes = 10 * 1024 * 1024;
export const maxImageFileBytes = 25 * 1024 * 1024;

const executableExtensions = new Set([
  ".exe",
  ".dll",
  ".dylib",
  ".so",
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".app",
  ".pkg",
  ".dmg",
]);

const textExtensions = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".html",
  ".htm",
  ".json",
  ".js",
  ".jsx",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const imageExtensions = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

export interface SuppliedFile {
  path: string;
  bytes: Uint8Array;
}

export interface SuppliedPackage {
  files: SuppliedFile[];
  rawFiles: SuppliedFile[];
}

class PackageRejection extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "PackageRejection";
  }
}

function rejectPackage(message: string): never {
  throw new PackageRejection(message);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertSafePackagePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[a-zA-Z]:/u.test(path)
  ) {
    return rejectPackage("la ruta del paquete no es segura");
  }

  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.toLowerCase() === ".git" ||
        segment.toLowerCase() === "node_modules",
    )
  ) {
    return rejectPackage("la ruta del paquete no es segura");
  }

  const normalized = segments.map((segment) => segment.normalize("NFC"));
  if (
    normalized.some(
      (segment) =>
        segment.toLowerCase() === ".git" ||
        segment.toLowerCase() === "node_modules",
    )
  ) {
    return rejectPackage("la ruta del paquete no es segura");
  }

  const result = normalized.join("/");
  if (executableExtensions.has(extname(result).toLowerCase())) {
    return rejectPackage("el paquete contiene un ejecutable");
  }
  return result;
}

interface PackagePathInventory {
  entries: PackagePathRecord[];
  components: PackagePathRecord[];
}

interface PackagePathRecord {
  original: string;
  normalized: string;
}

function createPackagePathInventory(): PackagePathInventory {
  return { entries: [], components: [] };
}

/**
 * Produces a deterministic caseless equality key for supplied package paths.
 * It is never used to rewrite a path: it only detects two spellings that a
 * case-insensitive filesystem could conflate. JavaScript lacks a direct
 * Unicode default-case-fold operation, so preserve dotless-i and cover the
 * two uppercase edge forms that do not otherwise expand to their fold keys.
 */
function caselessPackagePathKey(value: string): string {
  return [...value.normalize("NFC")]
    .map((character) => {
      if (character === "\u0131") {
        return character;
      }
      if (character === "\u1E9E") {
        return "SS";
      }
      if (character === "\u03F4") {
        return "\u0398";
      }
      return character.toUpperCase();
    })
    .join("")
    .normalize("NFC");
}

function packagePathsMayCollide(left: string, right: string): boolean {
  return caselessPackagePathKey(left) === caselessPackagePathKey(right);
}

function assertComponentIsUnique(
  inventory: PackagePathInventory,
  original: string,
  normalized: string,
): void {
  if (
    inventory.components.some(
      (existing) =>
        existing.original !== original &&
        packagePathsMayCollide(existing.normalized, normalized),
    )
  ) {
    rejectPackage("el paquete contiene rutas que colisionan");
  }
  inventory.components.push({ original, normalized });
}

function assertEntryIsUnique(
  inventory: PackagePathInventory,
  original: string,
  normalized: string,
): void {
  if (
    inventory.entries.some((existing) =>
      packagePathsMayCollide(existing.normalized, normalized),
    )
  ) {
    rejectPackage("el paquete contiene rutas que colisionan");
  }
  inventory.entries.push({ original, normalized });
}

function normalizeAndRegisterPackagePath(
  path: string,
  inventory: PackagePathInventory,
): string {
  const normalized = assertSafePackagePath(path);
  const originalSegments = path.split("/");
  const normalizedSegments = normalized.split("/");
  for (let index = 0; index < normalizedSegments.length; index += 1) {
    const component = normalizedSegments.slice(0, index + 1).join("/");
    const original = originalSegments.slice(0, index + 1).join("/");
    assertComponentIsUnique(inventory, original, component);
  }
  assertEntryIsUnique(inventory, path, normalized);
  return normalized;
}

/** Validates a supplied path inventory before any file is read. */
export function validateSuppliedPackagePaths(
  paths: readonly string[],
): string[] {
  const knownPaths = createPackagePathInventory();
  return paths.map((path) => normalizeAndRegisterPackagePath(path, knownPaths));
}

function isImagePath(path: string): boolean {
  return imageExtensions.has(extname(path).toLowerCase());
}

function limitForPath(path: string): number {
  return isImagePath(path) ? maxImageFileBytes : maxGeneralFileBytes;
}

function assertTextIsSafe(path: string, bytes: Uint8Array): void {
  if (!textExtensions.has(extname(path).toLowerCase())) {
    return;
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    rejectPackage("el archivo de texto no usa UTF-8 válido");
  }
  try {
    assertNoSuppliedSecrets(source);
  } catch (error) {
    if (error instanceof TypeError) {
      rejectPackage(error.message);
    }
    throw error;
  }
}

async function readOpenedFileAtMost(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
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
  if (offset > maximumBytes) {
    rejectPackage("un archivo del paquete supera el límite permitido");
  }
  return buffer.subarray(0, offset);
}

async function readRegularFileAtMost(
  path: string,
  maximumBytes: number,
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
        rejectPackage("el paquete contiene un enlace o archivo no regular");
      }
      throw error;
    }
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) {
      rejectPackage("el paquete contiene un archivo no regular");
    }
    if ((entry.mode & 0o111) !== 0) {
      rejectPackage("el paquete contiene un archivo ejecutable");
    }
    if (entry.size > maximumBytes) {
      rejectPackage("un archivo del paquete supera el límite permitido");
    }
    return await readOpenedFileAtMost(handle, maximumBytes);
  } finally {
    await handle?.close();
  }
}

async function realPathWithin(root: string, path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!isWithin(root, canonical)) {
    rejectPackage("el paquete atraviesa un enlace simbólico");
  }
  return canonical;
}

async function readDirectoryPackage(
  rootPath: string,
): Promise<SuppliedPackage> {
  const rootEntry = await lstat(rootPath);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    rejectPackage("la carpeta aportada debe ser un directorio sin enlaces");
  }
  const root = await realpath(rootPath);
  const files: SuppliedFile[] = [];
  const paths = createPackagePathInventory();
  let entryCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => lexicalCompare(left.name, right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > maxArchiveEntries) {
        rejectPackage("el paquete supera 500 entradas");
      }
      const child = resolve(directory, entry.name);
      const relativePath =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = normalizeAndRegisterPackagePath(relativePath, paths);
      const inspected = await lstat(child);
      if (inspected.isSymbolicLink()) {
        rejectPackage("el paquete contiene un enlace simbólico");
      }
      const canonical = await realPathWithin(root, child);
      if (inspected.isDirectory()) {
        await visit(canonical, path);
        continue;
      }
      if (!inspected.isFile()) {
        rejectPackage("el paquete contiene un archivo no regular");
      }
      const bytes = await readRegularFileAtMost(canonical, limitForPath(path));
      totalBytes += bytes.byteLength;
      if (totalBytes > maxExtractedArchiveBytes) {
        rejectPackage("el paquete supera 100 MiB extraídos");
      }
      assertNoSuppliedSecretsBytes(bytes);
      assertTextIsSafe(path, bytes);
      files.push({ path, bytes });
    }
  };

  await visit(root, "");
  return { files, rawFiles: files };
}

function entryMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0o170000;
}

function entryPermissions(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0o777;
}

function isZipDirectory(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith("/");
}

async function readZipEntryAtMost(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maximumBytes: number,
): Promise<Uint8Array> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      stream.destroy();
      rejectPackage("un archivo del paquete supera el límite permitido");
    }
    chunks.push(bytes);
  }
  if (total !== entry.uncompressedSize) {
    rejectPackage("el tamaño declarado de una entrada ZIP no coincide");
  }
  return Buffer.concat(chunks, total);
}

async function readZipPackage(path: string): Promise<SuppliedPackage> {
  const bytes = await readRegularFileAtMost(path, maxCompressedArchiveBytes);
  assertNoSuppliedSecretsBytes(bytes);
  let zip: yauzl.ZipFile | undefined;
  try {
    try {
      zip = await yauzl.fromBufferPromise(Buffer.from(bytes), {
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: false,
      });
    } catch {
      rejectPackage("el archivo ZIP no es válido");
    }

    const files: SuppliedFile[] = [];
    const paths = createPackagePathInventory();
    let declaredBytes = 0;
    let extractedBytes = 0;
    if (zip.entryCount > maxArchiveEntries) {
      rejectPackage("el paquete supera 500 entradas");
    }
    for await (const entry of zip.eachEntry()) {
      const mode = entryMode(entry);
      const directory = isZipDirectory(entry);
      if (entry.isEncrypted()) {
        rejectPackage("el paquete contiene una entrada cifrada");
      }
      if (mode === 0o120000) {
        rejectPackage("el paquete contiene un enlace simbólico");
      }
      if (
        mode !== 0 &&
        mode !== 0o100000 &&
        !(directory && mode === 0o040000)
      ) {
        rejectPackage("el paquete contiene una entrada Unix especial");
      }
      const sourcePath = directory
        ? entry.fileName.slice(0, -1)
        : entry.fileName;
      const filePath = normalizeAndRegisterPackagePath(sourcePath, paths);
      if (directory) {
        continue;
      }
      if ((entryPermissions(entry) & 0o111) !== 0) {
        rejectPackage("el paquete contiene un archivo ejecutable");
      }
      const maximumBytes = limitForPath(filePath);
      if (entry.uncompressedSize > maximumBytes) {
        rejectPackage("un archivo del paquete supera el límite permitido");
      }
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > maxExtractedArchiveBytes) {
        rejectPackage("el paquete supera 100 MiB extraídos");
      }
      const content = await readZipEntryAtMost(zip, entry, maximumBytes);
      extractedBytes += content.byteLength;
      if (extractedBytes > maxExtractedArchiveBytes) {
        rejectPackage("el paquete supera 100 MiB extraídos");
      }
      assertNoSuppliedSecretsBytes(content);
      assertTextIsSafe(filePath, content);
      files.push({ path: filePath, bytes: content });
    }
    return {
      files,
      rawFiles: [{ path: basename(path), bytes }, ...files],
    };
  } finally {
    zip?.close();
  }
}

async function readSingleFilePackage(path: string): Promise<SuppliedPackage> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    rejectPackage("la página aportada debe ser un archivo regular");
  }
  const filePath = assertSafePackagePath(basename(path));
  const bytes = await readRegularFileAtMost(path, limitForPath(filePath));
  assertNoSuppliedSecretsBytes(bytes);
  assertTextIsSafe(filePath, bytes);
  const file = { path: filePath, bytes };
  return { files: [file], rawFiles: [file] };
}

/** Reads a directory, page file, or ZIP wholly as inert bytes. */
export async function readSuppliedPackage(
  path: string,
): Promise<SuppliedPackage> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      rejectPackage("el paquete no puede ser un enlace simbólico");
    }
    if (entry.isDirectory()) {
      return await readDirectoryPackage(path);
    }
    if (!entry.isFile()) {
      rejectPackage("el paquete debe ser un archivo regular, carpeta o ZIP");
    }
    if (extname(path).toLowerCase() === ".zip") {
      return await readZipPackage(path);
    }
    return await readSingleFilePackage(path);
  } catch (error) {
    if (error instanceof PackageRejection) {
      throw new TypeError(`Paquete rechazado: ${error.message}`);
    }
    const detail = error instanceof Error ? error.message : "error de lectura";
    throw new TypeError(`Paquete rechazado: ${detail}`);
  }
}
