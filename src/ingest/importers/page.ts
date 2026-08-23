import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";

import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { readSuppliedPackage, type SuppliedFile } from "./archive.ts";
import {
  copyRawRequest,
  normalizeIngestionText,
  normalizeRequestInput,
  parseSafeYaml,
  readRequestBytes,
  type RawArtifactOptions,
} from "./common.ts";
import { parseMarkdownFrontmatter } from "./frontmatter.ts";
import { extractSafeHtmlBody } from "./html.ts";
import {
  assertNoSuppliedSecrets,
  assertNoSuppliedSecretsBytes,
} from "./secret-scan.ts";
import type { NormalizedRequest, RequestAsset } from "../domain.ts";

const pageExtensions = new Set([".html", ".md", ".astro", ".tsx"]);

const assetMediaTypes = new Map([
  [".css", "text/css"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".astro", "text/x-astro"],
  [".cjs", "text/javascript"],
  [".ts", "text/typescript"],
  [".tsx", "text/tsx"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".jsx", "text/jsx"],
  [".json", "application/json"],
]);

const sourceImportExtensions = new Set([
  ".astro",
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

interface ParsedMetadata {
  input: Record<string, unknown>;
  entrypoint: string | undefined;
  raw: SuppliedFile | undefined;
  packagePath: string | undefined;
}

export type ImportPageOptions = RawArtifactOptions;

function ownDataRecord(value: object): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Los metadatos de página deben contener datos planos");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(
        "Los metadatos de página no admiten claves simbólicas",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(
        "Los metadatos de página deben contener propiedades de datos",
      );
    }
    result[key] = descriptor.value;
  }
  return result;
}

function decodeText(bytes: Uint8Array, description: string): string {
  try {
    return normalizeIngestionText(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new TypeError(`${description} debe usar UTF-8 válido`);
  }
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new TypeError("Los metadatos de página no son JSON válido");
  }
}

function parseMetadataValue(path: string, bytes: Uint8Array): unknown {
  const source = decodeText(bytes, "Los metadatos de página");
  assertNoSuppliedSecretsBytes(bytes);
  assertNoSuppliedSecrets(source);
  switch (extname(path).toLowerCase()) {
    case ".json":
      return parseJson(source);
    case ".yaml":
    case ".yml":
      return parseSafeYaml(source);
    case ".md":
      return parseMarkdownFrontmatter(source);
    default:
      throw new TypeError("Los metadatos deben usar .json, .yaml, .yml o .md");
  }
}

function parseMetadata(
  path: string,
  bytes: Uint8Array,
  packagePath: string | undefined,
): ParsedMetadata {
  const value = parseMetadataValue(path, bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Los metadatos de página deben ser un objeto");
  }
  const input = ownDataRecord(value);
  const entrypoint = input.entrypoint;
  delete input.entrypoint;
  if (entrypoint !== undefined && typeof entrypoint !== "string") {
    throw new TypeError("El entrypoint declarado debe ser texto");
  }
  if (Object.hasOwn(input, "content") || Object.hasOwn(input, "assets")) {
    throw new TypeError(
      "Los metadatos de página no pueden sustituir contenido ni recursos",
    );
  }
  return { input, entrypoint, raw: { path, bytes }, packagePath };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function packagePathForExternalMetadata(
  inputPath: string,
  metadataPath: string,
  files: readonly SuppliedFile[],
): Promise<string | undefined> {
  const supplied = await lstat(inputPath);
  if (supplied.isSymbolicLink() || !supplied.isDirectory()) {
    return undefined;
  }
  const metadata = await lstat(metadataPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return undefined;
  }

  const root = await realpath(inputPath);
  const canonicalMetadata = await realpath(metadataPath);
  if (!isWithin(root, canonicalMetadata)) {
    return undefined;
  }
  const packagePath = relative(root, canonicalMetadata)
    .split(sep)
    .join("/")
    .normalize("NFC");
  return files.some((file) => file.path === packagePath)
    ? packagePath
    : undefined;
}

async function loadMetadata(
  inputPath: string,
  metadataPath: string | undefined,
  files: readonly SuppliedFile[],
): Promise<ParsedMetadata> {
  if (metadataPath !== undefined) {
    const bytes = await readRequestBytes(metadataPath);
    const packagePath = await packagePathForExternalMetadata(
      inputPath,
      metadataPath,
      files,
    );
    return parseMetadata(metadataPath, bytes, packagePath);
  }

  const metadataFiles = files.filter((file) =>
    /^page-meta\.(?:json|ya?ml|md)$/iu.test(file.path),
  );
  if (metadataFiles.length === 0) {
    throw new TypeError("La página aportada requiere metadatos explícitos");
  }
  if (metadataFiles.length !== 1) {
    throw new TypeError("La página aportada declara varios metadatos");
  }
  return parseMetadata(
    metadataFiles[0].path,
    metadataFiles[0].bytes,
    metadataFiles[0].path,
  );
}

function normalizedEntrypoint(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError("El entrypoint declarado no es seguro");
  }
  return value.normalize("NFC");
}

function selectEntrypoint(
  files: readonly SuppliedFile[],
  entrypoint: string | undefined,
): SuppliedFile {
  const candidates = files.filter((file) =>
    pageExtensions.has(extname(file.path).toLowerCase()),
  );
  if (entrypoint !== undefined) {
    const selected = normalizedEntrypoint(entrypoint);
    const result = candidates.find((candidate) => candidate.path === selected);
    if (result === undefined) {
      throw new TypeError("El entrypoint declarado no existe en la página");
    }
    return result;
  }
  if (candidates.length !== 1) {
    throw new TypeError(
      "La página aportada debe incluir un único entrypoint o declararlo",
    );
  }
  return candidates[0];
}

const activeSvgReferenceAttributes = new Set(["data", "href", "src"]);

function normalizedSvgReference(value: string): string {
  return [...value]
    .filter((character) => character.codePointAt(0)! > 0x20)
    .join("")
    .toLowerCase();
}

function isExternalSvgReference(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("//") ||
    value.startsWith("data:")
  );
}

function hasUnsafeSvgUrlFunction(value: string): boolean {
  return /url\((?:["'])?(?:https?:|\/\/|data:|javascript:)/iu.test(
    normalizedSvgReference(value),
  );
}

function hasUnsafeSvgStyleContent(
  node: DefaultTreeAdapterTypes.Element,
): boolean {
  return node.childNodes.some(
    (child) =>
      "value" in child &&
      typeof child.value === "string" &&
      (normalizedSvgReference(child.value).includes("@import") ||
        hasUnsafeSvgUrlFunction(child.value)),
  );
}

function hasUnsafeSvgElement(node: DefaultTreeAdapterTypes.Element): boolean {
  const tagName = node.tagName.toLowerCase();
  if (tagName === "script") {
    return true;
  }
  if (tagName === "style" && hasUnsafeSvgStyleContent(node)) {
    return true;
  }
  if (
    node.attrs.some((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = normalizedSvgReference(attribute.value);
      return (
        name.startsWith("on") ||
        value.includes("javascript:") ||
        hasUnsafeSvgUrlFunction(attribute.value) ||
        (activeSvgReferenceAttributes.has(name) &&
          isExternalSvgReference(value))
      );
    })
  ) {
    return true;
  }
  return node.childNodes.some(
    (child) => "tagName" in child && hasUnsafeSvgElement(child),
  );
}

function hasSafeSvgBytes(bytes: Uint8Array): boolean {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const document = parseFragment(source);
  const svg = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      "tagName" in node && node.tagName.toLowerCase() === "svg",
  );
  return svg !== undefined && !hasUnsafeSvgElement(svg);
}

function hasMagicBytes(path: string, bytes: Uint8Array): boolean {
  const extension = extname(path).toLowerCase();
  const buffer = Buffer.from(bytes);
  switch (extension) {
    case ".css":
    case ".astro":
    case ".cjs":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".mjs":
    case ".jsx":
    case ".json":
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        return !buffer.includes(0);
      } catch {
        return false;
      }
    case ".svg": {
      const source = buffer.toString("utf8").trimStart().toLowerCase();
      return (
        (source.startsWith("<svg") ||
          (source.startsWith("<?xml") && source.includes("<svg"))) &&
        hasSafeSvgBytes(buffer)
      );
    }
    case ".png":
      return buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case ".jpg":
    case ".jpeg":
      return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case ".gif":
      return (
        buffer.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
        buffer.subarray(0, 6).equals(Buffer.from("GIF89a"))
      );
    case ".webp":
      return (
        buffer.subarray(0, 4).equals(Buffer.from("RIFF")) &&
        buffer.subarray(8, 12).equals(Buffer.from("WEBP"))
      );
    case ".avif":
      return buffer.subarray(4, 12).includes(Buffer.from("ftypavif"));
    default:
      return false;
  }
}

function staticImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const declarationPattern =
    /\b(?:import|export)\s+(?:[^"'`;\r\n]*?\s+from\s+)?["']([^"'\r\n]+)["']/gu;
  for (const match of source.matchAll(declarationPattern)) {
    if (match[1] !== undefined) {
      specifiers.add(match[1]);
    }
  }

  const literalCallPattern =
    /\b(?:import|require)\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*\)/gu;
  let literalCalls = 0;
  for (const match of source.matchAll(literalCallPattern)) {
    literalCalls += 1;
    if (match[2] !== undefined) {
      specifiers.add(match[2]);
    }
  }
  const allCalls = [...source.matchAll(/\b(?:import|require)\s*\(/gu)].length;
  if (allCalls !== literalCalls) {
    throw new TypeError(
      "Una importación dinámica aportada debe usar una ruta literal",
    );
  }

  return [...specifiers].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function resolveLocalImport(
  importerPath: string,
  specifier: string,
): string | undefined {
  const path = specifier.split(/[?#]/u, 1)[0] ?? "";
  if (!path.startsWith(".")) {
    return undefined;
  }
  const segments = importerPath.split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new TypeError("Una importación aportada atraviesa el paquete");
      }
      segments.pop();
      continue;
    }
    segments.push(segment.normalize("NFC"));
  }
  if (segments.length === 0) {
    throw new TypeError("Una importación aportada no identifica un archivo");
  }
  return segments.join("/");
}

function inventoryLocalSourceImports(
  entrypoint: SuppliedFile,
  files: readonly SuppliedFile[],
): Set<string> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const imported = new Set<string>();
  const inspected = new Set<string>();

  const inspect = (file: SuppliedFile): void => {
    if (inspected.has(file.path)) {
      return;
    }
    inspected.add(file.path);
    if (!sourceImportExtensions.has(extname(file.path).toLowerCase())) {
      return;
    }
    const source = decodeText(file.bytes, "El archivo importado");
    for (const specifier of staticImportSpecifiers(source)) {
      const path = resolveLocalImport(file.path, specifier);
      if (path === undefined) {
        continue;
      }
      const target = byPath.get(path);
      if (target === undefined) {
        throw new TypeError(`La importación local aportada no existe: ${path}`);
      }
      imported.add(path);
      inspect(target);
    }
  };

  inspect(entrypoint);
  return imported;
}

function inventoryAssets(
  files: readonly SuppliedFile[],
  entrypoint: SuppliedFile,
  metadata: ParsedMetadata,
): RequestAsset[] {
  const imported = inventoryLocalSourceImports(entrypoint, files);
  return files
    .filter(
      (file) =>
        file.path !== metadata.packagePath &&
        file.path !== entrypoint.path &&
        (!pageExtensions.has(extname(file.path).toLowerCase()) ||
          imported.has(file.path)),
    )
    .map((file) => {
      const mediaType = assetMediaTypes.get(extname(file.path).toLowerCase());
      if (mediaType === undefined || !hasMagicBytes(file.path, file.bytes)) {
        throw new TypeError(
          `El recurso aportado no tiene tipo o firma permitidos: ${file.path}`,
        );
      }
      return {
        path: file.path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        mediaType,
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

function extractContent(entrypoint: SuppliedFile): string {
  const source = decodeText(entrypoint.bytes, "El entrypoint aportado");
  switch (extname(entrypoint.path).toLowerCase()) {
    case ".html":
      return extractSafeHtmlBody(source);
    case ".md":
    case ".astro":
    case ".tsx":
      return source;
    default:
      throw new TypeError(
        "El entrypoint aportado no usa una extensión permitida",
      );
  }
}

async function preserveRawFiles(
  request: NormalizedRequest,
  files: readonly SuppliedFile[],
  options: ImportPageOptions,
): Promise<void> {
  for (const file of files) {
    const extension = extname(file.path).toLowerCase() || ".bin";
    await copyRawRequest(file.bytes, request, extension, options);
  }
}

/**
 * Imports a supplied page as inert text and hashed local assets. No supplied
 * HTML, TSX, Astro, or archive entry is imported or evaluated.
 */
export async function importPage(
  inputPath: string,
  metadataPath?: string,
  options: ImportPageOptions = {},
): Promise<NormalizedRequest> {
  const supplied = await readSuppliedPackage(inputPath);
  const metadata = await loadMetadata(inputPath, metadataPath, supplied.files);
  const entrypoint = selectEntrypoint(supplied.files, metadata.entrypoint);
  const request = normalizeRequestInput(
    {
      ...metadata.input,
      content: extractContent(entrypoint),
      assets: inventoryAssets(supplied.files, entrypoint, metadata),
    },
    "page",
  );
  await preserveRawFiles(
    request,
    [
      ...supplied.rawFiles,
      ...(metadataPath === undefined || metadata.raw === undefined
        ? []
        : [metadata.raw]),
    ],
    options,
  );
  return request;
}
