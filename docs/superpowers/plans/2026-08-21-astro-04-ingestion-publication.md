# Ingestión, candidatos y publicación — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recibir una solicitud detallada o página aportada, planificarla, exigir Gate 1, transformarla en Astro mediante un agente intercambiable, validarla, presentar el artefacto exacto en preview y exigir Gate 2 antes de promover/publicar.

**Architecture:** Un CLI fino llama a un controlador tipado y a una máquina de estados persistida de forma atómica. Importadores no confiables normalizan entradas hacia un contrato único; los adaptadores de generación reciben un `AgentWorkspace` desechable sin Git mediante un broker del operador, y el controlador copia por bytes solo la salida estructuralmente aceptada a un staging limpio propio. Validadores deterministas producen evidencia y un digest del bundle desplegable generado (`dist/` más `.wrangler/deploy/config.json`). Aprobaciones, staging, commits candidatos y publicación permanecen fuera de la autoridad del agente.

**Tech Stack:** TypeScript, Node `parseArgs`, Ajv 8.20.0, YAML 2.9.0, yauzl 3.4.0, parse5 8.0.1, Astro compiler 4.0.0, Codex CLI 0.148.0, Git, Playwright/axe, Wrangler.

**Spec:** `docs/superpowers/specs/2026-08-21-astro-parity-ingestion-design.md` y la adenda vinculante `docs/superpowers/specs/2026-08-31-task-7-practical-isolation-design.md`. La adenda prevalece para la frontera de confianza y el handoff de Tasks 7–8.

## Global Constraints

- Aplican el plan maestro y los planes 01–03 deben estar completamente verdes.
- El CLI no interpreta strings mediante shell; usa `execFile`/`spawn` con argv.
- Entradas, prompts, stdout y stderr no se consideran confianza ni aprobación.
- El agente escribe solo en un `AgentWorkspace` desechable, sin `.git`, `.change-state/`, credenciales ni autoridad de publicación.
- Las entradas copiadas al workspace se rehashean después del agente; cualquier alteración rechaza el intento.
- El workspace completo se considera hostil después del job. Solo archivos regulares planificados se copian por bytes a un staging nuevo controlado por el controlador.
- La Task 7 no afirma aislamiento OS frente a otro proceso local con autoridad equivalente; un despliegue multi-tenant requiere un broker operativo respaldado por contenedor o VM.
- Dependencias, overwrites o rutas fuera del plan aprobado rechazan el intento.
- FixtureAgent solo funciona con `INGEST_TEST_MODE=true`; no es un proveedor publicable.
- Gate 1 y Gate 2 por CLI requieren TTY y confirmación del hash; tests inyectan un `ApprovalPrompt` explícito.
- El digest publicable es un SHA-256 determinista del bundle de build
  (`dist/` más `.wrangler/deploy/config.json`), no el timestamp de un tar.
- El adaptador Cloudflare usa `wrangler deploy --no-bundle`; sin `--execute` solo hace dry-run.
- No se publica ni modifica infraestructura durante implementación o tests.

---

## CLI final

```text
npm run ingest -- receive request <archivo>
npm run ingest -- receive page <archivo|carpeta|zip> --meta <archivo-opcional>
npm run ingest -- plan <change-id> [--target local|cloudflare --config <path> --environment <name>]
npm run ingest -- approve <change-id> --gate 1 [--actor <identidad>]
npm run ingest -- generate <change-id> --adapter codex|command
npm run ingest -- validate <change-id>
npm run ingest -- preview <change-id>
npm run ingest -- approve <change-id> --gate 2 [--actor <identidad>]
npm run ingest -- publish <change-id> --adapter local|cloudflare [--execute --config <path>]
npm run ingest -- status <change-id> [--json]
```

Cada comando devuelve 0 en éxito, 2 cuando espera un gate, 3 para entrada o
transición rechazada y 1 para fallo operativo.

## Mapa de archivos

```text
schemas/ingestion/*.schema.json       contratos versionados
src/ingest/cli.ts                     parseArgs + presentación
src/ingest/controller.ts              orquestación de casos de uso
src/ingest/domain.ts                  tipos y transiciones
src/ingest/state-store.ts             locks, atomic rename y journal hash-chain
src/ingest/importers/*                request, página, carpeta y ZIP
src/ingest/planning/*                 impacto, modo y plan estructurado
src/ingest/approvals/*                Gate 1/Gate 2
src/ingest/agents/*                   fixture, Codex y command
src/ingest/workspaces/*               export Git-less, manifest y staging limpio
src/ingest/validation/*               políticas, build, E2E y evidencia
src/ingest/candidate/*                commit, digest, preview y manifest
src/ingest/publishers/*               local y Cloudflare
src/components/generated/*            salida permitida de componentes
src/content/generated/*               salida permitida de bloques/datos
src/styles/generated/*                CSS aislado
public/generated/*                    assets incorporados
changes/*                              expedientes saneados tras promoción
.change-state/*                        estado operativo ignorado
.artifacts/intake/*                    entrada original ignorada
.artifacts/candidates/*                build/evidencia ignorados
```

### Task 1: Fijar schemas, tipos y serialización canónica

**Files:**
- Create: `schemas/ingestion/request-input.schema.json`
- Create: `schemas/ingestion/normalized-request.schema.json`
- Create: `schemas/ingestion/change-plan.schema.json`
- Create: `schemas/ingestion/approval.schema.json`
- Create: `schemas/ingestion/attempt.schema.json`
- Create: `schemas/ingestion/candidate.schema.json`
- Create: `src/ingest/domain.ts`
- Create: `src/ingest/canonical-json.ts`
- Create: `src/ingest/schema-validator.ts`
- Create: `tests/ingest/domain.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: tipos canónicos del plan maestro.
- Produces: `canonicalJson(value): string`, `sha256Canonical(value): string`, `validateSchema<T>(name, value): T`, `allowedTransition(from, to): boolean`.

- [ ] **Step 1: Escribir tests de hashes, schemas y transiciones**

```ts
test("canonical JSON hashes objects independent of key order", () => {
  assert.equal(
    sha256Canonical({ b: 2, a: [3, { d: 4, c: 5 }] }),
    sha256Canonical({ a: [3, { c: 5, d: 4 }], b: 2 }),
  );
});

test("requires an observable acceptance criterion", () => {
  assert.throws(
    () => validateSchema("normalized-request", validRequest({ acceptanceCriteria: [] })),
    /acceptanceCriteria/i,
  );
});

test("forbids skipping either human gate", () => {
  assert.equal(allowedTransition("planned", "generated"), false);
  assert.equal(allowedTransition("validated", "published"), false);
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/domain.test.ts`

Expected: FAIL con módulos ausentes.

- [ ] **Step 3: Añadir dependencias y contratos cerrados**

```bash
npm install ajv@8.20.0 ajv-formats@3.0.1 yaml@2.9.0 yauzl@3.4.0 parse5@8.0.1 @astrojs/compiler@4.0.0
npm install --save-dev @types/yauzl@3.4.0 @axe-core/playwright@4.13.0
```

Todos los schemas usan `additionalProperties: false`. Reglas exactas:

- `changeId`: `^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$`;
- `targetPath`: empieza por `/`, no contiene `//`, `..`, query ni fragment y
  no termina en `/` salvo que sea exactamente `/`;
- cada segmento de `targetPath` usa `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` y no
  puede ser `api`, empezar por `_` ni contener extensiones/brackets;
- `acceptanceCriteria`: 1–50 strings no vacíos de máximo 500 caracteres;
- hashes: 64 hex minúsculas;
- `selectedMode`: solo `blocks|freeform|hybrid`;
- Gate 1 exige candidate/artifact null; Gate 2 exige ambos hashes;
- approvals `test` nunca autorizan promoción de `main` ni Cloudflare;
- publication local exige hash del `wrangler.jsonc`, environment null y
  `siteIndexable: false`; Cloudflare exige config hash, environment explícito y el valor indexable
  extraído del config saneado;
- candidate no permite un validation `failed`.

`canonicalJson` ordena recursivamente keys, conserva orden de arrays, rechaza
`undefined`, funciones, símbolos, bigint, NaN, Infinity y ciclos.

- [ ] **Step 4: Ejecutar schemas y TypeScript**

```bash
npm run test:unit -- tests/ingest/domain.test.ts
npm run check
```

Expected: PASS y tipos coinciden con los schemas mediante fixtures válidas.

- [ ] **Step 5: Commit**

```bash
git add schemas/ingestion src/ingest/domain.ts src/ingest/canonical-json.ts src/ingest/schema-validator.ts tests/ingest/domain.test.ts package.json package-lock.json
git commit -m "feat: define ingestion domain contracts"
```

### Task 2: Implementar estado atómico, locks y journal verificable

**Files:**
- Create: `src/ingest/paths.ts`
- Create: `src/ingest/state-store.ts`
- Create: `src/ingest/journal.ts`
- Create: `tests/ingest/state-store.test.ts`
- Create: `tests/fixtures/ingestion/stress-locks.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `ChangeState` y schemas.
- Produces: `withChangeLock(changeId, fn)`, `readChange(changeId)`, `transition(changeId, event)`, `writeAtomic(path, bytes)`, `verifyJournal(changeId)`.

- [ ] **Step 1: Escribir tests de concurrencia, atomicidad y tampering**

```ts
test("only one writer owns a change lock", async () => {
  await withChangeLock("landing-solar", async () => {
    await assert.rejects(
      withChangeLock("landing-solar", async () => undefined),
      /bloqueado por otro proceso/i,
    );
  });
});

test("detects a modified journal event", async () => {
  await transition("landing-solar", receivedEvent);
  await mutateFirstJournalLine("landing-solar");
  await assert.rejects(verifyJournal("landing-solar"), /cadena de hashes/i);
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/state-store.test.ts`

Expected: FAIL con store ausente.

- [ ] **Step 3: Implementar paths y transiciones seguras**

`ingestPaths(changeId)` resuelve solo bajo `.change-state/<changeId>` y usa
`realpath` del ancestro para impedir escapes. Lock: `open(lock, "wx")` con PID,
fecha y hostname; un lock de más de 30 minutos solo se rompe si el PID local no
existe, registrando `lock-recovered`.

Cada evento incluye:

```ts
export interface JournalEvent {
  sequence: number;
  at: string;
  type: string;
  from: ChangeState | null;
  to: ChangeState;
  payloadSha256: string;
  previousEventSha256: string | null;
  eventSha256: string;
}
```

La escritura crea `.tmp-<pid>`, `fsync`, rename y `fsync` del directorio. Un
intento fallido guarda `resumeState`; `retry` solo vuelve al último checkpoint
`received|normalized|planned|gate1_approved` y crea un attempt nuevo.
`.gitignore` añade `.change-state/` y los raws/builds bajo `.artifacts/`, sin
ignorar los expedientes saneados `changes/`. Los workspaces desechables viven
fuera del repositorio bajo un root operativo controlado.

- [ ] **Step 4: Ejecutar stress local y tests**

```bash
npm run test:unit -- tests/ingest/state-store.test.ts
npx tsx tests/fixtures/ingestion/stress-locks.ts
```

Expected: un único escritor por changeId, journal válido y cero `.tmp-*`.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/paths.ts src/ingest/state-store.ts src/ingest/journal.ts tests/ingest/state-store.test.ts tests/fixtures/ingestion/stress-locks.ts .gitignore
git commit -m "feat: persist tamper-evident change state"
```

### Task 3: Importar solicitudes Markdown/YAML/JSON

**Files:**
- Create: `src/ingest/importers/request.ts`
- Create: `src/ingest/importers/frontmatter.ts`
- Create: `src/ingest/importers/common.ts`
- Create: `tests/fixtures/ingestion/detailed-request/request.yaml`
- Create: `tests/fixtures/ingestion/detailed-request/request.md`
- Create: `tests/fixtures/ingestion/detailed-request/request.json`
- Create: `tests/fixtures/ingestion/detailed-request/unsafe.yaml`
- Create: `tests/ingest/request-importer.test.ts`

**Interfaces:**
- Consumes: path a `.json|.yaml|.yml|.md`.
- Produces: `importRequest(path): Promise<NormalizedRequest>`.

- [ ] **Step 1: Escribir aceptación de tres formatos y errores concretos**

```ts
for (const name of ["request.json", "request.yaml", "request.md"]) {
  test(`normalizes ${name} to the same contract`, async () => {
    const result = await importRequest(fixture(name));
    assert.equal(result.changeId, "nueva-pagina-autoconsumo");
    assert.equal(result.targetPath, "/autoconsumo-compartido");
    assert.equal(result.acceptanceCriteria.length, 3);
  });
}

test("rejects aliases and executable YAML tags", async () => {
  await assert.rejects(importRequest(fixture("unsafe.yaml")), /YAML no permitido/i);
});
```

- [ ] **Step 2: Ejecutar y observar fallo**

Run: `npm run test:unit -- tests/ingest/request-importer.test.ts`

Expected: FAIL con importador ausente.

- [ ] **Step 3: Implementar normalización y límites**

Máximo 1 MiB de archivo y 100 KiB de contenido textual normalizado. Markdown
usa frontmatter YAML obligatorio para `changeId`, `targetPath`, `intent` y
`acceptanceCriteria`; el body pasa a `content`. YAML se parsea con alias count 0
y schema core, sin tags personalizados. Todos los strings se normalizan NFC y
line endings LF.

`inputSha256` se calcula sobre el JSON canónico normalizado excluyendo el propio
campo `inputSha256`, se inserta después y se valida recalculándolo antes de cada
uso. El original se copia a
`.artifacts/intake/<changeId>/<inputSha256>/raw/`; solo
`request.json` saneado entra en state.

- [ ] **Step 4: Ejecutar tests y demostrar equivalencia**

```bash
npm run test:unit -- tests/ingest/request-importer.test.ts
npx tsx -e 'import { importRequest } from "./src/ingest/importers/request.ts"; void importRequest("tests/fixtures/ingestion/detailed-request/request.yaml").then((value) => console.log(JSON.stringify(value)))'
```

Expected: JSON normalizado válido y hash estable en dos ejecuciones. La
persistencia y presentación CLI se conectan en Task 12.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/importers tests/fixtures/ingestion/detailed-request tests/ingest/request-importer.test.ts
git commit -m "feat: ingest structured page requests"
```

### Task 4: Importar página, carpeta o ZIP sin ejecutar contenido

**Files:**
- Create: `src/ingest/importers/page.ts`
- Create: `src/ingest/importers/archive.ts`
- Create: `src/ingest/importers/html.ts`
- Create: `src/ingest/importers/secret-scan.ts`
- Create: `tests/fixtures/ingestion/supplied-page/page.html`
- Create: `tests/fixtures/ingestion/supplied-page/styles.css`
- Create: `tests/fixtures/ingestion/supplied-page/solar.svg`
- Create: `tests/fixtures/ingestion/page-meta.yaml`
- Create: `tests/fixtures/ingestion/archives/zip-slip.zip`
- Create: `tests/fixtures/ingestion/archives/symlink.zip`
- Create: `tests/fixtures/ingestion/archives/too-many-files.zip`
- Create: `tests/fixtures/ingestion/archives/executable.zip`
- Create: `tests/fixtures/ingestion/archives/secret.zip`
- Create: `tests/ingest/page-importer.test.ts`

**Interfaces:**
- Consumes: `.html|.md|.astro|.tsx`, directorio o ZIP + metadata opcional.
- Produces: `importPage(inputPath, metadataPath?): Promise<NormalizedRequest>` y `ImportedAsset[]`.

- [ ] **Step 1: Escribir matriz de paquetes válidos y hostiles**

```ts
test("extracts body structure and assets without running scripts", async () => {
  const result = await importPage(fixture("supplied-page"), fixture("page-meta.yaml"));
  assert.equal(result.inputKind, "page");
  assert.match(result.content, /<main/);
  assert.doesNotMatch(result.content, /<script/i);
  assert.equal(result.assets.length, 2);
});

for (const name of ["zip-slip.zip", "symlink.zip", "too-many-files.zip", "executable.zip", "secret.zip"]) {
  test(`rejects hostile package ${name}`, async () => {
    await assert.rejects(importPage(fixture(name)), /paquete rechazado/i);
  });
}
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/page-importer.test.ts`

Expected: FAIL con importadores ausentes.

- [ ] **Step 3: Implementar límites y extracción segura**

Límites exactos: ZIP comprimido 25 MiB, total extraído 100 MiB, 500 entradas,
10 MiB por archivo general y 25 MiB por imagen. Rechazar:

- path absoluto, NUL, `..`, path vacío o colisiones tras NFC/case-fold;
- symlink por Unix mode `0o120000` en `externalFileAttributes >>> 16`;
- `.git`, `node_modules`, dotfiles no declarados;
- `.exe|.dll|.dylib|.so|.sh|.bat|.cmd|.ps1|.app|.pkg|.dmg`;
- claves privadas, tokens con prefijos conocidos y asignaciones de secrets.

yauzl abre lazy entries y nunca extrae con una utilidad del sistema. HTML se
parsea con parse5; para análisis elimina `script`, `object`, `embed`, meta refresh
y atributos `on*`, pero conserva el original ignorado para trazabilidad. TSX y
Astro se tratan como texto, nunca se importan.

Los assets se identifican por extensión + magic bytes permitidos y se copian a
la carpeta raw con hash; ningún path remoto se descarga.
Una carpeta/ZIP debe tener un único entrypoint de página o declararlo en
`page-meta.yaml`; dos candidatos sin declaración se rechazan. Markdown conserva
body/frontmatter como texto. Astro/TSX se inspeccionan como texto y sus imports
se inventarían, pero ninguno se evalúa.

- [ ] **Step 4: Ejecutar tests y recibir la fixture real**

```bash
npm run test:unit -- tests/ingest/page-importer.test.ts
npx tsx -e 'import { importPage } from "./src/ingest/importers/page.ts"; void importPage("tests/fixtures/ingestion/supplied-page", "tests/fixtures/ingestion/page-meta.yaml").then((value) => console.log(JSON.stringify(value)))'
```

Expected: contrato normalizado, scripts no ejecutados y hashes/mediatypes
presentes. La transición persistida se conecta en Task 12.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/importers tests/fixtures/ingestion/supplied-page tests/fixtures/ingestion/page-meta.yaml tests/fixtures/ingestion/archives tests/ingest/page-importer.test.ts
git commit -m "feat: safely ingest supplied pages and archives"
```

### Task 5: Planificar modo, impacto, archivos y validaciones

**Files:**
- Create: `src/ingest/planning/route-impact.ts`
- Create: `src/ingest/planning/mode.ts`
- Create: `src/ingest/planning/plan.ts`
- Create: `src/ingest/planning/markdown.ts`
- Create: `src/ingest/planning/catalog.ts`
- Create: `tests/ingest/planning.test.ts`

**Interfaces:**
- Consumes: `NormalizedRequest`, `parity/source-manifest.json`, catálogo Astro.
- Produces: `createChangePlan(request, context): ChangePlan`, `renderPlanMarkdown(plan, request): string`.

- [ ] **Step 1: Escribir tests de selección y overwrite**

```ts
test("auto chooses blocks for a textual request", () => {
  assert.equal(selectMode(request({ inputKind: "request", mode: "auto" })), "blocks");
});

test("auto chooses hybrid for a supplied page using site chrome", () => {
  assert.equal(selectMode(pageRequest({ mode: "auto", content: '<header class="site-header">' })), "hybrid");
});

test("marks an existing route as an explicit overwrite", () => {
  const plan = createChangePlan(request({ targetPath: "/baterias" }), context);
  assert.equal(plan.overwritesExistingRoute, true);
  assert.ok(plan.validations.includes("existing-route-visual-parity"));
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/planning.test.ts`

Expected: FAIL con planner ausente.

- [ ] **Step 3: Implementar reglas deterministas**

Modo explícito siempre gana. `auto`:

- request textual sin markup → `blocks`;
- página con `.site-root|.site-header|SiteLayout` → `hybrid`;
- otra página aportada → `freeform`.

Paths de salida:

```ts
export function outputPaths(request: NormalizedRequest, mode: "blocks" | "freeform" | "hybrid") {
  const route = request.targetPath === "/"
    ? "src/pages/index.astro"
    : `src/pages${request.targetPath}.astro`;
  return {
    route,
    componentsDir: `src/components/generated/${request.changeId}`,
    content: `src/content/generated/${request.changeId}.json`,
    stylesheet: `src/styles/generated/${request.changeId}.css`,
    assetsDir: `public/generated/${request.changeId}`,
  };
}
```

El planner añade overwrite, SEO, privacidad, componentes, islands,
dependencias (vacío salvo solicitud explícita) y validaciones nombradas. El
`planSha256` se calcula excluyendo su propio campo y se inserta al final.
Los cinco outputs son el default; `plan.files` puede añadir archivos compartidos
exactos (por ejemplo registry/navegación) solo si el impacto lo exige y Gate 1
los muestra. Nunca amplía un path a todo un directorio compartido.
`plan.md` contiene siempre: resumen de entrada + hash, ruta/overwrite, modo,
archivos, componentes reutilizados/nuevos, islands, assets, claims, enlaces e
integraciones, impacto SEO/privacidad/navegación, dependencias, riesgos y la
matriz criterio de aceptación → validación/evidencia.

El contexto de planificación incluye `publication`. Default `local` usa una
copia saneada/hash del wrangler local y no es desplegable. Para `cloudflare`, llama al validador de fase
3, guarda solo copia saneada + hash bajo state y registra environment/
`SITE_INDEXABLE`; cambiar cualquiera de esos valores invalida Gate 1 y requiere
nuevo plan/candidato.

- [ ] **Step 4: Crear planes para ambas fixtures y validar Markdown/JSON**

```bash
npm run test:unit -- tests/ingest/planning.test.ts
```

Expected: cada fixture produce `plan.json` validado y `plan.md` completo; ningún
archivo del sitio se modifica. El CLI persistirá el estado `planned` en Task 12.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/planning tests/ingest/planning.test.ts
git commit -m "feat: plan Astro page transformations"
```

### Task 6: Implementar Gate 1 y Gate 2 fuera del agente

**Files:**
- Create: `src/ingest/approvals/prompt.ts`
- Create: `src/ingest/approvals/service.ts`
- Create: `tests/ingest/approvals.test.ts`

**Interfaces:**
- Consumes: plan/candidate hash, state store, actor.
- Produces: `approveGate1(input, prompt): Promise<ApprovalRecord>`, `approveGate2(input, prompt): Promise<ApprovalRecord>`, `verifyApproval(record, subject, currentBaseline): void`.

- [ ] **Step 1: Escribir tests de TTY, hash y baseline**

```ts
test("refuses approval without a human TTY", async () => {
  await assert.rejects(
    approveGate1(input, fakePrompt({ isTTY: false })),
    /terminal interactivo/i,
  );
});

test("invalidates Gate 1 after any plan change", () => {
  assert.throws(() => verifyApproval(gate1, changedPlan), /hash aprobado no coincide/i);
});

test("invalidates approval when main no longer equals its baseline", () => {
  assert.throws(() => verifyApproval(gate1, plan, advancedMain), /baseline/i);
});

test("Gate 2 binds commit and artifact digest", () => {
  assert.equal(gate2.candidateCommit, candidate.candidateCommit);
  assert.equal(gate2.artifactSha256, candidate.artifactSha256);
});
```

- [ ] **Step 2: Ejecutar y observar fallo**

Run: `npm run test:unit -- tests/ingest/approvals.test.ts`

Expected: FAIL con approvals ausentes.

- [ ] **Step 3: Implementar confirmación explícita**

El prompt muestra resumen y exige escribir los primeros 12 caracteres de
`subjectSha256`. Actor tiene 3–120 caracteres y no puede ser `agent`, `codex`,
`fixture` ni vacío. Gate 1 registra plan hash/baseline; Gate 2 registra hash
canónico del candidate, commit y artifact. Los records se escriben en
`.change-state`, nunca en el workspace del agente.

Tests usan `fakePrompt({ isTTY: true, answer: hash.slice(0,12) })`; producción
usa stdin/stdout reales y escribe `environment: "production"`. Solo runners de
fixture inyectados pueden crear `environment: "test"`; publicadores y promoción
del repo principal los rechazan.

- [ ] **Step 4: Ejecutar unitarios y probar rechazo CLI no interactivo**

```bash
npm run test:unit -- tests/ingest/approvals.test.ts
```

Expected: tests PASS; el fake prompt no TTY devuelve el error previsto y no
crea approval. El rechazo mediante pipe se prueba en Task 12 cuando exista CLI.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/approvals tests/ingest/approvals.test.ts
git commit -m "feat: enforce two human approval gates"
```

### Task 7: Crear workspaces Git-less, ejecutar mediante broker y entregar staging limpio

**Files:**
- Create: `src/ingest/workspaces/service.ts`
- Create: `src/ingest/workspaces/policy.ts`
- Create: `src/ingest/limits.ts`
- Create: `src/ingest/agents/types.ts`
- Create: `src/ingest/agents/codex.ts`
- Create: `src/ingest/agents/command.ts`
- Create: `src/ingest/agents/fixture.ts`
- Create: `src/ingest/agents/isolation.ts`
- Create: `schemas/ingestion/agent-result.schema.json`
- Create: `tests/fixtures/ingestion/command-agent.mjs`
- Create: `tests/ingest/agents.test.ts`
- Create: `docs/operations/agent-isolation.md`

**Interfaces:**
- Consumes: plan aprobado, baseline commit, inputs autoritativos y una capacidad `IsolationBroker` configurada por el operador.
- Produces: `AgentWorkspace`, `AgentAdapter.run(input): Promise<AgentRunResult>` y `validateAgentWorkspaceOutput(workspace, plan): Promise<StagedAgentOutput>`.

- [ ] **Step 1: Escribir tests del broker, workspace y handoff**

```ts
test("exports the approved baseline without Git or operational state", async () => {
  const workspace = await createAgentWorkspace(input);
  assert.equal(await exists(join(workspace.path, ".git")), false);
  assert.equal(await exists(join(workspace.path, ".change-state")), false);
});

test("Command is bound to one service-owned workspace", async () => {
  await agent.run(workspaceInputs(workspace));
  await assert.rejects(
    agent.run({ ...workspaceInputs(workspace), requestPath: forgedPath }),
    /workspace aprobado/i,
  );
});

test("copies only independently inventoried planned output", async () => {
  const staged = await validateAgentWorkspaceOutput(workspace, plan);
  assert.deepEqual(staged.files, ["src/pages/generated.astro"]);
  assert.notEqual(await inode(staged.path), await inode(workspace.path));
});
```

Se conservan casos adversariales de mutación de inputs, traversal, symlinks,
hardlinks, archivos especiales, output no planificado, límites, capability del
broker y guardias before/after del repositorio. No son criterio de aceptación
los tests que intentaban demostrar resistencia a races de otro proceso local
con la misma autoridad.

- [ ] **Step 2: Ejecutar y confirmar fallo inicial**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: FAIL mientras no existan el broker de ejecución, `AgentWorkspace`, el
inventario hostil y el staging limpio.

- [ ] **Step 3: Implementar el contrato práctico de aislamiento**

```ts
export interface AgentRunInput {
  changeId: string;
  attemptId: string;
  workspace: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
  resultSchemaPath: string;
}

export interface IsolationBroker {
  run(input: BrokerRunInput): Promise<BrokerRunResult>;
}

export interface StagedAgentOutput {
  readonly path: string;
  readonly files: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
}
```

El controlador exporta el baseline aprobado a un directorio nuevo sin `.git`,
copia inputs autoritativos bajo `.agent-input/` y registra manifests/hashes. Los
adaptadores quedan ligados al objeto `AgentWorkspace` emitido por el servicio y
rechazan una proyección de paths forjada. El broker posee el proceso completo,
usa argv sin shell, environment mínimo y timeout fijo por configuración
confiable; ningún request puede ampliar esa autoridad.

Al terminar el job, el controlador vuelve a validar inputs y repositorios,
recorre todo el workspace sin seguir enlaces, deriva el inventario sin confiar
en stdout y copia por bytes solo archivos regulares planificados a un baseline
limpio nuevo bajo un root temporal separado y opaco que no codifica
`changeId`/`attemptId` ni comparte parent con el workspace.
`StagedAgentOutput.path`, `files` y `sha256` son propiedad del controlador y
constituyen la superficie completa y única del handoff a Task 8; el objeto no
expone `AgentWorkspace` ni permite derivarlo como sibling. El controlador
conserva por separado su lifecycle y cleanup mediante una capacidad ligada al
objeto staging. Gate 1, Task 8, validación, commit candidato, Gate 2 y
publicación quedan fuera del agente.

La frontera práctica confía en host, filesystem, controlador y broker. No
promete protección frente a un proceso local concurrente con igual autoridad.
En un despliegue multi-tenant el operador debe aportar un broker respaldado por
contenedor o VM; el broker local de tests no es publicable.

- [ ] **Step 4: Ejecutar adapters, policy estructural y guardias negativas**

```bash
INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts
```

Expected: PASS para broker/capability, argv sin shell, env mínimo, timeout,
workspace Git-less, inputs inmutables, inventario independiente, copia por bytes
y guardias del repositorio. El cleanup elimina solo el workspace propio.

- [ ] **Step 5: Cerrar Task 7**

```bash
git add src/ingest/agents src/ingest/workspaces src/ingest/limits.ts schemas/ingestion/agent-result.schema.json tests/fixtures/ingestion/command-agent.mjs tests/ingest/agents.test.ts docs/operations/agent-isolation.md docs/operations/task-7-closeout.md
git commit -m "feat: close practical agent isolation task"
```

### Task 8: Definir catálogo de bloques y políticas de salida Astro

**Files:**
- Create: `src/content/block-catalog.ts`
- Create: `src/content/generated/.gitkeep`
- Create: `src/components/generated/.gitkeep`
- Create: `src/styles/generated/.gitkeep`
- Create: `public/generated/.gitkeep`
- Create: `src/components/blocks/GeneratedBlockPage.astro`
- Create: `src/components/blocks/HeroBlock.astro`
- Create: `src/components/blocks/FeatureBlock.astro`
- Create: `src/components/blocks/CtaBlock.astro`
- Create: `src/components/blocks/StepsBlock.astro`
- Create: `src/components/blocks/FaqBlock.astro`
- Create: `src/components/blocks/TrustBlock.astro`
- Create: `schemas/ingestion/block-page.schema.json`
- Create: `src/ingest/validation/output-policy.ts`
- Create: `tests/ingest/output-policy.test.ts`

**Interfaces:**
- Consumes: `ChangePlan`, `StagedAgentOutput.path`, `StagedAgentOutput.files` y `StagedAgentOutput.sha256`, todos derivados por el controlador y no por el listado declarado del agente.
- Produces: `BlockPageDefinition`, `validateOutputPolicy(stagingPath, inventory, plan): PolicyViolation[]`.

- [ ] **Step 1: Escribir tests para tres modos y ataques comunes**

```ts
test("blocks accepts only the six approved block types", () => {
  assert.deepEqual(APPROVED_BLOCK_TYPES, ["hero", "feature", "cta", "steps", "faq", "trust"]);
  assert.throws(() => validateBlockPage(rawHtmlBlock), /no aprobado/i);
});

for (const [name, source] of [
  ["inline script", "<script>alert(1)</script>"],
  ["event handler", '<img onerror="alert(1)">'],
  ["Next import", 'import Link from "next/link"'],
  ["unsafe protocol", '<a href="javascript:alert(1)">x</a>'],
] as const) {
  test(`rejects ${name}`, async () => {
    assert.ok((await validateAstroSource(source, plan)).length > 0);
  });
}
```

- [ ] **Step 2: Ejecutar y observar fallo**

Run: `npm run test:unit -- tests/ingest/output-policy.test.ts`

Expected: FAIL con catálogo/policy ausentes.

- [ ] **Step 3: Implementar renderer y allowlists**

Todos los bloques tienen schema cerrado y links limitados a `/`, `#`, HTTPS,
mailto y tel. Blocks genera JSON + ruta `.astro` que importa
`GeneratedBlockPage`. Freeform/hybrid deben importar `SiteLayout`, usar CSS de
`src/styles/generated/<id>.css` y solo islas ya aprobadas por plan.
Los tres modos escriben también `src/content/generated/<id>.json` con ruta,
metadata, privacidad y hash de contenido para sitemap/auditoría.

Policy evalúa únicamente el árbol limpio en `StagedAgentOutput.path` y su inventario independiente. Permite crear/modificar los cinco roots de `outputPaths` y cada archivo exacto de `plan.files`; rechaza cualquier otro path y no vuelve a leer el workspace hostil ni confía en `generatedFiles` del agente.
`package.json` y `package-lock.json` se añaden de forma excepcional solo cuando
`plan.dependencies` no está vacío y el diff coincide exactamente con nombre +
versión aprobados; ningún otro manifest/config es escribible.
Parsea `.astro` con `@astrojs/compiler`, rechaza scripts inline, atributos
`on*`, iframe/domain no allowlisted, imports `next|vinext|node:*` en cliente,
secrets y paths fuera del root. Dependencias/lockfile solo se permiten si están
en `plan.dependencies` y Gate 1 las incluyó.

- [ ] **Step 4: Ejecutar todos los casos de policy**

Run: `npm run test:unit -- tests/ingest/output-policy.test.ts`

Expected: PASS en blocks/freeform/hybrid válidos y rechazo en cada fixture
hostil.

- [ ] **Step 5: Commit**

```bash
git add src/content/block-catalog.ts src/content/generated src/components/generated src/styles/generated public/generated src/components/blocks schemas/ingestion/block-page.schema.json src/ingest/validation/output-policy.ts tests/ingest/output-policy.test.ts
git commit -m "feat: enforce generated Astro page policies"
```

### Task 9: Ejecutar validación determinista completa

**Files:**
- Create: `src/ingest/validation/runner.ts`
- Create: `src/ingest/validation/routes.ts`
- Create: `src/ingest/validation/assets.ts`
- Create: `src/ingest/validation/links.ts`
- Create: `src/ingest/validation/seo.ts`
- Create: `src/ingest/validation/accessibility.ts`
- Create: `src/ingest/validation/commands.ts`
- Create: `tests/ingest/validation-runner.test.ts`

**Interfaces:**
- Consumes: staging limpio controlado por el controlador, inventario aprobado por Task 8 y plan aprobado.
- Produces: `runValidation(input): Promise<ValidationResult[]>`, todos `passed` o intento `failed`.

- [ ] **Step 1: Escribir test de orden fail-fast y evidencia**

```ts
test("never runs build after a policy violation", async () => {
  const commands = recordingCommandRunner();
  const results = await runValidation(invalidInput, { commands });
  assert.equal(results.find((r) => r.id === "output-policy")?.status, "failed");
  assert.equal(commands.calls.length, 0);
});

test("records an evidence path and hash for every validator", async () => {
  const results = await runValidation(validInput, { commands: passingFixtureRunner() });
  assert.ok(results.every((r) => r.evidence && /^[a-f0-9]{64}$/.test(r.evidenceSha256)));
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/validation-runner.test.ts`

Expected: FAIL con runner ausente.

- [ ] **Step 3: Implementar pipeline en orden fijo**

Orden:

1. schema/diff/output policy;
2. slug/canonical/route collision;
3. assets, magic bytes, dimensiones y alt;
4. imports/dependencies/secrets;
5. links internos/externos;
6. metadata, sitemap, privacidad;
7. `npm ci`;
8. `npm run format:check`, `npm run lint`, `npm run check` y unitarias;
9. `CLOUDFLARE_CONFIG_PATH=<perfil-saneado> CLOUDFLARE_ENV=<environment> npm run
   build` (variables omitidas para local), `npm run test:integration` y
   `npm run test:http -- --scope all` con el mismo perfil;
10. arrancar preview exacto;
11. `npm run test:e2e -- --grep-invert @ingestion` más smoke de la ruta,
    console errors y axe (sin impactos critical/serious);
12. captura desktop/tablet/mobile;
13. comparación HTML/visual si overwrite.

Cada comando usa argv, timeout 10 minutos, stdout/stderr saneados y el staging limpio como directorio de trabajo. Un fallo detiene pasos dependientes pero registra `skipped` solo en el intento; candidate schema nunca acepta skipped/failed. La evidencia se escribe fuera del staging, bajo el attempt. Los unitarios del runner siempre
inyectan `CommandRunner` fixture y nunca ejecutan recursivamente la suite real.

- [ ] **Step 4: Validar una fixture buena y cinco negativas**

```bash
INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/validation-runner.test.ts
```

Expected: fixture válida todo `passed`; negativas fallan antes de build o en el
validador específico previsto.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/validation tests/ingest/validation-runner.test.ts
git commit -m "feat: validate generated Astro candidates"
```

### Task 10: Crear commit candidato, digest, evidencia y preview exacto

**Files:**
- Create: `src/ingest/candidate/tree-digest.ts`
- Create: `src/ingest/candidate/commit.ts`
- Create: `src/ingest/candidate/evidence.ts`
- Create: `src/ingest/candidate/manifest.ts`
- Create: `src/ingest/candidate/preview.ts`
- Create: `tests/fixtures/ingestion/run-candidate-fixture.ts`
- Create: `tests/ingest/candidate.test.ts`

**Interfaces:**
- Consumes: `StagedAgentOutput.path` e inventario ya aprobados por Tasks 7–9, validations y artifacts.
- Produces: `createCandidate(input): Promise<CandidateManifest>`, `hashTree(root): Promise<string>`, `startCandidatePreview(candidate): PreviewHandle`.

- [ ] **Step 1: Escribir tests de digest y mutación posterior**

```ts
test("tree digest is independent of mtimes and directory enumeration", async () => {
  const first = await hashTree(fixtureDist);
  await changeAllMtimes(fixtureDist);
  assert.equal(await hashTree(fixtureDist), first);
});

test("candidate verification fails after one output byte changes", async () => {
  const candidate = await createCandidate(validatedAttempt);
  await appendFile(join(candidateBundle(candidate), "dist/index.html"), " ");
  await assert.rejects(verifyCandidateArtifact(candidate), /digest no coincide/i);
});

test("candidate binds the exact approved build profile", async () => {
  const candidate = await createCandidate(validatedAttempt);
  assert.deepEqual(candidate.buildProfile, validatedAttempt.plan.publication);
  await assert.rejects(
    createCandidate(validatedAttemptWithDifferentBuildConfig),
    /build profile/i,
  );
});

test("candidate preserves the generated redirected deploy config", async () => {
  const candidate = await createCandidate(validatedAttempt);
  const redirect = await readDeployRedirect(candidateBundle(candidate));
  assert.match(redirect.configPath, /^\.\.\/\.\.\/dist\//);
  assert.equal(
    await generatedTargetEnvironment(candidateBundle(candidate), redirect),
    candidate.buildProfile.environment,
  );
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/candidate.test.ts`

Expected: FAIL con candidate modules ausentes.

- [ ] **Step 3: Implementar identidad no circular del candidato**

Tras policy inicial, el controlador materializa desde el staging y su inventario un checkout candidato limpio que nunca se entrega al agente, vuelve a comprobar los hashes y crea un commit A con solo outputs aprobados. El checkout debe quedar limpio. Validación/build se ejecutan sobre A. El build debe producir `.wrangler/deploy/config.json`; su `configPath` debe ser relativo, resolver dentro del checkout controlado y apuntar a un `wrangler.json` generado bajo
`dist/`. Se aplican las mismas reglas a `auxiliaryWorkers` y
`prerenderWorkerConfigPath` cuando existan. El config aplanado principal debe
declarar el `targetEnvironment` aprobado y los mismos
bindings/destino/indexabilidad del perfil saneado.

Se copian `dist/` y `.wrangler/deploy/config.json`, conservando su topología
relativa, a `.artifacts/candidates/<change>/<attempt>/bundle/`. `hashTree`
calcula sobre el bundle completo:

```text
SHA256(concat(sort(relativePath + NUL + mode + NUL + bytes + NUL + fileSHA256)))
```

Rechaza symlinks y normaliza mode a `0644|0755` para que el digest sea estable
entre macOS/Linux. La copia se rehashea y debe coincidir con el digest registrado
al terminar validación.

El candidate manifest vive en `.change-state` y referencia commit A; por eso no
existe hash circular. Copia `plan.publication` sin cambios a `buildProfile` y
la creación falla si el hash/config/environment/indexabilidad usados por build
no coinciden con ese perfil. Evidencia incluye outputs de validators,
screenshots, diffs, HTML, route manifest, el redirect de deploy generado y
tamaños/hashes. Preview arranca la copia exacta, sin reconstruir. El runner
resuelve el `configPath` generado dentro del bundle, comprueba que no escapa de
él y usa el Wrangler local fijado, sin descarga de `npx`, con argv equivalente
a:

```text
<repo>/node_modules/.bin/wrangler dev <bundle>/dist/_worker.js/index.js
  --no-bundle --assets <bundle>/dist --config <generated-flattened-config>
  --local
```

- [ ] **Step 4: Crear candidato fixture y abrir/cerrar preview**

```bash
INGEST_TEST_MODE=true npx tsx tests/fixtures/ingestion/run-candidate-fixture.ts
```

Expected: estado `validated`, commit/digest de 64 hex, URL responde 200 y el
preview termina sin proceso huérfano.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/candidate tests/fixtures/ingestion/run-candidate-fixture.ts tests/ingest/candidate.test.ts
git commit -m "feat: build immutable preview candidates"
```

### Task 11: Implementar promoción y publicadores local/Cloudflare

**Files:**
- Create: `src/ingest/publishers/types.ts`
- Create: `src/ingest/publishers/local.ts`
- Create: `src/ingest/publishers/cloudflare.ts`
- Create: `src/ingest/promotion.ts`
- Create: `src/ingest/dossier.ts`
- Create: `tests/fixtures/ingestion/run-publisher-fixture.ts`
- Create: `tests/ingest/publishers.test.ts`

**Interfaces:**
- Consumes: candidate + Gate 1/Gate 2 válidos, artifact y config operador.
- Produces: `Publisher.publish(input): Promise<PublishResult>`, `promoteCandidate(changeId)`, expediente `changes/<id>`.

- [ ] **Step 1: Escribir tests de gates, digest, fast-forward y dry-run**

```ts
test("refuses publish without Gate 2", async () => {
  await assert.rejects(localPublisher.publish(input({ gate2: null })), /Gate 2/i);
});

test("test approvals can never authorize main or Cloudflare", async () => {
  await assert.rejects(cloudflarePublisher.publish(input({ gate2: testGate2 })), /test approval/i);
  await assert.rejects(promoteCandidate(input({ gate2: testGate2 })), /test approval/i);
});

test("refuses a changed artifact before spawning Wrangler", async () => {
  await mutateArtifact(input.candidate);
  await assert.rejects(cloudflarePublisher.publish(input), /digest no coincide/i);
  assert.equal(spawn.calls.length, 0);
});

test("Cloudflare defaults to strict dry-run and no bundle", () => {
  const invocation = cloudflareInvocation(validInput({ execute: false }));
  assert.ok(invocation.args.includes("--dry-run"));
  assert.ok(invocation.args.includes("--no-bundle"));
  assert.ok(invocation.args.includes("--strict"));
  assert.equal(invocation.args.includes("--config"), false);
  assert.equal(invocation.args.includes("--env"), false);
  assert.equal(invocation.cwd, candidateBundlePath);
  assert.equal(invocation.env.CLOUDFLARE_ENV, cloudflareProfile.environment);
});

test("Cloudflare rejects a local or different environment build profile", async () => {
  await assert.rejects(
    cloudflarePublisher.publish(input({ buildProfile: localProfile })),
    /build profile/i,
  );
  await assert.rejects(
    cloudflarePublisher.publish(input({ operatorEnvironment: "other" })),
    /environment/i,
  );
  assert.equal(spawn.calls.length, 0);
});

test("promotion fast-forwards baseline to candidate before dossier commit", async () => {
  const result = await promoteCandidate(validInput);
  assert.equal(await parentOf(result.dossierCommit), input.candidate.candidateCommit);
  assert.equal(await parentOf(input.candidate.candidateCommit), input.candidate.baselineCommit);
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/publishers.test.ts`

Expected: FAIL con publishers ausentes.

- [ ] **Step 3: Implementar verificación y export saneado**

Antes de cualquier publisher: verificar journal, schemas, approvals, request/
plan/candidate hashes, commit existente, checkout controlador limpio, artifact digest y
validations verdes. El redirect `.wrangler/deploy/config.json` y el config
aplanado al que apunta se vuelven a resolver dentro del bundle y sus hashes,
`targetEnvironment`, bindings y destino deben coincidir con candidate/plan. Si
`main` avanzó desde baseline, invalidar candidato; no rebase automático tras
Gate 2.
Cloudflare exige `candidate.buildProfile.adapter === "cloudflare"` y que
configSha256/environment/indexabilidad coincidan con el config operador;
LocalPublisher exige perfil `local`. Nunca se reconstruye para cambiar target.

LocalPublisher arranca preview, ejecuta healthcheck/ruta y para. Cloudflare
ejecuta desde `<bundle>` y fija `CLOUDFLARE_ENV` al environment del candidato.
No pasa entrypoint, assets ni `--config`: así Wrangler consume el redirect
generado por el mismo build y valida su `targetEnvironment`. Argv:

```text
<repo>/node_modules/.bin/wrangler deploy --no-bundle
  --strict --message candidate:<change>:<artifactSha256>
```

Añade `--dry-run` salvo `execute:true`. `execute:true` solo llega desde CLI con
TTY, flag literal `--execute`, config validado y Gate 2. Nunca se usa en tests.

Tras promoción exitosa, exportar request/plan, dos approvals, attempts y
candidate saneados a `changes/<id>/`. Con el checkout principal limpio y en `main`, `promoteCandidate` ejecuta `git merge --ff-only <candidateCommit>`; como
`main === baseline`, ese movimiento lleva exactamente a commit A. Después crea
commit B, con identidad Git explícita del servicio, que solo documenta el
expediente. El artifact publicado sigue siendo el commit A/digest aprobado,
registrado en B. Un fallo externo o Git se registra como evento recuperable y
nunca se presenta como `published`.

- [ ] **Step 4: Ejecutar todos los rechazos y publicación local**

```bash
INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/publishers.test.ts
INGEST_TEST_MODE=true npx tsx tests/fixtures/ingestion/run-publisher-fixture.ts
```

Expected: local PASS; Cloudflare con fixture de config solo dry-run y los casos
sin Gate/config se rechazan. `run-publisher-fixture` opera en un clone temporal,
único lugar donde LocalPublisher acepta approvals `test`. Ningún deploy externo.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/publishers src/ingest/promotion.ts src/ingest/dossier.ts tests/fixtures/ingestion/run-publisher-fixture.ts tests/ingest/publishers.test.ts
git commit -m "feat: gate candidate promotion and publication"
```

### Task 12: Integrar CLI/controlador y probar ambos carriles end-to-end

**Files:**
- Create: `src/ingest/controller.ts`
- Create: `src/ingest/cli.ts`
- Create: `scripts/verify-ingestion.ts`
- Create: `tests/ingest/cli.test.ts`
- Create: `tests/e2e/ingestion.spec.ts`
- Create: `tests/fixtures/ingestion/run-e2e.ts`
- Create: `docs/operations/ingestion.md`
- Create: `examples/requests/page-request.yaml`
- Create: `examples/pages/supplied-page.html`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: todos los casos de uso Tasks 1–11.
- Produces: CLI final, `verifyIngestion(): IngestionAudit` y tres candidatos demostrables que cubren ambos tipos de entrada y los tres modos.

- [ ] **Step 1: Escribir tests CLI de códigos y help**

```ts
test("CLI returns 2 exactly when a gate is pending", async () => {
  const result = await runCli(["generate", "planned-change", "--adapter", "codex"], testEnv);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Gate 1 pendiente/i);
});

test("production CLI rejects fixture agents and hidden e2e commands", async () => {
  assert.equal((await runCli(["generate", "fixture-forbidden", "--adapter", "fixture"], testEnv)).exitCode, 3);
  assert.equal((await runCli(["e2e", "--fixture", "detailed-request"], testEnv)).exitCode, 3);
});

test("status JSON never includes raw secrets or absolute intake paths", async () => {
  const result = await runCli(["status", "pagina-aportada-solar", "--json"], testEnv);
  assert.doesNotMatch(result.stdout, /PRIVATE KEY|\/Users\//);
});
```

- [ ] **Step 2: Ejecutar y confirmar fallo**

Run: `npm run test:unit -- tests/ingest/cli.test.ts`

Expected: FAIL con CLI/controlador ausentes.

- [ ] **Step 3: Cablear comandos sin lógica de dominio en CLI**

`parseArgs({ strict:true, allowPositionals:true })`; CLI valida comando/options,
llama a `IngestionController` y serializa resultado. El controlador adquiere
lock, verifica estado, llama import/planner/approval/agent/validator/candidate/
publisher y transiciona solo después de éxito atómico.

El CLI productivo solo registra `codex|command`; no importa FixtureAgent,
TestApprovalPrompt ni un subcomando `e2e`.

Scripts finales:

```json
{
  "ingest": "tsx src/ingest/cli.ts",
  "ingest:fixture": "tsx tests/fixtures/ingestion/run-e2e.ts",
  "verify:ingestion": "tsx scripts/verify-ingestion.ts"
}
```

`run-e2e.ts` admite `--fixture`, `--mode`, `--change-id` y `--record`. Clona el
HEAD limpio a un `mkdtemp` sin hardlinks, inyecta FixtureAgent,
TestApprovalPrompt(actor `test-human`, clock fijo) y LocalPublisher, y elimina
el clone en `finally`. Con `--record` solo acepta las tres combinaciones
hardcodeadas de este plan; importa el commit candidato al repo principal bajo
`refs/tags/ingestion-fixture/<change-id>` y copia únicamente el expediente
saneado. Nunca mergea `main`, nunca usa Cloudflare y revalida source/main antes
y después. `ingestion.spec.ts` lleva tag `@ingestion`, ejecuta las tres matrices
en clones temporales sin `--record` y prueba también gates/digest negativos.

Documentar ejemplos completos, states, códigos de salida, ubicación de
evidencia, cómo configurar CommandAgent y la advertencia de `--execute`.

- [ ] **Step 4: Ejecutar unitarios y commit de la implementación**

```bash
npm run test:unit -- tests/ingest/cli.test.ts
npm run check
git add src/ingest/controller.ts src/ingest/cli.ts scripts/verify-ingestion.ts tests/ingest/cli.test.ts tests/e2e/ingestion.spec.ts tests/fixtures/ingestion/run-e2e.ts docs/operations/ingestion.md examples package.json package-lock.json README.md
git commit -m "feat: deliver end-to-end Astro page ingestion"
```

Expected: CLI productivo sin adaptadores fixture y HEAD limpio, listo para ser
el baseline real de los candidatos de evidencia.

- [ ] **Step 5: Ejecutar tres pipelines fixture completos y registrar evidencia**

```bash
INGEST_TEST_MODE=true npm run ingest:fixture -- --record --fixture detailed-request --mode blocks --change-id fixture-request-blocks
INGEST_TEST_MODE=true npm run ingest:fixture -- --record --fixture detailed-request --mode hybrid --change-id fixture-request-hybrid
INGEST_TEST_MODE=true npm run ingest:fixture -- --record --fixture supplied-page --mode freeform --change-id fixture-page-freeform
npm run verify:ingestion
```

Expected para los tres: receive → normalized → planned → gate1_approved →
generated → validated → gate2_approved, ruta `.astro`, build digest, screenshots
en tres viewports, tag candidato alcanzable y expediente saneado. No se marca
`published`: los tests de Task 11 demuestran la publicación y estas fixtures no
alteran `main`.

- [ ] **Step 6: Ejecutar una transformación real con Codex local**

Crear un changeId nuevo desde `examples/requests/page-request.yaml`, generar el
plan, aprobar Gate 1 interactivamente y ejecutar:

```bash
npm run ingest -- receive request examples/requests/page-request.yaml
npm run ingest -- plan ejemplo-real-codex
npm run ingest -- approve ejemplo-real-codex --gate 1
npm run ingest -- generate ejemplo-real-codex --adapter codex
npm run ingest -- validate ejemplo-real-codex
npm run ingest -- preview ejemplo-real-codex --check-only
```

Expected: Codex CLI 0.148.0 termina exit 0, solo modifica paths aprobados, el
candidato compila y preview responde. No ejecutar Gate 2 ni publicar este
ejemplo si el operador no lo solicita; su evidencia prueba la integración real.
`approve` pide actor y los 12 caracteres del hash en TTY si no se pasa `--actor`.

- [ ] **Step 7: Ejecutar suite completa, independencia y guardia fuente**

```bash
npm run source:check
npm run format:check
npm run lint
npm run check
npm run test:unit
npm run build
npm run test:integration
npm run test:http -- --scope all
npm run test:e2e
npm run parity:http
npm run verify:ingestion
git add changes
npm run verify:independent -- --staged
npm run deploy:dry
npm run source:check
```

Expected: todos exit 0; ningún `next|vinext`; original limpio en commit fijado;
tres candidatos fixture/tag y un candidato Codex verificable.

- [ ] **Step 8: Commit de expedientes de evidencia**

```bash
git commit -m "test: record ingestion fixture candidates"
```

Después se ejecuta Task 5 (auditoría final) del plan maestro. El objetivo solo se
marca completo si esa auditoría no contiene ninguna evidencia `missing`.
