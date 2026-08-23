import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  prepareCloudflareConfig,
  prepareCloudflareDryRunConfig,
} from "../../../scripts/prepare-cloudflare-config.ts";
import { sha256Canonical } from "../canonical-json.ts";
import type { ChangePlan, NormalizedRequest } from "../domain.ts";
import { assertNormalizedRequest } from "../importers/common.ts";
import { validateSchema } from "../schema-validator.ts";

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
): PreparedPlanningPublication {
  const profile = Object.freeze({
    adapter: publication.adapter,
    configSha256: publication.configSha256,
    environment: publication.environment,
    siteIndexable: publication.siteIndexable,
  });
  preparedPublications.add(profile);
  return profile as PreparedPlanningPublication;
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
    return preparedPublication({
      adapter: "local",
      configSha256: prepared.sha256,
      environment: null,
      siteIndexable: false,
    });
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
  return preparedPublication({
    adapter: "cloudflare",
    configSha256: prepared.sha256,
    environment: prepared.environment,
    siteIndexable: prepared.indexable,
  });
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
