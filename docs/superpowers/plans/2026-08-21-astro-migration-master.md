# Migración Astro con paridad total e ingestión — Plan maestro de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar un repositorio Astro autónomo que iguale todo el contrato observable de `comunidadsolarweb` y transforme solicitudes o páginas aportadas en candidatos Astro verificables para preview/publicación.

**Architecture:** Cuatro planes secuenciales separan el arnés de paridad, el sitio público, el runtime privado/servidor y la ingestión/publicación. Astro controla routing y renderizado desde el primer entregable; un Worker Cloudflare propio conserva la precedencia de redirects y respuestas 410, y React queda limitado a islas. Los manifiestos y hashes congelan el commit fuente y conectan cada gate humano con el código y el build exactos.

**Tech Stack:** Node 22.22.3, Astro 7.2.4, `@astrojs/cloudflare` 14.2.3, `@astrojs/react` 6.0.4, React 19.2.6, TypeScript 5.9.3, Cloudflare Workers/Wrangler, D1, Drizzle 0.45.2, Node Test, Playwright 1.62.1, pixelmatch y JSON Schema/Ajv.

**Spec:** `docs/superpowers/specs/2026-08-21-astro-parity-ingestion-design.md`

## Global Constraints

- La referencia es `../comunidadsolarweb` en `68ea294c54dc5e15e20f470fc421a239927565a8`.
- Ninguna tarea puede escribir dentro de `../comunidadsolarweb`; las copias proceden de `git show` o `git archive` del commit fijado.
- Antes y después de cada tarea se ejecuta `npm run source:check`; una referencia sucia o en otro commit detiene el trabajo.
- Build, preview y producción no pueden leer el repositorio fuente ni usar symlinks hacia él.
- El resultado final no contiene `next`, `vinext`, imports `next/*` ni una página completa renderizada como isla React.
- Astro 7.2.4 y las versiones enumeradas en este plan quedan fijadas por `package-lock.json`.
- Las páginas públicas conservan HTML, CSS computado, contenido, assets, responsive, enlaces, SEO y estados interactivos de la referencia.
- El objetivo visual es diferencia cero; cualquier diferencia no nula necesita evidencia y aprobación humana explícita.
- Las rutas privadas, APIs y D1 fallan cerradas y conservan status, headers y mensajes de la referencia.
- La generación del agente solo ocurre después de Gate 1 y la publicación solo después de Gate 2.
- Gate 2 no puede dispensar format, lint, typecheck, build, contratos, E2E o evidencia visual fallidos.
- Ningún comando de este plan despliega externamente salvo una invocación explícita del operador al adaptador de publicación.
- Todo código nuevo se escribe mediante TDD y cada tarea termina en un commit enfocado.

---

## Orden de ejecución

| Orden | Plan | Entregable comprobable |
|---|---|---|
| 1 | `2026-08-21-astro-01-foundation-parity.md` | Proyecto Astro/Worker ejecutable, fuente protegida, manifiesto y arnés de paridad |
| 2 | `2026-08-21-astro-02-public-site.md` | Todas las rutas públicas nativas en Astro con paridad visual y contractual |
| 3 | `2026-08-21-astro-03-server-private.md` | 308/410, auth, privadas, APIs, D1 y Manganáfer equivalentes |
| 4 | `2026-08-21-astro-04-ingestion-publication.md` | Dos entradas, transformación, validación, candidatos, gates, preview y publicador |

Los planes no son alternativas. Se ejecutan en ese orden y juntos implementan la
especificación completa.

## Registro canónico de interfaces

Las firmas siguientes son compartidas por los cuatro planes. Si una tarea
descubre que debe cambiarlas, se actualizan este archivo y todos los consumidores
en el mismo commit antes de continuar.

```ts
export type RouteKind =
  | "page"
  | "private-page"
  | "api"
  | "redirect"
  | "gone"
  | "asset";

export interface SourceRef {
  repository: "../comunidadsolarweb";
  branch: "main";
  commit: "68ea294c54dc5e15e20f470fc421a239927565a8";
}

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

export interface SourceManifest {
  schemaVersion: 1;
  source: SourceRef;
  generatedAt: string;
  routes: RouteContract[];
  sourceFiles: Array<{ path: string; sha256: string; bytes: number }>;
  assets: Array<{ path: string; sha256: string; bytes: number }>;
  wordpressAudit: { total: 122; unclassified: string[] };
}

export type PrivateArea = "socios" | "equipo" | "manganafer";

export interface Identity {
  displayName: string;
  email: string;
  fullName: string | null;
}

export type CompositionMode = "auto" | "blocks" | "freeform" | "hybrid";

export type ChangeState =
  | "received"
  | "normalized"
  | "planned"
  | "gate1_approved"
  | "generated"
  | "validated"
  | "gate2_approved"
  | "published"
  | "rejected"
  | "failed";

export interface NormalizedRequest {
  schemaVersion: 1;
  changeId: string;
  inputKind: "request" | "page";
  intent: string;
  audience: string | null;
  targetPath: `/${string}`;
  mode: CompositionMode;
  content: string;
  claims: string[];
  references: string[];
  assets: Array<{ path: string; sha256: string; mediaType: string }>;
  seo: {
    title: string | null;
    description: string | null;
    index: boolean;
  };
  privacy: { private: boolean; area: PrivateArea | null };
  allowedExternalLinks: string[];
  acceptanceCriteria: string[];
  inputSha256: string;
}

export interface ChangePlan {
  schemaVersion: 1;
  changeId: string;
  baselineCommit: string;
  requestSha256: string;
  selectedMode: Exclude<CompositionMode, "auto">;
  targetPath: `/${string}`;
  overwritesExistingRoute: boolean;
  files: Array<{ path: string; operation: "create" | "modify" }>;
  components: string[];
  islands: string[];
  dependencies: string[];
  validations: string[];
  publication: {
    adapter: "local" | "cloudflare";
    configSha256: string;
    environment: string | null;
    siteIndexable: boolean;
  };
  planSha256: string;
}

export interface ApprovalRecord {
  schemaVersion: 1;
  environment: "production" | "test";
  gate: 1 | 2;
  changeId: string;
  actor: string;
  approvedAt: string;
  subjectSha256: string;
  baselineCommit: string;
  candidateCommit: string | null;
  artifactSha256: string | null;
}

export interface CandidateManifest {
  schemaVersion: 1;
  changeId: string;
  attemptId: string;
  requestSha256: string;
  planSha256: string;
  baselineCommit: string;
  candidateCommit: string;
  artifactSha256: string;
  buildProfile: ChangePlan["publication"];
  routes: string[];
  files: string[];
  validations: Array<{ id: string; status: "passed" | "failed"; evidence: string }>;
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  preview: { command: string; url: string };
  knownDifferences: Array<{ description: string; approvalRequired: true }>;
}
```

## Convenciones de archivos

```text
src/
├── components/          # Astro estático e islas React pequeñas
├── content/             # datos tipados copiados y trazables
├── layouts/             # documento HTML, SEO y chrome compartido
├── lib/                 # dominio puro: routing, auth, DB, SEO, ingestión
├── pages/               # rutas Astro y endpoints
├── styles/              # CSS de referencia y CSS aislado de candidatos
└── worker.ts             # entrada Cloudflare previa al router Astro

parity/
├── source-manifest.json # inventario fijado al commit fuente
├── route-matrix.json    # resultado por ruta/contrato
└── provenance.json      # archivo copiado -> blob/hash de origen

changes/<change-id>/     # expediente saneado y versionado
.artifacts/              # builds, screenshots y entradas sin sanear; ignorado
.change-state/           # estado operativo antes de promoción; ignorado
```

Un archivo bajo `src/` tiene una responsabilidad. Los datos de contenido no
importan componentes; los componentes no acceden directamente a D1; las rutas
llaman a servicios tipados; el controlador de ingestión no contiene lógica de
renderizado de bloques.

## Gates de revisión entre planes

### Gate de fase 1

Ejecutar:

```bash
npm ci
npm run source:check
npm run check
npm test
npm run build
npm run parity:manifest
git status --short
```

Aceptar solo si el proyecto Astro arranca, el Worker responde, el manifiesto no
tiene duplicados y la fuente continúa limpia.

### Gate de fase 2

Ejecutar:

```bash
npm run verify:public
npm run parity:http -- --scope public
npm run parity:visual -- --scope public
npm run verify:links
```

Aceptar solo si toda ruta pública del manifiesto tiene resultado y las
diferencias visuales son cero o están registradas para aprobación humana.

### Gate de fase 3

Ejecutar:

```bash
npm run build
npm run test:unit
npm run test:integration
npm run test:http -- --scope all
npm run verify:server
npm run parity:http -- --scope server
npm run test:e2e -- --grep '@private|@manganafer'
npm run deploy:dry
```

Aceptar solo si auth falla cerrada, D1 usa un binding local/preview, los tres
endpoints cumplen sus contratos y 308/410 preceden al router Astro.

### Gate de fase 4

Ejecutar:

```bash
npm run build
npm run verify:ingestion
npm run test:e2e -- --grep '@ingestion'
npm run verify:independent
```

Aceptar solo si ambos carriles producen un candidato Astro, Gate 1 y Gate 2
bloquean transiciones inválidas, el publicador rechaza un digest cambiado y el
repositorio funciona sin el checkout fuente.

## Task 1: Ejecutar la base y el arnés de paridad

**Files:**
- Read: `docs/superpowers/plans/2026-08-21-astro-01-foundation-parity.md`
- Create/modify: los archivos enumerados dentro de ese plan

**Interfaces:**
- Consumes: `SourceRef`, `RouteContract`, `SourceManifest` de este registro.
- Produces: proyecto instalable, `parity/source-manifest.json`, scripts de guardia y comparadores reutilizados por todas las fases.

- [ ] **Step 1: Ejecutar todas las tareas y checks del plan 01 en orden**

```bash
sed -n '1,9999p' docs/superpowers/plans/2026-08-21-astro-01-foundation-parity.md
```

- [ ] **Step 2: Confirmar el gate de fase 1**

Ejecutar los siete comandos del “Gate de fase 1”. Esperado: exit 0, `git status`
vacío después del commit final y fuente en el commit fijado.

## Task 2: Migrar el sitio público nativo

**Files:**
- Read: `docs/superpowers/plans/2026-08-21-astro-02-public-site.md`
- Create/modify: los archivos enumerados dentro de ese plan

**Interfaces:**
- Consumes: `SourceManifest`, layout, rutas y arnés de fase 1.
- Produces: todas las rutas públicas, contenido, assets, islas y resultados públicos de paridad.

- [ ] **Step 1: Ejecutar todas las tareas y checks del plan 02 en orden**

```bash
sed -n '1,9999p' docs/superpowers/plans/2026-08-21-astro-02-public-site.md
```

- [ ] **Step 2: Confirmar el gate de fase 2**

Ejecutar los cuatro comandos del “Gate de fase 2”. Esperado: toda entrada
pública pasa y no existen rutas ni enlaces internos ausentes.

## Task 3: Reproducir servidor, datos y áreas privadas

**Files:**
- Read: `docs/superpowers/plans/2026-08-21-astro-03-server-private.md`
- Create/modify: los archivos enumerados dentro de ese plan

**Interfaces:**
- Consumes: `PrivateArea`, `Identity`, layout público y Worker de fases 1–2.
- Produces: auth, privadas, D1, APIs, redirects, gone y contratos de servidor.

- [ ] **Step 1: Ejecutar todas las tareas y checks del plan 03 en orden**

```bash
sed -n '1,9999p' docs/superpowers/plans/2026-08-21-astro-03-server-private.md
```

- [ ] **Step 2: Confirmar el gate de fase 3**

Ejecutar los ocho comandos del “Gate de fase 3”. Esperado: todos los contratos
privados y de servidor pasan sin credenciales reales ni acceso a producción.

## Task 4: Construir ingestión, gates y publicación

**Files:**
- Read: `docs/superpowers/plans/2026-08-21-astro-04-ingestion-publication.md`
- Create/modify: los archivos enumerados dentro de ese plan

**Interfaces:**
- Consumes: `NormalizedRequest`, `ChangePlan`, `ApprovalRecord`, `CandidateManifest`, catálogo de componentes, manifiesto y verificadores.
- Produces: CLI de ingestión, adaptadores de agente, evidencia, preview y adaptadores de publicación.

- [ ] **Step 1: Ejecutar todas las tareas y checks del plan 04 en orden**

```bash
sed -n '1,9999p' docs/superpowers/plans/2026-08-21-astro-04-ingestion-publication.md
```

- [ ] **Step 2: Confirmar el gate de fase 4**

Ejecutar los cuatro comandos del “Gate de fase 4”. Esperado: ambos tipos de
entrada y los tres modos de composición tienen candidatos versionados y se
reproducen en clones temporales; las
pruebas negativas bloquean cualquier atajo de gates, path o digest.

## Task 5: Auditoría final contra el objetivo

**Files:**
- Modify: `parity/route-matrix.json`
- Modify: `package.json`
- Create: `docs/completion-audit.md`
- Create: `scripts/verify-complete.ts`
- Test: `tests/completion/goal-audit.test.ts`

**Interfaces:**
- Consumes: manifiesto, matriz, candidatos fixture, logs de checks y cuatro planes completados.
- Produces: `GoalAuditResult { requirement: string; evidence: string[]; status: "proven" | "missing" }[]` sin entradas `missing`.

- [ ] **Step 1: Escribir primero la prueba de auditoría fallida**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { auditGoal } from "../../scripts/verify-complete.js";

test("cada requisito del objetivo tiene evidencia autoritativa", async () => {
  const result = await auditGoal();
  assert.equal(result.length, 13);
  assert.deepEqual(
    result.filter((item) => item.status !== "proven"),
    [],
  );
});
```

- [ ] **Step 2: Ejecutar la prueba y confirmar que enumera evidencia ausente**

Run: `npm run test:unit -- tests/completion/goal-audit.test.ts`

Expected: FAIL mientras falte cualquiera de los requisitos de definición de
terminado de la especificación.

- [ ] **Step 3: Implementar la auditoría como verificador, no como lista declarativa**

`scripts/verify-complete.ts` debe leer archivos y resultados reales: manifiesto,
matriz sin pendientes, package manifest sin Next/vinext, builds, resultados de
tests, tres candidatos fixture/tag, hashes de artefacto, approvals y estado del repo
fuente. Cada evidencia registra path y hash o el comando verificable que la
produce. `EXPECTED_REQUIREMENTS` contiene, en el mismo orden, los 13 puntos de
“Definición de terminado” de la spec; el test rechaza omisiones o requisitos
inventados. Si el sibling no existe (prueba de independencia), la auditoría
valida la evidencia source-check versionada en el informe y el SourceRef fijado;
si existe, siempre vuelve a comprobarlo en vivo.

```ts
export interface GoalAuditResult {
  requirement: string;
  evidence: string[];
  status: "proven" | "missing";
}

export async function auditGoal(): Promise<GoalAuditResult[]>;
```

Añadir el script consumido por el gate final:

```json
{ "verify:complete": "tsx scripts/verify-complete.ts" }
```

- [ ] **Step 4: Ejecutar la suite completa, generar y stagear el informe**

```bash
npm run source:check
npm run check
npm run build
npm run format:check
npm run lint
npm run test:unit
npm run test:integration
npm run test:http -- --scope all
npm run test:e2e
npm run parity:http
npm run parity:visual
npm run verify:links
npm run verify:server
npm run verify:ingestion
npm run deploy:dry
npm run verify:complete -- --write docs/completion-audit.md
git add parity/route-matrix.json docs/completion-audit.md tests/completion/goal-audit.test.ts scripts/verify-complete.ts package.json
npm run verify:independent -- --staged
npm run source:check
```

Expected: todos los comandos exit 0 y `docs/completion-audit.md` muestra cada
requisito como `proven` con evidencia concreta.

- [ ] **Step 5: Commit**

```bash
git commit -m "test: prove complete Astro migration and ingestion goal"
```

## Referencias técnicas fijadas

- Astro Cloudflare adapter: <https://docs.astro.build/en/guides/integrations-guide/cloudflare/>
- Astro on-demand rendering: <https://docs.astro.build/en/guides/on-demand-rendering/>
- Cloudflare Workers con Astro: <https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/>
- Cloudflare D1: <https://developers.cloudflare.com/d1/get-started/>

El adaptador Cloudflare 14 usa `cloudflare:workers` para bindings; no se planifica
la API retirada `Astro.locals.runtime`. El Worker personalizado importa
`handle` desde `@astrojs/cloudflare/handler` y Wrangler apunta a
`src/worker.ts`.
