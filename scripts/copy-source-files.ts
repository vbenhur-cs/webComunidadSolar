import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertSourcePristine,
  readSourceBlob,
  resolveSourceRoot,
} from "./lib/source-reference.ts";

const execFileAsync = promisify(execFile);
const provenanceRelativePath = "parity/provenance.json";

export interface ProvenanceEntry {
  sourcePath: string;
  destination: string;
  sourceCommit: string;
  sha256: string;
  bytes: number;
}

interface CopyMapping {
  sourcePath: string;
  destination: string;
}

export interface CopySourceFilesOptions {
  repositoryRoot?: string;
  sourceRoot?: string;
  expectedCommit?: string;
}

function assertSafeRelativePath(path: string, label: string): string {
  const portablePath = path.replaceAll("\\", "/");
  if (
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    portablePath.split("/").includes("..")
  ) {
    throw new Error(`La ruta ${label} debe ser relativa y no contener '..'`);
  }

  const normalizedPath = posix.normalize(portablePath);
  if (normalizedPath === "." || normalizedPath.startsWith("../")) {
    throw new Error(`La ruta ${label} debe permanecer dentro del repositorio`);
  }
  return normalizedPath;
}

function parseCopyMapping(path: string): CopyMapping {
  const separator = path.indexOf(":");
  const sourcePath = separator === -1 ? path : path.slice(0, separator);
  const destination = separator === -1 ? path : path.slice(separator + 1);

  return {
    sourcePath: assertSafeRelativePath(sourcePath, "de origen"),
    destination: assertSafeRelativePath(destination, "de destino"),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  return root === candidate || isWithin(root, candidate);
}

async function repositoryRoot(): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return resolve(process.cwd(), stdout.trim());
}

async function resolveDestination(
  root: string,
  destination: string,
): Promise<string> {
  const absoluteDestination = resolve(root, destination);
  if (!isWithin(root, absoluteDestination)) {
    throw new Error("La ruta de destino queda fuera del repositorio");
  }

  const parent = dirname(absoluteDestination);
  const realRoot = await realpath(root);
  let current = root;
  for (const segment of relative(root, parent).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      await lstat(current);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError: unknown) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
    }

    const realCurrent = await realpath(current);
    if (!isWithinOrEqual(realRoot, realCurrent)) {
      throw new Error("La ruta de destino queda fuera del repositorio");
    }
  }
  return absoluteDestination;
}

async function atomicWrite(
  destination: string,
  contents: Buffer | string,
): Promise<void> {
  const temporary = resolve(
    dirname(destination),
    `.source-copy-${basename(destination)}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function compareProvenanceEntries(
  left: ProvenanceEntry,
  right: ProvenanceEntry,
): number {
  if (left.destination < right.destination) return -1;
  if (left.destination > right.destination) return 1;
  if (left.sourcePath < right.sourcePath) return -1;
  if (left.sourcePath > right.sourcePath) return 1;
  return 0;
}

function asProvenanceEntries(value: unknown): ProvenanceEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("parity/provenance.json debe contener una lista");
  }
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.sourcePath !== "string" ||
      typeof entry.destination !== "string" ||
      typeof entry.sourceCommit !== "string" ||
      typeof entry.sha256 !== "string" ||
      typeof entry.bytes !== "number"
    ) {
      throw new Error("parity/provenance.json contiene una entrada inválida");
    }
    return entry;
  });
}

async function readProvenance(root: string): Promise<ProvenanceEntry[]> {
  try {
    return asProvenanceEntries(
      JSON.parse(await readFile(resolve(root, provenanceRelativePath), "utf8")),
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeProvenance(
  root: string,
  entries: ProvenanceEntry[],
): Promise<void> {
  const destination = await resolveDestination(root, provenanceRelativePath);
  await atomicWrite(destination, `${JSON.stringify(entries, null, 2)}\n`);
}

export async function copySourceFiles(
  paths: string[],
  options: CopySourceFilesOptions = {},
): Promise<ProvenanceEntry[]> {
  const mappings = paths.map(parseCopyMapping);
  if (mappings.length === 0) return [];

  const destinations = new Set<string>();
  for (const mapping of mappings) {
    if (destinations.has(mapping.destination)) {
      throw new Error(`Destino duplicado: ${mapping.destination}`);
    }
    destinations.add(mapping.destination);
  }

  const root =
    options.repositoryRoot === undefined
      ? await repositoryRoot()
      : resolve(options.repositoryRoot);
  const sourceRoot = await resolveSourceRoot(options.sourceRoot);
  const source = await assertSourcePristine(sourceRoot, options.expectedCommit);
  const entries: ProvenanceEntry[] = [];

  for (const mapping of mappings) {
    const destination = await resolveDestination(root, mapping.destination);
    const blob = await readSourceBlob(
      mapping.sourcePath,
      sourceRoot,
      source.commit,
    );
    await atomicWrite(destination, blob);
    entries.push({
      sourcePath: mapping.sourcePath,
      destination: mapping.destination,
      sourceCommit: source.commit,
      sha256: createHash("sha256").update(blob).digest("hex"),
      bytes: blob.byteLength,
    });
  }

  const provenance = await readProvenance(root);
  const orderedEntries = entries.sort(compareProvenanceEntries);
  const orderedProvenance = [
    ...provenance.filter((entry) => !destinations.has(entry.destination)),
    ...orderedEntries,
  ].sort(compareProvenanceEntries);
  await writeProvenance(root, orderedProvenance);
  return orderedEntries;
}

async function manifestAssetPaths(root: string): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(resolve(root, "parity/source-manifest.json"), "utf8"),
  ) as { assets?: Array<{ path?: unknown }> };
  if (!Array.isArray(manifest.assets)) {
    throw new Error("parity/source-manifest.json no contiene assets");
  }
  return manifest.assets.map((asset) => {
    if (!asset || typeof asset.path !== "string") {
      throw new Error("parity/source-manifest.json contiene un asset inválido");
    }
    return asset.path;
  });
}

async function main(args: string[]): Promise<void> {
  const paths: string[] = [];
  let includePublicManifest = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--map") {
      const mapping = args[index + 1];
      if (!mapping) throw new Error("--map requiere origen:destino");
      paths.push(mapping);
      index += 1;
    } else if (argument === "--public-from-manifest") {
      includePublicManifest = true;
    } else {
      throw new Error(`Argumento desconocido: ${argument}`);
    }
  }

  if (includePublicManifest) {
    paths.push(...(await manifestAssetPaths(await repositoryRoot())));
  }
  if (paths.length === 0) throw new Error("Indica al menos un --map");

  const entries = await copySourceFiles(paths);
  process.stdout.write(`SOURCE_COPIED ${entries.length}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
