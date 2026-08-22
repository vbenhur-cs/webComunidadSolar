import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import ts from "typescript";

import {
  assertSourcePristine,
  git,
  readSourceBlob,
  resolveSourceRoot,
  type SourceRef,
} from "./source-reference.ts";

export type RouteKind =
  "page" | "private-page" | "api" | "redirect" | "gone" | "asset";

export type PrivateArea = "socios" | "equipo" | "manganafer";

export interface RouteContract {
  path: string;
  kind: RouteKind;
  sourceFile: string;
  fixtureId: string | null;
  expectedStatus: number;
  expectedLocation: string | null;
  privateArea: PrivateArea | null;
  visualTemplate: string | null;
}

export interface SourceFileInventoryEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface PublicAssetInventoryEntry extends SourceFileInventoryEntry {
  mediaType: string;
}

export interface SourceManifest {
  schemaVersion: 1;
  source: SourceRef;
  generatedAt: string;
  routes: RouteContract[];
  sourceFiles: SourceFileInventoryEntry[];
  assets: PublicAssetInventoryEntry[];
  wordpressAudit: { total: 122; unclassified: string[] };
}

export interface SourceRepository {
  assertPristine(): Promise<SourceRef>;
  listFiles(): Promise<string[]>;
  readBlob(path: string): Promise<Buffer>;
}

export interface BuildSourceManifestOptions {
  source?: SourceRepository;
  generatedAt?: string;
}

export interface RouteMatrixEntry extends RouteContract {
  status: string;
  [key: string]: unknown;
}

export interface WriteSourceManifestOptions {
  root?: string;
}

interface PureSourceModules {
  community: Record<string, unknown>;
  blog: Record<string, unknown>;
  remote: Record<string, unknown>;
  legacy: Record<string, unknown>;
}

interface LegacyRedirect {
  from: string;
  to: string;
}

interface LegacyInventory {
  redirects: LegacyRedirect[];
  gone: string[];
  pending: string[];
  preserved: string[];
  wordpressPaths: string[];
}

const sourceModulePaths = {
  community: "app/community-data.ts",
  blog: "app/blog-data.ts",
  remote: "app/remote-project-data.ts",
  legacy: "app/legacy-routes.ts",
} as const;

const privateAreas = new Map<string, PrivateArea>([
  ["/socios", "socios"],
  ["/guia-equipo", "equipo"],
  ["/guia-equipo-nueva-web-comunidad-solar.md", "equipo"],
  ["/manganafer/interesados", "manganafer"],
  ["/api/manganafer-interest/export", "manganafer"],
]);

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRouteContract(
  left: Pick<RouteContract, "kind" | "path" | "fixtureId">,
  right: Pick<RouteContract, "kind" | "path" | "fixtureId">,
): number {
  return (
    compareText(left.kind, right.kind) ||
    compareText(left.path, right.path) ||
    compareText(left.fixtureId ?? "", right.fixtureId ?? "")
  );
}

function routeKey(route: Pick<RouteContract, "kind" | "path">): string {
  return `${route.kind}\u0000${route.path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} debe ser un texto`);
  }
  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} debe ser una lista`);
  }
  return value.map((entry, index) => readString(entry, `${label}[${index}]`));
}

function readSlugList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} debe ser una lista`);
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${label}[${index}] debe ser un objeto`);
    }
    return readString(entry.slug, `${label}[${index}].slug`);
  });
}

function readLegacyInventory(module: Record<string, unknown>): LegacyInventory {
  const redirectsValue = module.legacyRedirects;
  if (!Array.isArray(redirectsValue)) {
    throw new Error("legacyRedirects debe ser una lista");
  }
  const redirects = redirectsValue.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`legacyRedirects[${index}] debe ser un objeto`);
    }
    return {
      from: readString(entry.from, `legacyRedirects[${index}].from`),
      to: readString(entry.to, `legacyRedirects[${index}].to`),
    };
  });

  const pendingValue = module.legacyRoutesPendingDecision;
  if (!Array.isArray(pendingValue)) {
    throw new Error("legacyRoutesPendingDecision debe ser una lista");
  }
  const pending = pendingValue.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(
        `legacyRoutesPendingDecision[${index}] debe ser un objeto`,
      );
    }
    return readString(entry.path, `legacyRoutesPendingDecision[${index}].path`);
  });

  return {
    redirects,
    gone: readStringArray(module.legacyGonePaths, "legacyGonePaths"),
    pending,
    preserved: readStringArray(
      module.legacyPreservedPaths,
      "legacyPreservedPaths",
    ),
    wordpressPaths: readStringArray(
      module.legacyWordPressSitemapPaths,
      "legacyWordPressSitemapPaths",
    ),
  };
}

function sourceFileEntry(path: string, blob: Buffer): SourceFileInventoryEntry {
  return {
    path,
    sha256: createHash("sha256").update(blob).digest("hex"),
    bytes: blob.byteLength,
  };
}

const publicAssetMediaTypes: Readonly<Record<string, string>> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function publicAssetMediaType(path: string): string {
  if (!path.startsWith("public/")) {
    throw new Error(`El asset público debe vivir en public/: ${path}`);
  }
  const mediaType = publicAssetMediaTypes[extname(path).toLowerCase()];
  if (mediaType === undefined) {
    throw new Error(`Media type público no declarado: ${path}`);
  }
  return mediaType;
}

function sourceFileComparator(
  left: SourceFileInventoryEntry,
  right: SourceFileInventoryEntry,
): number {
  return compareText(left.path, right.path);
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

export function extractGenericSlugKeys(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "app/[slug]/page.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let pages: ts.ObjectLiteralExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      pages === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "pages" &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      pages = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (pages === undefined) {
    throw new Error("No se encontró el objeto pages en app/[slug]/page.tsx");
  }

  const keys: string[] = [];
  for (const property of pages.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        "El objeto pages contiene una propiedad no inventariable",
      );
    }
    const key = propertyNameText(property.name);
    if (key === null) {
      throw new Error("El objeto pages contiene una clave calculada");
    }
    keys.push(key);
  }

  if (new Set(keys).size !== keys.length) {
    throw new Error("El objeto pages contiene claves duplicadas");
  }
  return keys;
}

export function appFileToRoute(file: string): string {
  return file
    .replace(/^app/, "")
    .replace(/\/(?:page\.tsx|route\.ts)$/, "")
    .replace(/^$/, "/");
}

async function loadPureSourceModules(
  blobs: ReadonlyMap<string, Buffer>,
): Promise<PureSourceModules> {
  const root = await mkdtemp(join(tmpdir(), "comunidad-solar-manifest-"));
  try {
    const requireFromTemporaryDirectory = createRequire(
      join(root, "loader.cjs"),
    );
    const loaded = {} as PureSourceModules;

    for (const [key, sourcePath] of Object.entries(sourceModulePaths) as Array<
      [keyof typeof sourceModulePaths, string]
    >) {
      const source = blobs.get(sourcePath);
      if (source === undefined) {
        throw new Error(`Falta el blob requerido: ${sourcePath}`);
      }
      const result = ts.transpileModule(source.toString("utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: sourcePath,
        reportDiagnostics: true,
      });
      const errors = (result.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      if (errors.length > 0) {
        const message = ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => root,
          getNewLine: () => "\n",
        });
        throw new Error(`No se pudo transpilar ${sourcePath}:\n${message}`);
      }

      const temporaryModule = join(root, `${basename(sourcePath, ".ts")}.cjs`);
      await writeFile(temporaryModule, result.outputText);
      const value: unknown = requireFromTemporaryDirectory(temporaryModule);
      if (!isRecord(value)) {
        throw new Error(`${sourcePath} no exporta un módulo válido`);
      }
      loaded[key] = value;
    }

    return loaded;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeRoute(
  path: string,
  kind: RouteKind,
  sourceFile: string,
  options: {
    fixtureId?: string | null;
    expectedStatus?: number;
    expectedLocation?: string | null;
    privateArea?: PrivateArea | null;
    visualTemplate?: string | null;
  } = {},
): RouteContract {
  return {
    path,
    kind,
    sourceFile,
    fixtureId: options.fixtureId ?? null,
    expectedStatus: options.expectedStatus ?? 200,
    expectedLocation: options.expectedLocation ?? null,
    privateArea: options.privateArea ?? null,
    visualTemplate: options.visualTemplate ?? null,
  };
}

function addRoute(
  routes: Map<string, RouteContract>,
  route: RouteContract,
): void {
  const key = routeKey(route);
  if (!routes.has(key)) routes.set(key, route);
}

function staticVisualTemplate(path: string, sourceFile: string): string | null {
  if (sourceFile === "app/page.tsx") return "home";
  if (sourceFile === "app/[slug]/page.tsx") {
    if (path === "/blog") return "blog-index";
    if (
      path === "/politica-privacidad" ||
      path === "/cookies" ||
      path === "/aviso-legal" ||
      path === "/terminos-y-condiciones"
    ) {
      return "legal-page";
    }
    return "generic-page";
  }
  if (path === "/comunidades-energeticas/manganafer") return "manganafer";
  if (path === "/socios") return "socios";
  if (path === "/guia-equipo") return "team-guide";
  if (path === "/manganafer/interesados") return "manganafer-interests";
  return null;
}

function addStaticRoute(
  routes: Map<string, RouteContract>,
  file: string,
  path: string,
  legacyGonePaths: ReadonlySet<string>,
): void {
  if (legacyGonePaths.has(path)) {
    addRoute(routes, makeRoute(path, "gone", file, { expectedStatus: 410 }));
    return;
  }

  const privateArea = privateAreas.get(path) ?? null;
  if (privateArea !== null && !path.startsWith("/api/")) {
    addRoute(
      routes,
      makeRoute(path, "private-page", file, {
        privateArea,
        visualTemplate: staticVisualTemplate(path, file),
      }),
    );
    return;
  }

  if (file.endsWith("/route.ts")) {
    addRoute(
      routes,
      makeRoute(path, "api", file, {
        privateArea,
      }),
    );
    return;
  }

  addRoute(
    routes,
    makeRoute(path, "page", file, {
      visualTemplate: staticVisualTemplate(path, file),
    }),
  );
}

function auditWordPressPaths(legacy: LegacyInventory): {
  total: 122;
  unclassified: string[];
} {
  if (legacy.wordpressPaths.length !== 122) {
    throw new Error(
      `El sitemap WordPress auditado debe contener 122 rutas, recibió ${legacy.wordpressPaths.length}`,
    );
  }
  const classified = new Set([
    ...legacy.redirects.map((redirect) => redirect.from),
    ...legacy.gone,
    ...legacy.pending,
    ...legacy.preserved,
  ]);
  const unclassified = legacy.wordpressPaths
    .filter((path) => !classified.has(path))
    .sort(compareText);
  return { total: 122, unclassified };
}

export function createGitSourceRepository(
  sourceRoot?: string,
): SourceRepository {
  let rootPromise: Promise<string> | undefined;
  let sourcePromise: Promise<SourceRef> | undefined;

  const root = (): Promise<string> => {
    rootPromise ??= resolveSourceRoot(sourceRoot);
    return rootPromise;
  };
  const source = (): Promise<SourceRef> => {
    sourcePromise ??= root().then((resolvedRoot) =>
      assertSourcePristine(resolvedRoot),
    );
    return sourcePromise;
  };

  return {
    assertPristine: source,
    async listFiles() {
      const [resolvedRoot, reference] = await Promise.all([root(), source()]);
      const output = await git(resolvedRoot, [
        "ls-tree",
        "-r",
        "--name-only",
        reference.commit,
      ]);
      return output.split("\n").filter(Boolean).sort(compareText);
    },
    async readBlob(path) {
      const [resolvedRoot, reference] = await Promise.all([root(), source()]);
      return readSourceBlob(path, resolvedRoot, reference.commit);
    },
  };
}

export async function buildSourceManifest(
  options: BuildSourceManifestOptions = {},
): Promise<SourceManifest> {
  const source = options.source ?? createGitSourceRepository();
  const sourceRef = await source.assertPristine();
  const files = [...new Set(await source.listFiles())].sort(compareText);
  const blobs = new Map<string, Buffer>();
  for (const file of files) {
    blobs.set(file, await source.readBlob(file));
  }

  const sourceModules = await loadPureSourceModules(blobs);
  const communitySlugs = readSlugList(
    sourceModules.community.communityPages,
    "communityPages",
  );
  const blogSlugs = readSlugList(sourceModules.blog.blogPosts, "blogPosts");
  const remoteSlugs = readSlugList(
    sourceModules.remote.remoteProjects,
    "remoteProjects",
  );
  const legacy = readLegacyInventory(sourceModules.legacy);
  const genericSource = blobs.get("app/[slug]/page.tsx");
  if (genericSource === undefined) {
    throw new Error("Falta app/[slug]/page.tsx");
  }
  const genericSlugs = extractGenericSlugKeys(genericSource.toString("utf8"));
  if (genericSlugs.length !== 18) {
    throw new Error(
      `Se esperaban 18 claves pages en app/[slug]/page.tsx, recibió ${genericSlugs.length}`,
    );
  }

  const routes = new Map<string, RouteContract>();
  const legacyGonePaths = new Set(legacy.gone);
  const appRouteFiles = files.filter(
    (file) =>
      /^app\/.+\/(?:page\.tsx|route\.ts)$/.test(file) ||
      file === "app/page.tsx",
  );

  for (const file of appRouteFiles) {
    const route = appFileToRoute(file);
    if (route === "/comunidades-energeticas/[community]") {
      for (const slug of communitySlugs) {
        addRoute(
          routes,
          makeRoute(`/comunidades-energeticas/${slug}`, "page", file, {
            fixtureId: slug,
            visualTemplate: "community-detail",
          }),
        );
      }
    } else if (route === "/blog/[post]") {
      for (const slug of blogSlugs) {
        addRoute(
          routes,
          makeRoute(`/blog/${slug}`, "page", file, {
            fixtureId: slug,
            visualTemplate: "blog-detail",
          }),
        );
      }
    } else if (route === "/autoconsumo-remoto/[project]") {
      for (const slug of remoteSlugs) {
        addRoute(
          routes,
          makeRoute(`/autoconsumo-remoto/${slug}`, "page", file, {
            fixtureId: slug,
            visualTemplate: "remote-detail",
          }),
        );
      }
    } else if (route === "/[slug]") {
      for (const slug of genericSlugs) {
        addRoute(
          routes,
          makeRoute(`/${slug}`, "page", file, {
            fixtureId: slug,
            visualTemplate: staticVisualTemplate(`/${slug}`, file),
          }),
        );
      }
    } else if (route.includes("[")) {
      throw new Error(`Patrón dinámico sin inventariar: ${file}`);
    } else {
      addStaticRoute(routes, file, route, legacyGonePaths);
    }
  }

  for (const [path, sourceFile] of [
    ["/sitemap.xml", "app/sitemap.ts"],
    ["/robots.txt", "app/robots.ts"],
  ] as const) {
    if (!blobs.has(sourceFile)) {
      throw new Error(`Falta ${sourceFile}`);
    }
    addRoute(routes, makeRoute(path, "page", sourceFile));
  }

  for (const redirect of legacy.redirects) {
    addRoute(
      routes,
      makeRoute(redirect.from, "redirect", sourceModulePaths.legacy, {
        expectedStatus: 308,
        expectedLocation: redirect.to,
      }),
    );
  }
  for (const path of legacy.gone) {
    addRoute(
      routes,
      makeRoute(path, "gone", sourceModulePaths.legacy, {
        expectedStatus: 410,
      }),
    );
  }

  const inventory = files.map((file) => {
    const blob = blobs.get(file);
    if (blob === undefined) throw new Error(`Falta el blob de ${file}`);
    return sourceFileEntry(file, blob);
  });
  const assets = inventory
    .filter((entry) => entry.path.startsWith("public/"))
    .map((entry) => ({ ...entry, mediaType: publicAssetMediaType(entry.path) }))
    .sort(sourceFileComparator);
  const sourceFiles = inventory
    .filter((entry) => !entry.path.startsWith("public/"))
    .sort(sourceFileComparator);
  for (const asset of assets) {
    addRoute(
      routes,
      makeRoute(`/${asset.path.slice("public/".length)}`, "asset", asset.path),
    );
  }

  return {
    schemaVersion: 1,
    source: sourceRef,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    routes: [...routes.values()].sort(compareRouteContract),
    sourceFiles,
    assets,
    wordpressAudit: auditWordPressPaths(legacy),
  };
}

function assertRouteMatrixEntry(value: unknown): RouteMatrixEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.status !== "string"
  ) {
    throw new Error("parity/route-matrix.json contiene una entrada inválida");
  }
  return value as RouteMatrixEntry;
}

async function readRouteMatrix(path: string): Promise<RouteMatrixEntry[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) {
      throw new Error("parity/route-matrix.json debe contener una lista");
    }
    return value.map(assertRouteMatrixEntry);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function buildRouteMatrix(
  manifest: SourceManifest,
  existing: RouteMatrixEntry[] = [],
): RouteMatrixEntry[] {
  const existingByRoute = new Map<string, RouteMatrixEntry>();
  for (const entry of existing) {
    const key = routeKey(entry);
    if (existingByRoute.has(key)) {
      throw new Error(
        `parity/route-matrix.json duplica ${entry.kind}:${entry.path}`,
      );
    }
    existingByRoute.set(key, entry);
  }

  const manifestKeys = new Set(manifest.routes.map(routeKey));
  const refreshed = manifest.routes.map((route) => {
    const previous = existingByRoute.get(routeKey(route));
    if (previous === undefined) return { ...route, status: "pending" };
    return { ...previous, ...route, status: previous.status };
  });
  const preserved = existing.filter(
    (entry) => !manifestKeys.has(routeKey(entry)),
  );
  return [...refreshed, ...preserved].sort(compareRouteContract);
}

export function serializeSourceManifest(manifest: SourceManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function serializeRouteMatrix(entries: RouteMatrixEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export async function writeSourceManifest(
  manifest: SourceManifest,
  options: WriteSourceManifestOptions = {},
): Promise<void> {
  const root = resolve(options.root ?? process.cwd());
  const parityDirectory = join(root, "parity");
  const manifestPath = join(parityDirectory, "source-manifest.json");
  const matrixPath = join(parityDirectory, "route-matrix.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  const existing = await readRouteMatrix(matrixPath);
  const matrix = buildRouteMatrix(manifest, existing);
  await writeFile(manifestPath, serializeSourceManifest(manifest));
  await writeFile(matrixPath, serializeRouteMatrix(matrix));
}

export async function readExistingRouteMatrix(
  root: string = process.cwd(),
): Promise<RouteMatrixEntry[]> {
  return readRouteMatrix(join(resolve(root), "parity", "route-matrix.json"));
}
