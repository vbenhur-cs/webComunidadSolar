import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

interface FileEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly mode: "0644" | "0755";
  readonly identity: FileIdentity;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function isWithin(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return (
    remainder === "" ||
    (!isAbsolute(remainder) &&
      remainder !== ".." &&
      !remainder.startsWith(`..${sep}`))
  );
}

function normalizedMode(mode: number): "0644" | "0755" {
  return (mode & 0o111) === 0 ? "0644" : "0755";
}

function fileIdentity(entry: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): FileIdentity {
  return Object.freeze({
    device: entry.dev,
    inode: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: {
    readonly dev: number;
    readonly ino: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  },
): boolean {
  return (
    left.device === right.dev &&
    left.inode === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectFiles(root: string): Promise<{
  readonly files: readonly FileEntry[];
  readonly directories: readonly DirectoryIdentity[];
}> {
  const files: FileEntry[] = [];
  const directories: DirectoryIdentity[] = [];

  async function visit(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const before = await lstat(directory);
    if (before.isSymbolicLink()) {
      throw new TypeError("El árbol contiene un enlace simbólico");
    }
    if (!before.isDirectory()) {
      throw new TypeError(
        "El árbol candidato contiene una entrada no directorio",
      );
    }
    directories.push(
      Object.freeze({
        path: directory,
        device: before.dev,
        inode: before.ino,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      }),
    );

    const handle = await opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) {
      if (!safeName(entry.name)) {
        throw new TypeError("El árbol contiene una ruta no segura");
      }
      names.push(entry.name);
    }
    names.sort(lexicalCompare);
    for (const name of names) {
      const relativePath =
        relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const path = join(directory, name);
      if (!isWithin(root, path)) {
        throw new TypeError("El árbol contiene una ruta que escapa de su raíz");
      }
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        throw new TypeError("El árbol contiene un enlace simbólico");
      }
      if (entry.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new TypeError("El árbol contiene un archivo especial");
      }
      if (entry.nlink !== 1) {
        throw new TypeError("El árbol contiene un hardlink inseguro");
      }
      files.push(
        Object.freeze({
          path,
          relativePath,
          mode: normalizedMode(entry.mode),
          identity: fileIdentity(entry),
        }),
      );
    }
  }

  await visit(root, "");
  files.sort((left, right) =>
    lexicalCompare(left.relativePath, right.relativePath),
  );
  return Object.freeze({
    files: Object.freeze(files),
    directories: Object.freeze(directories),
  });
}

async function updateWithStableFile(
  tree: ReturnType<typeof createHash>,
  file: FileEntry,
): Promise<void> {
  const handle = await open(
    file.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !sameFileIdentity(file.identity, fileIdentity(before))
    ) {
      throw new TypeError("El árbol contiene un hardlink o archivo no regular");
    }
    tree.update(file.relativePath, "utf8");
    tree.update("\0", "utf8");
    tree.update(file.mode, "utf8");
    tree.update("\0", "utf8");

    const fileHash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      bytes += bytesRead;
      tree.update(chunk);
      fileHash.update(chunk);
    }

    const after = await handle.stat();
    if (
      bytes !== before.size ||
      !sameFileIdentity(file.identity, fileIdentity(before)) ||
      !sameFileIdentity(fileIdentity(before), fileIdentity(after))
    ) {
      throw new TypeError("El árbol cambió durante el cálculo del digest");
    }
    tree.update("\0", "utf8");
    tree.update(fileHash.digest("hex"), "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Hashes a candidate tree deterministically. Only regular, single-linked files
 * participate; mtimes and directory enumeration order never affect the result.
 */
export async function hashTree(rootInput: string): Promise<string> {
  const requestedRoot = resolve(rootInput);
  const rootEntry = await lstat(requestedRoot);
  if (rootEntry.isSymbolicLink()) {
    throw new TypeError("La raíz del árbol no puede ser un enlace simbólico");
  }
  if (!rootEntry.isDirectory()) {
    throw new TypeError("La raíz del árbol candidato debe ser un directorio");
  }
  const root = await realpath(requestedRoot);

  const collected = await collectFiles(root);
  const tree = createHash("sha256");
  for (const file of collected.files) {
    await updateWithStableFile(tree, file);
  }

  for (const directory of collected.directories) {
    const current = await lstat(directory.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameDirectoryIdentity(directory, current)
    ) {
      throw new TypeError("El árbol cambió durante el cálculo del digest");
    }
  }
  return tree.digest("hex");
}
