import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";

import { parse as parseAstro } from "@astrojs/compiler";
import type {
  AttributeNode,
  Node as AstroNode,
  TagLikeNode,
} from "@astrojs/compiler/types";
import ts from "typescript";

import { validateBlockPage } from "../../content/block-catalog.ts";
import { canonicalJson } from "../canonical-json.ts";
import type { ChangePlan, PrivateArea } from "../domain.ts";
import {
  assertNoSuppliedSecrets,
  assertNoSuppliedSecretsBytes,
} from "../importers/secret-scan.ts";
import {
  assertControllerStagedOutput,
  readStagedPackageBaselines,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";

export interface PolicyViolation {
  readonly code: string;
  readonly path: string | null;
  readonly message: string;
}

interface ImportRecord {
  readonly specifier: string;
  readonly locals: readonly string[];
}

interface GeneratedContentDefinition {
  readonly schemaVersion: 1;
  readonly changeId: string;
  readonly mode: ChangePlan["selectedMode"];
  readonly route: `/${string}`;
  readonly metadata: {
    readonly title: string | null;
    readonly description: string | null;
    readonly index: boolean;
  };
  readonly privacy: {
    readonly private: boolean;
    readonly area: PrivateArea | null;
  };
  readonly contentSha256: string;
}

const hashPattern = /^[a-f0-9]{64}$/u;
const exactVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const sourceExtensions = new Set([
  ".astro",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const activeUrlAttributes = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
]);
const forbiddenConfigBasenames = new Set([
  ".env",
  ".npmrc",
  ".dev.vars",
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "eslint.config.js",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
  "yarn.lock",
]);

function violation(
  code: string,
  message: string,
  path: string | null = null,
): PolicyViolation {
  return Object.freeze({ code, path, message });
}

function expectedPaths(plan: ChangePlan) {
  return Object.freeze({
    route:
      plan.targetPath === "/"
        ? "src/pages/index.astro"
        : `src/pages${plan.targetPath}.astro`,
    components: `src/components/generated/${plan.changeId}`,
    content: `src/content/generated/${plan.changeId}.json`,
    stylesheet: `src/styles/generated/${plan.changeId}.css`,
    assets: `public/generated/${plan.changeId}`,
  });
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isDescendant(root: string, path: string): boolean {
  return path.startsWith(`${root}/`);
}

function forbiddenConfig(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  return (
    segments.some(
      (segment) =>
        segment === ".git" ||
        segment === "node_modules" ||
        segment === ".agent-input" ||
        segment === ".agent-output" ||
        segment.startsWith(".env."),
    ) || forbiddenConfigBasenames.has(basename)
  );
}

function outputPathAllowed(path: string, plan: ChangePlan): boolean {
  if (!safeRelativePath(path)) return false;
  if (path === "package.json" || path === "package-lock.json") {
    const planned = new Set(plan.files.map((file) => file.path));
    return (
      plan.dependencies.length > 0 &&
      planned.has("package.json") &&
      planned.has("package-lock.json")
    );
  }
  if (forbiddenConfig(path)) return false;
  const paths = expectedPaths(plan);
  const planned = new Set(plan.files.map((file) => file.path));
  return (
    planned.has(path) ||
    isDescendant(paths.components, path) ||
    isDescendant(paths.assets, path)
  );
}

function normalizedActiveUrl(value: string): string {
  return [...value]
    .filter((character) => character.codePointAt(0)! > 0x20)
    .join("")
    .toLowerCase();
}

function safeLink(value: string): boolean {
  const normalized = normalizedActiveUrl(value);
  if (value.includes("\\")) return false;
  const allowed =
    (normalized.startsWith("/") && !normalized.startsWith("//")) ||
    normalized.startsWith("#") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("tel:");
  if (!allowed) return false;
  if (normalized.startsWith("https://")) {
    try {
      const url = new URL(normalized);
      return url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }
  return true;
}

function tagAttributes(node: AstroNode): readonly AttributeNode[] {
  return "attributes" in node ? node.attributes : [];
}

function quotedAttribute(
  node: TagLikeNode,
  name: string,
): AttributeNode | undefined {
  return node.attributes.find(
    (attribute) => attribute.name.toLowerCase() === name,
  );
}

function sourceImports(source: string): {
  imports: ImportRecord[];
  invalidDynamicImport: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "generated.tsx",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const imports: ImportRecord[] = [];
  let invalidDynamicImport = false;

  const add = (specifier: string, locals: readonly string[] = []): void => {
    imports.push(
      Object.freeze({ specifier, locals: Object.freeze([...locals]) }),
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const locals: string[] = [];
      if (ts.isImportDeclaration(node) && node.importClause !== undefined) {
        if (node.importClause.name !== undefined)
          locals.push(node.importClause.name.text);
        const bindings = node.importClause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) locals.push(bindings.name.text);
          else
            locals.push(
              ...bindings.elements.map((element) => element.name.text),
            );
        }
      }
      add(node.moduleSpecifier.text, locals);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      if (
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        add(node.arguments[0].text);
      } else {
        invalidDynamicImport = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { imports, invalidDynamicImport };
}

function resolvedLocalImport(
  importer: string,
  specifier: string,
): string | null {
  const clean = specifier.split(/[?#]/u, 1)[0] ?? "";
  if (!clean.startsWith(".")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(importer), clean));
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  ) {
    throw new TypeError("La importación atraviesa el root del staging");
  }
  return resolved;
}

function dependencyName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/", 1)[0] ?? specifier;
}

function approvedDependencies(plan: ChangePlan): Map<string, string> {
  const result = new Map<string, string>();
  for (const declaration of plan.dependencies) {
    const separator = declaration.lastIndexOf("@");
    if (separator <= 0) continue;
    result.set(
      declaration.slice(0, separator),
      declaration.slice(separator + 1),
    );
  }
  return result;
}

function validateImports(
  frontmatter: string,
  plan: ChangePlan,
  path: string,
): { violations: PolicyViolation[]; records: ImportRecord[] } {
  const violations: PolicyViolation[] = [];
  const parsed = sourceImports(frontmatter);
  if (parsed.invalidDynamicImport) {
    violations.push(
      violation(
        "import.dynamic",
        "Las importaciones dinámicas deben ser literales",
        path,
      ),
    );
  }
  const dependencies = approvedDependencies(plan);
  for (const record of parsed.imports) {
    const lower = record.specifier.toLowerCase();
    if (
      lower === "next" ||
      lower.startsWith("next/") ||
      lower === "vinext" ||
      lower.startsWith("vinext/") ||
      lower.startsWith("node:")
    ) {
      violations.push(
        violation(
          "import.forbidden",
          `Import no aprobado: ${record.specifier}`,
          path,
        ),
      );
      continue;
    }
    try {
      const local = resolvedLocalImport(path, record.specifier);
      if (local !== null) continue;
    } catch {
      violations.push(
        violation(
          "import.traversal",
          "Una importación sale del root del staging",
          path,
        ),
      );
      continue;
    }
    if (
      record.specifier.startsWith("/") ||
      record.specifier.startsWith("file:")
    ) {
      violations.push(
        violation(
          "import.absolute",
          "Las importaciones absolutas no están permitidas",
          path,
        ),
      );
      continue;
    }
    if (!dependencies.has(dependencyName(record.specifier))) {
      violations.push(
        violation(
          "import.dependency",
          `Dependencia no aprobada: ${record.specifier}`,
          path,
        ),
      );
    }
  }
  return { violations, records: parsed.imports };
}

function frontmatterSources(ast: AstroNode): string[] {
  const result: string[] = [];
  const visit = (node: AstroNode): void => {
    if (node.type === "frontmatter") result.push(node.value);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(ast);
  return result;
}

function validateTags(
  ast: AstroNode,
  plan: ChangePlan,
  path: string,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const visit = (node: AstroNode): void => {
    for (const attribute of tagAttributes(node)) {
      const name = attribute.name.toLowerCase();
      if (attribute.kind === "spread") {
        violations.push(
          violation(
            "astro.spread",
            "Los atributos spread no permiten demostrar la allowlist",
            path,
          ),
        );
      }
      if (name.startsWith("on")) {
        violations.push(
          violation(
            "astro.event-handler",
            "Los handlers on* no están permitidos",
            path,
          ),
        );
      }
      if (name === "set:html") {
        violations.push(
          violation("astro.raw-html", "set:html no está permitido", path),
        );
      }
      if (activeUrlAttributes.has(name)) {
        if (attribute.kind !== "quoted" || !safeLink(attribute.value)) {
          violations.push(
            violation(
              "link.unsafe",
              "El enlace usa un protocolo no aprobado",
              path,
            ),
          );
        }
      }
      if (
        name === "style" &&
        /url\(\s*["']?\s*(?:javascript:|data:text\/html)/iu.test(
          attribute.value,
        )
      ) {
        violations.push(
          violation(
            "link.unsafe",
            "El estilo usa un protocolo no aprobado",
            path,
          ),
        );
      }
    }
    if (node.type === "element") {
      const name = node.name.toLowerCase();
      if (name === "iframe") {
        violations.push(
          violation(
            "iframe.forbidden",
            "No existe un dominio iframe aprobado en el plan",
            path,
          ),
        );
      }
      if (name === "script") {
        const src = quotedAttribute(node, "src");
        const inlineDirective = quotedAttribute(node, "is:inline");
        const hasBody = node.children.some(
          (child) => child.type !== "text" || child.value.trim().length > 0,
        );
        if (
          inlineDirective !== undefined ||
          src === undefined ||
          hasBody ||
          !safeLink(src.value) ||
          !normalizedActiveUrl(src.value).startsWith("https://")
        ) {
          violations.push(
            violation(
              "script.inline",
              "Los scripts inline no están permitidos",
              path,
            ),
          );
        }
      }
    }
    if (
      node.type === "component" &&
      node.attributes.some((attribute) =>
        attribute.name.toLowerCase().startsWith("client:"),
      ) &&
      !plan.islands.includes(node.name)
    ) {
      violations.push(
        violation(
          "island.unapproved",
          `Isla no aprobada por el plan: ${node.name}`,
          path,
        ),
      );
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(ast);
  return violations;
}

function requiredRouteImports(
  records: readonly ImportRecord[],
  plan: ChangePlan,
  path: string,
): PolicyViolation[] {
  if (path !== expectedPaths(plan).route) return [];
  const violations: PolicyViolation[] = [];
  const resolved = records.flatMap((record) => {
    try {
      const target = resolvedLocalImport(path, record.specifier);
      return target === null ? [] : [{ target, locals: record.locals }];
    } catch {
      return [];
    }
  });
  const paths = expectedPaths(plan);
  if (plan.selectedMode === "blocks") {
    if (
      !resolved.some(
        (record) =>
          record.target === "src/components/blocks/GeneratedBlockPage.astro" &&
          record.locals.includes("GeneratedBlockPage"),
      )
    ) {
      violations.push(
        violation(
          "mode.blocks-renderer",
          "Blocks debe importar GeneratedBlockPage",
          path,
        ),
      );
    }
    if (!resolved.some((record) => record.target === paths.content)) {
      violations.push(
        violation(
          "mode.blocks-content",
          "Blocks debe importar su JSON generado",
          path,
        ),
      );
    }
  } else {
    if (
      !resolved.some(
        (record) =>
          record.target === "src/layouts/SiteLayout.astro" &&
          record.locals.includes("SiteLayout"),
      )
    ) {
      violations.push(
        violation(
          "mode.layout",
          "Freeform e hybrid deben importar SiteLayout",
          path,
        ),
      );
    }
    if (!resolved.some((record) => record.target === paths.stylesheet)) {
      violations.push(
        violation(
          "mode.stylesheet",
          "Freeform e hybrid deben importar su CSS generado",
          path,
        ),
      );
    }
  }
  return violations;
}

export async function validateAstroSource(
  source: string,
  plan: ChangePlan,
  path: string = expectedPaths(plan).route,
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  try {
    assertNoSuppliedSecrets(source);
  } catch {
    violations.push(
      violation(
        "secret.detected",
        "La salida contiene un secreto o token",
        path,
      ),
    );
  }
  let parsed: Awaited<ReturnType<typeof parseAstro>>;
  try {
    parsed = await parseAstro(source, { position: true });
  } catch {
    return [
      ...violations,
      violation("astro.parse", "El archivo Astro no se puede parsear", path),
    ];
  }
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 1)) {
    violations.push(
      violation("astro.parse", "El archivo Astro contiene errores", path),
    );
  }
  violations.push(...validateTags(parsed.ast, plan, path));
  const imports = frontmatterSources(parsed.ast).map((sourcePart) =>
    validateImports(sourcePart, plan, path),
  );
  violations.push(...imports.flatMap((entry) => entry.violations));
  violations.push(
    ...requiredRouteImports(
      imports.flatMap((entry) => entry.records),
      plan,
      path,
    ),
  );
  return violations;
}

async function readInventoryFile(
  stagingPath: string,
  path: string,
  expectedHash: string,
): Promise<{ bytes?: Buffer; violation?: PolicyViolation }> {
  const absolute = posix.join(stagingPath, path);
  let handle;
  try {
    handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new TypeError("not a regular single-link file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new TypeError("changed while reading");
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedHash) {
      return {
        violation: violation(
          "inventory.hash",
          "El hash del archivo no coincide con el inventario controlador",
          path,
        ),
      };
    }
    return { bytes };
  } catch {
    return {
      violation: violation(
        "inventory.file",
        "El archivo inventariado no es un archivo regular estable",
        path,
      ),
    };
  } finally {
    await handle?.close();
  }
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validateCommonContent(
  value: unknown,
  plan: ChangePlan,
  routeHash: string | undefined,
): value is GeneratedContentDefinition {
  const record = dataRecord(value);
  if (record === null) return false;
  const expected = [
    "schemaVersion",
    "changeId",
    "mode",
    "route",
    "metadata",
    "privacy",
    "contentSha256",
    ...(plan.selectedMode === "blocks" ? ["blocks"] : []),
  ];
  const metadata = dataRecord(record.metadata);
  const privacy = dataRecord(record.privacy);
  return (
    exactKeys(record, expected) &&
    record.schemaVersion === 1 &&
    record.changeId === plan.changeId &&
    record.mode === plan.selectedMode &&
    record.route === plan.targetPath &&
    typeof record.contentSha256 === "string" &&
    hashPattern.test(record.contentSha256) &&
    record.contentSha256 === routeHash &&
    metadata !== null &&
    exactKeys(metadata, ["title", "description", "index"]) &&
    (typeof metadata.title === "string" || metadata.title === null) &&
    (typeof metadata.description === "string" ||
      metadata.description === null) &&
    typeof metadata.index === "boolean" &&
    (plan.publication.siteIndexable || metadata.index === false) &&
    privacy !== null &&
    exactKeys(privacy, ["private", "area"]) &&
    typeof privacy.private === "boolean" &&
    (privacy.private === true
      ? privacy.area === "socios" ||
        privacy.area === "equipo" ||
        privacy.area === "manganafer"
      : privacy.area === null) &&
    (privacy.private !== true || metadata.index === false)
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dependencyDiffValid(
  baselinePackage: unknown,
  baselineLock: unknown,
  currentPackage: unknown,
  currentLock: unknown,
  plan: ChangePlan,
): boolean {
  const dependencies = approvedDependencies(plan);
  if (
    dependencies.size !== plan.dependencies.length ||
    [...dependencies.values()].some(
      (version) => !exactVersionPattern.test(version),
    )
  ) {
    return false;
  }
  const basePackage = dataRecord(baselinePackage);
  const nextPackage = dataRecord(currentPackage);
  const baseLock = dataRecord(baselineLock);
  const nextLock = dataRecord(currentLock);
  if (
    basePackage === null ||
    nextPackage === null ||
    baseLock === null ||
    nextLock === null
  ) {
    return false;
  }
  const expectedPackage = cloneJson(basePackage);
  const packageDependencies = dataRecord(expectedPackage.dependencies) ?? {};
  expectedPackage.dependencies = packageDependencies;
  for (const [name, version] of dependencies)
    packageDependencies[name] = version;
  if (canonicalJson(expectedPackage) !== canonicalJson(nextPackage))
    return false;

  const expectedLock = cloneJson(baseLock);
  const expectedPackages = dataRecord(expectedLock.packages);
  const currentPackages = dataRecord(nextLock.packages);
  if (expectedPackages === null || currentPackages === null) return false;
  const expectedRoot = dataRecord(expectedPackages[""]);
  const currentRoot = dataRecord(currentPackages[""]);
  if (expectedRoot === null || currentRoot === null) return false;
  const rootDependencies = dataRecord(expectedRoot.dependencies) ?? {};
  expectedRoot.dependencies = rootDependencies;
  for (const [name, version] of dependencies) {
    rootDependencies[name] = version;
    const key = `node_modules/${name}`;
    const currentEntry = dataRecord(currentPackages[key]);
    const resolved = currentEntry?.resolved;
    if (
      currentEntry === null ||
      currentEntry.version !== version ||
      currentEntry.link === true ||
      (resolved !== undefined &&
        (typeof resolved !== "string" ||
          !normalizedActiveUrl(resolved).startsWith("https://") ||
          !safeLink(resolved)))
    ) {
      return false;
    }
    expectedPackages[key] = cloneJson(currentEntry);
  }
  return canonicalJson(expectedLock) === canonicalJson(nextLock);
}

async function validateDependencies(
  inventory: StagedAgentOutput,
  files: ReadonlyMap<string, Buffer>,
  plan: ChangePlan,
): Promise<PolicyViolation[]> {
  const hasPackage = files.has("package.json");
  const hasLock = files.has("package-lock.json");
  if (!hasPackage && !hasLock) return [];
  if (!hasPackage || !hasLock || plan.dependencies.length === 0) {
    return [
      violation(
        "dependency.authorization",
        "Package y lock requieren dependencias aprobadas y deben cambiar juntos",
      ),
    ];
  }
  const packageSource = decodeUtf8(files.get("package.json")!);
  const lockSource = decodeUtf8(files.get("package-lock.json")!);
  if (packageSource === null || lockSource === null) {
    return [violation("dependency.diff", "Los manifests deben ser JSON UTF-8")];
  }
  try {
    const baseline = await readStagedPackageBaselines(inventory);
    if (
      !dependencyDiffValid(
        JSON.parse(baseline.packageJson.toString("utf8")),
        JSON.parse(baseline.packageLockJson.toString("utf8")),
        JSON.parse(packageSource),
        JSON.parse(lockSource),
        plan,
      )
    ) {
      return [
        violation(
          "dependency.diff",
          "El diff de package y lock no coincide exactamente con nombre y versión aprobados",
        ),
      ];
    }
  } catch {
    return [
      violation(
        "dependency.diff",
        "No se pudo validar el diff exacto de dependencias",
      ),
    ];
  }
  return [];
}

function validateScriptSource(
  source: string,
  plan: ChangePlan,
  path: string,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  try {
    assertNoSuppliedSecrets(source);
  } catch {
    violations.push(
      violation(
        "secret.detected",
        "La salida contiene un secreto o token",
        path,
      ),
    );
  }
  violations.push(...validateImports(source, plan, path).violations);
  return violations;
}

export async function validateOutputPolicy(
  stagingPath: string,
  inventory: StagedAgentOutput,
  plan: ChangePlan,
): Promise<PolicyViolation[]> {
  await assertControllerStagedOutput(inventory, plan);
  if (stagingPath !== inventory.path) {
    throw new TypeError(
      "El path solicitado no coincide con el staging controlador",
    );
  }

  const violations: PolicyViolation[] = [];
  const inventoryFiles = [...inventory.files];
  const uniqueFiles = [...new Set(inventoryFiles)].sort();
  const hashKeys = Object.keys(inventory.sha256).sort();
  if (
    uniqueFiles.length !== inventoryFiles.length ||
    uniqueFiles.join("\0") !== [...inventoryFiles].sort().join("\0") ||
    uniqueFiles.join("\0") !== hashKeys.join("\0")
  ) {
    return [
      violation("inventory.shape", "El inventario controlador no es exacto"),
    ];
  }

  const files = new Map<string, Buffer>();
  for (const path of uniqueFiles) {
    if (!outputPathAllowed(path, plan)) {
      violations.push(
        violation(
          "path.forbidden",
          "El path no pertenece a una salida aprobada",
          path,
        ),
      );
    }
    const expectedHash = inventory.sha256[path];
    if (
      !safeRelativePath(path) ||
      expectedHash === undefined ||
      !hashPattern.test(expectedHash)
    ) {
      violations.push(
        violation(
          "inventory.shape",
          "Path o hash de inventario inválido",
          path,
        ),
      );
      continue;
    }
    const result = await readInventoryFile(stagingPath, path, expectedHash);
    if (result.violation !== undefined) {
      violations.push(result.violation);
      continue;
    }
    const bytes = result.bytes!;
    try {
      assertNoSuppliedSecretsBytes(bytes);
    } catch {
      violations.push(
        violation(
          "secret.detected",
          "La salida contiene un secreto o token",
          path,
        ),
      );
    }
    files.set(path, bytes);
  }

  const paths = expectedPaths(plan);
  const route = files.get(paths.route);
  const content = files.get(paths.content);
  if (route === undefined) {
    violations.push(
      violation(
        "mode.route",
        "La salida no contiene la ruta planificada",
        paths.route,
      ),
    );
  }
  if (content === undefined) {
    violations.push(
      violation(
        "mode.content",
        "La salida no contiene el JSON de contenido",
        paths.content,
      ),
    );
  }
  if (plan.selectedMode !== "blocks" && !files.has(paths.stylesheet)) {
    violations.push(
      violation(
        "mode.stylesheet",
        "Freeform e hybrid requieren su CSS generado",
        paths.stylesheet,
      ),
    );
  }

  for (const [path, bytes] of files) {
    const extension = posix.extname(path).toLowerCase();
    if (extension === ".astro") {
      const source = decodeUtf8(bytes);
      if (source === null) {
        violations.push(
          violation("source.utf8", "El source debe usar UTF-8", path),
        );
      } else {
        violations.push(...(await validateAstroSource(source, plan, path)));
      }
    } else if (sourceExtensions.has(extension)) {
      const source = decodeUtf8(bytes);
      if (source === null) {
        violations.push(
          violation("source.utf8", "El source debe usar UTF-8", path),
        );
      } else {
        violations.push(...validateScriptSource(source, plan, path));
      }
    } else if (extension === ".css") {
      const source = decodeUtf8(bytes);
      if (
        source === null ||
        /@import\b/iu.test(source) ||
        /url\(\s*["']?\s*(?:javascript:|data:text\/html)/iu.test(source)
      ) {
        violations.push(
          violation(
            "css.unsafe",
            "El CSS contiene una referencia no aprobada",
            path,
          ),
        );
      }
    }
  }

  if (content !== undefined) {
    const source = decodeUtf8(content);
    try {
      if (source === null) throw new TypeError("invalid UTF-8");
      const parsed = JSON.parse(source) as unknown;
      if (!validateCommonContent(parsed, plan, inventory.sha256[paths.route])) {
        throw new TypeError("invalid common content");
      }
      if (plan.selectedMode === "blocks") validateBlockPage(parsed);
    } catch {
      violations.push(
        violation(
          "content.schema",
          "El JSON generado no respeta metadata, privacidad, hash y schema cerrados",
          paths.content,
        ),
      );
    }
  }

  violations.push(...(await validateDependencies(inventory, files, plan)));
  return violations;
}
