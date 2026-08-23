import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const changeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;

export interface IngestPathOptions {
  projectRoot?: string;
  stateRoot?: string;
}

export interface IngestPaths {
  stateRoot: string;
  changeDir: string;
  state: string;
  journal: string;
  lock: string;
  recoveryGuard: string;
  request: string;
  plan: string;
  approvalsDir: string;
  attemptsDir: string;
  candidate: string;
}

function pathContainsSegment(path: string, segment: string): boolean {
  return resolve(path)
    .split(/[\\/]+/u)
    .includes(segment);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertChangeId(changeId: string): void {
  if (!changeIdPattern.test(changeId)) {
    throw new TypeError("El identificador de cambio no es seguro");
  }
}

function assertStateRoot(stateRoot: string): void {
  if (basename(stateRoot) !== ".change-state") {
    throw new TypeError(
      "El estado debe vivir bajo un directorio .change-state",
    );
  }
  if (pathContainsSegment(stateRoot, ".agent-worktrees")) {
    throw new TypeError(
      "El estado no puede vivir dentro de un worktree de candidato",
    );
  }
}

async function existingDirectory(path: string): Promise<string> {
  let cursor = path;
  const missing: string[] = [];

  for (;;) {
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new TypeError(
          "La ruta de estado no puede atravesar enlaces simbólicos",
        );
      }
      if (!entry.isDirectory()) {
        throw new TypeError("La ruta de estado debe ser un directorio");
      }
      break;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const parent = dirname(cursor);
        if (parent === cursor) {
          throw new TypeError(
            "No se encontró un ancestro seguro para el estado",
          );
        }
        missing.unshift(basename(cursor));
        cursor = parent;
        continue;
      }
      throw error;
    }
  }

  let current = await realpath(cursor);
  for (const segment of missing) {
    const next = resolve(current, segment);
    try {
      await mkdir(next);
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    const entry = await lstat(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError(
        "La ruta de estado no puede atravesar enlaces simbólicos",
      );
    }
    current = await realpath(next);
  }
  return current;
}

async function safeChildDirectory(
  parent: string,
  child: string,
): Promise<string> {
  const path = resolve(parent, child);
  if (!isWithin(parent, path)) {
    throw new TypeError("La ruta de estado escapa de su raíz");
  }

  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError(
        "La ruta de estado no puede atravesar enlaces simbólicos",
      );
    }
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      try {
        await mkdir(path);
      } catch (mkdirError: unknown) {
        if (
          typeof mkdirError !== "object" ||
          mkdirError === null ||
          !("code" in mkdirError) ||
          mkdirError.code !== "EEXIST"
        ) {
          throw mkdirError;
        }
      }
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError(
          "La ruta de estado no puede atravesar enlaces simbólicos",
        );
      }
    } else {
      throw error;
    }
  }

  const realChild = await realpath(path);
  if (!isWithin(parent, realChild)) {
    throw new TypeError("La ruta de estado escapa de su raíz");
  }
  return realChild;
}

export function defaultStateRoot(projectRoot = process.cwd()): string {
  const root = resolve(projectRoot);
  if (pathContainsSegment(root, ".agent-worktrees")) {
    throw new TypeError(
      "El estado no puede vivir dentro de un worktree de candidato",
    );
  }
  return resolve(root, ".change-state");
}

export async function ingestPaths(
  changeId: string,
  options: IngestPathOptions = {},
): Promise<IngestPaths> {
  assertChangeId(changeId);
  const configuredRoot = resolve(
    options.stateRoot ?? defaultStateRoot(options.projectRoot),
  );
  assertStateRoot(configuredRoot);
  const stateRoot = await existingDirectory(configuredRoot);
  const changeDir = await safeChildDirectory(stateRoot, changeId);
  const approvalsDir = await safeChildDirectory(changeDir, "approvals");
  const attemptsDir = await safeChildDirectory(changeDir, "attempts");

  return {
    stateRoot,
    changeDir,
    state: resolve(changeDir, "state.json"),
    journal: resolve(changeDir, "journal.ndjson"),
    lock: resolve(changeDir, ".lock"),
    recoveryGuard: resolve(changeDir, ".recovery-guard"),
    request: resolve(changeDir, "request.json"),
    plan: resolve(changeDir, "plan.json"),
    approvalsDir,
    attemptsDir,
    candidate: resolve(changeDir, "candidate.json"),
  };
}
