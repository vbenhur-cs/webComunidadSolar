import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  prepareCloudflareConfig,
  prepareCloudflareDryRunConfig,
} from "../../../scripts/prepare-cloudflare-config.ts";
import { canonicalJson, sha256Canonical } from "../canonical-json.ts";
import type { ChangePlan, NormalizedRequest } from "../domain.ts";
import { assertNormalizedRequest } from "../importers/common.ts";
import { validateSchema } from "../schema-validator.ts";
import {
  assertControllerStagedRepository,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";

import { selectCatalog } from "./catalog.ts";
import { selectMode } from "./mode.ts";
import {
  outputPaths,
  routeExists,
  type SourceManifestRoute,
} from "./route-impact.ts";

type PlanningPublication = ChangePlan["publication"];

declare const preparedPublicationBrand: unique symbol;

/** A publication profile returned by the Phase 3 sanitizer in this process. */
export type PreparedPlanningPublication = PlanningPublication & {
  readonly [preparedPublicationBrand]: true;
};

const preparedPublications = new WeakSet<object>();
interface PreparedPublicationRecord {
  readonly projectRoot: string;
  readonly profilePath: string;
  readonly sha256: string;
}

const preparedPublicationRecords = new WeakMap<
  PreparedPlanningPublication,
  PreparedPublicationRecord
>();

/** Opaque controller capability containing only a relocatable profile mapping. */
declare const relocatablePlanningPublicationBrand: unique symbol;
export interface RelocatablePlanningPublication {
  readonly sourceSha256: string;
  readonly [relocatablePlanningPublicationBrand]: true;
}

interface RelocatablePublicationRecord {
  readonly sourceSha256: string;
  readonly bytes: Buffer;
  readonly executionPaths: readonly string[];
}

const relocatablePublicationRecords = new WeakMap<
  RelocatablePlanningPublication,
  RelocatablePublicationRecord
>();

export interface PlanningContext {
  baselineCommit: string;
  sourceManifestPath: string;
  projectRoot?: string;
  publication: PreparedPlanningPublication;
}

export interface PublicationPreparation {
  adapter?: "local" | "cloudflare";
  configPath?: string;
  environment?: string;
  projectRoot?: string;
  /** State-owned, ignored root for the sanitized profile; never a site route. */
  stateArtifactRoot: string;
}

interface SourceManifest {
  routes: SourceManifestRoute[];
}

const manifestRouteKinds = new Set([
  "api",
  "asset",
  "gone",
  "page",
  "private-page",
  "redirect",
]);

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertBaselineCommit(value: string): string {
  if (!/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new TypeError("El baseline commit no es seguro");
  }
  return value;
}

function preparedPublication(
  publication: PlanningPublication,
  record: PreparedPublicationRecord,
): PreparedPlanningPublication {
  const profile = Object.freeze({
    adapter: publication.adapter,
    configSha256: publication.configSha256,
    environment: publication.environment,
    siteIndexable: publication.siteIndexable,
  });
  preparedPublications.add(profile);
  const prepared = profile as PreparedPlanningPublication;
  preparedPublicationRecords.set(prepared, Object.freeze(record));
  return prepared;
}

function assertPreparedPublication(
  value: unknown,
): PreparedPlanningPublication {
  if (
    typeof value !== "object" ||
    value === null ||
    !preparedPublications.has(value)
  ) {
    throw new TypeError(
      "El plan requiere un perfil de publicación preparado por Fase 3",
    );
  }
  return value as PreparedPlanningPublication;
}

function readSourceManifest(path: string, projectRoot: string): SourceManifest {
  const expected = resolve(projectRoot, "parity", "source-manifest.json");
  if (resolve(path) !== expected) {
    throw new TypeError("El manifiesto de rutas debe ser el manifiesto fijado");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new TypeError("El manifiesto de rutas no es JSON válido");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { routes?: unknown }).routes)
  ) {
    throw new TypeError("El manifiesto de rutas no es válido");
  }

  const routes = (value as { routes: unknown[] }).routes.map((route) => {
    if (
      typeof route !== "object" ||
      route === null ||
      typeof (route as { path?: unknown }).path !== "string"
    ) {
      throw new TypeError("El manifiesto contiene una ruta no válida");
    }
    const record = route as { path: string; kind?: unknown };
    if (
      typeof record.kind !== "string" ||
      !manifestRouteKinds.has(record.kind)
    ) {
      throw new TypeError("El manifiesto contiene un tipo de ruta no válido");
    }
    return {
      path: record.path,
      kind: record.kind,
    };
  });
  return { routes };
}

function defaultValidations(
  existingRoute: boolean,
  criteria: readonly string[],
): string[] {
  const validations = [
    "change-plan-schema",
    "output-path-policy",
    "dependency-policy",
    "seo-metadata",
    "privacy-policy",
    "navigation-links",
    "accessibility",
    "format",
    "lint",
    "typecheck",
    "build",
    "unit-tests",
    "preview-e2e",
  ];
  if (existingRoute) {
    validations.push("existing-route-visual-parity");
  }
  for (let index = 0; index < criteria.length; index += 1) {
    validations.push(`acceptance-criterion-${index + 1}`);
  }
  return validations;
}

const publicationProfileMaximumBytes = 1024 * 1024;
const safeName = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const safeDatabaseId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrictlyWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function assertExactKeys(
  value: JsonRecord,
  label: string,
  required: readonly string[],
  allowed: readonly string[] = required,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new TypeError(`El perfil saneado tiene ${label} no soportado`);
  }
}

function requiredString(
  value: JsonRecord,
  key: string,
  label: string,
  pattern?: RegExp,
): string {
  const result = value[key];
  if (
    typeof result !== "string" ||
    result.length === 0 ||
    (pattern !== undefined && !pattern.test(result))
  ) {
    throw new TypeError(`El perfil saneado tiene ${label} inválido`);
  }
  return result;
}

function requiredRecord(
  value: JsonRecord,
  key: string,
  label: string,
): JsonRecord {
  const result = value[key];
  if (!isRecord(result)) {
    throw new TypeError(`El perfil saneado tiene ${label} inválido`);
  }
  return result;
}

function relativeExecutionPath(
  value: string,
  label: string,
  record: PreparedPublicationRecord,
): string {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.startsWith("/")
  ) {
    throw new TypeError(`El perfil saneado tiene ${label} no mapeable`);
  }
  const sourcePath = resolve(dirname(record.profilePath), value);
  if (!isStrictlyWithin(record.projectRoot, sourcePath)) {
    throw new TypeError(`El perfil saneado tiene ${label} fuera del proyecto`);
  }
  const projectRelative = relative(record.projectRoot, sourcePath);
  if (
    projectRelative === "" ||
    projectRelative.includes("\\") ||
    projectRelative
      .split(sep)
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`El perfil saneado tiene ${label} no mapeable`);
  }
  return `./${projectRelative.split(sep).join("/")}`;
}

function normalizedVars(
  value: unknown,
  label: string,
): {
  readonly SITE_INDEXABLE: "false" | "true";
} {
  if (!isRecord(value)) {
    throw new TypeError(`El perfil saneado tiene ${label} inválido`);
  }
  assertExactKeys(value, label, ["SITE_INDEXABLE"]);
  if (value.SITE_INDEXABLE !== "false" && value.SITE_INDEXABLE !== "true") {
    throw new TypeError(`El perfil saneado tiene ${label} inválido`);
  }
  return Object.freeze({ SITE_INDEXABLE: value.SITE_INDEXABLE });
}

function normalizedDatabase(
  value: unknown,
  label: string,
  record: PreparedPublicationRecord,
  executionPaths: string[],
): {
  readonly binding: "DB";
  readonly database_id: string;
  readonly database_name: string;
  readonly migrations_dir: string;
} {
  if (!isRecord(value)) {
    throw new TypeError(`El perfil saneado tiene ${label} inválido`);
  }
  assertExactKeys(value, label, [
    "binding",
    "database_id",
    "database_name",
    "migrations_dir",
  ]);
  const binding = requiredString(value, "binding", `${label}.binding`);
  const databaseId = requiredString(
    value,
    "database_id",
    `${label}.database_id`,
    safeDatabaseId,
  );
  const databaseName = requiredString(
    value,
    "database_name",
    `${label}.database_name`,
    safeName,
  );
  const migrationsDirectory = relativeExecutionPath(
    requiredString(value, "migrations_dir", `${label}.migrations_dir`),
    `${label}.migrations_dir`,
    record,
  );
  if (binding !== "DB") {
    throw new TypeError(`El perfil saneado tiene ${label}.binding inválido`);
  }
  executionPaths.push(migrationsDirectory);
  return Object.freeze({
    binding: "DB",
    database_id: databaseId,
    database_name: databaseName,
    migrations_dir: migrationsDirectory,
  });
}

function normalizedDatabases(
  value: unknown,
  label: string,
  record: PreparedPublicationRecord,
  executionPaths: string[],
): readonly ReturnType<typeof normalizedDatabase>[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TypeError(`El perfil saneado tiene ${label} inválido`);
  }
  return Object.freeze(
    value.map((database) =>
      normalizedDatabase(database, label, record, executionPaths),
    ),
  );
}

interface RelocatableTemplate {
  readonly bytes: Buffer;
  readonly executionPaths: readonly string[];
}

function relocatableTemplate(
  source: Buffer,
  record: PreparedPublicationRecord,
  publication: PlanningPublication,
): RelocatableTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    );
  } catch {
    throw new TypeError("El perfil saneado no contiene JSON válido");
  }
  if (!isRecord(parsed)) {
    throw new TypeError("El perfil saneado no contiene un objeto válido");
  }
  const allowedTopLevel = [
    "assets",
    "compatibility_date",
    "compatibility_flags",
    "d1_databases",
    "env",
    "main",
    "name",
    "vars",
  ];
  const requiredTopLevel = allowedTopLevel.filter((key) => key !== "env");
  assertExactKeys(parsed, "campos", requiredTopLevel, allowedTopLevel);
  if (
    publication.adapter === "local" &&
    (publication.environment !== null || Object.hasOwn(parsed, "env"))
  ) {
    throw new TypeError("El perfil local no admite un environment publicado");
  }
  if (
    publication.adapter === "cloudflare" &&
    (typeof publication.environment !== "string" ||
      publication.environment.length === 0)
  ) {
    throw new TypeError("El perfil Cloudflare no tiene un environment válido");
  }

  const executionPaths: string[] = [];
  const main = relativeExecutionPath(
    requiredString(parsed, "main", "main"),
    "main",
    record,
  );
  executionPaths.push(main);
  const assets = requiredRecord(parsed, "assets", "assets");
  assertExactKeys(assets, "assets", [
    "binding",
    "directory",
    "run_worker_first",
  ]);
  const assetsBinding = requiredString(assets, "binding", "assets.binding");
  const assetsDirectory = relativeExecutionPath(
    requiredString(assets, "directory", "assets.directory"),
    "assets.directory",
    record,
  );
  if (assetsBinding !== "ASSETS" || assets.run_worker_first !== true) {
    throw new TypeError("El perfil saneado tiene assets inválido");
  }
  executionPaths.push(assetsDirectory);
  const compatibilityDate = requiredString(
    parsed,
    "compatibility_date",
    "compatibility_date",
    /^\d{4}-\d{2}-\d{2}$/u,
  );
  const compatibilityFlags = parsed.compatibility_flags;
  if (
    !Array.isArray(compatibilityFlags) ||
    compatibilityFlags.length === 0 ||
    compatibilityFlags.some(
      (flag) =>
        typeof flag !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(flag),
    ) ||
    !compatibilityFlags.includes("nodejs_compat")
  ) {
    throw new TypeError(
      "El perfil saneado tiene compatibility_flags inválidos",
    );
  }
  const baseVars = normalizedVars(parsed.vars, "vars");
  const baseDatabases = normalizedDatabases(
    parsed.d1_databases,
    "d1_databases",
    record,
    executionPaths,
  );
  const name = requiredString(parsed, "name", "name", safeName);
  let environmentConfig:
    | Readonly<
        Record<
          string,
          {
            readonly d1_databases: readonly ReturnType<
              typeof normalizedDatabase
            >[];
            readonly vars: { readonly SITE_INDEXABLE: "false" | "true" };
          }
        >
      >
    | undefined;
  const effectiveVars =
    publication.environment === null
      ? baseVars
      : (() => {
          const environments = requiredRecord(parsed, "env", "env");
          assertExactKeys(environments, "env", [publication.environment!]);
          const selected = requiredRecord(
            environments,
            publication.environment!,
            "env seleccionado",
          );
          assertExactKeys(selected, "env seleccionado", [
            "d1_databases",
            "vars",
          ]);
          const selectedVars = normalizedVars(selected.vars, "env.vars");
          const selectedDatabases = normalizedDatabases(
            selected.d1_databases,
            "env.d1_databases",
            record,
            executionPaths,
          );
          environmentConfig = Object.freeze({
            [publication.environment!]: Object.freeze({
              d1_databases: selectedDatabases,
              vars: selectedVars,
            }),
          });
          return selectedVars;
        })();
  if ((effectiveVars.SITE_INDEXABLE === "true") !== publication.siteIndexable) {
    throw new TypeError(
      "El perfil saneado no coincide con la indexación del plan",
    );
  }
  const transformed = {
    assets: {
      binding: "ASSETS" as const,
      directory: assetsDirectory,
      run_worker_first: true as const,
    },
    compatibility_date: compatibilityDate,
    compatibility_flags: [...compatibilityFlags],
    d1_databases: baseDatabases,
    ...(environmentConfig === undefined ? {} : { env: environmentConfig }),
    main,
    name,
    vars: baseVars,
  };
  return Object.freeze({
    bytes: Buffer.from(`${canonicalJson(transformed)}\n`, "utf8"),
    executionPaths: Object.freeze([...new Set(executionPaths)].sort()),
  });
}

async function readPreparedPublication(
  record: PreparedPublicationRecord,
): Promise<Buffer> {
  const entry = await lstat(record.profilePath);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.size > publicationProfileMaximumBytes
  ) {
    throw new TypeError("El perfil saneado del controlador no es regular");
  }
  const handle = await open(
    record.profilePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > publicationProfileMaximumBytes
    ) {
      throw new TypeError("El perfil saneado del controlador no es regular");
    }
    const bytes = await handle.readFile();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== record.sha256) {
      throw new TypeError("El perfil saneado cambió desde la planificación");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Reads a profile only from the private Phase 3 record associated with the
 * planning capability, then derives an opaque execution-copy-relative form.
 */
export async function createRelocatablePlanningPublication(
  publication: PreparedPlanningPublication,
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<RelocatablePlanningPublication> {
  const record = preparedPublicationRecords.get(publication);
  if (
    record === undefined ||
    !preparedPublications.has(publication) ||
    publication.adapter !== plan.publication.adapter ||
    publication.configSha256 !== plan.publication.configSha256 ||
    publication.environment !== plan.publication.environment ||
    publication.siteIndexable !== plan.publication.siteIndexable ||
    record.sha256 !== plan.publication.configSha256
  ) {
    throw new TypeError("El perfil de planificación no coincide con el plan");
  }
  await assertControllerStagedRepository(
    output,
    plan,
    attemptId,
    record.projectRoot,
  );
  const template = relocatableTemplate(
    await readPreparedPublication(record),
    record,
    plan.publication,
  );
  const relocatable = Object.freeze({
    sourceSha256: record.sha256,
  }) as RelocatablePlanningPublication;
  relocatablePublicationRecords.set(
    relocatable,
    Object.freeze({
      sourceSha256: record.sha256,
      bytes: template.bytes,
      executionPaths: template.executionPaths,
    }),
  );
  return relocatable;
}

/** Returns controller-generated config bytes only after execution-root checks. */
export function materializeRelocatablePlanningPublication(
  profile: RelocatablePlanningPublication,
  executionRoot: string,
): {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly sourceSha256: string;
} {
  const record = relocatablePublicationRecords.get(profile);
  if (record === undefined || profile.sourceSha256 !== record.sourceSha256) {
    throw new TypeError("El perfil relocatable no pertenece al controlador");
  }
  if (!isAbsolute(executionRoot)) {
    throw new TypeError("La copia de ejecución debe tener una ruta absoluta");
  }
  const root = resolve(executionRoot);
  for (const path of record.executionPaths) {
    if (!isStrictlyWithin(root, resolve(root, path))) {
      throw new TypeError("El perfil relocatable escapa la copia de ejecución");
    }
  }
  return Object.freeze({
    bytes: Buffer.from(record.bytes),
    sha256: createHash("sha256").update(record.bytes).digest("hex"),
    sourceSha256: record.sourceSha256,
  });
}

async function preparedPublicationRecord(
  projectRoot: string,
  profilePath: string,
  sha256: string,
): Promise<PreparedPublicationRecord> {
  const [canonicalProjectRoot, canonicalProfilePath] = await Promise.all([
    realpath(projectRoot),
    realpath(profilePath),
  ]);
  if (!isStrictlyWithin(canonicalProjectRoot, canonicalProfilePath)) {
    throw new TypeError("El perfil saneado no pertenece al proyecto preparado");
  }
  return Object.freeze({
    projectRoot: canonicalProjectRoot,
    profilePath: canonicalProfilePath,
    sha256,
  });
}

/**
 * Creates the publication profile before planning. This is the only planning
 * API that writes, and it writes only the Phase 3 sanitized copy under state.
 */
export async function preparePlanningPublication(
  options: PublicationPreparation,
): Promise<PreparedPlanningPublication> {
  const adapter = options.adapter ?? "local";
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const configPath = resolve(
    projectRoot,
    options.configPath ?? "wrangler.jsonc",
  );
  const artifactRoot = resolve(options.stateArtifactRoot);
  if (!isWithin(projectRoot, configPath)) {
    throw new TypeError("El config de publicación escapa del proyecto");
  }
  if (!isWithin(resolve(projectRoot, ".change-state"), artifactRoot)) {
    throw new TypeError("La copia de publicación debe vivir bajo el estado");
  }

  if (adapter === "local") {
    const prepared = await prepareCloudflareDryRunConfig(
      configPath,
      undefined,
      {
        projectRoot,
        artifactRoot,
      },
    );
    if (prepared.environment !== null || prepared.indexable) {
      throw new TypeError(
        "El perfil local debe ser no indexable y no desplegable",
      );
    }
    return preparedPublication(
      {
        adapter: "local",
        configSha256: prepared.sha256,
        environment: null,
        siteIndexable: false,
      },
      await preparedPublicationRecord(
        projectRoot,
        prepared.outputPath,
        prepared.sha256,
      ),
    );
  }

  if (options.environment === undefined || options.environment === "") {
    throw new TypeError("Cloudflare requiere un environment explícito");
  }
  const prepared = await prepareCloudflareConfig(
    configPath,
    options.environment,
    {
      projectRoot,
      artifactRoot,
    },
  );
  return preparedPublication(
    {
      adapter: "cloudflare",
      configSha256: prepared.sha256,
      environment: prepared.environment,
      siteIndexable: prepared.indexable,
    },
    await preparedPublicationRecord(
      projectRoot,
      prepared.outputPath,
      prepared.sha256,
    ),
  );
}

/** Builds a closed, deterministic plan; it never writes a page or a route. */
export function createChangePlan(
  request: NormalizedRequest,
  context: PlanningContext,
): ChangePlan {
  const normalized = assertNormalizedRequest(request);
  const baselineCommit = assertBaselineCommit(context.baselineCommit);
  const publication = assertPreparedPublication(context.publication);
  const manifest = readSourceManifest(
    context.sourceManifestPath,
    resolve(context.projectRoot ?? process.cwd()),
  );
  const selectedMode = selectMode(normalized);
  const paths = outputPaths(normalized, selectedMode);
  const overwritesExistingRoute = routeExists(
    normalized.targetPath,
    manifest.routes,
  );
  const catalog = selectCatalog(normalized);
  const files: ChangePlan["files"] = [
    {
      path: paths.route,
      operation: overwritesExistingRoute ? "modify" : "create",
    },
    { path: paths.componentsDir, operation: "create" },
    { path: paths.content, operation: "create" },
    { path: paths.stylesheet, operation: "create" },
    { path: paths.assetsDir, operation: "create" },
  ];
  const unsigned = {
    schemaVersion: 1 as const,
    changeId: normalized.changeId,
    baselineCommit,
    requestSha256: normalized.inputSha256,
    selectedMode,
    targetPath: normalized.targetPath,
    overwritesExistingRoute,
    files,
    components: [...catalog.reused, ...catalog.new],
    islands: catalog.islands,
    // NormalizedRequest has no dependency authorization field. Do not infer it.
    dependencies: [],
    validations: defaultValidations(
      overwritesExistingRoute,
      normalized.acceptanceCriteria,
    ),
    publication: {
      adapter: publication.adapter,
      configSha256: publication.configSha256,
      environment: publication.environment,
      siteIndexable: publication.siteIndexable,
    },
  };
  const plan: ChangePlan = {
    ...unsigned,
    planSha256: sha256Canonical(unsigned),
  };
  return validateSchema<ChangePlan>("change-plan", plan);
}
