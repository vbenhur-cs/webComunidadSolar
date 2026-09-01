import { posix } from "node:path";

import type { ChangePlan } from "../domain.ts";

const imageExtensions = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const fontExtensions = new Set([".woff", ".woff2"]);
const maximumImageDimension = 8192;

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function hasMagic(bytes: Buffer, extension: string): boolean {
  const prefix = (length: number) =>
    bytes.subarray(0, length).toString("ascii");
  switch (extension) {
    case ".png":
      return (
        bytes.length >= 8 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    case ".jpg":
    case ".jpeg":
      return (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );
    case ".gif":
      return prefix(6) === "GIF87a" || prefix(6) === "GIF89a";
    case ".webp":
      return (
        bytes.length >= 12 &&
        prefix(4) === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case ".avif": {
      const brand = bytes.subarray(8, 12).toString("ascii");
      return (
        bytes.length >= 12 &&
        bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
        (brand === "avif" || brand === "avis")
      );
    }
    case ".ico":
      return (
        bytes.length >= 4 &&
        bytes[0] === 0 &&
        bytes[1] === 0 &&
        bytes[2] === 1 &&
        bytes[3] === 0
      );
    case ".woff":
      return prefix(4) === "wOFF";
    case ".woff2":
      return prefix(4) === "wOF2";
    default:
      return false;
  }
}

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  if (
    bytes.length < 24 ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function icoDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 8) return null;
  return {
    width: bytes[6] === 0 ? 256 : bytes[6]!,
    height: bytes[7] === 0 ? 256 : bytes[7]!,
  };
}

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  let index = 2;
  while (index + 8 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }
    while (bytes[index] === 0xff) index += 1;
    const marker = bytes[index];
    if (marker === undefined) return null;
    index += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (index + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(index);
    if (length < 2 || index + length > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) return null;
      return {
        height: bytes.readUInt16BE(index + 3),
        width: bytes.readUInt16BE(index + 5),
      };
    }
    index += length;
  }
  return null;
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const kind = bytes.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    const value = bytes.readUInt32LE(21);
    return {
      width: (value & 0x3fff) + 1,
      height: ((value >>> 14) & 0x3fff) + 1,
    };
  }
  if (
    kind === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function avifDimensions(bytes: Buffer): ImageDimensions | null {
  for (let index = 4; index + 16 <= bytes.length; index += 1) {
    if (bytes.subarray(index, index + 4).toString("ascii") !== "ispe") continue;
    return {
      width: bytes.readUInt32BE(index + 8),
      height: bytes.readUInt32BE(index + 12),
    };
  }
  return null;
}

function dimensions(bytes: Buffer, extension: string): ImageDimensions | null {
  switch (extension) {
    case ".png":
      return pngDimensions(bytes);
    case ".gif":
      return gifDimensions(bytes);
    case ".ico":
      return icoDimensions(bytes);
    case ".jpg":
    case ".jpeg":
      return jpegDimensions(bytes);
    case ".webp":
      return webpDimensions(bytes);
    case ".avif":
      return avifDimensions(bytes);
    default:
      return null;
  }
}

/** Rechecks magic bytes and dimensions of controller-inventoried public assets. */
export function validateGeneratedAssets(
  plan: ChangePlan,
  files: ReadonlyMap<string, Buffer>,
): readonly string[] {
  const findings: string[] = [];
  const root = `public/generated/${plan.changeId}/`;
  for (const [path, bytes] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!path.startsWith(root)) continue;
    const extension = posix.extname(path).toLowerCase();
    if (!imageExtensions.has(extension) && !fontExtensions.has(extension)) {
      findings.push(`asset.type: ${path} no es un asset público inerte`);
      continue;
    }
    if (!hasMagic(bytes, extension)) {
      findings.push(
        `asset.magic: ${path} no coincide con su formato declarado`,
      );
      continue;
    }
    if (!imageExtensions.has(extension)) continue;
    const size = dimensions(bytes, extension);
    if (size === null) {
      findings.push(
        `asset.dimensions: no se pudieron determinar las dimensiones de ${path}`,
      );
      continue;
    }
    if (
      size.width < 1 ||
      size.height < 1 ||
      size.width > maximumImageDimension ||
      size.height > maximumImageDimension
    ) {
      findings.push(
        `asset.dimensions: ${path} tiene dimensiones fuera de rango`,
      );
    }
  }
  return findings;
}
