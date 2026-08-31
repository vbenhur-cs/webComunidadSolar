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

import {
  isApprovedGeneratedLink,
  validateBlockPage,
} from "../../content/block-catalog.ts";
import type { ChangePlan, PrivateArea } from "../domain.ts";
import {
  assertNoSuppliedSecrets,
  assertNoSuppliedSecretsBytes,
} from "../importers/secret-scan.ts";
import {
  assertControllerStagedOutput,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";

export interface PolicyViolation {
  readonly code: string;
  readonly path: string | null;
  readonly message: string;
}

interface ImportBinding {
  readonly kind: "default" | "named" | "namespace";
  readonly imported: string;
  readonly local: string;
}

interface ImportRecord {
  readonly specifier: string;
  readonly bindings: readonly ImportBinding[];
  readonly sideEffect: boolean;
  readonly typeOnly: boolean;
  readonly attributes: boolean;
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
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "manifest",
  "ping",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const unsupportedMultiUrlAttributes = new Set(["ping", "srcset"]);
const inertPublicExtensions = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
]);
const canonicalComponentModules = Object.freeze({
  SiteLayout: "src/layouts/SiteLayout.astro",
  PageHero: "src/components/site/PageHero.astro",
  SectionHeading: "src/components/site/SectionHeading.astro",
  ButtonLink: "src/components/site/ButtonLink.astro",
} as const);
const canonicalIslandModules = Object.freeze({
  BlogFilter: "src/components/islands/BlogFilter",
  ConsentManager: "src/components/islands/ConsentManager",
  CoverageFinder: "src/components/islands/CoverageFinder",
  ManganaferInterestForm: "src/components/islands/ManganaferInterestForm",
  ManganaferQuoteForm: "src/components/islands/ManganaferQuoteForm",
} as const);
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
  executable: boolean;
  parseError: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "generated.tsx",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const imports: ImportRecord[] = [];
  let executable = false;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      executable = true;
      continue;
    }
    const bindings: ImportBinding[] = [];
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      bindings.push({
        kind: "default",
        imported: "default",
        local: clause.name.text,
      });
    }
    const namedBindings = clause?.namedBindings;
    if (namedBindings !== undefined) {
      if (ts.isNamespaceImport(namedBindings)) {
        bindings.push({
          kind: "namespace",
          imported: "*",
          local: namedBindings.name.text,
        });
      } else {
        bindings.push(
          ...namedBindings.elements.map((element) => ({
            kind: "named" as const,
            imported: (element.propertyName ?? element.name).text,
            local: element.name.text,
          })),
        );
      }
    }
    imports.push(
      Object.freeze({
        specifier: statement.moduleSpecifier.text,
        bindings: Object.freeze(bindings),
        sideEffect: clause === undefined,
        typeOnly:
          clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
          (namedBindings !== undefined &&
            ts.isNamedImports(namedBindings) &&
            namedBindings.elements.some((element) => element.isTypeOnly)),
        attributes: statement.attributes !== undefined,
      }),
    );
  }
  return {
    imports,
    executable,
    parseError:
      (
        sourceFile as ts.SourceFile & {
          readonly parseDiagnostics: readonly ts.Diagnostic[];
        }
      ).parseDiagnostics.length > 0,
  };
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

function canonicalLocalSpecifier(importer: string, target: string): string {
  const relative = posix.relative(posix.dirname(importer), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

interface ImportExpectation {
  readonly kind: "default" | "named" | "side-effect";
  readonly imported: string;
  readonly local: string;
}

function canonicalImportExpectations(
  plan: ChangePlan,
): ReadonlyMap<string, ImportExpectation> {
  const paths = expectedPaths(plan);
  const result = new Map<string, ImportExpectation>();
  if (plan.selectedMode === "blocks") {
    result.set("src/components/blocks/GeneratedBlockPage.astro", {
      kind: "default",
      imported: "default",
      local: "GeneratedBlockPage",
    });
    result.set(paths.content, {
      kind: "default",
      imported: "default",
      local: "page",
    });
    return result;
  }
  result.set(paths.stylesheet, {
    kind: "side-effect",
    imported: "",
    local: "",
  });
  for (const name of plan.components) {
    const target =
      canonicalComponentModules[name as keyof typeof canonicalComponentModules];
    if (target !== undefined) {
      result.set(target, {
        kind: "default",
        imported: "default",
        local: name,
      });
    }
  }
  for (const name of plan.islands) {
    const target =
      canonicalIslandModules[name as keyof typeof canonicalIslandModules];
    if (target !== undefined) {
      result.set(target, { kind: "named", imported: name, local: name });
    }
  }
  return result;
}

function importMatches(
  record: ImportRecord,
  expected: ImportExpectation,
  importer: string,
  target: string,
): boolean {
  if (
    record.typeOnly ||
    record.attributes ||
    record.specifier !== canonicalLocalSpecifier(importer, target)
  ) {
    return false;
  }
  if (expected.kind === "side-effect") {
    return record.sideEffect && record.bindings.length === 0;
  }
  return (
    !record.sideEffect &&
    record.bindings.length === 1 &&
    record.bindings[0]?.kind === expected.kind &&
    record.bindings[0]?.imported === expected.imported &&
    record.bindings[0]?.local === expected.local
  );
}

function validateImports(
  frontmatter: string,
  plan: ChangePlan,
  path: string,
): { violations: PolicyViolation[]; records: ImportRecord[] } {
  const violations: PolicyViolation[] = [];
  const parsed = sourceImports(frontmatter);
  if (parsed.parseError) {
    violations.push(
      violation(
        "source.parse",
        "El frontmatter generado no se puede parsear completamente",
        path,
      ),
    );
  }
  if (parsed.executable) {
    violations.push(
      violation(
        "source.executable",
        "El frontmatter generado solo puede contener imports estáticos canónicos",
        path,
      ),
    );
  }
  const expectations = canonicalImportExpectations(plan);
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
      if (local !== null) {
        const expected = expectations.get(local);
        if (expected === undefined) {
          violations.push(
            violation(
              "import.unapproved",
              `Módulo local no aprobado por el plan: ${record.specifier}`,
              path,
            ),
          );
        } else if (!importMatches(record, expected, path, local)) {
          violations.push(
            violation(
              "component.binding",
              `El import no usa el binding canónico para ${record.specifier}`,
              path,
            ),
          );
        }
        continue;
      }
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
    violations.push(
      violation(
        "import.dependency",
        `La salida generada no admite módulos de paquete: ${record.specifier}`,
        path,
      ),
    );
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

const approvedHtmlElements = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "img",
  "input",
  "label",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "picture",
  "pre",
  "section",
  "select",
  "small",
  "source",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
]);

function resolvedCanonicalBindings(
  records: readonly ImportRecord[],
  plan: ChangePlan,
  path: string,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const expectations = canonicalImportExpectations(plan);
  for (const record of records) {
    try {
      const target = resolvedLocalImport(path, record.specifier);
      if (target === null) continue;
      const expected = expectations.get(target);
      if (
        expected !== undefined &&
        importMatches(record, expected, path, target)
      ) {
        result.set(expected.local, target);
      }
    } catch {
      // validateImports owns the traversal violation.
    }
  }
  return result;
}

function validateTags(
  ast: AstroNode,
  plan: ChangePlan,
  path: string,
  imports: readonly ImportRecord[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const bindings = resolvedCanonicalBindings(imports, plan, path);
  const visit = (node: AstroNode): void => {
    if (node.type === "expression") {
      violations.push(
        violation(
          "source.executable",
          "Las expresiones Astro ejecutables no están permitidas",
          path,
        ),
      );
    }
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
      } else if (
        attribute.kind !== "quoted" &&
        attribute.kind !== "empty" &&
        !(
          node.type === "component" &&
          node.name === "GeneratedBlockPage" &&
          attribute.kind === "shorthand" &&
          attribute.name === "page"
        )
      ) {
        violations.push(
          violation(
            "source.executable",
            "Los atributos generados deben ser estáticos",
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
        const navigationOnlyProtocol =
          attribute.value.startsWith("mailto:") ||
          attribute.value.startsWith("tel:");
        if (
          unsupportedMultiUrlAttributes.has(name) ||
          attribute.kind !== "quoted" ||
          !isApprovedGeneratedLink(attribute.value) ||
          (navigationOnlyProtocol && name !== "href")
        ) {
          violations.push(
            violation(
              "link.unsafe",
              "El enlace usa un protocolo no aprobado",
              path,
            ),
          );
        }
      }
      if (name === "style") {
        violations.push(
          violation(
            "style.inline",
            "Los estilos inline no están permitidos",
            path,
          ),
        );
      }
      if (name === "srcdoc" || name === "http-equiv") {
        violations.push(
          violation(
            "active-element.forbidden",
            "El atributo HTML activo no está permitido",
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
        violations.push(
          violation(
            "script.forbidden",
            "Ningún script generado está autorizado por el plan",
            path,
          ),
        );
        const src = quotedAttribute(node, "src");
        const hasBody = node.children.some(
          (child) => child.type !== "text" || child.value.trim().length > 0,
        );
        if (src === undefined || hasBody) {
          violations.push(
            violation(
              "script.inline",
              "Los scripts inline no están permitidos",
              path,
            ),
          );
        }
      } else if (name === "style") {
        violations.push(
          violation(
            "style.inline",
            "Las hojas de estilo inline no están permitidas",
            path,
          ),
        );
      } else if (name === "object" || name === "embed" || name === "link") {
        violations.push(
          violation(
            "active-element.forbidden",
            `Elemento HTML activo no aprobado: ${name}`,
            path,
          ),
        );
      } else if (name === "base" || name === "meta") {
        violations.push(
          violation(
            "active-element.forbidden",
            `Elemento HTML de documento no aprobado: ${name}`,
            path,
          ),
        );
      } else if (name !== "iframe" && !approvedHtmlElements.has(name)) {
        violations.push(
          violation(
            "element.unapproved",
            `Elemento HTML no aprobado: ${name}`,
            path,
          ),
        );
      }
    }
    if (node.type === "component") {
      const componentTarget =
        canonicalComponentModules[
          node.name as keyof typeof canonicalComponentModules
        ];
      const islandTarget =
        canonicalIslandModules[
          node.name as keyof typeof canonicalIslandModules
        ];
      const renderer =
        plan.selectedMode === "blocks" &&
        node.name === "GeneratedBlockPage" &&
        bindings.get(node.name) ===
          "src/components/blocks/GeneratedBlockPage.astro";
      const component =
        componentTarget !== undefined &&
        plan.components.includes(node.name) &&
        bindings.get(node.name) === componentTarget;
      const island =
        islandTarget !== undefined &&
        plan.islands.includes(node.name) &&
        bindings.get(node.name) === islandTarget;
      if (!renderer && !component && !island) {
        violations.push(
          violation(
            "component.binding",
            `Componente no ligado a su módulo canónico aprobado: ${node.name}`,
            path,
          ),
        );
      }
      const hydrated = node.attributes.some((attribute) =>
        attribute.name.toLowerCase().startsWith("client:"),
      );
      if (hydrated && (plan.selectedMode !== "hybrid" || !island)) {
        violations.push(
          violation(
            "island.unapproved",
            `Isla hidratada no aprobada o no canónica: ${node.name}`,
            path,
          ),
        );
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(ast);
  return violations;
}

function significantRootChildren(ast: AstroNode): readonly AstroNode[] {
  if (!("children" in ast)) return [];
  return ast.children.filter(
    (child) =>
      child.type !== "frontmatter" &&
      child.type !== "comment" &&
      !(child.type === "text" && child.value.trim() === ""),
  );
}

function validateModeStructure(
  ast: AstroNode,
  plan: ChangePlan,
  path: string,
): PolicyViolation[] {
  if (path !== expectedPaths(plan).route) return [];
  const roots = significantRootChildren(ast);
  const root = roots[0];
  if (plan.selectedMode === "blocks") {
    const canonical =
      roots.length === 1 &&
      root?.type === "component" &&
      root.name === "GeneratedBlockPage" &&
      root.children.length === 0 &&
      root.attributes.length === 1 &&
      root.attributes[0]?.kind === "shorthand" &&
      root.attributes[0]?.name === "page";
    return canonical
      ? []
      : [
          violation(
            "mode.structure",
            "Blocks requiere una única invocación canónica de GeneratedBlockPage",
            path,
          ),
        ];
  }
  const canonical =
    roots.length === 1 &&
    root?.type === "component" &&
    root.name === "SiteLayout";
  return canonical
    ? []
    : [
        violation(
          "mode.layout",
          "Freeform e hybrid requieren SiteLayout como única raíz renderizada",
          path,
        ),
      ];
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
      const expected =
        target === null
          ? undefined
          : canonicalImportExpectations(plan).get(target);
      return target === null || expected === undefined
        ? []
        : [{ target, valid: importMatches(record, expected, path, target) }];
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
          record.valid,
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
    if (
      !resolved.some(
        (record) => record.target === paths.content && record.valid,
      )
    ) {
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
          record.target === "src/layouts/SiteLayout.astro" && record.valid,
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
    if (
      !resolved.some(
        (record) => record.target === paths.stylesheet && record.valid,
      )
    ) {
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
  const imports = frontmatterSources(parsed.ast).map((sourcePart) =>
    validateImports(sourcePart, plan, path),
  );
  const records = imports.flatMap((entry) => entry.records);
  violations.push(...imports.flatMap((entry) => entry.violations));
  if (path !== expectedPaths(plan).route) {
    violations.push(
      violation(
        "source.unsupported",
        "Solo la ruta canónica puede contener source Astro generado",
        path,
      ),
    );
  }
  violations.push(...validateTags(parsed.ast, plan, path, records));
  violations.push(...validateModeStructure(parsed.ast, plan, path));
  violations.push(...requiredRouteImports(records, plan, path));
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

function validateDependencies(
  files: ReadonlyMap<string, Buffer>,
): PolicyViolation[] {
  const hasPackage = files.has("package.json");
  const hasLock = files.has("package-lock.json");
  if (!hasPackage && !hasLock) return [];
  return [
    violation(
      "dependency.unsupported",
      "Los cambios de dependencias se rechazan hasta disponer de un grafo lock confiable derivado fuera del staging hostil",
    ),
  ];
}

function validateScriptSource(source: string, path: string): PolicyViolation[] {
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
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (
    (
      parsed as ts.SourceFile & {
        readonly parseDiagnostics: readonly ts.Diagnostic[];
      }
    ).parseDiagnostics.length > 0
  ) {
    violations.push(
      violation(
        "source.parse",
        "El source ejecutable generado no se puede parsear completamente",
        path,
      ),
    );
  }
  violations.push(
    violation(
      "source.executable",
      "Los archivos TS/JS/TSX/JSX generados no están autorizados",
      path,
    ),
  );
  return violations;
}

function validateGeneratedCss(
  source: string,
  plan: ChangePlan,
  path: string,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, "").trim();
  if (
    /@|\\|url\s*\(|src\s*\(|image-set\s*\(|expression\s*\(|(?:javascript|data|https?)\s*:|\/\/|:global\b|-moz-binding\b|behavior\s*:/iu.test(
      withoutComments,
    )
  ) {
    violations.push(
      violation(
        "css.unsafe",
        "El CSS generado no admite imports, URLs, at-rules ni valores activos",
        path,
      ),
    );
  }
  const scopeClass = `.generated-${plan.changeId}`;
  const rulePattern = /([^{}]+)\{([^{}]*)\}/gu;
  let consumed = "";
  let ruleCount = 0;
  for (const match of withoutComments.matchAll(rulePattern)) {
    ruleCount += 1;
    consumed += match[0];
    const selectors = (match[1] ?? "").split(",");
    if (
      selectors.some((selector) => {
        const trimmed = selector.trim();
        if (!trimmed.startsWith(scopeClass)) return true;
        const suffix = trimmed.slice(scopeClass.length);
        const first = suffix[0] ?? "";
        return suffix !== "" && !/\s/u.test(first) && !".#[>:".includes(first);
      })
    ) {
      violations.push(
        violation(
          "css.scope",
          `Cada selector debe estar limitado por ${scopeClass}`,
          path,
        ),
      );
    }
  }
  const compactSource = withoutComments.replace(/\s/gu, "");
  const compactConsumed = consumed.replace(/\s/gu, "");
  if (
    ruleCount === 0 ||
    compactConsumed !== compactSource ||
    (withoutComments.match(/\{/gu)?.length ?? 0) !==
      (withoutComments.match(/\}/gu)?.length ?? 0)
  ) {
    violations.push(
      violation(
        "css.unsafe",
        "El CSS generado usa una sintaxis no soportada por la política cerrada",
        path,
      ),
    );
  }
  return violations;
}

function inertPublicAssetMatches(bytes: Buffer, extension: string): boolean {
  const prefix = (length: number) =>
    bytes.subarray(0, length).toString("ascii");
  switch (extension) {
    case ".png":
      return (
        bytes.length >= 8 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    case ".jpg":
    case ".jpeg":
      return (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );
    case ".gif":
      return prefix(6) === "GIF87a" || prefix(6) === "GIF89a";
    case ".webp":
      return (
        bytes.length >= 12 &&
        prefix(4) === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case ".avif": {
      const brand = bytes.subarray(8, 12).toString("ascii");
      return (
        bytes.length >= 12 &&
        bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
        (brand === "avif" || brand === "avis")
      );
    }
    case ".ico":
      return (
        bytes.length >= 4 &&
        bytes[0] === 0 &&
        bytes[1] === 0 &&
        bytes[2] === 1 &&
        bytes[3] === 0
      );
    case ".woff":
      return prefix(4) === "wOFF";
    case ".woff2":
      return prefix(4) === "wOF2";
    default:
      return false;
  }
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
    if (
      isDescendant(paths.assets, path) &&
      (!inertPublicExtensions.has(extension) ||
        !inertPublicAssetMatches(bytes, extension))
    ) {
      violations.push(
        violation(
          "asset.active",
          "Los assets públicos generados se limitan a imágenes y fuentes inertes",
          path,
        ),
      );
    }
    if (isDescendant(paths.components, path)) {
      violations.push(
        violation(
          "source.unsupported",
          "Los componentes generados no están autorizados por la gramática canónica actual",
          path,
        ),
      );
    }
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
        violations.push(...validateScriptSource(source, path));
      }
    } else if (extension === ".css") {
      const source = decodeUtf8(bytes);
      if (
        source === null ||
        path !== paths.stylesheet ||
        plan.selectedMode === "blocks"
      ) {
        violations.push(
          violation(
            "css.unsafe",
            "El CSS solo se admite en la hoja canónica de freeform/hybrid",
            path,
          ),
        );
      } else {
        violations.push(...validateGeneratedCss(source, plan, path));
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

  violations.push(...validateDependencies(files));
  return violations;
}
