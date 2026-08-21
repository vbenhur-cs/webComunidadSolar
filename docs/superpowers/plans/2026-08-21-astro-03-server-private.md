# Servidor, D1 y áreas privadas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproducir en Astro/Cloudflare todos los contratos dinámicos: headers, autenticación, páginas privadas, guía, Manganáfer, tres APIs y persistencia D1.

**Architecture:** Las funciones de dominio reciben Request/Headers/env/DB explícitos y se prueban fuera del framework; rutas Astro pequeñas las adaptan a HTTP. El Worker envuelve la respuesta Astro para aplicar solo los headers globales existentes. Un único SQL versionado alimenta migración y creación local, evitando dos esquemas divergentes sin cambiar el contrato D1.

**Tech Stack:** Astro endpoints, Cloudflare Workers `cloudflare:workers`, D1, Drizzle ORM 0.45.2, Wrangler local, React islands para los formularios Manganáfer.

**Spec:** `docs/superpowers/specs/2026-08-21-astro-parity-ingestion-design.md`

## Global Constraints

- Aplican el plan maestro y los planes 01–02 deben estar verdes.
- Las rutas `/signin-with-chatgpt`, `/signout-with-chatgpt` y `/callback` siguen reservadas a la plataforma; la app no las implementa.
- Identidad ausente o allowlist vacía siempre deniega acceso.
- Las páginas privadas devuelven 200 con `PrivateAccessPage` para anonymous/denied/unconfigured, excepto la descarga Markdown y export CSV cuyos status están fijados.
- El binding D1 se llama `DB`; tests y preview nunca usan una base de producción.
- Los upstreams de CUPS/cotización no se llaman en tests sin credenciales/autoridad; se prueban mediante `fetch` inyectado.
- Los textos, límites y status de APIs se copian exactamente del commit fuente.

---

## Contratos privados exactos

| Ruta | Anónimo | No permitido/no configurado | Permitido |
|---|---|---|---|
| `/socios` | 200 access page | 200 access page | 200 dashboard |
| `/guia-equipo` | 200 access page | 200 access page | 200 guía |
| `/guia-equipo-nueva-web-comunidad-solar.md` | 307 sign-in | 403 texto | 200 attachment Markdown |
| `/manganafer/interesados` | 200 access page | 200 access page | 200 tabla D1 |
| `/api/manganafer-interest/export` | 401 JSON | 403 JSON | 200 CSV BOM |

### Task 1: Aplicar headers de respuesta y preservar precedencia Worker

**Files:**
- Create: `src/lib/http/private-headers.ts`
- Create: `src/lib/http/response-policy.ts`
- Modify: `src/worker.ts`
- Create: `tests/server/response-policy.test.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: `routeBeforeAstro(request)` de fase 1.
- Produces: `applyResponsePolicy(request: Request, response: Response): Response`.

- [ ] **Step 1: Escribir tests de precedencia y headers exactos**

```ts
test("applies the original private headers to socios and guide only", () => {
  const response = applyResponsePolicy(
    new Request("https://example.test/socios"),
    new Response("ok"),
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, noimageindex");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("does not add those global headers to public pages", () => {
  const response = applyResponsePolicy(
    new Request("https://example.test/"),
    new Response("ok"),
  );
  assert.equal(response.headers.get("cache-control"), null);
});
```

- [ ] **Step 2: Ejecutar tests y confirmar fallo**

Run: `npm run test:unit -- tests/server/response-policy.test.ts`

Expected: FAIL con módulo ausente.

- [ ] **Step 3: Implementar política sin mutar respuestas originales**

Clonar status/body/headers solo para `/socios`, `/socios/*`, `/guia-equipo` y
`/guia-equipo-nueva-web-comunidad-solar.md`, exactamente como `next.config.ts`.
El Worker conserva 308/410 antes del handler:

```ts
export default {
  async fetch(request, env, ctx) {
    const early = routeBeforeAstro(request);
    if (early) return early;
    return applyResponsePolicy(request, await handle(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Ejecutar tests y contratos Worker**

```bash
npm run test:unit -- tests/server/response-policy.test.ts
npm run build
npm run parity:http -- --scope routing
```

Expected: 308/410 siguen iguales y solo las cuatro patterns reciben los headers.

- [ ] **Step 5: Commit**

```bash
git add src/lib/http src/worker.ts tests/server/response-policy.test.ts parity/route-matrix.json
git commit -m "feat: preserve Worker response policies"
```

### Task 2: Portar identidad, allowlists y muro privado

**Files:**
- Create: `src/lib/auth/identity.ts`
- Create: `src/lib/auth/private-area.ts`
- Create: `src/components/private/PrivateAccessPage.astro`
- Create: `tests/server/identity.test.ts`
- Create: `tests/server/private-area.test.ts`

**Interfaces:**
- Consumes: `PrivateArea`, `Identity` del plan maestro.
- Produces: `readIdentity(headers: Headers): Identity | null`, `signInPath(returnTo)`, `signOutPath(returnTo?)`, `resolvePrivateAccess(area: PrivateArea, identity: Identity | null, env: AccessEnv): PrivateAccessDecision`.

- [ ] **Step 1: Escribir matriz de identidad y autorización**

```ts
test("decodes a percent-encoded UTF-8 full name", () => {
  const headers = new Headers({
    "oai-authenticated-user-email": "Persona@Example.com",
    "oai-authenticated-user-full-name": "V%C3%ADctor%20Solar",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  });
  assert.deepEqual(readIdentity(headers), {
    displayName: "Víctor Solar",
    email: "Persona@Example.com",
    fullName: "Víctor Solar",
  });
});

test("fails closed for an empty allowlist", () => {
  assert.deepEqual(
    resolvePrivateAccess("socios", { email: "a@b.es", displayName: "a", fullName: null }, {}),
    { state: "unconfigured", allowed: false },
  );
});

test("rejects absolute and reserved return paths", () => {
  assert.equal(signInPath("//evil.test"), "/signin-with-chatgpt?return_to=%2F");
  assert.equal(signInPath("/callback"), "/signin-with-chatgpt?return_to=%2F");
});
```

- [ ] **Step 2: Ejecutar y observar fallo**

Run: `npm run test:unit -- tests/server/identity.test.ts tests/server/private-area.test.ts`

Expected: FAIL con exports ausentes.

- [ ] **Step 3: Portar lógica pura y markup del muro**

Copiar la semántica de `app/chatgpt-auth.ts` y `app/private-area-auth.ts`,
sustituyendo `headers()`/`process.env` por argumentos. La env tipada:

```ts
export interface AccessEnv {
  SOCIOS_ALLOWED_EMAILS?: string;
  TEAM_ALLOWED_EMAILS?: string;
  MANGANAFER_ALLOWED_EMAILS?: string;
}

export type PrivateAccessDecision =
  | { state: "allowed"; allowed: true }
  | { state: "anonymous" | "denied" | "unconfigured"; allowed: false };
```

`PrivateAccessPage.astro` porta `app/private-access-page.tsx` línea por línea,
usando Header/Footer Astro y los mismos mailto/sign-in/sign-out.

- [ ] **Step 4: Ejecutar unitarios y snapshot HTML del muro**

```bash
npm run test:unit -- tests/server/identity.test.ts tests/server/private-area.test.ts
npm run build
```

Expected: PASS en anonymous, denied y unconfigured. Los contratos HTTP se
activan cuando existan las rutas privadas en Tasks 3–4.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth src/components/private tests/server/identity.test.ts tests/server/private-area.test.ts
git commit -m "feat: port fail-closed private access"
```

### Task 3: Portar la guía privada y su descarga Markdown

**Files:**
- Create: `src/lib/guide/runtime.ts`
- Create: `src/lib/guide/markdown.ts`
- Create: `src/components/private/TeamGuidePage.astro`
- Create: `src/pages/guia-equipo.astro`
- Create: `src/pages/guia-equipo-nueva-web-comunidad-solar.md.ts`
- Create: `tests/server/team-guide.test.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: auth, `src/content/guide-content.md`, counts de contenido.
- Produces: `hydrateTeamGuideMarkdown(source): string`, `parseGuideMarkdown(source): GuideBlock[]` y dos rutas SSR.

- [ ] **Step 1: Escribir contratos de hidratación y estados HTTP**

```ts
test("hydrates all route count tokens", () => {
  const output = hydrateTeamGuideMarkdown("{{BASE_PAGE_COUNT}}/{{COMMUNITY_PAGE_COUNT}}/{{REMOTE_PROJECT_COUNT}}/{{BLOG_STORY_COUNT}}/{{TOTAL_CONTENT_ROUTES}}");
  assert.equal(output, "21/21/3/19/64");
});

test("anonymous Markdown download redirects with 307", async () => {
  const response = await fetchRoute("/guia-equipo-nueva-web-comunidad-solar.md");
  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /^\/signin-with-chatgpt\?/);
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/server/team-guide.test.ts`

Expected: FAIL hasta implementar runtime y rutas.

- [ ] **Step 3: Portar parser y rutas SSR**

Portar `app/guide-runtime.ts` y `app/team-guide-page.tsx` a funciones puras +
Astro. `guia-equipo.astro` usa `readIdentity(Astro.request.headers)` y
`env` importada de `cloudflare:workers`; no prerenderiza. La descarga:

```ts
import guideSource from "../content/guide-content.md?raw";
import { env } from "cloudflare:workers";
```

```ts
export const prerender = false;
export async function GET({ request }: APIContext): Promise<Response> {
  const identity = readIdentity(request.headers);
  if (!identity) return Response.redirect(new URL(signInPath(DOWNLOAD_PATH), request.url), 307);
  const decision = resolvePrivateAccess("equipo", identity, env);
  if (!decision.allowed) return privateText("Cuenta no autorizada.", 403);
  return markdownAttachment(hydrateTeamGuideMarkdown(guideSource));
}
```

Conservar Content-Type, Content-Disposition, Cache-Control, nosniff y
X-Robots-Tag exactos.

- [ ] **Step 4: Ejecutar matriz anonymous/denied/allowed y visual**

```bash
npm run build
npm run test:http -- --scope server --test-name-pattern 'team guide|downloadable Markdown'
npm run parity:visual -- --routes /guia-equipo --fixtures anonymous,allowed
```

Expected: 200/200/200 para página; 307/403/200 para descarga.

- [ ] **Step 5: Commit**

```bash
git add src/lib/guide src/components/private/TeamGuidePage.astro src/pages/guia-equipo.astro src/pages/guia-equipo-nueva-web-comunidad-solar.md.ts tests/server/team-guide.test.ts parity/route-matrix.json
git commit -m "feat: port protected team guide"
```

### Task 4: Portar el área de socios

**Files:**
- Create: `src/components/private/PartnerDashboard.astro`
- Create: `src/pages/socios.astro`
- Create: `tests/server/partners.test.ts`
- Create: `tests/e2e/private.spec.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: `partner-data`, auth y `Identity`.
- Produces: dashboard SSR `PartnerDashboard({ identity })`.

- [ ] **Step 1: Escribir tests de estados y contenido confidencial**

```ts
for (const fixture of ["anonymous", "unconfigured", "denied"] as const) {
  test(`${fixture} never receives partner data`, async () => {
    const html = await renderPrivate("/socios", fixture);
    assert.doesNotMatch(html, /Resumen ejecutivo|roadmap|finanzas/i);
  });
}
```

- [ ] **Step 2: Ejecutar y observar fallo**

Run: `npm run test:unit -- tests/server/partners.test.ts`

Expected: FAIL porque `/socios` no existe.

- [ ] **Step 3: Portar markup completo sin isla React**

Portar `app/socios/page.tsx:41-512` a `PartnerDashboard.astro`; preservar cada
sección, status, fecha, materiales y mailto. `socios.astro` resuelve decisión
antes de importar/renderizar datos sensibles en la respuesta y utiliza noindex.
`private.spec.ts` recorre anonymous/denied/unconfigured/allowed para `/socios` y
`/guia-equipo`; sus títulos empiezan por `@private` y verifica que ningún estado
denegado contiene copy confidencial.

- [ ] **Step 4: Verificar cuatro identidades y visuales**

```bash
npm run build
npm run test:http -- --scope server --test-name-pattern 'partner information|fails closed|socios'
npm run test:e2e -- tests/e2e/private.spec.ts
npm run parity:visual -- --routes /socios --fixtures anonymous,allowed
```

Expected: anonymous/denied/unconfigured 200 muro; allowed 200 dashboard.

- [ ] **Step 5: Commit**

```bash
git add src/components/private/PartnerDashboard.astro src/pages/socios.astro tests/server/partners.test.ts tests/e2e/private.spec.ts parity/route-matrix.json
git commit -m "feat: port protected partner dashboard"
```

### Task 5: Portar landing Manganáfer como Astro + islas de formulario

**Files:**
- Create: `src/components/pages/manganafer/ManganaferLanding.astro`
- Create: `src/components/pages/manganafer/ManganaferLocalMap.astro`
- Create: `src/components/islands/ManganaferQuoteForm.tsx`
- Create: `src/components/islands/ManganaferInterestForm.tsx`
- Create: `src/pages/comunidades-energeticas/manganafer.astro`
- Create: `tests/e2e/manganafer-landing.spec.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: shell y endpoints `/api/manganafer-quote`, `/api/manganafer-interest`.
- Produces: landing prerenderizada y dos islas con sus estados `idle | submitting | success | error`.

- [ ] **Step 1: Escribir E2E que pruebe HTML sin JS y estados accesibles**

```ts
test("@manganafer static story exists before islands hydrate", async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  await page.goto("/comunidades-energeticas/manganafer", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Manganáfer");
  await expect(page.locator("[data-manganafer-map]")).toBeVisible();
  await expect(page.locator("form")).toHaveCount(2);
});
```

- [ ] **Step 2: Ejecutar el E2E y confirmar fallo**

Run: `npm run build && npm run test:e2e -- tests/e2e/manganafer-landing.spec.ts`

Expected: FAIL porque la ruta falta.

- [ ] **Step 3: Separar markup estático de dos flujos interactivos**

Portar `manganafer-landing.tsx:105-255` y el contenido estático de `256-1060` a
Astro. Mantener en islas únicamente handlers, refs y estados de los formularios
de líneas 259-380, 570 y 948-954. No duplicar headings/labels entre Astro e isla.

- [ ] **Step 4: Verificar visual y requests interceptadas**

```bash
npm run build
npm run test:e2e -- tests/e2e/manganafer-landing.spec.ts
npm run parity:visual -- --routes /comunidades-energeticas/manganafer
```

Expected: paridad visual y solo header/consent/dos formularios hidratables. El
contrato original combinado se activa en Task 7, cuando también existe quote.

- [ ] **Step 5: Commit**

```bash
git add src/components/pages/manganafer src/components/islands/ManganaferQuoteForm.tsx src/components/islands/ManganaferInterestForm.tsx src/pages/comunidades-energeticas/manganafer.astro tests/e2e/manganafer-landing.spec.ts parity/route-matrix.json
git commit -m "feat: port Manganáfer landing to Astro islands"
```

### Task 6: Implementar esquema D1 y API de interés

**Files:**
- Create: `src/lib/db/schema.ts`
- Create: `src/lib/db/client.ts`
- Create: `src/lib/db/migrations.ts`
- Create: `drizzle/0000_fat_wolfsbane.sql`
- Create: `drizzle.config.ts`
- Create: `src/lib/manganafer/interest.ts`
- Create: `src/pages/api/manganafer-interest.ts`
- Create: `tests/server/manganafer-interest.test.ts`
- Create: `tests/integration/d1-interest.test.ts`
- Create: `tests/helpers/wrangler-local.ts`
- Modify: `src/env.d.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: binding `env.DB` y payload HTTP.
- Produces: `validateInterestPayload(value): Result<ValidatedInterest, ValidationError>`, `saveInterest(db, interest)`, endpoint POST.

- [ ] **Step 1: Escribir tabla de validación y upsert**

```ts
for (const [payload, status, field] of [
  [{}, 400, "kind"],
  [{ kind: "neighbor" }, 400, "firstName"],
  [validNeighbor({ email: "bad" }), 400, "email"],
  [validNeighbor({ phone: "123" }), 400, "phone"],
  [validNeighbor({ postalCode: "1234" }), 400, "postalCode"],
  [validNeighbor({ privacyAccepted: false }), 400, "privacyAccepted"],
] as const) {
  test(`matches ${field} validation`, async () => {
    const response = await postInterest(payload);
    assert.equal(response.status, status);
    assert.equal((await response.json()).field, field);
  });
}
```

Añadir tests: Content-Length `24001` → 413, JSON inválido → 400, honeypot →
201 sin DB, mismo `(email,kind)` actualiza y no duplica.

- [ ] **Step 2: Ejecutar tests y confirmar fallo**

Run: `npm run test:unit -- tests/server/manganafer-interest.test.ts`

Expected: FAIL con endpoint/servicio ausente.

- [ ] **Step 3: Portar schema y servicio con SQL único**

Copiar `db/schema.ts` y la migración por blob. `migrations.ts` importa el SQL y
separa `--> statement-breakpoint`; `ensureManganaferInterestStorage(db)` prepara
esas mismas sentencias. No mantener un segundo DDL literal.

El endpoint Astro:

```ts
import { env } from "cloudflare:workers";

export const prerender = false;
export async function POST({ request }: APIContext): Promise<Response> {
  return handleInterestRequest(request, { db: env.DB });
}
```

Portar todos los límites, strings españoles, lowercase email,
`consentVersion: "2026-07-31"`, source y upsert exactos.

Añadir antes de ejecutar la integración:

```json
{
  "test:integration": "tsx scripts/run-unit-tests.ts tests/integration/d1-interest.test.ts",
  "db:generate": "drizzle-kit generate"
}
```

Añadir `drizzle-kit: "0.31.10"` a devDependencies. `wrangler-local.ts` crea un
directorio temporal, aplica migraciones con `wrangler d1 migrations apply DB
--local --persist-to <temp> --config wrangler.jsonc`, arranca el Worker ya
construido con `wrangler dev dist/_worker.js/index.js --no-bundle --assets dist
--local --persist-to <temp> --port <libre> --config wrangler.jsonc`, espera
healthcheck y garantiza SIGTERM/SIGKILL + borrado en `t.after()`.
Ambos comandos resuelven `--config` desde
`CLOUDFLARE_CONFIG_PATH ?? "wrangler.jsonc"` y añaden el environment de
`CLOUDFLARE_ENV` cuando exista, para probar exactamente el build profile
seleccionado.

- [ ] **Step 4: Ejecutar unitarios e integración D1 local**

```bash
npm run test:unit -- tests/server/manganafer-interest.test.ts
npm run build
npm run test:integration
```

Expected: PASS, una fila tras dos POST del mismo email/kind y datos actualizados.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db src/lib/manganafer/interest.ts src/pages/api/manganafer-interest.ts drizzle drizzle.config.ts tests/server/manganafer-interest.test.ts tests/integration/d1-interest.test.ts tests/helpers/wrangler-local.ts src/env.d.ts package.json package-lock.json
git commit -m "feat: persist Manganáfer interests in D1"
```

### Task 7: Portar cotización Manganáfer y geofence

**Files:**
- Create: `src/lib/manganafer/quote-config.ts`
- Create: `src/lib/manganafer/quote.ts`
- Create: `src/pages/api/manganafer-quote.ts`
- Create: `tests/fixtures/manganafer/cups-success.json`
- Create: `tests/fixtures/manganafer/quote-success.json`
- Create: `tests/server/manganafer-quote.test.ts`
- Modify: `src/env.d.ts`

**Interfaces:**
- Consumes: CUPS payload, env económica y `fetcher: typeof fetch`.
- Produces: `handleQuoteRequest(request, { env, fetcher }): Promise<Response>` y `nearestPlantDistance(lat, lon): number`.

- [ ] **Step 1: Escribir tests para formato, distancia y upstreams**

```ts
test("rejects malformed CUPS without calling an upstream", async () => {
  let calls = 0;
  const response = await handleQuoteRequest(jsonRequest({ cups: "bad" }), {
    env: validQuoteEnv,
    fetcher: async () => { calls += 1; return new Response(); },
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("rejects a valid CUPS outside one kilometre", async () => {
  const response = await handleQuoteRequest(validRequest, {
    env: validQuoteEnv,
    fetcher: fixtureFetch({ latitude: 37.70, longitude: -0.90 }),
  });
  assert.equal(response.status, 422);
});
```

Cubrir upstream no-JSON, missing invoice fields, no calculable quotes, candidate
selection, missing env, 24KB y success con headers exactos.

- [ ] **Step 2: Ejecutar tests y observar fallo**

Run: `npm run test:unit -- tests/server/manganafer-quote.test.ts`

Expected: FAIL con servicio ausente.

- [ ] **Step 3: Portar algoritmo sin cambiar constantes comerciales**

Portar `app/manganafer-quote-config.ts` y las 420+ líneas del endpoint a módulos
puros. Mantener URLs, referencias `(37.61395,-0.78202)` y
`(37.60767,-0.7884)`, radio `1_000`, CUPS regex, Haversine, campos de factura,
panels candidatos, KPI y todos los mensajes/status. Solo sustituir `fetch` por
el argumento `fetcher` y `process.env` por `env`. El endpoint importa
`env` desde `cloudflare:workers`, declara `prerender = false` y pasa `fetch`
explícitamente al servicio.

- [ ] **Step 4: Ejecutar suite y contrato HTTP sin red**

```bash
npm run test:unit -- tests/server/manganafer-quote.test.ts
npm run build
npm run test:http -- --scope server --test-name-pattern 'Manganáfer CUPS server-side|one kilometre'
```

Expected: PASS, cero requests de red reales durante tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/manganafer/quote-config.ts src/lib/manganafer/quote.ts src/pages/api/manganafer-quote.ts tests/fixtures/manganafer tests/server/manganafer-quote.test.ts src/env.d.ts
git commit -m "feat: port Manganáfer quote service"
```

### Task 8: Portar tabla privada y export CSV

**Files:**
- Create: `src/lib/manganafer/csv.ts`
- Create: `src/components/private/ManganaferInterestsPage.astro`
- Create: `src/pages/manganafer/interesados.astro`
- Create: `src/pages/api/manganafer-interest/export.ts`
- Create: `tests/server/manganafer-admin.test.ts`
- Create: `tests/server/manganafer-export.test.ts`
- Create: `tests/e2e/manganafer-admin.spec.ts`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: auth y repositorio D1.
- Produces: `toInterestCsv(rows): string`, página de tabla y endpoint GET.

- [ ] **Step 1: Escribir tests de seguridad y escaping CSV**

```ts
test("export returns 401 then 403 before touching D1", async () => {
  assert.equal((await exportRequest({ identity: null })).status, 401);
  assert.equal((await exportRequest({ identity: deniedIdentity })).status, 403);
  assert.equal(dbCalls, 0);
});

test("CSV adds BOM and doubles quotes", () => {
  const csv = toInterestCsv([interest({ message: 'dice "hola"' })]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"dice ""hola"""/);
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/server/manganafer-admin.test.ts tests/server/manganafer-export.test.ts`

Expected: FAIL con módulos/rutas ausentes.

- [ ] **Step 3: Portar tabla y las 15 columnas CSV exactas**

Portar `app/manganafer/interesados/page.tsx` como Astro SSR y el endpoint export.
Ordenar `createdAt DESC, id DESC`; mantener formateo Europe/Madrid, etiquetas,
stats, empty state, BOM, CRLF, Content-Disposition por fecha y Cache-Control.
`manganafer-admin.spec.ts` usa el helper D1 local y sus títulos empiezan por
`@manganafer`; verifica la tabla de status para las cuatro identidades, que el
HTML denegado no contiene filas y que allowed-empty/allowed-data renderizan sus
estados. Página y endpoint declaran `prerender = false`.

- [ ] **Step 4: Ejecutar identidades, D1 y visual**

```bash
npm run build
npm run test:unit -- tests/server/manganafer-admin.test.ts tests/server/manganafer-export.test.ts
npm run test:e2e -- tests/e2e/manganafer-admin.spec.ts
npm run parity:visual -- --routes /manganafer/interesados --fixtures anonymous,allowed-empty,allowed-data
```

Expected: status según tabla de contratos y CSV con 15 columnas.

- [ ] **Step 5: Commit**

```bash
git add src/lib/manganafer/csv.ts src/components/private/ManganaferInterestsPage.astro src/pages/manganafer/interesados.astro src/pages/api/manganafer-interest/export.ts tests/server/manganafer-admin.test.ts tests/server/manganafer-export.test.ts tests/e2e/manganafer-admin.spec.ts parity/route-matrix.json
git commit -m "feat: port protected Manganáfer administration"
```

### Task 9: Cerrar contratos server y dry-run Cloudflare

**Files:**
- Create: `scripts/verify-server.ts`
- Create: `scripts/prepare-cloudflare-config.ts`
- Create: `tests/server/server-closure.test.ts`
- Create: `.env.example`
- Create: `docs/operations/cloudflare.md`
- Modify: `package.json`
- Modify: `parity/route-matrix.json`

**Interfaces:**
- Consumes: route matrix, env schema, Worker build y config externo de operador.
- Produces: `verifyServer(): ServerVerification`, `prepareCloudflareConfig(inputPath: string, environment?: string): Promise<PreparedConfig>` con hash e indexabilidad.

- [ ] **Step 1: Escribir test de cierre y rechazo del UUID local**

```ts
test("no server route remains pending", async () => {
  const pending = (await readRouteMatrix()).filter(
    (entry) => entry.scope === "server" && entry.status !== "passed",
  );
  assert.deepEqual(pending, []);
});

test("publisher config rejects the local D1 UUID", async () => {
  await assert.rejects(
    prepareCloudflareConfig("wrangler.jsonc"),
    /database_id de producción o preview/i,
  );
});
```

- [ ] **Step 2: Ejecutar y observar fallo/pendientes reales**

Run: `npm run test:unit -- tests/server/server-closure.test.ts`

Expected: FAIL hasta cerrar matriz y validador.

- [ ] **Step 3: Implementar verificador y documentación operativa**

`.env.example` enumera sin valores: `CLOUDFLARE_CONFIG_PATH`, tres allowlists,
`SITE_INDEXABLE` y todas las `MANGANAFER_*`. `prepareCloudflareConfig` recibe un archivo proporcionado por el
operador, valida nombre, main, assets, binding `DB`, UUID no cero y ausencia de
secrets literales; escribe una copia saneada en `.artifacts/config/`.

Scripts finales:

```json
{
  "verify:server": "tsx scripts/verify-server.ts",
  "preview:cloudflare": "tsx scripts/prepare-cloudflare-config.ts"
}
```

- [ ] **Step 4: Ejecutar el gate de fase 3 completo**

```bash
npm run source:check
npm run check
npm run test:unit
npm run build
npm run test:integration
npm run test:http -- --scope all
npm run test:e2e -- --grep '@private|@manganafer'
npm run parity:http -- --scope server
npm run verify:server
npm run deploy:dry
```

Expected: todo exit 0, sin red externa ni deploy; matriz server sin `pending`.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-server.ts scripts/prepare-cloudflare-config.ts tests/server/server-closure.test.ts .env.example docs/operations/cloudflare.md package.json package-lock.json parity/route-matrix.json
git commit -m "test: close Cloudflare server parity"
```

Al terminar, ejecutar nuevamente `npm run source:check` y el Gate de fase 3 del
plan maestro.
