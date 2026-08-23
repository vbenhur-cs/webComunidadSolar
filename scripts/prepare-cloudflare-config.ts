import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, type ParseError } from "jsonc-parser";

type JsonRecord = Record<string, unknown>;

export interface PreparedConfig {
  destination: {
    database: {
      binding: "DB";
      id: string;
      name: string;
    };
    workerName: string;
  };
  inputPath: string;
  outputPath: string;
  sha256: string;
  environment: string | null;
  indexable: boolean;
}

export interface PrepareCloudflareConfigOptions {
  /** Ignored local directory for the deterministic sanitized copy. */
  artifactRoot?: string;
  /** Root whose source and asset paths the operator profile is allowed to name. */
  projectRoot?: string;
  /** Test seam for the final, ignored artifact write. */
  artifactWriter?: CloudflareArtifactWriter;
}

export interface CloudflareArtifactWriter {
  randomUUID(): string;
  writeTemporary(path: string, contents: string): Promise<void>;
  linkTemporary(temporaryPath: string, outputPath: string): Promise<void>;
  removeTemporary(path: string): Promise<void>;
}

interface SanitizedProfile {
  assets: {
    binding: "ASSETS";
    directory: string;
    run_worker_first: true;
  };
  compatibility_date?: string;
  compatibility_flags?: string[];
  d1_databases: Array<{
    binding: "DB";
    database_id: string;
    database_name: string;
    migrations_dir: string;
  }>;
  main: string;
  name: string;
  vars: { SITE_INDEXABLE: "false" | "true" };
}

interface SanitizedConfig extends SanitizedProfile {
  env?: Record<string, Pick<SanitizedProfile, "d1_databases" | "vars">>;
}

interface SanitizeCloudflareConfigOptions {
  /** A local dry validation can inspect the repository's intentionally local D1 id. */
  allowLocalD1?: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonc(contents: string): JsonRecord {
  const errors: ParseError[] = [];
  const parsed = parse(contents, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error("El config Cloudflare debe ser JSONC válido");
  }
  return parsed;
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(lexicalCompare)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("El config Cloudflare contiene un valor no serializable");
  }
  return serialized;
}

function isSafeRelativePath(value: string): boolean {
  const portable = value.replaceAll("\\", "/");
  const segments = portable.split("/");
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !isAbsolute(value) &&
    !portable.startsWith("/") &&
    !segments.includes("..") &&
    segments.some((segment) => segment !== "" && segment !== ".")
  );
}

function requireString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error(`El config Cloudflare tiene ${label} inválido`);
  }
  return value;
}

interface SelectedEnvironment {
  base: JsonRecord;
  effective: JsonRecord;
  environment: string | null;
  rawEnvironment: JsonRecord | null;
}

function selectEnvironment(
  config: JsonRecord,
  environment: string | undefined,
): SelectedEnvironment {
  const base = { ...config };
  delete base.env;
  if (environment === undefined || environment === "") {
    return {
      base,
      effective: { ...base },
      environment: null,
      rawEnvironment: null,
    };
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(environment)) {
    throw new Error("El environment Cloudflare es inválido");
  }
  const environments = config.env;
  if (!isRecord(environments) || !isRecord(environments[environment])) {
    throw new Error(`El environment Cloudflare no existe: ${environment}`);
  }
  const selected = environments[environment];
  const baseVars = isRecord(config.vars) ? config.vars : {};
  const selectedVars = isRecord(selected.vars) ? selected.vars : {};
  return {
    base,
    effective: {
      ...base,
      ...selected,
      vars: { ...baseVars, ...selectedVars },
    },
    environment,
    rawEnvironment: selected,
  };
}

function assertNoLiteralSecrets(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoLiteralSecrets(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (key.toLowerCase() === "secrets") {
      throw new Error(
        `El config Cloudflare no puede contener secrets literales: ${nextPath}`,
      );
    }
    if (
      /(?:^|_)(?:token|secret|password|api_key|bearer|allowed_emails)$/i.test(
        key,
      ) &&
      child !== "" &&
      child !== undefined
    ) {
      throw new Error(
        `El config Cloudflare no puede contener un secret literal: ${nextPath}`,
      );
    }
    assertNoLiteralSecrets(child, nextPath);
  }
}

function configuredIndexability(vars: unknown): boolean {
  if (!isRecord(vars) || vars.SITE_INDEXABLE === undefined) return false;
  if (vars.SITE_INDEXABLE !== "true" && vars.SITE_INDEXABLE !== "false") {
    throw new Error("SITE_INDEXABLE debe ser true o false");
  }
  return vars.SITE_INDEXABLE === "true";
}

function configuredCompatibility(
  config: JsonRecord,
): Pick<SanitizedProfile, "compatibility_date" | "compatibility_flags"> {
  if (
    config.compatibility_date === undefined &&
    config.compatibility_flags === undefined
  ) {
    throw new Error(
      "El config Cloudflare requiere compatibility_date y compatibility_flags",
    );
  }
  if (
    config.compatibility_date === undefined ||
    config.compatibility_flags === undefined
  ) {
    throw new Error(
      "El config Cloudflare requiere compatibility_date y compatibility_flags",
    );
  }
  const date = requireString(
    config.compatibility_date,
    "compatibility_date",
    /^\d{4}-\d{2}-\d{2}$/,
  );
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new Error("El config Cloudflare tiene compatibility_date inválido");
  }
  if (
    !Array.isArray(config.compatibility_flags) ||
    config.compatibility_flags.length === 0 ||
    config.compatibility_flags.some(
      (flag) => typeof flag !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(flag),
    )
  ) {
    throw new Error("El config Cloudflare tiene compatibility_flags inválidos");
  }
  const flags = [...new Set(config.compatibility_flags)].sort(lexicalCompare);
  if (!flags.includes("nodejs_compat")) {
    throw new Error(
      "El config Cloudflare requiere compatibility_flags nodejs_compat",
    );
  }
  return { compatibility_date: date, compatibility_flags: flags };
}

async function rebaseProjectPath(
  projectRoot: string,
  artifactRoot: string,
  value: string,
  label: string,
): Promise<string> {
  if (!isSafeRelativePath(value)) {
    throw new Error(`El config Cloudflare tiene ${label} inválido`);
  }
  const candidate = resolve(projectRoot, value.replaceAll("\\", "/"));
  if (!isInside(projectRoot, candidate)) {
    throw new Error(`El config Cloudflare tiene ${label} fuera del proyecto`);
  }
  await assertPathHasNoSymlink(projectRoot, candidate, label);
  const rebased = relative(artifactRoot, candidate).split(sep).join("/");
  return rebased.startsWith(".") ? rebased : `./${rebased}`;
}

async function assertPathHasNoSymlink(
  projectRoot: string,
  candidate: string,
  label: string,
): Promise<void> {
  const root = resolve(projectRoot);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      "El projectRoot Cloudflare debe ser un directorio sin symlink",
    );
  }
  const segments = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `El config Cloudflare tiene ${label} a través de un symlink`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function sanitizeProfile(
  config: JsonRecord,
  projectRoot: string,
  artifactRoot: string,
  options: SanitizeCloudflareConfigOptions = {},
): Promise<SanitizedProfile> {
  const name = requireString(config.name, "name", /^[a-z0-9][a-z0-9-]{0,62}$/);
  const main = requireString(config.main, "main");
  const rebasedMain = await rebaseProjectPath(
    projectRoot,
    artifactRoot,
    main,
    "main",
  );
  if (!isRecord(config.assets)) {
    throw new Error("El config Cloudflare tiene assets inválido");
  }
  const assetsBinding = requireString(config.assets.binding, "assets.binding");
  const assetsDirectory = requireString(
    config.assets.directory,
    "assets.directory",
  );
  if (assetsBinding !== "ASSETS" || config.assets.run_worker_first !== true) {
    throw new Error("El config Cloudflare tiene assets inválido");
  }
  const rebasedAssetsDirectory = await rebaseProjectPath(
    projectRoot,
    artifactRoot,
    assetsDirectory,
    "assets",
  );
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new Error(
      "El config Cloudflare debe declarar exactamente el binding D1 DB",
    );
  }
  const [database] = config.d1_databases;
  if (!isRecord(database) || database.binding !== "DB") {
    throw new Error(
      "El config Cloudflare debe declarar exactamente el binding D1 DB",
    );
  }
  const databaseName = requireString(
    database.database_name,
    "d1 database_name",
    /^[a-z0-9][a-z0-9-]{0,62}$/,
  );
  const databaseId = requireString(
    database.database_id,
    "d1 database_id",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const localDatabaseId = new Set([
    "00000000-0000-0000-0000-000000000000",
    "00000000-0000-4000-8000-000000000000",
  ]).has(databaseId.toLowerCase());
  if (!options.allowLocalD1 && localDatabaseId) {
    throw new Error(
      "El config Cloudflare requiere un database_id de producción o preview",
    );
  }
  const migrationsDirectory = requireString(
    database.migrations_dir,
    "d1 migrations_dir",
  );
  const rebasedMigrationsDirectory = await rebaseProjectPath(
    projectRoot,
    artifactRoot,
    migrationsDirectory,
    "d1 migrations_dir",
  );
  const indexable = configuredIndexability(config.vars);
  const compatibility = configuredCompatibility(config);
  return {
    assets: {
      binding: "ASSETS",
      directory: rebasedAssetsDirectory,
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "DB",
        database_id: databaseId,
        database_name: databaseName,
        migrations_dir: rebasedMigrationsDirectory,
      },
    ],
    ...compatibility,
    main: rebasedMain,
    name,
    vars: { SITE_INDEXABLE: indexable ? "true" : "false" },
  };
}

function assertNamedEnvironmentShape(environment: JsonRecord): void {
  const unsupported = Object.keys(environment).filter(
    (key) => key !== "d1_databases" && key !== "vars",
  );
  if (unsupported.length > 0) {
    throw new Error(
      `El environment Cloudflare contiene campos no soportados: ${unsupported.sort(lexicalCompare).join(", ")}`,
    );
  }
}

async function sanitizeSelectedConfig(
  selected: SelectedEnvironment,
  projectRoot: string,
  artifactRoot: string,
  options: SanitizeCloudflareConfigOptions,
): Promise<{
  config: SanitizedConfig;
  effective: SanitizedProfile;
  indexable: boolean;
}> {
  const base = await sanitizeProfile(
    selected.base,
    projectRoot,
    artifactRoot,
    options,
  );
  if (selected.environment === null || selected.rawEnvironment === null) {
    return {
      config: base,
      effective: base,
      indexable: base.vars.SITE_INDEXABLE === "true",
    };
  }
  assertNamedEnvironmentShape(selected.rawEnvironment);
  const effective = await sanitizeProfile(
    selected.effective,
    projectRoot,
    artifactRoot,
    options,
  );
  return {
    config: {
      ...base,
      env: {
        [selected.environment]: {
          d1_databases: effective.d1_databases,
          vars: effective.vars,
        },
      },
    },
    effective,
    indexable: effective.vars.SITE_INDEXABLE === "true",
  };
}

async function readRegularFile(path: string, label: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `${label} no puede ser un symlink ni un archivo no regular`,
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(`${label} no es un archivo regular`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} no puede ser un symlink`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureDirectoryWithoutSymlinks(path: string): Promise<void> {
  const pending: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          `El directorio de artifacts no puede contener symlinks: ${current}`,
        );
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      pending.push(current);
      const parent = dirname(current);
      if (parent === current) {
        throw new Error("No se pudo crear el directorio de artifacts");
      }
      current = parent;
    }
  }
  for (const directory of pending.reverse()) {
    await mkdir(directory);
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `El directorio de artifacts no puede contener symlinks: ${directory}`,
      );
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function writeSanitizedArtifact(
  artifactRoot: string,
  contents: string,
  artifactWriter: CloudflareArtifactWriter = defaultArtifactWriter,
): Promise<{ outputPath: string; sha256: string }> {
  await ensureDirectoryWithoutSymlinks(artifactRoot);
  const rootStat = await lstat(artifactRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("El directorio de artifacts no puede ser un symlink");
  }
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const outputPath = resolve(artifactRoot, `cloudflare-${sha256}.json`);
  if (!isInside(resolve(artifactRoot), outputPath)) {
    throw new Error("El perfil saneado salió del directorio de artifacts");
  }
  try {
    const existing = await readRegularFile(outputPath, "El perfil saneado");
    if (existing !== contents) {
      throw new Error("El perfil saneado existente no coincide con su hash");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporaryPath = resolve(
      artifactRoot,
      `.cloudflare-${sha256}-${artifactWriter.randomUUID()}.tmp`,
    );
    if (!isInside(resolve(artifactRoot), temporaryPath)) {
      throw new Error("El temporal saneado salió del directorio de artifacts");
    }
    let primary: unknown;
    try {
      await artifactWriter.writeTemporary(temporaryPath, contents);
      try {
        await artifactWriter.linkTemporary(temporaryPath, outputPath);
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw linkError;
        }
        const existing = await readRegularFile(outputPath, "El perfil saneado");
        if (existing !== contents) {
          throw new Error(
            "El perfil saneado existente no coincide con su hash",
          );
        }
      }
    } catch (writeError) {
      primary = writeError;
    }
    let cleanupError: unknown;
    try {
      await artifactWriter.removeTemporary(temporaryPath);
    } catch (error) {
      cleanupError = error;
    }
    if (primary !== undefined) {
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [primary, cleanupError],
          "No se pudo limpiar el temporal del perfil saneado",
        );
      }
      throw primary;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }
  return { outputPath, sha256 };
}

const defaultArtifactWriter: CloudflareArtifactWriter = {
  randomUUID,
  async writeTemporary(path, contents) {
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
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle?.close();
    }
  },
  linkTemporary: (temporaryPath, outputPath) => link(temporaryPath, outputPath),
  removeTemporary: (path) => rm(path, { force: true }),
};

/**
 * Validates an operator-provided deployment profile without mutating it and
 * writes only a deterministic, secret-free copy under ignored artifacts.
 */
async function prepareCloudflareConfigForPurpose(
  inputPath: string,
  environment?: string,
  options: PrepareCloudflareConfigOptions = {},
  sanitizeOptions: SanitizeCloudflareConfigOptions = {},
): Promise<PreparedConfig> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const artifactRoot = resolve(
    options.artifactRoot ?? join(projectRoot, ".artifacts", "config"),
  );
  const resolvedInput = resolve(inputPath);
  const contents = await readRegularFile(resolvedInput, "El config Cloudflare");
  const config = parseJsonc(contents);
  assertNoLiteralSecrets(config);
  const selected = selectEnvironment(config, environment);
  const sanitized = await sanitizeSelectedConfig(
    selected,
    projectRoot,
    artifactRoot,
    sanitizeOptions,
  );
  const contentsToWrite = `${canonicalJson(sanitized.config)}\n`;
  const artifact = await writeSanitizedArtifact(
    artifactRoot,
    contentsToWrite,
    options.artifactWriter,
  );
  return {
    destination: {
      database: {
        binding: "DB",
        id: sanitized.effective.d1_databases[0].database_id,
        name: sanitized.effective.d1_databases[0].database_name,
      },
      workerName: sanitized.effective.name,
    },
    inputPath: resolvedInput,
    outputPath: artifact.outputPath,
    sha256: artifact.sha256,
    environment: selected.environment,
    indexable: sanitized.indexable,
  };
}

/**
 * Validates an operator-provided deployment profile. A local D1 UUID is never
 * publishable through this API.
 */
export async function prepareCloudflareConfig(
  inputPath: string,
  environment?: string,
  options: PrepareCloudflareConfigOptions = {},
): Promise<PreparedConfig> {
  return prepareCloudflareConfigForPurpose(inputPath, environment, options);
}

/**
 * Validates the repository's local profile without invoking Wrangler or any
 * network/deployment mechanism. It may inspect the intentionally local D1 id,
 * but still writes only the sanitized artifact.
 */
export async function prepareCloudflareDryRunConfig(
  inputPath: string,
  environment?: string,
  options: PrepareCloudflareConfigOptions = {},
): Promise<PreparedConfig> {
  return prepareCloudflareConfigForPurpose(inputPath, environment, options, {
    allowLocalD1: true,
  });
}

async function main(): Promise<void> {
  const inputPath = process.env.CLOUDFLARE_CONFIG_PATH ?? "wrangler.jsonc";
  const prepared = await prepareCloudflareConfig(
    inputPath,
    process.env.CLOUDFLARE_ENV,
  );
  process.stdout.write(
    `CLOUDFLARE_CONFIG_OK sha256=${prepared.sha256} indexable=${prepared.indexable} output=${prepared.outputPath}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
