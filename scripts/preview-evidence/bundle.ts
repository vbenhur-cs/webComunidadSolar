import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { canonicalJson, sha256, type EvidenceRole } from "./domain.ts";

type JsonRecord = Record<string, unknown>;

export interface BundleLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface BundleFile {
  path: string;
  bytes: number;
  mode: 420 | 493;
  sha256: string;
}

export interface BundleTopology {
  workerName: "comunidad-solar-preview" | "comunidad-solar-production";
  database: {
    binding: "DB";
    id: string;
    name: string;
  };
  assets: {
    binding: "ASSETS";
    directory: "../client";
    runWorkerFirst: true;
  };
  sessionBinding: true;
  imagesBinding: true;
  indexable: boolean;
}

export type DeploymentTarget = "preview" | "production";

export interface BundleManifest {
  schemaVersion: 1;
  role: EvidenceRole;
  sourceSha: string;
  profileSha256: string;
  bundleSha256: string;
  topology: BundleTopology;
  files: BundleFile[];
}

export interface SealBundleInput {
  sourceRoot: string;
  outputRoot: string;
  role: EvidenceRole;
  sourceSha: string;
  profilePath: string;
  profileSha256: string;
  target?: DeploymentTarget;
}

export interface BundleExpectation {
  role: EvidenceRole;
  sourceSha: string;
  profilePath: string;
  profileSha256: string;
  target?: DeploymentTarget;
}

interface LoadedFile extends BundleFile {
  contents: Buffer;
}

function bundleFileProjection(file: LoadedFile): BundleFile {
  return {
    path: file.path,
    bytes: file.bytes,
    mode: file.mode,
    sha256: file.sha256,
  };
}

interface DeploymentProfileExpectation {
  workerName: "comunidad-solar-preview" | "comunidad-solar-production";
  compatibilityDate: string;
  compatibilityFlags: string[];
  database: { id: string; name: string };
  indexable: boolean;
}

const defaultLimits: BundleLimits = {
  maxFiles: 5_000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
};
const gitShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeRoles = new Set<EvidenceRole>(["base", "candidate", "release"]);
const forbiddenFileNames = new Set([".env", ".dev.vars", ".npmrc", ".netrc"]);

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${label} inválido`);
  return value;
}

function requireString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    value.includes("\0") ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new TypeError(`${label} inválido`);
  }
  return value;
}

function assertExactKeys(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  if (
    Object.keys(record).length !== allowed.size ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} contiene un campo no permitido`);
  }
}

function validLimits(value: BundleLimits): BundleLimits {
  if (
    !Number.isSafeInteger(value.maxFiles) ||
    value.maxFiles < 1 ||
    !Number.isSafeInteger(value.maxFileBytes) ||
    value.maxFileBytes < 1 ||
    !Number.isSafeInteger(value.maxTotalBytes) ||
    value.maxTotalBytes < 1
  ) {
    throw new TypeError("Los límites del bundle son inválidos");
  }
  return value;
}

function validateIdentity(input: {
  role: EvidenceRole;
  sourceSha: string;
  profileSha256: string;
  target?: DeploymentTarget;
}): void {
  const target = input.target ?? "preview";
  if (
    !safeRoles.has(input.role) ||
    !gitShaPattern.test(input.sourceSha) ||
    !sha256Pattern.test(input.profileSha256) ||
    (target !== "preview" && target !== "production") ||
    (target === "production" && input.role !== "release")
  ) {
    throw new TypeError("La identidad del bundle es inválida");
  }
}

async function readRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<{ contents: Buffer; mode: 420 | 493 }> {
  const stat = await lstat(path);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    throw new TypeError(`${label} no puede ser un symlink`);
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new TypeError(
      `${label} no puede ser un hardlink ni archivo especial`,
    );
  }
  if (mode !== 0o644 && mode !== 0o755) {
    throw new TypeError(`${label} tiene un mode o permiso no permitido`);
  }
  if (stat.size > maxBytes) {
    throw new RangeError(`${label} supera el tamaño máximo por archivo`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== stat.size ||
      (opened.mode & 0o777) !== mode
    ) {
      throw new TypeError(`${label} cambió durante la lectura`);
    }
    const contents = await handle.readFile();
    if (contents.length !== opened.size || contents.length > maxBytes) {
      throw new RangeError(`${label} cambió de tamaño durante la lectura`);
    }
    return { contents, mode: mode as 420 | 493 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError(`${label} no puede ser un symlink`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function portablePath(root: string, path: string): string {
  const portable = relative(root, path).split(sep).join("/");
  if (
    portable.length === 0 ||
    portable.startsWith("../") ||
    portable.includes("\0") ||
    portable !== portable.normalize("NFC") ||
    isAbsolute(portable)
  ) {
    throw new TypeError("El bundle contiene un path no portable");
  }
  return portable;
}

function rejectSecretFilename(path: string): void {
  const name = basename(path).toLowerCase();
  if (
    forbiddenFileNames.has(name) ||
    name.startsWith(".env.") ||
    name.startsWith(".dev.vars.")
  ) {
    throw new TypeError(
      "El bundle contiene un nombre de archivo secret o .env",
    );
  }
}

async function collectBundleFiles(
  root: string,
  limits: BundleLimits,
): Promise<LoadedFile[]> {
  const resolvedRoot = resolve(root);
  const result: LoadedFile[] = [];
  let totalBytes = 0;

  async function walk(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new TypeError("El bundle no puede contener symlinks");
    }
    if (!stat.isDirectory()) {
      throw new TypeError("El bundle requiere directorios regulares");
    }
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const candidate = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate);
        continue;
      }
      if (!entry.isFile()) {
        throw new TypeError("El bundle contiene un symlink o archivo especial");
      }
      const relativePath = portablePath(resolvedRoot, candidate);
      rejectSecretFilename(relativePath);
      if (result.length >= limits.maxFiles) {
        throw new RangeError("El bundle supera el número máximo de archivos");
      }
      const loaded = await readRegularFile(
        candidate,
        limits.maxFileBytes,
        "El archivo del bundle",
      );
      totalBytes += loaded.contents.length;
      if (totalBytes > limits.maxTotalBytes) {
        throw new RangeError("El bundle supera el tamaño total máximo");
      }
      result.push({
        path: relativePath,
        bytes: loaded.contents.length,
        mode: loaded.mode,
        sha256: sha256(loaded.contents),
        contents: loaded.contents,
      });
    }
  }

  for (const directory of ["dist", "drizzle"] as const) {
    await walk(resolve(resolvedRoot, directory));
  }
  result.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return result;
}

async function assertRegularDirectory(
  path: string,
  label: string,
): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(
      `${label} debe ser un directorio regular, no un symlink`,
    );
  }
}

async function assertSealedRoot(root: string): Promise<void> {
  await assertRegularDirectory(root, "El root del bundle");
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const expected = [".preview-evidence", "dist", "drizzle"];
  if (
    entries.length !== expected.length ||
    entries.some(
      (entry, index) => entry.name !== expected[index] || !entry.isDirectory(),
    )
  ) {
    throw new TypeError("El root del bundle contiene un archivo no permitido");
  }
}

async function parseJsonFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<{ value: JsonRecord; contents: Buffer }> {
  const loaded = await readRegularFile(path, maxBytes, label);
  let value: unknown;
  try {
    value = JSON.parse(loaded.contents.toString("utf8"));
  } catch {
    throw new TypeError(`${label} contiene JSON inválido`);
  }
  return { value: requireRecord(value, label), contents: loaded.contents };
}

async function loadDeploymentProfile(
  path: string,
  expectedSha256: string,
  target: DeploymentTarget,
): Promise<DeploymentProfileExpectation> {
  const { value, contents } = await parseJsonFile(
    path,
    maxRequestProfileBytes,
    "El perfil de despliegue",
  );
  if (sha256(contents) !== expectedSha256) {
    throw new Error("Falló la integridad hash del perfil de despliegue");
  }
  const expectedWorker =
    target === "preview"
      ? "comunidad-solar-preview"
      : "comunidad-solar-production";
  const vars = requireRecord(value.vars, "SITE_INDEXABLE del perfil");
  const expectedIndexability = target === "production" ? "true" : "false";
  if (
    value.name !== expectedWorker ||
    vars.SITE_INDEXABLE !== expectedIndexability ||
    Object.keys(vars).length !== 1 ||
    (target === "preview" &&
      (value.workers_dev !== true || value.preview_urls !== true)) ||
    (target === "production" &&
      (value.workers_dev !== undefined || value.preview_urls !== undefined))
  ) {
    throw new TypeError(
      `El perfil no identifica el Worker ${target} aprobado o su indexabilidad`,
    );
  }
  const compatibilityDate = requireString(
    value.compatibility_date,
    "compatibility_date del perfil",
    /^\d{4}-\d{2}-\d{2}$/u,
  );
  if (
    !Array.isArray(value.compatibility_flags) ||
    value.compatibility_flags.some((flag) => typeof flag !== "string") ||
    !value.compatibility_flags.includes("nodejs_compat")
  ) {
    throw new TypeError("Los compatibility_flags del perfil son inválidos");
  }
  if (!Array.isArray(value.d1_databases) || value.d1_databases.length !== 1) {
    throw new TypeError("El perfil preview requiere exactamente un D1 DB");
  }
  const database = requireRecord(value.d1_databases[0], "D1 del perfil");
  if (database.binding !== "DB" || database.database_name !== expectedWorker) {
    throw new TypeError("El binding D1 del perfil no coincide con el destino");
  }
  return {
    workerName: expectedWorker,
    compatibilityDate,
    compatibilityFlags: [...value.compatibility_flags] as string[],
    database: {
      id: requireString(
        database.database_id,
        "database_id del perfil",
        uuidPattern,
      ),
      name: requireString(
        database.database_name,
        "database_name del perfil",
        /^[a-z0-9][a-z0-9-]{0,62}$/u,
      ),
    },
    indexable: target === "production",
  };
}

const maxRequestProfileBytes = 64 * 1024;

function emptyCollection(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function validateGeneratedTopology(
  config: JsonRecord,
  profile: DeploymentProfileExpectation,
): BundleTopology {
  if (
    config.name !== profile.workerName ||
    (config.topLevelName !== undefined &&
      config.topLevelName !== profile.workerName)
  ) {
    throw new TypeError("El Worker name generado no coincide con el perfil");
  }
  if (config.main !== "entry.mjs") {
    throw new TypeError("El main generado debe ser entry.mjs");
  }
  if (config.no_bundle !== true) {
    throw new TypeError("El config generado requiere no_bundle=true");
  }
  if (
    config.compatibility_date !== profile.compatibilityDate ||
    canonicalJson(config.compatibility_flags) !==
      canonicalJson(profile.compatibilityFlags)
  ) {
    throw new TypeError("La compatibilidad generada no coincide con el perfil");
  }
  const assets = requireRecord(config.assets, "Los assets generados");
  if (
    assets.binding !== "ASSETS" ||
    assets.directory !== "../client" ||
    assets.run_worker_first !== true
  ) {
    throw new TypeError("La topología assets generada es inválida");
  }
  const vars = requireRecord(config.vars, "Las vars generadas");
  if (
    vars.SITE_INDEXABLE !== (profile.indexable ? "true" : "false") ||
    Object.keys(vars).length !== 1
  ) {
    throw new TypeError(
      "SITE_INDEXABLE del bundle no coincide con el perfil indexable",
    );
  }
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new TypeError("La topología D1 generada es inválida");
  }
  const database = requireRecord(config.d1_databases[0], "El D1 generado");
  if (
    database.binding !== "DB" ||
    database.database_id !== profile.database.id ||
    database.database_name !== profile.database.name ||
    database.migrations_dir !== "../../drizzle"
  ) {
    throw new TypeError("La topología D1/database generada no coincide");
  }
  if (
    !Array.isArray(config.kv_namespaces) ||
    config.kv_namespaces.length !== 1 ||
    !isRecord(config.kv_namespaces[0]) ||
    config.kv_namespaces[0].binding !== "SESSION"
  ) {
    throw new TypeError("El único KV generado debe ser SESSION");
  }
  const images = requireRecord(config.images, "El binding Images generado");
  if (images.binding !== "IMAGES") {
    throw new TypeError("El binding Images generado debe ser IMAGES");
  }
  for (const [key, value] of Object.entries({
    routes: config.routes,
    services: config.services,
    workflows: config.workflows,
    r2_buckets: config.r2_buckets,
    hyperdrive: config.hyperdrive,
    vectorize: config.vectorize,
    dispatch_namespaces: config.dispatch_namespaces,
    mtls_certificates: config.mtls_certificates,
    pipelines: config.pipelines,
    secrets_store_secrets: config.secrets_store_secrets,
  })) {
    if (!emptyCollection(value)) {
      const label = key === "routes" ? "route o dominio" : key;
      throw new TypeError(`El bundle contiene un ${label} no permitido`);
    }
  }
  if (!emptyCollection(config.triggers)) {
    throw new TypeError("El bundle contiene triggers no permitidos");
  }
  if (config.durable_objects !== undefined) {
    const durable = requireRecord(config.durable_objects, "durable_objects");
    if (!emptyCollection(durable.bindings)) {
      throw new TypeError("El bundle contiene durable objects no permitidos");
    }
  }
  if (config.queues !== undefined) {
    const queues = requireRecord(config.queues, "queues");
    if (
      !emptyCollection(queues.producers) ||
      !emptyCollection(queues.consumers)
    ) {
      throw new TypeError("El bundle contiene queues no permitidas");
    }
  }
  return {
    workerName: profile.workerName,
    database: {
      binding: "DB",
      id: profile.database.id,
      name: profile.database.name,
    },
    assets: {
      binding: "ASSETS",
      directory: "../client",
      runWorkerFirst: true,
    },
    sessionBinding: true,
    imagesBinding: true,
    indexable: profile.indexable,
  };
}

async function loadTopology(
  root: string,
  profile: DeploymentProfileExpectation,
): Promise<BundleTopology> {
  const { value } = await parseJsonFile(
    resolve(root, "dist", "server", "wrangler.json"),
    maxRequestProfileBytes,
    "El config Wrangler generado",
  );
  return validateGeneratedTopology(value, profile);
}

function unsignedManifest(
  role: EvidenceRole,
  sourceSha: string,
  profileSha256: string,
  topology: BundleTopology,
  files: BundleFile[],
): Omit<BundleManifest, "bundleSha256"> {
  return {
    schemaVersion: 1,
    role,
    sourceSha,
    profileSha256,
    topology,
    files,
  };
}

function manifestWithDigest(
  unsigned: Omit<BundleManifest, "bundleSha256">,
): BundleManifest {
  return { ...unsigned, bundleSha256: sha256(canonicalJson(unsigned)) };
}

async function assertOutputAbsent(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new TypeError("El output del bundle no puede ser un symlink");
    }
    throw new TypeError("El output del bundle ya existe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeExclusive(
  path: string,
  contents: Buffer,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(contents);
  } finally {
    await handle?.close();
  }
}

export async function createSealedBundle(
  input: SealBundleInput,
  options: { limits?: BundleLimits } = {},
): Promise<BundleManifest> {
  validateIdentity(input);
  const limits = validLimits(options.limits ?? defaultLimits);
  const sourceRoot = resolve(input.sourceRoot);
  const outputRoot = resolve(input.outputRoot);
  await assertRegularDirectory(sourceRoot, "El source del bundle");
  if (
    sourceRoot === outputRoot ||
    outputRoot.startsWith(`${sourceRoot}${sep}`)
  ) {
    throw new TypeError("El output del bundle debe estar fuera del source");
  }
  await assertOutputAbsent(outputRoot);
  const target = input.target ?? "preview";
  const profile = await loadDeploymentProfile(
    resolve(input.profilePath),
    input.profileSha256,
    target,
  );
  const topology = await loadTopology(sourceRoot, profile);
  const loaded = await collectBundleFiles(sourceRoot, limits);
  const files = loaded.map(bundleFileProjection);
  const manifest = manifestWithDigest(
    unsignedManifest(
      input.role,
      input.sourceSha,
      input.profileSha256,
      topology,
      files,
    ),
  );

  await mkdir(outputRoot, { mode: 0o700 });
  try {
    for (const file of loaded) {
      await writeExclusive(
        resolve(outputRoot, file.path),
        file.contents,
        file.mode,
      );
    }
    await writeExclusive(
      resolve(outputRoot, ".preview-evidence", "bundle-manifest.json"),
      Buffer.from(`${canonicalJson(manifest)}\n`, "utf8"),
      0o644,
    );
    return manifest;
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseBundleManifest(value: unknown): BundleManifest {
  const manifest = requireRecord(value, "El manifest del bundle");
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "role",
      "sourceSha",
      "profileSha256",
      "bundleSha256",
      "topology",
      "files",
    ],
    "El manifest del bundle",
  );
  if (
    manifest.schemaVersion !== 1 ||
    !safeRoles.has(manifest.role as EvidenceRole) ||
    typeof manifest.sourceSha !== "string" ||
    !gitShaPattern.test(manifest.sourceSha) ||
    typeof manifest.profileSha256 !== "string" ||
    !sha256Pattern.test(manifest.profileSha256) ||
    typeof manifest.bundleSha256 !== "string" ||
    !sha256Pattern.test(manifest.bundleSha256) ||
    !Array.isArray(manifest.files)
  ) {
    throw new TypeError("El manifest del bundle es inválido");
  }
  const topology = requireRecord(
    manifest.topology,
    "La topología del manifest",
  );
  assertExactKeys(
    topology,
    [
      "workerName",
      "database",
      "assets",
      "sessionBinding",
      "imagesBinding",
      "indexable",
    ],
    "La topología del manifest",
  );
  const files = manifest.files.map((entry) => {
    const file = requireRecord(entry, "Un archivo del manifest");
    assertExactKeys(
      file,
      ["path", "bytes", "mode", "sha256"],
      "Un archivo del manifest",
    );
    if (
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      (file.mode !== 420 && file.mode !== 493) ||
      typeof file.sha256 !== "string" ||
      !sha256Pattern.test(file.sha256)
    ) {
      throw new TypeError("Un archivo del manifest es inválido");
    }
    return file as unknown as BundleFile;
  });
  return {
    schemaVersion: 1,
    role: manifest.role as EvidenceRole,
    sourceSha: manifest.sourceSha,
    profileSha256: manifest.profileSha256,
    bundleSha256: manifest.bundleSha256,
    topology: topology as unknown as BundleTopology,
    files,
  };
}

export async function verifySealedBundle(
  root: string,
  expected: BundleExpectation,
  options: { limits?: BundleLimits } = {},
): Promise<BundleManifest> {
  validateIdentity(expected);
  const resolvedRoot = resolve(root);
  await assertSealedRoot(resolvedRoot);
  const manifestDirectory = resolve(resolvedRoot, ".preview-evidence");
  const manifestEntries = await readdir(manifestDirectory, {
    withFileTypes: true,
  });
  if (
    manifestEntries.length !== 1 ||
    manifestEntries[0].name !== "bundle-manifest.json" ||
    !manifestEntries[0].isFile()
  ) {
    throw new TypeError(
      "El directorio manifest del bundle contiene archivos extra",
    );
  }
  const { value } = await parseJsonFile(
    resolve(manifestDirectory, "bundle-manifest.json"),
    maxRequestProfileBytes,
    "El manifest del bundle",
  );
  const manifest = parseBundleManifest(value);
  if (
    manifest.role !== expected.role ||
    manifest.sourceSha !== expected.sourceSha ||
    manifest.profileSha256 !== expected.profileSha256
  ) {
    throw new Error(
      "La identidad del manifest no coincide con el bundle esperado",
    );
  }
  const target = expected.target ?? "preview";
  const profile = await loadDeploymentProfile(
    resolve(expected.profilePath),
    expected.profileSha256,
    target,
  );
  const topology = await loadTopology(resolvedRoot, profile);
  const loaded = await collectBundleFiles(
    resolvedRoot,
    validLimits(options.limits ?? defaultLimits),
  );
  const files = loaded.map(bundleFileProjection);
  if (canonicalJson(files) !== canonicalJson(manifest.files)) {
    throw new Error("Falló la integridad del inventario o hash del bundle");
  }
  if (canonicalJson(topology) !== canonicalJson(manifest.topology)) {
    throw new Error("Falló la integridad de la topología del bundle");
  }
  const rebuilt = manifestWithDigest(
    unsignedManifest(
      manifest.role,
      manifest.sourceSha,
      manifest.profileSha256,
      topology,
      files,
    ),
  );
  if (rebuilt.bundleSha256 !== manifest.bundleSha256) {
    throw new Error("Falló el hash sellado del bundle");
  }
  return manifest;
}
