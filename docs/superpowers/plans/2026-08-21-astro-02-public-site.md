# Sitio público Astro con paridad completa — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproducir todas las páginas públicas de `comunidadsolarweb` como rutas y componentes Astro nativos, conservando exactamente diseño, contenido, responsive, SEO e interacciones.

**Architecture:** El CSS y los datos del commit fuente se copian con procedencia antes de portar markup. Un layout Astro genera documento y metadatos; componentes Astro renderizan HTML estático; ocho islas React encapsulan únicamente los estados que el sitio realmente usa. Las familias dinámicas leen contenido tipado y generan paths completos, mientras el arnés de fase 1 demuestra paridad por contrato y visual.

**Tech Stack:** Astro 7.2.4, React islands 19.2.6, TypeScript 5.9.3, Playwright, pixelmatch, manifiestos JSON.

**Spec:** `docs/superpowers/specs/2026-08-21-astro-parity-ingestion-design.md`

## Global Constraints

- Aplican todas las restricciones del plan maestro y el plan 01 debe estar verde.
- Copiar texto, datos, CSS y recursos no autoriza ninguna corrección editorial.
- `src/styles/reference.css` comienza byte a byte igual a `app/globals.css`; cualquier cambio posterior se justifica con un test de paridad.
- Cada componente portado conserva clases, orden DOM, atributos accesibles, URLs y texto del rango fuente indicado.
- No se usa una isla para envolver una página completa.
- Toda ruta pública se prerenderiza con `export const prerender = true`.
- Los tests contractuales originales se conservan; solo cambia el helper que obtiene la respuesta Astro.

---

## Mapa de componentes e islas

| Fuente | Destino Astro | Cliente |
|---|---|---|
| `site.tsx:343-584` | `src/components/site/HeaderIsland.tsx` | `client:load` |
| `site.tsx:585-660` | `src/components/site/Footer.astro` | no |
| `consent-manager.tsx` | `src/components/islands/ConsentManager.tsx` | `client:idle` |
| `site.tsx:785-1046` | `src/components/islands/CoverageFinder.tsx` | `client:visible` |
| `site.tsx:3592-3960` | `src/components/islands/TariffBillSimulator.tsx` | `client:visible` |
| `site.tsx:5033-5195` | `src/components/islands/AboutVideo.tsx` | `client:visible` |
| `site.tsx:5482-5690` | `src/components/islands/RemoteVideo.tsx` | `client:visible` |
| `site.tsx:6748-6982` | `src/components/islands/BlogFilter.tsx` | `client:visible` |
| `site.tsx:7683-7835` | `src/components/islands/OperationalPlantForm.tsx` | `client:visible` |

Manganáfer se divide en estático + islas en el plan 03 porque sus dos formularios
dependen de APIs.

### Task 1: Copiar contenido, estilos y recursos con hashes

**Files:**
- Create: `src/content/community-data.ts`
- Create: `src/content/blog-data.ts`
- Create: `src/content/remote-project-data.ts`
- Create: `src/content/events-data.ts`
- Create: `src/content/trust-data.ts`
- Create: `src/content/legal-content.ts`
- Create: `src/content/partner-data.ts`
- Create: `src/content/guide-content.md`
- Create: `src/styles/reference.css`
- Create: `public/**` (77 archivos del manifiesto)
- Modify: `parity/provenance.json`
- Create: `tests/content/source-copies.test.ts`

**Interfaces:**
- Consumes: `copySourceFiles(paths)` y `SourceManifest.assets`.
- Produces: las mismas exports de datos que los módulos fuente, renombrando solo paths de import.

- [ ] **Step 1: Escribir el test de integridad y cardinalidad**

```ts
test("copies every public asset and content module from the frozen commit", async () => {
  const manifest = await readSourceManifest();
  const provenance = await readProvenance();
  for (const asset of manifest.assets) {
    const destination = join("public", asset.path.replace(/^public\//, ""));
    assert.equal(await sha256File(destination), asset.sha256, destination);
    const entry = provenance.find((item) => item.destination === destination);
    assert.equal(entry?.sourceCommit, EXPECTED_SOURCE_COMMIT);
  }
});

test("preserves content inventory", () => {
  assert.equal(communities.length, 20);
  assert.equal(communityPages.length, 21);
  assert.equal(blogPosts.length, 19);
  assert.equal(remoteProjects.length, 3);
});
```

- [ ] **Step 2: Ejecutar el test y confirmar que falla**

Run: `npm run test:unit -- tests/content/source-copies.test.ts`

Expected: FAIL porque los destinos no existen.

- [ ] **Step 3: Copiar blobs exactos y ajustar únicamente imports**

```bash
npm run source:check
npx tsx scripts/copy-source-files.ts \
  --map app/community-data.ts:src/content/community-data.ts \
  --map app/blog-data.ts:src/content/blog-data.ts \
  --map app/remote-project-data.ts:src/content/remote-project-data.ts \
  --map app/events-data.ts:src/content/events-data.ts \
  --map app/trust-data.ts:src/content/trust-data.ts \
  --map app/legal-content.ts:src/content/legal-content.ts \
  --map app/socios/partner-data.ts:src/content/partner-data.ts \
  --map app/guide-content.md:src/content/guide-content.md \
  --map app/globals.css:src/styles/reference.css \
  --public-from-manifest
```

Los módulos son puros y no necesitan cambios salvo imports relativos si los
hubiera. Prohibido reformatear en este commit para que el diff de procedencia sea
auditable.

- [ ] **Step 4: Verificar contenido y fuente**

```bash
npm run test:unit -- tests/content/source-copies.test.ts
npm run source:check
```

Expected: PASS y todos los hashes de assets coinciden.

- [ ] **Step 5: Commit**

```bash
git add src/content src/styles/reference.css public parity/provenance.json tests/content/source-copies.test.ts
git commit -m "content: import frozen site data and assets"
```

### Task 2: Crear documento, SEO, chrome e islas globales

**Files:**
- Create: `src/lib/site/page-registry.ts`
- Create: `src/lib/seo/metadata.ts`
- Create: `src/layouts/DocumentLayout.astro`
- Create: `src/layouts/SiteLayout.astro`
- Create: `src/components/site/HeaderIsland.tsx`
- Create: `src/components/site/Footer.astro`
- Create: `src/components/site/ButtonLink.astro`
- Create: `src/components/site/Pill.astro`
- Create: `src/components/site/SectionHeading.astro`
- Create: `src/components/site/PageHero.astro`
- Create: `src/components/islands/ConsentManager.tsx`
- Create: `src/scripts/cookie-settings.ts`
- Create: `tests/contracts/rendered-html.contract.mjs`
- Create: `tests/contracts/contract-scope.json`
- Create: `tests/contracts/contract-scope.test.ts`
- Create: `tests/helpers/preview-pool.ts`
- Create: `tests/helpers/read-migrated-source.ts`
- Create: `scripts/run-http-contracts.ts`
- Create: `tests/e2e/chrome.spec.ts`
- Modify: `src/pages/index.astro`
- Modify: `package.json`

**Interfaces:**
- Consumes: CSS y contenido de Task 1.
- Produces: `SiteMeta`, `HeaderPageKey`, `pageRegistry`, `DocumentLayout` y `SiteLayout` usados por toda página.

- [ ] **Step 1: Copiar contratos originales y escribir tests del shell**

Copiar `tests/rendered-html.test.mjs` por blob a
`tests/contracts/rendered-html.contract.mjs`. Sustituir su `renderPath` por el helper
`preview-pool`: agrupa procesos `astro preview` por el objeto string
`options.env`, elige un puerto libre, pasa method/body/headers al `fetch` y los
cierra en `after(() => closePreviewPool())`. Mantener los 79 casos registrados
(61 tests directos + 18 generados por cuatro tablas) y todas sus assertions.
Sustituir sus lecturas `new URL("../…", import.meta.url)` por
`readMigratedSource(logicalName)` con este mapa exhaustivo:

```text
../app/site.tsx                       -> site
../app/api/manganafer-quote/route.ts -> quote
../app/consent-manager.tsx           -> consent
../app/guide-content.md              -> guide
../app/legacy-routes.ts              -> legacy-routes
../app/legal-content.ts              -> legal-content
../app/robots.ts                     -> robots
```

`read-migrated-source.ts` solo lee el repositorio nuevo y concatena, ordenados,
los archivos que reemplazan cada unidad original:

```ts
const bundles = {
  site: ["src/components/site", "src/components/pages", "src/components/islands"],
  quote: ["src/lib/manganafer/quote.ts", "src/lib/manganafer/quote-config.ts"],
  consent: ["src/components/islands/ConsentManager.tsx"],
  guide: ["src/content/guide-content.md"],
  "legacy-routes": ["src/lib/routing/legacy.ts"],
  "legal-content": ["src/content/legal-content.ts"],
  robots: ["src/pages/robots.txt.ts"],
} as const;
```

Los directorios expanden recursivamente solo `*.astro` y `*.tsx`; el helper
lanza error si un bundle está vacío. La lectura histórica de
`../dist/server/index.js` desaparece junto con el antiguo `renderPath`.
Los cuatro sitios de lectura de `../public…` se sustituyen por
`readProjectAsset(relativePath)`, que resuelve desde `process.cwd()/public`,
rechaza paths fuera de ese directorio y lee exclusivamente la copia local.

Para poder cerrar fase 2 antes del servidor, sustituir mecánicamente `test(` por
`contractTest(`. `contract-scope.json` clasifica cada uno de los 79 nombres
materializados como `public` o `server`; los que prueban Manganáfer, auth/guía/
socios, redirects o gone son `server`, el resto `public`. El test de scope extrae
los nombres directos y expande las cuatro tablas, exige exactamente 79 claves,
ninguna desconocida y al menos una de cada scope. `CONTRACT_SCOPE=public|server`
solo hace skip del callback opuesto; `all` ejecuta todos. No se elimina ni altera
ninguna assertion original.

Añadir Playwright:

```ts
test("header and consent retain keyboard behavior", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Soluciones" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#solutions-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#solutions-panel")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Tú decides qué medimos." })).toBeVisible();
});
```

- [ ] **Step 2: Ejecutar el subconjunto y confirmar el fallo**

Run: `npm run test:http -- --scope public --test-name-pattern 'canonical|analytics before consent'`

Expected: FAIL porque el shell temporal no contiene el contrato.

- [ ] **Step 3: Implementar metadata y layouts exactos**

```ts
export interface SiteMeta {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: { index: boolean; follow: boolean };
  openGraph: boolean;
}

export type HeaderPageKey =
  | "inicio" | "nosotros" | "remoto" | "comunidades"
  | "fotovoltaica" | "baterias" | "aerotermia" | "activos"
  | "activoConectado" | "blog" | "eventos" | "comunero"
  | "contacto" | "comercializadora" | "mantenimiento"
  | "privacy" | "cookies" | "legal" | "terms" | "socios" | "guia";
```

`SiteLayout.astro` recibe `meta: Partial<SiteMeta>`. `DocumentLayout.astro`
reproduce `app/layout.tsx:5-58`, completa los campos ausentes con los valores
globales, importa una sola vez `src/styles/reference.css` y usa el título default
y template exactos, canonical absoluto sobre `https://comunidadsolar.es`, OG,
Twitter, icons y robots controlados por `SITE_INDEXABLE === "true"`.

`SiteLayout.astro` produce `.site-root`, Header, skip target, slot, Footer y
`<ConsentManager client:idle />`. Header y Consent se portan línea por línea de
los rangos de la tabla, sustituyendo solo `next/link` por `<a>`.

`preview-pool.ts` calcula una key canónica de env, arranca un preview por key,
espera `/`, y garantiza cleanup en `after()`. `scripts/run-http-contracts.ts`
construye una sola vez, traduce `--scope` a `CONTRACT_SCOPE`, reenvía
`--test-name-pattern` a Node Test y ejecuta el `.contract.mjs`; no mantiene
procesos propios. Al no terminar en `.test.*`, el contrato no entra en
`npm run test:unit`.
Añadir scripts:

```json
{
  "test:http": "tsx scripts/run-http-contracts.ts",
  "verify:public": "npm run build && npm run test:http -- --scope public && npm run test:e2e"
}
```

- [ ] **Step 4: Ejecutar contratos globales y E2E**

```bash
npm run build
npm run test:http -- --scope public --test-name-pattern 'canonical|analytics before consent'
npm run test:e2e -- tests/e2e/chrome.spec.ts
```

Expected: PASS para metadata, header, footer y consentimiento.

- [ ] **Step 5: Commit**

```bash
git add src/lib/site src/lib/seo src/layouts src/components/site src/components/islands/ConsentManager.tsx src/scripts tests/contracts tests/helpers tests/e2e/chrome.spec.ts scripts/run-http-contracts.ts package.json
git commit -m "feat: add native Astro shell and global islands"
```

### Task 3: Portar la home con paridad visual cero

**Files:**
- Create: `src/components/pages/home/HomePage.astro`
- Create: `src/components/pages/home/HomeHero.astro`
- Create: `src/components/pages/home/HomeMap.astro`
- Create: `src/components/site/TrustBand.astro`
- Create: `src/components/site/PressTrustBand.astro`
- Create: `src/components/site/HumanHelp.astro`
- Create: `src/components/site/CustomerProof.astro`
- Create: `src/components/islands/CoverageFinder.tsx`
- Modify: `src/pages/index.astro`
- Create: `tests/e2e/home.spec.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: `communities`, trust data, shell y `SiteMeta`.
- Produces: `HomePage.astro` y `CoverageFinder({ communities, initialSlug })`.

- [ ] **Step 1: Activar los contratos de home y escribir interacción de cobertura**

```ts
test("coverage finder updates the selected project", async ({ page }) => {
  await page.goto("/");
  const finder = page.locator("#cobertura");
  await finder.getByRole("button", { name: /Nuevo Baztán/i }).click();
  await expect(finder.getByRole("heading", { name: /Nuevo Baztán/i })).toBeVisible();
});
```

- [ ] **Step 2: Ejecutar contratos originales de home y confirmar fallo**

Run: `npm run test:http -- --test-name-pattern 'home|trust evidence|Villalbilla roof|coverage|three worlds|subsidies'`

Expected: FAIL sobre textos/clases ausentes.

- [ ] **Step 3: Portar rangos exactos del monolito**

Portar `site.tsx:1235-1713`, `4464-5032` a los componentes enumerados. Cambios
mecánicos permitidos:

- `className` → `class` en `.astro`;
- `<Link href>` → `<a href>`;
- objetos/arrays pasan por props tipadas;
- `CoverageFinder` y `SpainCommunitiesMap` permanecen juntos en la isla para no
  duplicar estado;
- no cambiar clases ni orden del DOM.

`src/pages/index.astro`:

```astro
---
export const prerender = true;
import HomePage from "../components/pages/home/HomePage.astro";
import SiteLayout from "../layouts/SiteLayout.astro";
---
<SiteLayout page="inicio" meta={{ title: null, canonical: "/" }}>
  <HomePage />
</SiteLayout>
```

- [ ] **Step 4: Verificar HTML, interacción y tres viewports**

```bash
npm run build
npm run test:http -- --test-name-pattern 'home|trust evidence|Villalbilla roof|coverage|three worlds|subsidies'
npm run test:e2e -- tests/e2e/home.spec.ts
npm run parity:visual -- --routes / --viewports desktop,tablet,mobile
```

Expected: contratos PASS, geometría sin deltas y `differentPixels: 0`; si el
raster produce diferencia no nula, dejar `review-required` y corregir antes del
commit.

- [ ] **Step 5: Commit**

```bash
git add src/components/pages/home src/components/site src/components/islands/CoverageFinder.tsx src/pages/index.astro tests/e2e/home.spec.ts parity/route-matrix.json
git commit -m "feat: reproduce the public home in Astro"
```

### Task 4: Portar productos de hogar y comercializadora

**Files:**
- Create: `src/components/pages/home-energy/SolarInstallationPage.astro`
- Create: `src/components/pages/home-energy/BatteriesPage.astro`
- Create: `src/components/pages/home-energy/AerothermalPage.astro`
- Create: `src/components/pages/home-energy/MaintenancePage.astro`
- Create: `src/components/pages/home-energy/CommercializerPage.astro`
- Create: `src/components/pages/home-energy/ProductVisuals.astro`
- Create: `src/components/islands/TariffBillSimulator.tsx`
- Create: `src/pages/[slug].astro`
- Create: `tests/e2e/home-energy.spec.ts`
- Modify: `src/lib/site/page-registry.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: shell, shared components y cinco entradas de `pageRegistry`.
- Produces: `corePageComponents` para `fotovoltaica`, `baterias`, `aerotermia`, `mantenimiento`, `comercializadora` y `staticSlugPaths` ampliado por cada tarea posterior.

- [ ] **Step 1: Escribir el test del simulador y activar contratos de producto**

```ts
test("tariff simulator recalculates without a page-wide React root", async ({ page }) => {
  await page.goto("/comercializadora-y-tarifas");
  const simulator = page.locator("[data-tariff-simulator]");
  const before = await simulator.locator("[data-monthly-total]").textContent();
  await simulator.getByLabel("Consumo mensual").fill("500");
  await expect(simulator.locator("[data-monthly-total]")).not.toHaveText(before ?? "");
  await expect(page.locator('astro-island[component-url*="TariffBillSimulator"]')).toHaveCount(1);
  await expect(page.locator("main astro-island")).toHaveCount(1);
});
```

- [ ] **Step 2: Ejecutar contratos y observar fallo**

Run: `npm run test:http -- --test-name-pattern 'solar installation|battery page|aerothermal|maintenance page|commercializer|tariffs'`

Expected: FAIL porque `[slug].astro` aún no resuelve esas páginas.

- [ ] **Step 3: Portar las cinco páginas y la isla de cálculo**

Rangos fuente:

- solar: `site.tsx:1969-2469`;
- baterías: `2015-2065` y `2470-2829`;
- aerotermia: `2066-2107` y `2830-3202`;
- mantenimiento: `3203-3548`;
- comercializadora: `3549-4463`.

`[slug].astro` obtiene `Astro.params.slug`, valida contra `pageRegistry`, llama
`Astro.redirect` solo para un legacy que haya escapado al Worker y selecciona
un componente Astro por key. En esta tarea `getStaticPaths()` devuelve solo las
cinco entradas implementadas; Tasks 5–8 amplían la misma lista y el test de
cierre exige exactamente las 18 entradas core. No se generan páginas placeholder.

Solo `TariffBillSimulator` conserva hooks React; `ProductVisuals` es Astro.

- [ ] **Step 4: Ejecutar contratos, E2E y visuales de cinco templates**

```bash
npm run build
npm run test:http -- --test-name-pattern 'solar installation|battery page|aerothermal|maintenance page|commercializer|tariffs'
npm run test:e2e -- tests/e2e/home-energy.spec.ts
npm run parity:visual -- --routes /autoconsumo-en-mi-tejado,/baterias,/aerotermia,/mantenimiento,/comercializadora-y-tarifas
```

Expected: PASS y ninguna diferencia visual sin revisar.

- [ ] **Step 5: Commit**

```bash
git add src/components/pages/home-energy src/components/islands/TariffBillSimulator.tsx src/pages/'[slug].astro' src/lib/site/page-registry.ts tests/e2e/home-energy.spec.ts parity/route-matrix.json
git commit -m "feat: port home energy product routes to Astro"
```

### Task 5: Portar catálogo y 21 detalles de comunidades

**Files:**
- Create: `src/components/pages/communities/CommunitiesPage.astro`
- Create: `src/components/pages/communities/CommunityDetailPage.astro`
- Create: `src/components/pages/communities/LocalCommunity.astro`
- Create: `src/components/pages/communities/NetworkCommunity.astro`
- Create: `src/components/pages/communities/LegacyCommunity.astro`
- Create: `src/components/pages/communities/CommunityModelCard.astro`
- Create: `src/pages/comunidades-energeticas/[community].astro`
- Create: `tests/e2e/communities.spec.ts`
- Modify: `src/pages/[slug].astro`
- Modify: `src/lib/site/page-registry.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: `Community`, `getCommunity`, `getNetworkCommunities`, `getCommunityDisplayTitle`.
- Produces: `CommunityDetailPage({ community: Community })` y 21 paths prerenderizados.

- [ ] **Step 1: Escribir tests de paths, jerarquía y selector de plantilla**

```ts
test("chooses one detail template for every published community", () => {
  const selected = communityPages.map((community) => selectCommunityTemplate(community));
  assert.equal(selected.length, 21);
  assert.ok(selected.every((name) => ["local", "network", "legacy"].includes(name)));
});

test("all community detail URLs render", async ({ request }) => {
  for (const community of communityPages) {
    expect((await request.get(`/comunidades-energeticas/${community.slug}`)).status()).toBe(200);
  }
});
```

- [ ] **Step 2: Ejecutar contratos de comunidades y confirmar fallo**

Run: `npm run test:http -- --test-name-pattern 'communit|Extremeña|inventory|local image|slug|resident-focused'`

Expected: FAIL para catálogo y detalles.

- [ ] **Step 3: Portar catálogo y las tres plantillas sin ramas omitidas**

Rangos fuente:

- listing/hero: `site.tsx:921-1234`, `6102-6476`;
- modelo: `9051-9334`;
- local: `9335-9926`;
- network: `9927-10178`;
- legacy: `10179-10690`;
- wrapper: `10691-10714`.

La ruta dinámica usa:

```astro
---
export const prerender = true;
export function getStaticPaths() {
  return communityPages.map((community) => ({
    params: { community: community.slug },
    props: { community },
  }));
}
const { community } = Astro.props;
---
```

No serializar todo `Community` a una isla; los mapas interactivos reciben solo
los campos mínimos que ya usa `CoverageFinder`.
Añadir `comunidades-energeticas` a los paths materializados por `[slug].astro`;
el total core pasa de 5 a 6.

- [ ] **Step 4: Verificar las 21 URLs y representantes visuales**

```bash
npm run build
npm run test:http -- --test-name-pattern 'communit|Extremeña|inventory|local image|slug|resident-focused'
npm run test:e2e -- tests/e2e/communities.spec.ts
npm run parity:visual -- --routes /comunidades-energeticas,/comunidades-energeticas/villalbilla,/comunidades-energeticas/extremadura,/comunidades-energeticas/ontinyent
```

Expected: 21/21 status 200, todas las imágenes existen y representantes sin
diferencias no aprobadas.

- [ ] **Step 5: Commit**

```bash
git add src/components/pages/communities src/pages/comunidades-energeticas src/pages/'[slug].astro' src/lib/site/page-registry.ts tests/e2e/communities.spec.ts parity/route-matrix.json
git commit -m "feat: port all energy community routes"
```

### Task 6: Portar autoconsumo remoto, blog, eventos y Nosotros

**Files:**
- Create: `src/components/pages/remote/RemotePage.astro`
- Create: `src/components/pages/remote/RemoteProjectDetailPage.astro`
- Create: `src/components/pages/remote/TorronteraDetail.astro`
- Create: `src/components/pages/remote/LiguerzanaDetail.astro`
- Create: `src/components/pages/remote/GenericRemoteDetail.astro`
- Create: `src/components/pages/blog/BlogPage.astro`
- Create: `src/components/pages/blog/BlogDetailPage.astro`
- Create: `src/components/pages/events/EventsPage.astro`
- Create: `src/components/pages/about/AboutPage.astro`
- Create: `src/components/islands/RemoteVideo.tsx`
- Create: `src/components/islands/BlogFilter.tsx`
- Create: `src/components/islands/AboutVideo.tsx`
- Create: `src/pages/autoconsumo-remoto/[project].astro`
- Create: `src/pages/blog/[post].astro`
- Create: `tests/e2e/editorial.spec.ts`
- Modify: `src/pages/[slug].astro`
- Modify: `src/lib/site/page-registry.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: `RemoteProject`, `BlogPost`, events y trust data.
- Produces: 3 project paths, 19 blog paths y las páginas `remoto`, `blog`, `eventos`, `nosotros`.

- [ ] **Step 1: Escribir tests de filtros, vídeo y generación completa**

```ts
test("blog filter exposes every post before client filtering", async ({ page }) => {
  await page.goto("/blog");
  await expect(page.locator("article[data-blog-post]")).toHaveCount(19);
  await page.getByRole("button", { name: "Comunidades energéticas" }).click();
  await expect(page.locator("article[data-blog-post]:visible")).not.toHaveCount(19);
});

test("every remote project and post has a generated path", () => {
  assert.equal(remoteProjects.length, 3);
  assert.equal(blogPosts.length, 19);
});
```

- [ ] **Step 2: Ejecutar los contratos relacionados y observar fallo**

Run: `npm run test:http -- --test-name-pattern 'remote|Torrontera|Fuente Álamo|Pisuerga|blog|event|Nosotros|Damian'`

Expected: FAIL en las familias todavía pendientes.

- [ ] **Step 3: Portar rangos y separar tres islas**

Rangos fuente:

- Nosotros: `5033-5442`;
- remoto listing/video: `5443-6101`;
- eventos: `6477-6712`;
- blog listing/filter/detalle: `6713-7093`;
- detalle remoto: `8360-9050`, `10715-10730`.

Los reproductores mantienen lazy iframe y sus posters exactos. `BlogFilter`
renderiza las 19 cards en SSR y solo cambia `hidden`/ARIA en cliente, por lo que
contenido y enlaces existen sin JavaScript.
Añadir `nosotros`, `autoconsumo-remoto`, `blog` y `eventos` a `[slug].astro`;
el total core pasa de 6 a 10.

- [ ] **Step 4: Verificar contratos, E2E y templates visuales**

```bash
npm run build
npm run test:http -- --test-name-pattern 'remote|Torrontera|Fuente Álamo|Pisuerga|blog|event|Nosotros|Damian'
npm run test:e2e -- tests/e2e/editorial.spec.ts
npm run parity:visual -- --routes /nosotros,/autoconsumo-remoto,/autoconsumo-remoto/torrontera,/autoconsumo-remoto/liguerzana,/blog,/blog/septimo-aniversario-capsula-del-tiempo,/eventos
```

Expected: 3 proyectos y 19 posts resuelven; las muestras visuales pasan.

- [ ] **Step 5: Commit**

```bash
git add src/components/pages/remote src/components/pages/blog src/components/pages/events src/components/pages/about src/components/islands/RemoteVideo.tsx src/components/islands/BlogFilter.tsx src/components/islands/AboutVideo.tsx src/pages/autoconsumo-remoto src/pages/blog src/pages/'[slug].astro' src/lib/site/page-registry.ts tests/e2e/editorial.spec.ts parity/route-matrix.json
git commit -m "feat: port public editorial and remote routes"
```

### Task 7: Portar contacto, comunero y rutas de propietarios

**Files:**
- Create: `src/components/pages/member/MemberPage.astro`
- Create: `src/components/pages/contact/ContactPage.astro`
- Create: `src/components/pages/assets/AssetsPage.astro`
- Create: `src/components/pages/assets/OperationalAssetsPage.astro`
- Create: `src/components/islands/OperationalPlantForm.tsx`
- Create: `tests/e2e/general-pages.spec.ts`
- Modify: `src/pages/[slug].astro`
- Modify: `src/lib/site/page-registry.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: shared components, URLs y assets ya copiados.
- Produces: páginas `soy-comunero`, `contacto`, `rentabiliza-tu-activo`, `comunidades-energeticas-operativas`.

- [ ] **Step 1: Escribir E2E del formulario embebido y enlaces**

```ts
test("operational plant form stays hidden until requested", async ({ page }) => {
  await page.goto("/comunidades-energeticas-operativas");
  await expect(page.locator("#formulario-planta iframe")).toHaveCount(0);
  await page.getByRole("button", { name: /estudiar mi planta/i }).first().click();
  await expect(page.locator("#formulario-planta iframe")).toHaveCount(1);
});
```

- [ ] **Step 2: Ejecutar contratos y confirmar fallo**

Run: `npm run test:http -- --test-name-pattern 'member|contact|operating-plant|partnership|asset'`

Expected: FAIL en las cuatro páginas.

- [ ] **Step 3: Portar rangos exactos**

- comunero/contacto: `site.tsx:1714-1968`;
- activos: `7094-7498`;
- planta operativa: `7499-8359`.

Solo `OperationalPlantForm` conserva `useState/useEffect`; los formularios
externos no se cargan antes de intención. Mantener todos los mailto, tel, Zoho,
analytics attributes y responsabilidades comerciales sin cambios.
Añadir las cuatro rutas de esta tarea a `[slug].astro`; el total core pasa de
10 a 14.

- [ ] **Step 4: Ejecutar contratos, E2E y visuales**

```bash
npm run build
npm run test:http -- --test-name-pattern 'member|contact|operating-plant|partnership|asset'
npm run test:e2e -- tests/e2e/general-pages.spec.ts
npm run parity:visual -- --routes /soy-comunero,/contacto,/rentabiliza-tu-activo,/comunidades-energeticas-operativas
```

Expected: PASS y ninguna diferencia visual pendiente.

- [ ] **Step 5: Commit**

```bash
git add src/components/pages/member src/components/pages/contact src/components/pages/assets src/components/islands/OperationalPlantForm.tsx src/pages/'[slug].astro' src/lib/site/page-registry.ts tests/e2e/general-pages.spec.ts parity/route-matrix.json
git commit -m "feat: port member contact and owner routes"
```

### Task 8: Portar legales, SEO técnico y cerrar todas las rutas públicas

**Files:**
- Create: `src/components/pages/legal/LegalPage.astro`
- Create: `src/pages/robots.txt.ts`
- Create: `src/pages/sitemap.xml.ts`
- Create: `src/pages/404.astro`
- Create: `src/lib/site/sitemap.ts`
- Create: `scripts/verify-links.ts`
- Create: `tests/contracts/public-route-closure.test.ts`
- Create: `tests/e2e/seo.spec.ts`
- Modify: `src/pages/[slug].astro`
- Modify: `src/lib/site/page-registry.ts`
- Modify: `parity/route-matrix.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `legalDocuments`, page registry, comunidades, posts, proyectos y route matrix.
- Produces: legales, `buildSitemap(now: Date): SitemapEntry[]`, robots y `verifyInternalLinks(): LinkViolation[]`.

- [ ] **Step 1: Escribir tests de texto legal, robots, sitemap y cierre**

```ts
test("has no pending public routes", async () => {
  const matrix = await readRouteMatrix();
  assert.deepEqual(
    matrix.filter((entry) => entry.scope === "public" && entry.status !== "passed"),
    [],
  );
});

test("sitemap contains every indexable dynamic page exactly once", () => {
  const entries = buildSitemap(new Date("2026-08-21T00:00:00Z"));
  assert.equal(new Set(entries.map((entry) => entry.url)).size, entries.length);
  for (const community of communityPages) {
    assert.ok(entries.some((entry) => entry.url.endsWith(`/comunidades-energeticas/${community.slug}`)));
  }
});

test("materializes every core slug without placeholders", () => {
  assert.equal(staticSlugPaths.length, 18);
  assert.equal(new Set(staticSlugPaths).size, 18);
});
```

- [ ] **Step 2: Ejecutar contratos finales y observar pendientes**

Run: `npm run test:http -- --test-name-pattern 'legal|robots|sitemap|published route|internal link'`

Expected: FAIL hasta implementar legales/endpoints y cerrar matriz.

- [ ] **Step 3: Portar legales y SEO sin cambiar copy**

`LegalPage.astro` porta `app/legal-page.tsx` y recibe
`documentKey: LegalDocumentKey`. Privacidad usa `noindex,follow`; cookies,
aviso y términos usan `noindex,nofollow`. Sitemap conserva las 16 core routes,
21 comunidades, 3 proyectos y 19 posts con sus prioridades/frecuencias.
Las cuatro rutas legales completan `[slug].astro` de 14 a 18 paths.
Además, `sitemap.ts` incorpora mediante `import.meta.glob` los metadatos válidos
`src/content/generated/*.json`; antes de existir páginas generadas el glob está
vacío y no altera el XML de referencia.

Robots usa `SITE_INDEXABLE` y excluye exactamente `/socios`, `/guia-equipo`,
`/guia-equipo-nueva-web-comunidad-solar.md` y `/manganafer` cuando indexable.

`verify-links` parsea todo HTML generado/servido, resuelve links internos, ignora
fragments después de validar que el `id` existe, y exige status 200/308/410 según
manifiesto.

Añadir el script estable que consume el gate maestro:

```json
{ "verify:links": "tsx scripts/verify-links.ts" }
```

- [ ] **Step 4: Ejecutar gate público completo**

```bash
npm run build
npm run test:http -- --scope public
npm run test:e2e
npm run parity:http -- --scope public
npm run parity:visual -- --scope public
npm run verify:links
npm run source:check
```

Expected: 0 rutas públicas `pending`, 0 links rotos, todos los contratos
originales públicos pasan y todo diff no nulo está corregido o explícitamente
esperando aprobación humana (en cuyo caso esta tarea no se commitea aún).

- [ ] **Step 5: Commit**

```bash
git add src/components/pages/legal src/pages src/lib/site/page-registry.ts src/lib/site/sitemap.ts scripts/verify-links.ts tests/contracts/public-route-closure.test.ts tests/e2e/seo.spec.ts parity/route-matrix.json package.json
git commit -m "feat: complete public Astro route parity"
```

Al terminar, ejecutar el Gate de fase 2 del plan maestro y registrar hashes de
los informes HTTP/visual en `parity/route-matrix.json`.
