import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maximumArchiveBytes = 128 * 1024 * 1024;
const archivePrefix = "comunidadsolar-independent-";
const rootEnvExamplePath = ".env.example";
const canonicalEnvExample = `${[
  "CLOUDFLARE_CONFIG_PATH",
  "CLOUDFLARE_ENV",
  "SOCIOS_ALLOWED_EMAILS",
  "TEAM_ALLOWED_EMAILS",
  "MANGANAFER_ALLOWED_EMAILS",
  "SITE_INDEXABLE",
  "MANGANAFER_QUOTING_BEARER_TOKEN",
  "MANGANAFER_PANEL_MONTHLY_FEE",
  "MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT",
  "MANGANAFER_PANEL_FEE_VAT",
  "MANGANAFER_AVAILABLE_PANELS",
  "MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH",
  "MANGANAFER_DISCOUNT",
  "MANGANAFER_PANEL_POWER_W",
  "MANGANAFER_ANNUAL_DEGRADATION",
  "MANGANAFER_MAXIMUM_PANELS_PER_QUOTE",
]
  .map((key) => `${key}=`)
  .join("\n")}\n`;

export type IndependentSource = "head" | "staged";

export interface IndependentCommand {
  argv: [string, ...string[]];
  cwd: string;
  executed: boolean;
}

export interface IndependentResult {
  source: IndependentSource;
  tree: string;
  archiveHasGitDirectory: boolean;
  archiveHasSiblingCheckout: boolean;
  commands: IndependentCommand[];
}

export interface VerifyIndependentOptions {
  execute?: boolean;
  source?: IndependentSource;
}

export interface VerifyIndependentDependencies {
  /** Test-only root injection; the CLI always resolves its own repository. */
  repositoryRoot?: string;
  /** Test-only parent for the one owned temporary archive session. */
  temporaryDirectory?: string;
  /** Test-only Git archive boundary for deterministic failure cleanup coverage. */
  gitArchive?: (
    repositoryRoot: string,
    tree: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<Buffer>;
  /** Test-only inherited environment before the child-process denylist. */
  childEnvironment?: NodeJS.ProcessEnv;
}

interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
}

function compareLexically(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function isBinaryPublicAsset(contents: Buffer): boolean {
  if (contents.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return false;
  } catch {
    return true;
  }
}

function hasForbiddenModuleReference(
  text: string,
  moduleName: "next" | "vinext",
): boolean {
  const quotedSpecifier = String.raw`["'\x60]${moduleName}(?:\/[^"'\x60\s)]+)?["'\x60]`;
  return new RegExp(
    String.raw`(?:\bimport\s*(?:${quotedSpecifier}|\(\s*${quotedSpecifier}\s*\)|[^\r\n;]*?\bfrom\s+${quotedSpecifier})|\bexport\s+[^\r\n;]*?\bfrom\s+${quotedSpecifier}|\brequire\s*\(\s*${quotedSpecifier}\s*\))`,
    "i",
  ).test(text);
}

async function scanSourceEntry(
  path: string,
  displayPath: string,
  violations: Set<string>,
  skipBinaryPublicAssets: boolean,
): Promise<void> {
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined) return;

  const portableDisplayPath = portablePath(displayPath);
  if (metadata.isSymbolicLink()) {
    violations.add(`${portableDisplayPath}: symlink`);
    return;
  }

  if (metadata.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((first, second) => compareLexically(first.name, second.name));
    await Promise.all(
      entries.map((entry) =>
        scanSourceEntry(
          join(path, entry.name),
          portableDisplayPath
            ? `${portableDisplayPath}/${entry.name}`
            : entry.name,
          violations,
          skipBinaryPublicAssets,
        ),
      ),
    );
    return;
  }

  if (!metadata.isFile()) return;

  if (portableDisplayPath.split("/").includes("comunidadsolarweb")) {
    violations.add(`${portableDisplayPath}: path`);
  }

  const contents = await readFile(path);
  if (skipBinaryPublicAssets && isBinaryPublicAsset(contents)) return;
  const text = contents.toString("utf8");
  if (/\bcomunidadsolarweb\b/i.test(text)) {
    violations.add(`${portableDisplayPath}: comunidadsolarweb`);
  }
  if (hasForbiddenModuleReference(text, "next")) {
    violations.add(`${portableDisplayPath}: next`);
  }
  if (hasForbiddenModuleReference(text, "vinext")) {
    violations.add(`${portableDisplayPath}: vinext`);
  }
}

/**
 * Returns deterministic violations without traversing a symlink. Missing
 * inputs are intentionally empty: the foundation has no public/ directory.
 */
export async function findSourceCheckoutReferences(
  paths: string[],
): Promise<string[]> {
  const violations = new Set<string>();
  for (const inputPath of paths) {
    const resolvedPath = resolve(inputPath);
    const metadata = await lstatIfPresent(resolvedPath);
    if (metadata === undefined) continue;
    await scanSourceEntry(
      resolvedPath,
      metadata.isDirectory() ? "" : basename(inputPath),
      violations,
      basename(resolvedPath) === "public",
    );
  }
  return [...violations].sort(compareLexically);
}

async function gitOutput(
  repositoryRoot: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      env: environment,
    });
    return stdout;
  } catch (error: unknown) {
    throw new Error("El verificador autónomo requiere un repositorio Git", {
      cause: error,
    });
  }
}

async function gitText(
  repositoryRoot: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return (await gitOutput(repositoryRoot, args, environment)).trim();
}

async function gitBuffer(
  repositoryRoot: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: maximumArchiveBytes,
      shell: false,
      env: environment,
    });
    return stdout as Buffer;
  } catch (error: unknown) {
    throw new Error("No se pudo crear el archive Git autónomo", {
      cause: error,
    });
  }
}

async function resolveRepositoryRoot(
  dependencies: VerifyIndependentDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const requestedRoot = await realpath(
    resolve(dependencies.repositoryRoot ?? process.cwd()),
  );
  const repositoryRoot = await realpath(
    resolve(
      await gitText(
        requestedRoot,
        ["rev-parse", "--show-toplevel"],
        environment,
      ),
    ),
  );
  const scriptRepositoryRoot = await realpath(
    resolve(fileURLToPath(new URL("..", import.meta.url))),
  );

  if (dependencies.repositoryRoot !== undefined) {
    if (repositoryRoot !== requestedRoot) {
      throw new Error(
        "El root inyectado debe ser el top-level del repositorio Git",
      );
    }
  } else if (repositoryRoot !== scriptRepositoryRoot) {
    throw new Error(
      "El verificador autónomo debe ejecutarse desde el repositorio Astro previsto",
    );
  }

  return repositoryRoot;
}

function statusOffenders(status: string): string[] {
  const offenders = new Set<string>();
  const records = status.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const path = portablePath(record.slice(3));
    if (indexStatus === "?" && worktreeStatus === "?") {
      offenders.add(path);
    } else if (worktreeStatus !== " ") {
      offenders.add(path);
    }

    if (indexStatus === "R" || indexStatus === "C") index += 1;
  }
  return [...offenders].sort(compareLexically);
}

async function stagedTree(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const status = await gitOutput(
    repositoryRoot,
    ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    environment,
  );
  const offenders = statusOffenders(status);
  if (offenders.length > 0) {
    throw new Error(
      `El modo --staged falla cerrado por archivos sin stage: ${offenders.join(", ")}`,
    );
  }
  return gitText(repositoryRoot, ["write-tree"], environment);
}

function isExcludedArchivePath(path: string): boolean {
  const portable = portablePath(path);
  if (portable === rootEnvExamplePath) return false;
  const segments = portable.split("/");
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      segment === ".artifacts" ||
      segment === ".source-work" ||
      segment === ".git" ||
      segment === ".env" ||
      segment.startsWith(".env.") ||
      segment === ".dev.vars" ||
      segment.startsWith(".dev.vars."),
  );
}

async function assertCanonicalEnvExample(
  entries: GitTreeEntry[],
  repositoryRoot: string,
  tree: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const entry = entries.find(
    (candidate) => portablePath(candidate.path) === rootEnvExamplePath,
  );
  if (entry === undefined) return;
  if (entry.mode !== "100644" || entry.type !== "blob") {
    throw new Error(
      "El template .env.example debe ser un archivo regular canónico",
    );
  }
  const contents = await gitBuffer(
    repositoryRoot,
    ["show", `${tree}:${rootEnvExamplePath}`],
    environment,
  );
  if (!contents.equals(Buffer.from(canonicalEnvExample, "utf8"))) {
    throw new Error(
      "El template .env.example debe contener sólo las claves canónicas vacías",
    );
  }
}

async function listArchiveTree(
  repositoryRoot: string,
  tree: string,
  environment: NodeJS.ProcessEnv,
): Promise<GitTreeEntry[]> {
  const listing = await gitBuffer(
    repositoryRoot,
    ["ls-tree", "-r", "-z", tree],
    environment,
  );
  return listing
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\t");
      const [mode = "", type = ""] = record.slice(0, separator).split(" ");
      return { mode, type, path: record.slice(separator + 1) };
    });
}

async function assertArchiveTreeIsSafe(
  repositoryRoot: string,
  tree: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const entries = await listArchiveTree(repositoryRoot, tree, environment);
  const excluded = entries
    .map((entry) => entry.path)
    .filter(isExcludedArchivePath)
    .sort(compareLexically);
  if (excluded.length > 0) {
    throw new Error(
      `El archive autónomo no debe archivar material local: ${excluded.join(", ")}`,
    );
  }
  await assertCanonicalEnvExample(entries, repositoryRoot, tree, environment);
  const symlinks = entries
    .filter((entry) => entry.mode === "120000")
    .map((entry) => entry.path)
    .sort(compareLexically);
  if (symlinks.length > 0) {
    throw new Error(
      `El archive autónomo no permite symlinks: ${symlinks.join(", ")}`,
    );
  }
}

async function extractArchive(
  archivePath: string,
  archiveRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await execFileAsync("tar", ["-xf", archivePath, "-C", archiveRoot], {
      shell: false,
      env: environment,
    });
  } catch (error: unknown) {
    throw new Error("No se pudo extraer el archive Git autónomo", {
      cause: error,
    });
  }
}

async function inspectArchive(archiveRoot: string): Promise<{
  archiveHasGitDirectory: boolean;
  archiveHasSiblingCheckout: boolean;
}> {
  const archiveHasGitDirectory =
    (await lstatIfPresent(join(archiveRoot, ".git"))) !== undefined;
  const archiveHasSiblingCheckout =
    (await lstatIfPresent(join(archiveRoot, "..", "comunidadsolarweb"))) !==
    undefined;
  if (archiveHasGitDirectory || archiveHasSiblingCheckout) {
    throw new Error(
      "El archive autónomo contiene metadatos o un sibling prohibido",
    );
  }
  return { archiveHasGitDirectory, archiveHasSiblingCheckout };
}

function plannedCommands(cwd: string): IndependentCommand[] {
  return [
    { argv: ["npm", "ci"], cwd, executed: false },
    { argv: ["npm", "run", "check"], cwd, executed: false },
    { argv: ["npm", "test"], cwd, executed: false },
    { argv: ["npm", "run", "build"], cwd, executed: false },
  ];
}

async function runCommand(
  command: IndependentCommand,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const [program, ...args] = command.argv;
  const executable =
    program === "npm" && process.platform === "win32" ? "npm.cmd" : program;
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveOutcome, reject) => {
    const child = spawn(executable, args, {
      cwd: command.cwd,
      shell: false,
      stdio: "inherit",
      env: environment,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveOutcome({ code, signal }));
  });
  if (outcome.code !== 0) {
    throw new Error(
      `${command.argv.join(" ")} terminó con código ${outcome.code ?? outcome.signal ?? "desconocido"}`,
    );
  }
  command.executed = true;
}

export function parseIndependentArguments(args: string[]): {
  source: IndependentSource;
} {
  if (args.length === 0) return { source: "head" };
  if (args.length === 1 && args[0] === "--staged") return { source: "staged" };
  throw new Error("verify:independent solo acepta --staged");
}

function sanitizeChildEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.COMUNIDADSOLAR_SOURCE_ROOT;
  delete sanitized.GIT_DIR;
  delete sanitized.GIT_WORK_TREE;
  delete sanitized.NODE_PATH;
  delete sanitized.NODE_OPTIONS;
  return sanitized;
}

export async function verifyIndependent(
  options: VerifyIndependentOptions = {},
  dependencies: VerifyIndependentDependencies = {},
): Promise<IndependentResult> {
  const source = options.source ?? "head";
  const execute = options.execute ?? true;
  const childEnvironment = sanitizeChildEnvironment(
    dependencies.childEnvironment ?? process.env,
  );
  const repositoryRoot = await resolveRepositoryRoot(
    dependencies,
    childEnvironment,
  );
  const tree =
    source === "staged"
      ? await stagedTree(repositoryRoot, childEnvironment)
      : await gitText(
          repositoryRoot,
          ["rev-parse", "HEAD^{tree}"],
          childEnvironment,
        );
  await assertArchiveTreeIsSafe(repositoryRoot, tree, childEnvironment);

  const temporaryDirectory = dependencies.temporaryDirectory ?? tmpdir();
  await mkdir(temporaryDirectory, { recursive: true });
  const sessionRoot = await mkdtemp(join(temporaryDirectory, archivePrefix));
  const archiveRoot = join(sessionRoot, "archive");
  const archivePath = join(sessionRoot, "tree.tar");
  const gitArchive =
    dependencies.gitArchive ??
    ((root: string, selectedTree: string, environment: NodeJS.ProcessEnv) =>
      gitBuffer(root, ["archive", "--format=tar", selectedTree], environment));

  try {
    await mkdir(archiveRoot);
    await writeFile(
      archivePath,
      await gitArchive(repositoryRoot, tree, childEnvironment),
      { flag: "wx" },
    );
    await extractArchive(archivePath, archiveRoot, childEnvironment);
    const archive = await inspectArchive(archiveRoot);
    const commands = plannedCommands(archiveRoot);
    if (execute) {
      for (const command of commands) {
        await runCommand(command, childEnvironment);
      }
    }
    return { source, tree, commands, ...archive };
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const run = async (): Promise<void> => {
    const { source } = parseIndependentArguments(process.argv.slice(2));
    const result = await verifyIndependent({ source, execute: true });
    process.stdout.write(
      `INDEPENDENT_OK source=${result.source} tree=${result.tree} commands=${result.commands.length}\n`,
    );
  };
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
