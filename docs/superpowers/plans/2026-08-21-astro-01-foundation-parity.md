# Base Astro y arnés de paridad — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear un proyecto Astro/Cloudflare ejecutable, proteger el repositorio fuente y congelar un inventario y arnés reproducibles para medir toda la migración.

**Architecture:** El repositorio nuevo usa Astro en modo `server` y un Worker personalizado que delega al handler oficial. Scripts de desarrollo leen exclusivamente blobs del commit fijado mediante Git, construyen el manifiesto y guardan evidencia fuera del runtime. Los comparadores HTTP, HTML y visual consumen contratos versionados y no se integran dentro de las páginas.

**Tech Stack:** Node 22.22.3, Astro 7.2.4, `@astrojs/cloudflare` 14.2.3, React 19.2.6, TypeScript 5.9.3, Wrangler 4.125.0, Node Test, Playwright 1.62.1, pixelmatch 7.2.0.

**Spec:** `docs/superpowers/specs/2026-08-21-astro-parity-ingestion-design.md`

## Global Constraints

- Aplican todas las restricciones de `2026-08-21-astro-migration-master.md`.
- La captura conocida debe encontrar 103 redirects, 19 gone, 21 páginas de comunidades, 19 posts, 3 proyectos remotos y 122 rutas del sitemap WordPress auditado.
- El sitio fuente nunca se compila en su propio checkout; cualquier build se hace desde `git archive` en un directorio temporal.
- Los scripts de captura pueden conocer `../comunidadsolarweb`; nada bajo `src/` puede importarlo o leerlo.
- `.artifacts/` y `.source-work/` permanecen ignorados y nunca contienen secretos versionados.

---

## Mapa de archivos de esta fase

```text
package.json                         scripts y versiones fijadas
astro.config.mjs                    Astro server + React + Cloudflare
wrangler.jsonc                      Worker local, assets y D1 local ficticio
src/worker.ts                       entrada Cloudflare y delegación a Astro
src/pages/index.astro               smoke route temporal, reemplazada en fase 2
src/env.d.ts                         tipos Astro/Cloudflare
scripts/lib/source-reference.ts     lectura Git inmutable
scripts/source-check.ts             guardia de commit/limpieza
scripts/copy-source-files.ts         copia por blob con procedencia
scripts/capture-source-manifest.ts   inventario de rutas/archivos/assets
scripts/capture-http-baseline.ts     respuestas de referencia desde copia temporal
scripts/parity-http.ts               comparación de contratos
scripts/parity-visual.ts             screenshots, geometría y pixel diff
scripts/verify-independent.ts        build desde archivo Git sin repositorio vecino
parity/source-manifest.json          inventario canónico
parity/provenance.json               origen y hash de cada copia
parity/route-matrix.json             estado por contrato
tests/foundation/*                   configuración y guardias
tests/parity/*                       inventario y comparadores
```

### Task 1: Inicializar Astro 7 sobre Cloudflare Workers

**Files:**
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `package.json`
- Create: `astro.config.mjs`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `prettier.config.mjs`
- Create: `.prettierignore`
- Create: `wrangler.jsonc`
- Create: `src/env.d.ts`
- Create: `src/worker.ts`
- Create: `src/pages/index.astro`
- Create: `scripts/run-unit-tests.ts`
- Create: `tests/foundation/project-config.test.mjs`
- Generated: `package-lock.json`
- Generated: `worker-configuration.d.ts`

**Interfaces:**
- Consumes: ninguna interfaz de código; fija el runtime de todos los planes posteriores.
- Produces: `src/worker.ts` con `default ExportedHandler<Env>` y scripts npm estables.

- [ ] **Step 1: Escribir la prueba de configuración antes de crear el proyecto**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pins the approved Astro and Cloudflare runtime", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.engines.node, ">=22.12.0");
  assert.equal(pkg.dependencies.astro, "7.2.4");
  assert.equal(pkg.dependencies["@astrojs/cloudflare"], "14.2.3");
  assert.equal(pkg.dependencies.next, undefined);
  assert.equal(pkg.dependencies.vinext, undefined);

  const astroConfig = await readFile("astro.config.mjs", "utf8");
  assert.match(astroConfig, /output:\s*["']server["']/);
  assert.match(astroConfig, /cloudflare\(/);
});
```

- [ ] **Step 2: Ejecutar la prueba para verificar que falla**

Run: `node --test tests/foundation/project-config.test.mjs`

Expected: FAIL con `ENOENT: no such file or directory, open 'package.json'`.

- [ ] **Step 3: Crear la configuración mínima completa**

`package.json` tendrá exactamente estas versiones iniciales y scripts; las fases
posteriores añadirán Ajv/YAML/ZIP cuando tengan tests que los necesiten.

```json
{
  "name": "comunidad-solar-astro",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "dev": "wrangler types && astro dev",
    "check": "wrangler types && astro check",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint \"src/**/*.{ts,tsx,astro}\" \"scripts/**/*.ts\" \"tests/**/*.{ts,mjs}\" \"*.{js,mjs,ts}\"",
    "test:unit": "tsx scripts/run-unit-tests.ts",
    "test:e2e": "playwright test",
    "test": "npm run test:unit",
    "build": "wrangler types && astro check && astro build",
    "preview": "astro preview",
    "deploy:dry": "wrangler deploy --dry-run --strict",
    "source:check": "tsx scripts/source-check.ts",
    "parity:manifest": "tsx scripts/capture-source-manifest.ts",
    "parity:http": "tsx scripts/parity-http.ts",
    "parity:visual": "tsx scripts/parity-visual.ts",
    "verify:independent": "tsx scripts/verify-independent.ts"
  },
  "dependencies": {
    "@astrojs/cloudflare": "14.2.3",
    "@astrojs/react": "6.0.4",
    "astro": "7.2.4",
    "drizzle-orm": "0.45.2",
    "react": "19.2.6",
    "react-dom": "19.2.6"
  },
  "devDependencies": {
    "@eslint/js": "9.39.4",
    "@astrojs/check": "0.9.10",
    "@playwright/test": "1.62.1",
    "@types/node": "22.19.19",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "eslint": "9.39.4",
    "eslint-plugin-astro": "1.7.0",
    "globals": "17.11.0",
    "pixelmatch": "7.2.0",
    "pngjs": "7.0.0",
    "prettier": "3.9.6",
    "prettier-plugin-astro": "0.14.1",
    "tsx": "4.23.12",
    "typescript": "5.9.3",
    "typescript-eslint": "8.46.1",
    "wrangler": "4.125.0"
  }
}
```

`scripts/run-unit-tests.ts` permite que `npm run test:unit -- <archivos>` ejecute
solo el subconjunto indicado; sin argumentos descubre recursivamente todos los
`*.test.ts` y `*.test.mjs`, los ordena y los pasa a `tsx --test` sin shell:

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function collectTests(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(path));
    else if (/\.test\.(?:ts|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const requested = process.argv.slice(2);
const discovered = await collectTests("tests");
const files = (requested.length > 0
  ? requested
  : discovered.filter((file) => !file.split(/[\\/]/).includes("integration"))
).sort();
if (files.length === 0) throw new Error("No unit test files found");
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const child = spawn(tsx, ["--test", ...files], { stdio: "inherit", shell: false });
const code = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (value) => resolve(value ?? 1));
});
process.exitCode = code;
```

`eslint.config.js` usa la configuración flat compatible del conjunto fijado:

```js
import eslint from "@eslint/js";
import astro from "eslint-plugin-astro";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".astro/**", ".artifacts/**", ".source-work/**", "worker-configuration.d.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.astro"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { parser: tseslint.parser },
    },
  },
);
```

`prettier.config.mjs` exporta `{ plugins: ["prettier-plugin-astro"], overrides:
[{ files: "*.astro", options: { parser: "astro" } }] }`. `.gitignore` excluye
`node_modules`, `dist`, `.astro`, `.wrangler`, `.dev.vars*`, `.env*` salvo
`.env.example`, `.source-work`, `.artifacts` y `.change-state`.
`.prettierignore` excluye `docs/`, `public/`, `parity/`, `changes/`,
`worker-configuration.d.ts`, `src/styles/reference.css` y los Markdown copiados
literalmente bajo `src/content/`; el código Astro generado no queda excluido.
`.nvmrc` contiene `22.22.3`. `tsconfig.json` y `src/env.d.ts` son:

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

```ts
/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />
```

`astro.config.mjs`:

```js
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const configPath = process.env.CLOUDFLARE_CONFIG_PATH;

export default defineConfig({
  site: "https://comunidadsolar.es",
  output: "server",
  adapter: cloudflare({
    ...(configPath ? { configPath } : {}),
    imageService: { build: "compile", runtime: "cloudflare-binding" },
  }),
  integrations: [react()],
  vite: { resolve: { dedupe: ["react", "react-dom"] } },
});
```

`wrangler.jsonc` usa un UUID local no desplegable; un config externo será
obligatorio para publicar.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "comunidad-solar-astro-local",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-08-21",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "directory": "./dist" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "comunidad-solar-local",
      "database_id": "00000000-0000-4000-8000-000000000000",
      "migrations_dir": "drizzle"
    }
  ],
  "observability": { "enabled": true }
}
```

`src/worker.ts`:

```ts
import { handle } from "@astrojs/cloudflare/handler";

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

La ruta smoke devuelve `<h1>Comunidad Solar</h1>` y
`<meta name="robots" content="noindex,nofollow">`; no intenta ser todavía la
home de referencia.

- [ ] **Step 4: Instalar, generar tipos y ejecutar la prueba**

```bash
npm install
npx wrangler types
npm run test:unit -- tests/foundation/project-config.test.mjs
npm run check
npm run build
```

Expected: todos exit 0 y `dist/_worker.js/index.js` existe.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .prettierignore .nvmrc package.json package-lock.json astro.config.mjs tsconfig.json eslint.config.js prettier.config.mjs wrangler.jsonc worker-configuration.d.ts src scripts/run-unit-tests.ts tests/foundation/project-config.test.mjs
git commit -m "build: initialize Astro Cloudflare runtime"
```

### Task 2: Proteger la referencia y copiar blobs con procedencia

**Files:**
- Create: `scripts/lib/source-reference.ts`
- Create: `scripts/source-check.ts`
- Create: `scripts/copy-source-files.ts`
- Create: `parity/provenance.json`
- Create: `tests/foundation/source-reference.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `SourceRef` del plan maestro.
- Produces: `assertSourcePristine(sourceRoot?: string): Promise<SourceRef>`, `readSourceBlob(path: string): Promise<Buffer>`, `copySourceFiles(paths: string[]): Promise<ProvenanceEntry[]>`.

- [ ] **Step 1: Escribir tests de commit, limpieza y lectura por blob**

```ts
test("rejects a source checkout on another commit", async () => {
  await assert.rejects(
    assertSourcePristine(fixture.repo, EXPECTED_SOURCE_COMMIT),
    /commit de referencia/i,
  );
});

test("rejects tracked or untracked source changes", async () => {
  await writeFile(join(fixture.repo, "untracked.txt"), "stop");
  await assert.rejects(
    assertSourcePristine(fixture.repo, fixture.head),
    /no está limpio/i,
  );
});

test("reads the committed blob instead of the working tree", async () => {
  const blob = await readSourceBlob("public/favicon.svg", fixture.repo, fixture.head);
  assert.equal(blob.toString(), fixture.committedFavicon);
});
```

El fixture crea con `git init -b main` un repositorio Git dentro de `mkdtemp()`
mediante `execFile`, nunca dentro de `comunidadsolarweb`.

- [ ] **Step 2: Ejecutar los tests y confirmar el fallo**

Run: `npm run test:unit -- tests/foundation/source-reference.test.ts`

Expected: FAIL porque `assertSourcePristine` y `readSourceBlob` no existen.

- [ ] **Step 3: Implementar Git como única API de la referencia**

```ts
export const EXPECTED_SOURCE_COMMIT =
  "68ea294c54dc5e15e20f470fc421a239927565a8" as const;

export async function git(
  sourceRoot: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  return stdout;
}

export async function assertSourcePristine(
  sourceRoot = resolve("../comunidadsolarweb"),
  expectedCommit = EXPECTED_SOURCE_COMMIT,
): Promise<SourceRef> {
  const head = (await git(sourceRoot, ["rev-parse", "HEAD"])).trim();
  if (head !== expectedCommit) throw new Error("Commit de referencia inesperado");
  const branch = (await git(sourceRoot, ["branch", "--show-current"])).trim();
  if (branch !== "main") throw new Error("La referencia no está en branch main");
  if ((await git(sourceRoot, ["status", "--porcelain=v1"])).trim()) {
    throw new Error("El repositorio fuente no está limpio");
  }
  return { repository: "../comunidadsolarweb", branch: "main", commit: expectedCommit };
}

export async function readSourceBlob(
  path: string,
  sourceRoot = resolve("../comunidadsolarweb"),
  commit = EXPECTED_SOURCE_COMMIT,
): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["show", `${commit}:${path}`], {
    cwd: sourceRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}
```

`copySourceFiles` rechaza paths absolutos, `..` y destinos fuera del repositorio;
escribe mediante archivo temporal + rename y añade `sourcePath`, `destination`,
`sourceCommit`, `sha256` y `bytes` a `parity/provenance.json` ordenado.
El CLI `source-check --if-present` devuelve exit 0 y `SOURCE_UNAVAILABLE` solo si
el sibling no existe; si existe, commit, branch y limpieza siguen siendo
obligatorios. El script npm sin flag es siempre estricto.

- [ ] **Step 4: Ejecutar tests y la guardia real**

```bash
npm run test:unit -- tests/foundation/source-reference.test.ts
npm run source:check
```

Expected: tests PASS y salida
`SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.

- [ ] **Step 5: Commit**

```bash
git add .gitignore scripts/lib/source-reference.ts scripts/source-check.ts scripts/copy-source-files.ts parity/provenance.json tests/foundation/source-reference.test.ts
git commit -m "build: guard immutable source reference"
```

### Task 3: Generar el manifiesto completo de rutas y assets

**Files:**
- Create: `scripts/lib/route-inventory.ts`
- Create: `scripts/capture-source-manifest.ts`
- Create: `parity/source-manifest.json`
- Create: `parity/route-matrix.json`
- Create: `tests/parity/source-manifest.test.ts`

**Interfaces:**
- Consumes: `assertSourcePristine`, `readSourceBlob` y módulos de datos puros del commit fuente.
- Produces: `buildSourceManifest(options): Promise<SourceManifest>` y `writeSourceManifest(manifest): Promise<void>`.

- [ ] **Step 1: Escribir tests con las invariantes conocidas**

```ts
test("the frozen manifest inventories every known route family", async () => {
  const manifest = await readSourceManifest("parity/source-manifest.json");
  const byKind = Object.groupBy(manifest.routes, (route) => route.kind);

  assert.equal(byKind.redirect?.length, 103);
  assert.equal(byKind.gone?.length, 19);
  assert.equal(manifest.routes.filter((r) => r.visualTemplate === "community-detail").length, 21);
  assert.equal(manifest.routes.filter((r) => r.visualTemplate === "blog-detail").length, 19);
  assert.equal(manifest.routes.filter((r) => r.visualTemplate === "remote-detail").length, 3);
  assert.equal(new Set(manifest.routes.map((r) => `${r.kind}:${r.path}`)).size, manifest.routes.length);
});

test("accounts for all 122 audited WordPress paths", async () => {
  const manifest = await readSourceManifest("parity/source-manifest.json");
  assert.equal(manifest.wordpressAudit.total, 122);
  assert.deepEqual(manifest.wordpressAudit.unclassified, []);
});

test("manifest generation is deterministic for an injected source", async () => {
  const source = createMemorySourceFixture();
  const options = { source, generatedAt: "2026-08-21T00:00:00.000Z" };
  assert.deepEqual(await buildSourceManifest(options), await buildSourceManifest(options));
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `npm run test:unit -- tests/parity/source-manifest.test.ts`

Expected: FAIL porque `buildSourceManifest` no existe.

- [ ] **Step 3: Implementar el inventario mecánico**

El script:

1. ejecuta `assertSourcePristine`;
2. carga `community-data.ts`, `blog-data.ts`, `remote-project-data.ts` y
   `legacy-routes.ts` desde sus blobs usando `typescript.transpileModule` en un
   directorio temporal;
3. recorre los blobs `app/**/page.tsx` y `app/**/route.ts` obtenidos por
   `git ls-tree -r --name-only <commit>`;
4. expande `[community]`, `[post]` y `[project]` con los datos cargados;
5. usa TypeScript AST para extraer las 18 claves del objeto `pages` de
   `app/[slug]/page.tsx`;
6. añade home, sitemap, robots, privadas, APIs, 103 redirects y 19 gone;
7. calcula SHA-256 y bytes de cada archivo y asset;
8. ordena por `kind`, `path` y `fixtureId` antes de serializar.

`buildSourceManifest` recibe opcionalmente un `SourceRepository` con
`assertPristine`, `listFiles` y `readBlob`. Producción usa el adaptador Git;
unitarios usan `createMemorySourceFixture`, por lo que `npm test` no necesita el
checkout fuente. Solo `parity:manifest --write|--check` usa el adaptador real.

El conversor de archivo a patrón es explícito:

```ts
export function appFileToRoute(file: string): string {
  return file
    .replace(/^app/, "")
    .replace(/\/(?:page\.tsx|route\.ts)$/, "")
    .replace(/^$/, "/");
}
```

`parity/route-matrix.json` se inicia con una entrada por `RouteContract` y
`status: "pending"`; ninguna fase puede borrar entradas.

- [ ] **Step 4: Generar, volver a generar y demostrar determinismo semántico**

```bash
npm run parity:manifest -- --write
cp parity/source-manifest.json /tmp/comunidad-solar-manifest.json
npm run parity:manifest -- --write
node -e 'const fs=require("fs"); const a=JSON.parse(fs.readFileSync("/tmp/comunidad-solar-manifest.json")); const b=JSON.parse(fs.readFileSync("parity/source-manifest.json")); delete a.generatedAt; delete b.generatedAt; require("assert").deepStrictEqual(a,b)'
npm run test:unit -- tests/parity/source-manifest.test.ts
```

Expected: todos exit 0, con `unclassified: []`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/route-inventory.ts scripts/capture-source-manifest.ts parity/source-manifest.json parity/route-matrix.json tests/parity/source-manifest.test.ts
git commit -m "test: freeze complete source route manifest"
```

### Task 4: Congelar contratos HTTP/HTML desde una copia temporal

**Files:**
- Create: `scripts/lib/temporary-source-build.ts`
- Create: `scripts/capture-http-baseline.ts`
- Create: `parity/http-contracts.json`
- Create: `tests/parity/http-baseline.test.ts`

**Interfaces:**
- Consumes: `SourceManifest`.
- Produces: `withTemporarySourceBuild<T>(run, options?: TemporarySourceOptions): Promise<T>`, `HttpContract { routeKey, status, headers, bodySha256, normalizedHtmlPath }`.

- [ ] **Step 1: Escribir tests para aislamiento y normalización**

```ts
test("builds only inside a temporary git archive", async () => {
  const source = await createSourceRepoFixture();
  const original = await snapshotRepository(source.root);
  await withTemporarySourceBuild(async ({ root }) => {
    assert.notEqual(realpathSync(root), realpathSync(source.root));
    assert.equal(existsSync(join(root, ".git")), false);
  }, { sourceRoot: source.root, commit: source.commit, install: false });
  assert.deepEqual(await snapshotRepository(source.root), original);
});

test("normalizes volatile dates without removing meaningful HTML", () => {
  const normalized = normalizeHtml('<main data-build="2026-08-21T10:00:00Z"><h1>Sol</h1></main>');
  assert.equal(normalized, '<main data-build="__TIMESTAMP__"><h1>Sol</h1></main>');
});
```

- [ ] **Step 2: Ejecutar el fallo esperado**

Run: `npm run test:unit -- tests/parity/http-baseline.test.ts`

Expected: FAIL con exports ausentes.

- [ ] **Step 3: Implementar build y captura sin tocar el checkout**

`withTemporarySourceBuild` crea `mkdtemp`, usa `spawn("git", ["archive",
"--format=tar", commit], { cwd: SOURCE_ROOT })` y canaliza su stdout binario a
un `.tar` dentro del temporal; tras comprobar exit 0, lo extrae con
`execFile("tar", ["-xf", archivePath, "-C", root])`, elimina el tar y ejecuta
`npm ci` y `npm run build` dentro del temporal. No usa shell ni modifica el
checkout. Registra stdout/stderr en `.artifacts/source-build/` y siempre elimina
el temporal en `finally`.

`capture-http-baseline` importa el Worker construido y llama `fetch` con ASSETS
falso como hace `tests/rendered-html.test.mjs`. Captura:

- todas las páginas y endpoints que no requieren una red externa;
- identidades anonymous, allowed, denied y unconfigured;
- redirects con y sin query string;
- body de gone y errores de APIs;
- HTML normalizado por ruta y fixture bajo `.artifacts/http-baseline/`;
- status y allowlist de headers en `parity/http-contracts.json`.

No ejecuta los dos upstreams de cotización; los intercepta con fixtures que se
definen en fase 3.

- [ ] **Step 4: Capturar y validar la cobertura**

```bash
npm run source:check
npx tsx scripts/capture-http-baseline.ts --write
npm run test:unit -- tests/parity/http-baseline.test.ts
npm run source:check
```

Expected: cada ruta comparable tiene contrato o razón estructurada
`deferredToPhase: 2 | 3`, y el checkout fuente coincide antes/después.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/temporary-source-build.ts scripts/capture-http-baseline.ts parity/http-contracts.json tests/parity/http-baseline.test.ts .gitignore
git commit -m "test: capture immutable HTTP baseline"
```

### Task 5: Implementar el comparador HTTP y la entrada Worker enrutable

**Files:**
- Create: `src/lib/routing/legacy.ts`
- Create: `src/lib/routing/gone.ts`
- Create: `src/lib/routing/before-astro.ts`
- Modify: `src/worker.ts`
- Create: `scripts/parity-http.ts`
- Create: `tests/foundation/worker-routing.test.ts`
- Create: `tests/parity/http-compare.test.ts`

**Interfaces:**
- Consumes: `HttpContract`, 103 redirects y 19 paths gone.
- Produces: `routeBeforeAstro(request: Request): Response | null`, `compareHttpContract(expected, actual): HttpDiff[]`.

- [ ] **Step 1: Escribir tests de precedencia y query string**

```ts
test("returns gone before Astro", async () => {
  const response = routeBeforeAstro(new Request("https://example.test/subvenciones"));
  assert.equal(response?.status, 410);
  assert.equal(response?.headers.get("x-robots-tag"), "noindex");
});

test("preserves query strings in permanent redirects", async () => {
  const response = routeBeforeAstro(new Request("https://example.test/mision?utm_source=x"));
  assert.equal(response?.status, 308);
  assert.equal(response?.headers.get("location"), "https://example.test/nosotros?utm_source=x#mision");
});
```

Al implementar, conservar exactamente la semántica real: construir el destino
con `new URL(to, url.origin)` y asignar `destination.search = url.search` antes
de devolver 308. El orden serializado es `?utm_source=x#mision`.

- [ ] **Step 2: Ejecutar tests y observar el fallo**

Run: `npm run test:unit -- tests/foundation/worker-routing.test.ts tests/parity/http-compare.test.ts`

Expected: FAIL con módulos ausentes.

- [ ] **Step 3: Copiar datos y envolver el handler Astro**

Usar `copySourceFiles` para llevar `app/legacy-routes.ts` a
`src/lib/routing/legacy.ts`, cambiando solo el path y manteniendo arrays/textos.
Crear `gone.ts` con el body y headers exactos. El Worker final de esta tarea:

```ts
import { handle } from "@astrojs/cloudflare/handler";
import { routeBeforeAstro } from "./lib/routing/before-astro";

export default {
  fetch(request, env, ctx) {
    return routeBeforeAstro(request) ?? handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

`compareHttpContract` compara status, headers seleccionados, canonical, robots,
texto normalizado y hash de body cuando el contrato lo marca exacto. Cada diff
tiene `{ routeKey, field, expected, actual }`.

El CLI construye una sola vez, importa `dist/_worker.js/index.js` con cache-bust
por URL de archivo y ejecuta requests contra su export `fetch` con bindings
fixture (`ASSETS`, `DB` y env). Así ninguna ruta se compara mediante un servidor
distinto del Worker que se publicará.

- [ ] **Step 4: Ejecutar unitarios, build y comparación smoke**

```bash
npm run test:unit -- tests/foundation/worker-routing.test.ts tests/parity/http-compare.test.ts
npm run build
npm run parity:http -- --scope foundation
```

Expected: 103 redirects y 19 gone pasan; la home sigue marcada `pending` para
fase 2, no como falso positivo.

- [ ] **Step 5: Commit**

```bash
git add src/lib/routing src/worker.ts scripts/parity-http.ts tests/foundation/worker-routing.test.ts tests/parity/http-compare.test.ts parity/provenance.json parity/route-matrix.json
git commit -m "feat: route legacy contracts before Astro"
```

### Task 6: Crear comparación visual y geométrica reutilizable

**Files:**
- Create: `playwright.config.ts`
- Create: `scripts/lib/visual-contract.ts`
- Create: `scripts/parity-visual.ts`
- Create: `tests/parity/visual-contract.test.ts`

**Interfaces:**
- Consumes: `RouteContract.visualTemplate` y dos URLs o dos directorios de screenshots.
- Produces: `VisualResult { routeKey, viewport, differentPixels, diffRatio, geometryDiffs, files, status }`.

- [ ] **Step 1: Escribir tests del comparador con PNGs generados en memoria**

```ts
test("reports zero for identical pixels and geometry", async () => {
  const result = await compareVisuals(fixture.reference, fixture.reference, {
    referenceGeometry: fixture.boxes,
    candidateGeometry: fixture.boxes,
  });
  assert.equal(result.differentPixels, 0);
  assert.deepEqual(result.geometryDiffs, []);
});

test("never hides a non-zero diff behind a threshold", async () => {
  const result = await compareVisuals(fixture.reference, fixture.onePixelChanged, fixture.geometry);
  assert.equal(result.status, "review-required");
  assert.equal(result.differentPixels, 1);
});
```

- [ ] **Step 2: Ejecutar tests y confirmar el fallo**

Run: `npm run test:unit -- tests/parity/visual-contract.test.ts`

Expected: FAIL porque `compareVisuals` no existe.

- [ ] **Step 3: Implementar captura full-page determinista**

Los viewports exactos son `1440×900`, `768×1024` y `390×844`, DPR 1,
`reducedMotion: "reduce"`, color claro y locale `es-ES`. Antes de capturar:

```ts
await context.addInitScript(() => {
  localStorage.setItem("comunidad-solar-cookie-consent-v1", "necessary");
});
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(async () => document.fonts.ready);
await page.locator("img").evaluateAll(async (images) =>
  Promise.all(images.map((image) => image.complete ? undefined : new Promise((resolve) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", resolve, { once: true });
  }))),
);
```

La captura usa `fullPage: true`. pixelmatch genera el diff, pero cualquier
`differentPixels > 0` devuelve `review-required`. La geometría serializa
`x/y/width/height` a dos decimales para selectores declarados por template.
`parity-visual` obtiene la referencia mediante `withTemporarySourceBuild`, abre
el Worker fuente y el Worker candidato en puertos libres y aplica a ambos las
mismas respuestas fixture para toda petición de terceros; una petición externa
no declarada falla la captura en vez de introducir ruido.

- [ ] **Step 4: Probar con la home smoke sin declarar paridad**

```bash
npx playwright install chromium
npm run test:unit -- tests/parity/visual-contract.test.ts
npm run build
npm run parity:visual -- --scope foundation --allow-pending
```

Expected: el arnés genera JSON/HTML y marca home `pending`, sin afirmar que la
ruta temporal iguala la referencia.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts scripts/lib/visual-contract.ts scripts/parity-visual.ts tests/parity/visual-contract.test.ts .gitignore
git commit -m "test: add strict visual parity harness"
```

### Task 7: Probar build autónomo y cerrar la fase

**Files:**
- Create: `scripts/verify-independent.ts`
- Create: `tests/foundation/independence.test.ts`
- Create: `.github/workflows/verify.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: scripts npm y archivos tracked del repositorio nuevo.
- Produces: `verifyIndependent(options?: { execute?: boolean; source?: "head" | "staged" }): Promise<IndependentResult>`.

- [ ] **Step 1: Escribir el test que rechaza dependencias de sibling**

```ts
test("runtime sources never reference the old checkout", async () => {
  const violations = await findSourceCheckoutReferences(["src", "public", "astro.config.mjs"]);
  assert.deepEqual(violations, []);
});

test("independent verifier archives a Git tree and plans all checks", async () => {
  const result = await verifyIndependent({ execute: false, source: "head" });
  assert.equal(result.archiveHasGitDirectory, false);
  assert.deepEqual(result.commands.map((command) => command.argv), [
    ["npm", "ci"],
    ["npm", "run", "check"],
    ["npm", "test"],
    ["npm", "run", "build"],
  ]);
});
```

- [ ] **Step 2: Ejecutar y confirmar el fallo**

Run: `npm run test:unit -- tests/foundation/independence.test.ts`

Expected: FAIL hasta que exista `verifyIndependent`.

- [ ] **Step 3: Implementar archivo autónomo y CI**

`verifyIndependent` usa `git archive HEAD` por defecto, extrae en `mkdtemp`,
comprueba que no existe `.git` ni `../comunidadsolarweb`, ejecuta `npm ci`,
`npm run check`, `npm test` y `npm run build`, y limpia en `finally`. La opción
`execute:false` prueba sin lanzar subprocesses. `--staged` invoca internamente
`git write-tree` y archiva ese tree; antes rechaza archivos de proyecto sin
stage para que la prueba previa al commit no omita trabajo.

CI ejecuta Node 22, `npm ci`, `npx playwright install chromium`,
`source-check --if-present`, format, lint, check, test, build y
`wrangler deploy --dry-run --strict`. La suite consume fixtures y manifiestos
versionados cuando el sibling no existe. No configura secrets ni despliega.

- [ ] **Step 4: Ejecutar el gate completo de fase 1**

```bash
git add scripts/verify-independent.ts tests/foundation/independence.test.ts .github/workflows/verify.yml README.md
npm run source:check
npm run format:check
npm run lint
npm run check
npm test
npm run build
npm run parity:manifest
npm run verify:independent -- --staged
npm run deploy:dry
```

Expected: todos exit 0; el índice contiene exactamente los archivos de esta
tarea y el archivo Git staged compila sin el sibling.

- [ ] **Step 5: Commit**

```bash
git commit -m "ci: verify autonomous Astro foundation"
```

Al terminar, ejecutar `npm run source:check` una vez más y actualizar la fase 1
del plan maestro como completada.
