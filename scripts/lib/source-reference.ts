import { execFile } from "node:child_process";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const EXPECTED_SOURCE_COMMIT =
  "68ea294c54dc5e15e20f470fc421a239927565a8" as const;

export interface SourceRef {
  repository: "../comunidadsolarweb";
  branch: "main";
  commit: typeof EXPECTED_SOURCE_COMMIT;
}

export async function git(sourceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  return stdout;
}

export async function resolveSourceRoot(sourceRoot?: string): Promise<string> {
  const explicitRoot = sourceRoot ?? process.env.COMUNIDADSOLAR_SOURCE_ROOT;
  if (explicitRoot) return resolve(explicitRoot);

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const commonGitDir = resolve(process.cwd(), stdout.trim());
    return resolve(dirname(commonGitDir), "../comunidadsolarweb");
  } catch {
    return resolve(process.cwd(), "../comunidadsolarweb");
  }
}

export async function assertSourcePristine(
  sourceRoot?: string,
  expectedCommit: string = EXPECTED_SOURCE_COMMIT,
): Promise<SourceRef> {
  const resolvedSourceRoot = await resolveSourceRoot(sourceRoot);
  const head = (await git(resolvedSourceRoot, ["rev-parse", "HEAD"])).trim();
  if (head !== expectedCommit) {
    throw new Error("Commit de referencia inesperado");
  }

  const branch = (
    await git(resolvedSourceRoot, ["branch", "--show-current"])
  ).trim();
  if (branch !== "main") {
    throw new Error("La referencia no está en branch main");
  }

  if ((await git(resolvedSourceRoot, ["status", "--porcelain=v1"])).trim()) {
    throw new Error("El repositorio fuente no está limpio");
  }

  return {
    repository: "../comunidadsolarweb",
    branch: "main",
    commit: expectedCommit as SourceRef["commit"],
  };
}

function assertRelativeGitPath(path: string): void {
  const portablePath = path.replaceAll("\\", "/");
  if (
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    portablePath.split("/").includes("..")
  ) {
    throw new Error("La ruta del blob debe ser relativa y no contener '..'");
  }
}

export async function readSourceBlob(
  path: string,
  sourceRoot?: string,
  commit: string = EXPECTED_SOURCE_COMMIT,
): Promise<Buffer> {
  assertRelativeGitPath(path);
  const resolvedSourceRoot = await resolveSourceRoot(sourceRoot);
  const { stdout } = await execFileAsync("git", ["show", `${commit}:${path}`], {
    cwd: resolvedSourceRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout as Buffer;
}
