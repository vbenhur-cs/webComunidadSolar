# PR Preview Evidence Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar y probar el pipeline que crea previews Cloudflare exactas
para el base y el candidato de cada PR, conserva capturas PNG append-only,
requiere aprobación humana y despliega el SHA integrado a la preview compartida
sin habilitar producción.

**Architecture:** `Production readiness` sigue siendo el CI sin secretos. Un
workflow `workflow_run` definido en `main` resuelve la PR, construye base y
candidato sin credenciales, sube ambos bundles desde un job confiable, captura
las URLs en un job sin credenciales y publica evidencia desde otro job con
permisos GitHub mínimos. Un segundo workflow reutiliza los mismos contratos
para la preview compartida después del merge; producción queda detrás de un
guard y un environment independientes.

**Tech Stack:** Node.js 22.22.3, TypeScript 5.9, Astro 7, Wrangler 4.125,
Cloudflare Workers Versions/Preview URLs, Playwright 1.62, PNGJS 7, YAML 2.9,
GitHub Actions y `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-03-pr-preview-evidence-design.md`

## Global Constraints

- No cambiar Raiola, DNS, nameservers ni `comunidadsolar.es`.
- No desplegar a producción durante la implementación o el bootstrap.
- El código de una PR no recibe tokens Cloudflare, secretos de runtime ni
  permisos GitHub de escritura.
- Solo PR internas pueden recibir previews automáticas; forks fallan cerradas.
- Cada PR funcional añade exactamente un
  `evidence/requests/issue-<N>.yaml` cerrado y enlazado a una issue abierta.
- Los viewports son `desktop` 1440x1000 y `mobile` 390x844 con scale factor 1.
- Toda ruta de evidencia es pública; `/api`, `/socios`, `/guia-equipo` y
  `/manganafer/interesados` están prohibidas.
- Una PR con cambios bajo `drizzle/` no entra en el flujo estándar.
- La rama `evidence` nunca sobrescribe ni elimina una ruta ya publicada.
- El check `preview-approved` solo se emite después de evidencia durable y
  aprobación del environment `premerge-review` para el SHA exacto.
- `PRODUCTION_ENABLED` está ausente o es distinto de `true` durante esta
  entrega.
- Todas las actions de terceros quedan fijadas a un commit SHA completo.
- No se añaden dependencias; se reutilizan `yaml`, `playwright`, `pngjs` y las
  utilidades existentes.

---

## File map

| Archivo | Responsabilidad única |
| --- | --- |
| `scripts/preview-evidence/domain.ts` | Tipos, constantes, JSON canónico y validadores escalares del pipeline. |
| `scripts/preview-evidence/request.ts` | Parsear y validar el YAML de una issue y su path. |
| `scripts/preview-evidence/github.ts` | Resolver eventos/API GitHub, emitir outputs y actualizar comentarios/status. |
| `scripts/preview-evidence/bundle.ts` | Copiar, inventariar y volver a verificar bundles sin seguir symlinks. |
| `scripts/preview-evidence/cloudflare.ts` | Crear argv fijo, ejecutar Wrangler, verificar versión y Preview URL. |
| `scripts/preview-evidence/capture.ts` | Navegar previews y producir PNG + manifiesto determinista. |
| `scripts/preview-evidence/evidence.ts` | Mapear y publicar staging en un checkout `evidence` append-only. |
| `scripts/preview-evidence/cli.ts` | Dispatch estricto de comandos usados por Actions; sin lógica de dominio. |
| `tests/preview-evidence/*.test.ts` | Pruebas unitarias y de seguridad de cada límite. |
| `tests/foundation/preview-workflows.test.mjs` | Contratos estáticos de permisos, triggers, actions y gates de los workflows. |
| `.github/workflows/pr-preview.yml` | Preview/evidencia/aprobación antes del merge. |
| `.github/workflows/shared-preview.yml` | Despliegue del SHA verde de `main` a preview compartida. |
| `.github/workflows/production.yml` | Entrada manual de producción, cerrada por defecto. |
| `docs/operations/*.md` | Configuración, uso, recuperación y bootstrap sin conocimiento tácito. |

### Task 1: Closed evidence request contract

**Files:**

- Create: `scripts/preview-evidence/domain.ts`
- Create: `scripts/preview-evidence/request.ts`
- Create: `tests/preview-evidence/request.test.ts`
- Create: `evidence/requests/example-page.yaml`
- Create: `evidence/requests/example-section.yaml`
- Modify: `package.json`

**Interfaces:**

- Produces:
  `parseEvidenceRequest(contents: string, requestPath: string): EvidenceRequest`.
- Produces:
  `loadEvidenceRequest(requestPath: string, root?: string): Promise<EvidenceRequest>`.
- Produces: `canonicalJson(value: unknown): string` and
  `sha256(value: string | Uint8Array): string`.
- `EvidenceRequest` is exactly:

```ts
export interface EvidenceRequest {
  schemaVersion: 1;
  issue: number;
  scope: "page" | "section";
  route: string;
  selector: string | null;
  expectedStatus: { base: AllowedHttpStatus; candidate: AllowedHttpStatus };
  viewports: readonly ["desktop", "mobile"];
}

export type AllowedHttpStatus = 200 | 301 | 302 | 307 | 308 | 404 | 410;
```

- Later tasks consume `EvidenceRequest`, `canonicalJson` and `sha256` without
  redefining them.

- [x] **Step 1: Write the failing request-contract tests**

Create table-driven tests that prove canonical key conversion and every closed
boundary:

```ts
test("normalizes the closed page request", () => {
  assert.deepEqual(
    parseEvidenceRequest(
      `schema_version: 1\nissue: 4\nscope: page\nroute: /pruebas/guia/\nexpected_status:\n  base: 404\n  candidate: 200\nviewports: [desktop, mobile]\n`,
      "evidence/requests/issue-4.yaml",
    ),
    {
      schemaVersion: 1,
      issue: 4,
      scope: "page",
      route: "/pruebas/guia/",
      selector: null,
      expectedStatus: { base: 404, candidate: 200 },
      viewports: ["desktop", "mobile"],
    },
  );
});
```

Reject duplicate YAML keys, aliases, custom tags, unknown fields, filename and
issue mismatch, absolute URLs, query/fragment, traversal, repeated slash,
control characters, disallowed HTTP status, reversed/missing viewports,
selector on `page`, absent selector on `section`, selectors longer than 160,
and private/API route prefixes. Accept only `#id`, `.class` and a single
`[data-evidence-id='lowercase-kebab']` selector form.

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npm run test:unit -- tests/preview-evidence/request.test.ts
```

Expected: FAIL because `scripts/preview-evidence/request.ts` does not exist.

- [x] **Step 3: Implement the minimal closed parser and domain helpers**

Use `yaml.parseDocument` with `uniqueKeys: true`, reject `doc.errors`, reject
aliases/custom tags by walking `doc.contents`, then project from snake_case to
the exact interface. Define these constants in `domain.ts`:

```ts
export const EVIDENCE_REQUEST_PATH =
  /^evidence\/requests\/issue-([1-9][0-9]*)\.yaml$/u;
export const PRIVATE_ROUTE_PREFIXES = [
  "/api",
  "/socios",
  "/guia-equipo",
  "/manganafer/interesados",
] as const;
export const EVIDENCE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1 },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 1 },
] as const;
```

All errors use fixed Spanish messages and never interpolate YAML values.

- [x] **Step 4: Add valid versioned examples and the package command**

The examples use issue `1`, public route `/`, base/candidate status `200`, and
for the section example selector `[data-evidence-id='hero']`. Add:

```json
"preview:evidence": "tsx scripts/preview-evidence/cli.ts"
```

Do not name either example `issue-<N>.yaml`, so a workflow never mistakes them
for a live request.

- [x] **Step 5: Run focused tests and formatting**

Run:

```bash
npm run test:unit -- tests/preview-evidence/request.test.ts
npx prettier --check scripts/preview-evidence tests/preview-evidence evidence/requests package.json
```

Expected: PASS.

- [x] **Step 6: Commit the request contract**

```bash
git add package.json scripts/preview-evidence/domain.ts scripts/preview-evidence/request.ts tests/preview-evidence/request.test.ts evidence/requests/example-page.yaml evidence/requests/example-section.yaml
git commit -m "feat: validate preview evidence requests"
```

### Task 2: Preview-only Cloudflare profile

**Files:**

- Modify: `scripts/prepare-cloudflare-config.ts`
- Modify: `tests/server/cloudflare-config.test.ts`
- Create: `scripts/preview-evidence/profile.ts`
- Create: `tests/preview-evidence/profile.test.ts`

**Interfaces:**

- Consumes: `sha256` from Task 1.
- Produces:
  `prepareCloudflarePreviewConfig(inputPath, environment?, options?): Promise<PreparedConfig>`.
- Produces:
  `materializePreviewProfile(encoded: string, outputRoot: string, projectRoot: string): Promise<PreviewProfileArtifact>`.
- `PreviewProfileArtifact` contains only `path`, `sha256`, `workerName`,
  `databaseName`, `databaseId` and `indexable: false`.

- [x] **Step 1: Write failing preview-profile tests**

Extend the existing tests and add a focused test:

```ts
const pathWith = async (override: Record<string, unknown>): Promise<string> => {
  const path = join(root, `${randomUUID()}.jsonc`);
  await writeFile(path, validPreviewConfig(override), "utf8");
  return path;
};

await assert.rejects(
  prepareCloudflarePreviewConfig(await pathWith({ preview_urls: false })),
  /preview_urls/i,
);
await assert.rejects(
  prepareCloudflarePreviewConfig(await pathWith({ workers_dev: false })),
  /workers_dev/i,
);
await assert.rejects(
  prepareCloudflarePreviewConfig(
    await pathWith({ vars: { SITE_INDEXABLE: "true" } }),
  ),
  /indexable/i,
);
```

Also prove that a valid preview config preserves
`workers_dev: true`, `preview_urls: true`, contains no literal secret and that
`materializePreviewProfile` removes its decoded 0600 temporary even when
validation fails.

- [x] **Step 2: Run focused tests and confirm RED**

```bash
npm run test:unit -- tests/server/cloudflare-config.test.ts tests/preview-evidence/profile.test.ts
```

Expected: FAIL because preview-purpose validation and materialization do not
exist.

- [x] **Step 3: Add preview-purpose sanitization**

Extend `SanitizedProfile` with optional literal-true routing fields and add a
purpose option:

```ts
interface SanitizeCloudflareConfigOptions {
  allowLocalD1?: boolean;
  requirePreviewRouting?: boolean;
}
```

When `requirePreviewRouting` is true, require `workers_dev === true`,
`preview_urls === true`, `SITE_INDEXABLE === "false"`, a non-local D1 UUID and
worker name `comunidad-solar-preview`; preserve the two booleans in the
sanitized output. Keep existing generic and dry-run behavior unchanged.

- [x] **Step 4: Materialize the encoded GitHub secret without logging it**

`materializePreviewProfile` must:

1. reject an empty or non-base64 canonical input;
2. decode at most 64 KiB;
3. create a 0600 temporary under `outputRoot` with `O_EXCL | O_NOFOLLOW`;
4. call `prepareCloudflarePreviewConfig`;
5. verify the returned file has `SITE_INDEXABLE=false`; and
6. remove the decoded file in `finally`.

No thrown error may contain the encoded or decoded bytes.

- [x] **Step 5: Run focused and existing Cloudflare tests**

```bash
npm run test:unit -- tests/server/cloudflare-config.test.ts tests/preview-evidence/profile.test.ts tests/server/cloudflare-dry-run.test.ts
npm run deploy:dry
```

Expected: PASS and `CLOUDFLARE_DEPLOY_DRY_OK` from the dry run.

- [x] **Step 6: Commit the preview profile boundary**

```bash
git add scripts/prepare-cloudflare-config.ts scripts/preview-evidence/profile.ts tests/server/cloudflare-config.test.ts tests/preview-evidence/profile.test.ts
git commit -m "feat: enforce preview-only Cloudflare profiles"
```

### Task 3: Trusted GitHub context resolution

**Files:**

- Create: `scripts/preview-evidence/github.ts`
- Create: `tests/preview-evidence/github.test.ts`
- Modify: `scripts/preview-evidence/cli.ts`

**Interfaces:**

- Consumes: `EVIDENCE_REQUEST_PATH` and `loadEvidenceRequest` from Task 1.
- Produces:
  `resolvePullRequestRun(payload: unknown, api: GitHubApi): Promise<PullRequestRunContext>`.
- Produces:
  `resolveMainRun(payload: unknown, api: GitHubApi): Promise<MainRunContext>`.
- Produces: `writeGitHubOutputs(path: string, values: Record<string,string>): Promise<void>`.
- `GitHubApi` exposes only
  `get(path: string): Promise<unknown>`,
  `post(path: string, body: unknown): Promise<unknown>` and
  `patch(path: string, body: unknown): Promise<unknown>`.

```ts
export interface PullRequestRunContext {
  repository: string;
  runId: number;
  runUrl: string;
  prNumber: number;
  issueNumber: number;
  baseSha: string;
  headSha: string;
  requestPath: string;
  request: EvidenceRequest;
}
```

- [x] **Step 1: Write failing resolver tests with an in-memory API**

Cover one valid internal PR and reject: non-success conclusion,
non-`pull_request` source event, fork, base branch other than `main`, closed PR,
head mismatch, zero/multiple request files, request file not changed in this
PR, missing `#N`/issue URL in body, closed issue, more than 300 changed files,
and any `drizzle/` change.

Use a payload whose authoritative values disagree with untrusted PR body text
and assert the resolver keeps API SHAs.

- [x] **Step 2: Run the resolver test and confirm RED**

```bash
npm run test:unit -- tests/preview-evidence/github.test.ts
```

Expected: FAIL because `github.ts` does not exist.

- [x] **Step 3: Implement bounded GitHub API and payload validation**

Validate all objects as closed projections. Fetch the PR, up to three pages of
100 files, raw request contents for `headSha`, and the issue. Decode GitHub's
base64 content only after checking `encoding === "base64"` and size <= 64 KiB.
Call `parseEvidenceRequest`; never execute code from the candidate checkout.

`writeGitHubOutputs` uses the documented random delimiter form and rejects
keys outside `/^[a-z][a-z0-9_]{0,62}$/` and values containing NUL.

- [x] **Step 4: Add strict CLI commands**

At this stage `cli.ts` accepts the following exact commands and rejects all
others before reading environment or files. Task 9 adds `resolve-main` only
after its main-run tests exist:

```text
resolve-pr --event <path> --output <path> --context <path>
validate-request --path <path> --root <path>
```

`resolve-pr` requires `GITHUB_TOKEN` and `GITHUB_REPOSITORY`; it writes
`pr_number`, `issue_number`, `base_sha`, `head_sha`, `request_path`, `run_id`
and a path to a sanitized context JSON. That JSON embeds only the normalized
`EvidenceRequest`, never the raw YAML or PR body, so later jobs do not need a
candidate checkout to learn the route.

- [x] **Step 5: Run tests and a malformed CLI smoke test**

```bash
npm run test:unit -- tests/preview-evidence/github.test.ts
npm run preview:evidence -- unknown-command
```

Expected: tests PASS; malformed command exits nonzero with a fixed usage error.

- [x] **Step 6: Commit trusted context resolution**

```bash
git add scripts/preview-evidence/github.ts scripts/preview-evidence/cli.ts tests/preview-evidence/github.test.ts
git commit -m "feat: resolve trusted preview workflow context"
```

### Task 4: Sealed build bundle

**Files:**

- Create: `scripts/preview-evidence/bundle.ts`
- Create: `tests/preview-evidence/bundle.test.ts`
- Modify: `scripts/preview-evidence/cli.ts`

**Interfaces:**

- Consumes: `canonicalJson` and `sha256` from Task 1.
- Produces:
  `createSealedBundle(input: SealBundleInput): Promise<BundleManifest>`.
- Produces:
  `verifySealedBundle(root: string, expected: BundleExpectation): Promise<BundleManifest>`.
- `SealBundleInput` contains `sourceRoot`, `outputRoot`, `role`, `sourceSha`,
  `profilePath` and `profileSha256`.
- `BundleManifest.files` is sorted and each entry contains `path`, `bytes`,
  `mode` and `sha256`.

- [x] **Step 1: Write failing bundle tests**

Build a temporary fixture with `dist/server/wrangler.json`, an entry module,
`dist/client/index.html` and `drizzle/0000.sql`. Prove deterministic output and
round-trip verification. Reject source/output symlinks, hardlinked files,
special files, `..`, `.env`, `.dev.vars`, more than 5,000 files, one file over
25 MiB, total over 250 MiB, an unlisted byte change and a manifest with unknown
fields.

Assert topology rejects routes/custom domains, a worker name other than
`comunidad-solar-preview`, indexability other than false, D1 mismatch,
`no_bundle !== true`, main other than `entry.mjs` and assets other than
`../client`.

- [x] **Step 2: Run focused tests and confirm RED**

```bash
npm run test:unit -- tests/preview-evidence/bundle.test.ts
```

Expected: FAIL because bundle sealing is absent.

- [x] **Step 3: Copy only approved roots by bytes**

Walk `dist` and `drizzle` using `lstat` without following links. Require regular
files with link count 1, mode 0644 or 0755, portable NFC paths and the fixed
limits. Open with `O_RDONLY | O_NOFOLLOW`, recalculate the stat after open, copy
to a fresh output using `O_CREAT | O_EXCL | O_NOFOLLOW`, then hash the copied
bytes.

Write `.preview-evidence/bundle-manifest.json` as
`${canonicalJson(manifest)}\n` only after every file succeeds.

- [x] **Step 4: Validate emitted Wrangler topology**

Parse `dist/server/wrangler.json` as JSON and compare its effective worker, D1,
assets and indexability to the sanitized profile. Reject deploy routes,
triggers, service bindings, extra D1/KV namespaces other than generated
`SESSION`, and any secrets-store binding. Permit the generated `IMAGES` binding
and record it explicitly in the manifest.

- [x] **Step 5: Add bundle CLI commands and verify**

Add:

```text
seal-bundle --source <root> --output <root> --role <base|candidate|release> --sha <40hex> --profile <path> --profile-sha <64hex>
verify-bundle --root <root> --role <role> --sha <40hex> --profile <path> --profile-sha <64hex>
```

Run:

```bash
npm run test:unit -- tests/preview-evidence/bundle.test.ts
npm run test:unit -- tests/preview-evidence/cli.test.ts
npm run build
```

The CLI unit test creates an isolated source/profile fixture outside its output,
then proves `seal-bundle` and `verify-bundle` accept only the same exact identity.

- [x] **Step 6: Commit bundle sealing**

```bash
git add scripts/preview-evidence/bundle.ts scripts/preview-evidence/cli.ts tests/preview-evidence/bundle.test.ts
git commit -m "feat: seal preview deployment bundles"
```

### Task 5: Fixed Cloudflare version uploader

**Files:**

- Create: `scripts/preview-evidence/cloudflare.ts`
- Create: `tests/preview-evidence/cloudflare.test.ts`
- Modify: `scripts/preview-evidence/cli.ts`

**Interfaces:**

- Consumes: `verifySealedBundle` from Task 4.
- Produces:
  `uploadPreviewVersion(input: UploadInput, runner?: WranglerRunner): Promise<CloudflareVersionDescriptor>`.
- Produces:
  `deployExactVersion(input: DeployVersionInput, runner?: WranglerRunner): Promise<void>`.
- `CloudflareVersionDescriptor` contains schema version, role, source SHA,
  bundle digest, worker name, version ID, tag, alias and validated HTTPS URL.

- [x] **Step 1: Write failing uploader tests using a fake runner**

Assert fixed argv for upload:

```ts
[
  "versions", "upload",
  "--config", absoluteConfig,
  "--no-bundle", "--strict",
  "--tag", "pr-4-head-a1b2c3d",
  "--message", "PR 4 candidate a1b2c3d",
  "--preview-alias", "pr-4-head-a1b2c3d",
]
```

Then assert one `versions list --json --config <path>` call validates the UUID,
tag and message. Reject nonzero exit, timeout, output over 1 MiB, missing or
multiple preview URLs, HTTP/userinfo/port/query/fragment URLs, hostname outside
`.workers.dev`, tag mismatch, version mismatch and values containing ANSI
control sequences.

Prove deploy argv is exactly
`versions deploy <uuid>@100% --yes --config <path> --message <fixed>`.

- [x] **Step 2: Run uploader tests and confirm RED**

```bash
npm run test:unit -- tests/preview-evidence/cloudflare.test.ts
```

Expected: FAIL because the uploader does not exist.

- [x] **Step 3: Implement a capability-bounded Wrangler runner**

Spawn the absolute `node_modules/.bin/wrangler` with `shell:false`, a 10-minute
deadline and only these environment values:

```ts
{
  CI: "true",
  NO_COLOR: "1",
  CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
  CLOUDFLARE_API_TOKEN: credentials.apiToken,
}
```

Validate Account ID and token presence without reflecting either. Kill the
detached process group on timeout. Redact fixed token-like patterns from every
error.

- [x] **Step 4: Verify upload output against JSON listing**

Use a full UUID regex for version ID and exactly one HTTPS URL regex from the
upload output. Parse the subsequent JSON list as a bounded array of closed
objects and find exactly one matching tag. Compare its ID and message with the
upload result before writing the descriptor.

- [x] **Step 5: Add CLI commands and run tests**

```text
upload-version --bundle <root> --profile <path> --profile-sha <64hex> --context <path> --context-sha <64hex> --role <base|candidate> --output <path>
deploy-version --bundle <root> --profile <path> --profile-sha <64hex> --descriptor <path>
```

The PR command derives its source SHA and PR number exclusively from the sealed
context. Task 9 extends upload dispatch for a sealed main/release context.
Credentials are read only after argument, context, bundle and request
validation.

Run:

```bash
npm run test:unit -- tests/preview-evidence/cloudflare.test.ts tests/preview-evidence/bundle.test.ts
```

Expected: PASS without network access.

- [x] **Step 6: Commit the uploader**

```bash
git add scripts/preview-evidence/cloudflare.ts scripts/preview-evidence/cli.ts tests/preview-evidence/cloudflare.test.ts
git commit -m "feat: upload exact Cloudflare preview versions"
```

### Task 6: Deterministic remote screenshots and manifests

**Files:**

- Create: `scripts/preview-evidence/capture.ts`
- Create: `tests/preview-evidence/capture.test.ts`
- Modify: `scripts/preview-evidence/cli.ts`

**Interfaces:**

- Consumes: `EvidenceRequest`, `EVIDENCE_VIEWPORTS`, `canonicalJson`, `sha256`
  and `CloudflareVersionDescriptor`.
- Produces:
  `capturePullRequestEvidence(input: CaptureInput, adapter?: BrowserAdapter): Promise<CaptureSet>`.
- Produces:
  `captureReleaseEvidence(input: ReleaseCaptureInput, adapter?: BrowserAdapter): Promise<CaptureSet>`.
- `CaptureSet` names every PNG and a `manifest.json`; no caller invents names.

- [x] **Step 1: Write failing browser-adapter tests**

Use a fake browser to prove both variants and viewports execute in canonical
order. For `page`, expect four PNGs; for `section`, expect eight. Assert base
uses `expectedStatus.base`, candidate uses `expectedStatus.candidate`, selector
count must be exactly one and all output names match the spec.

Reject page errors, failed same-origin requests, wrong status, hidden/oversized
selector, invalid/truncated PNG, width mismatch, height above 30,000, file over
8 MiB and total capture set over 40 MiB. Cross-origin request failure is
recorded by origin count but does not fail the page.

- [x] **Step 2: Run capture tests and confirm RED**

```bash
npm run test:unit -- tests/preview-evidence/capture.test.ts
```

Expected: FAIL because capture logic does not exist.

- [x] **Step 3: Implement the Playwright adapter**

Create one Chromium browser, a fresh context per viewport and these exact
context options:

```ts
{
  viewport: { width, height },
  deviceScaleFactor: 1,
  locale: "es-ES",
  timezoneId: "Europe/Madrid",
  colorScheme: "light",
  reducedMotion: "reduce",
  serviceWorkers: "block",
}
```

Install an init script that disables animations/transitions, navigate with
`waitUntil: "domcontentloaded"`, wait for `document.fonts.ready` under the same
30-second page deadline and capture with `fullPage:true`. Close context/browser
in `finally` with bounded cleanup.

- [x] **Step 4: Validate PNG bytes and write the manifest**

Use `PNG.sync.read` to verify dimensions. Record status, URL origin, version ID,
viewport, selector, filename, bytes and SHA-256. Include `capturedAt`, GitHub
run URL and tool versions, while defining `stableCaptureProjection` that omits
only `capturedAt` and run-attempt metadata for idempotent reruns.

- [x] **Step 5: Add capture CLI and run tests**

```text
capture-pr --context <path> --context-sha <64hex> --base <descriptor> --candidate <descriptor> --output <dir> --run-attempt <n>
capture-release --context <path> --context-sha <64hex> --release <descriptor> --output <dir> --run-attempt <n>
```

Run:

```bash
npm run test:unit -- tests/preview-evidence/capture.test.ts
```

Expected: PASS with fake adapter and no browser/network.

- [x] **Step 6: Commit browser evidence capture**

```bash
git add scripts/preview-evidence/capture.ts scripts/preview-evidence/cli.ts tests/preview-evidence/capture.test.ts
git commit -m "feat: capture preview evidence with Playwright"
```

### Task 7: Append-only evidence and GitHub reporting

**Files:**

- Create: `scripts/preview-evidence/evidence.ts`
- Create: `tests/preview-evidence/evidence.test.ts`
- Modify: `scripts/preview-evidence/github.ts`
- Modify: `tests/preview-evidence/github.test.ts`
- Modify: `scripts/preview-evidence/cli.ts`

**Interfaces:**

- Consumes: `CaptureSet` and `stableCaptureProjection` from Task 6.
- Produces:
  `publishEvidenceToCheckout(input: PublishEvidenceInput): Promise<PublishEvidenceResult>`.
- Produces:
  `upsertEvidenceComments(api, input): Promise<void>`.
- Produces:
  `setPreviewApprovalStatus(api, repository, headSha, state): Promise<void>`.

- [x] **Step 1: Write failing append-only tests**

For a temporary evidence checkout, assert exact PR paths under
`issue-4/baseline/<sha>` and `issue-4/candidates/<sha>` and release paths under
`issue-4/releases/<sha>`. Prove first write adds, identical rerun changes
nothing and retains the original timestamp, while a changed PNG, manifest,
file type, missing destination file or extra destination file fails without
altering any existing byte.

Reject any symlink in source/destination, paths outside the checkout, more than
eight PNGs and filenames not present in the manifest.

- [x] **Step 2: Write failing comment/status tests**

Use the in-memory API to assert marker
`<!-- preview-evidence:issue-4:<head-sha> -->`, full SHAs, two Preview URLs, raw
PNG links, manifest link and explicit pending human-review text. Existing
marker uses PATCH; missing marker uses POST; multiple markers fail.

Assert `preview-approved` always targets the 40-hex candidate SHA with
`target_url` equal to the trusted workflow run URL and description
`Preview y evidencia aprobadas por una persona`.

- [x] **Step 3: Run focused tests and confirm RED**

```bash
npm run test:unit -- tests/preview-evidence/evidence.test.ts tests/preview-evidence/github.test.ts
```

Expected: FAIL because append-only publication and reporting are absent.

- [x] **Step 4: Implement transactional local publication**

Validate the complete source set before creating any destination. For new
paths, copy to sibling exclusive temporary files, hash them, then link/rename
only after all validation succeeds. On any failure remove only temporaries.
For existing paths compare PNG bytes and stable manifest projection; never
write them.

Return sorted `addedPaths`, `existingPaths`, raw URLs and the one commit message
`evidence: record issue 4 candidate <short-sha>`.

- [x] **Step 5: Implement bounded GitHub reporting**

List at most 100 issue comments, compare only exact markers, bound response
bodies and send closed JSON payloads. Escape all Markdown labels; URLs must
already pass the HTTPS GitHub/Cloudflare validators. Never include stderr,
environment data or profile contents.

- [x] **Step 6: Add CLI commands and run tests**

```text
publish-evidence --capture <dir> --checkout <dir> --context <path> --context-sha <64hex> --output <path> --github-output <path>
comment-evidence --publication <path> --context <path> --context-sha <64hex> --evidence-sha <40hex>
approve-preview --context <path> --context-sha <64hex>
```

Run:

```bash
npm run test:unit -- tests/preview-evidence/evidence.test.ts tests/preview-evidence/github.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit evidence publication**

```bash
git add scripts/preview-evidence/evidence.ts scripts/preview-evidence/github.ts scripts/preview-evidence/cli.ts tests/preview-evidence/evidence.test.ts tests/preview-evidence/github.test.ts
git commit -m "feat: publish immutable preview evidence"
```

### Task 8: Pre-merge preview workflow

**Files:**

- Create: `.github/workflows/pr-preview.yml`
- Create: `tests/foundation/preview-workflows.test.mjs`
- Modify: `.github/workflows/verify.yml`
- Modify: `tests/foundation/production-readiness-workflow.test.mjs`

**Interfaces:**

- Consumes every CLI command from Tasks 1-7.
- Produces trusted commit status `preview-approved` for branch protection.
- Produces artifacts named with run ID, role and full SHA.

- [x] **Step 1: Write failing static workflow tests**

Parse YAML and assert:

- trigger is only completed `workflow_run` for `Production readiness`;
- top-level permissions are `{ contents: "read" }`;
- PR path condition requires `conclusion == "success"` and
  `event == "pull_request"`;
- candidate build has no `environment`, token expression or write permission;
- upload alone references `secrets.CLOUDFLARE_API_TOKEN`;
- capture has no secret expression and installs Chromium;
- evidence writer alone has contents/issues/pull-requests write;
- approval alone uses `environment: premerge-review` and `statuses: write`;
- upload and evidence jobs never check out the candidate as executable code;
- every `uses` value matches a 40-hex SHA; and
- concurrency for evidence writing is `evidence-write-${{ github.repository }}`
  with `cancel-in-progress:false`.

- [x] **Step 2: Run the workflow contract and confirm RED**

```bash
npm run test:unit -- tests/foundation/preview-workflows.test.mjs tests/foundation/production-readiness-workflow.test.mjs
```

Expected: FAIL because `pr-preview.yml` does not exist.

- [x] **Step 3: Create resolve/profile/build jobs**

Use these pinned actions:

```text
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
```

`resolve` checks out only the controller and validates GitHub context. `profile`
uses environment `preview`, reads
`secrets.CLOUDFLARE_PREVIEW_CONFIG_B64`, publishes only its sanitized file and
hash. A two-entry matrix checks out base/candidate with
`persist-credentials:false`, runs `npm ci --ignore-scripts`, the existing build
sequence, and controller-owned `seal-bundle`.

- [x] **Step 4: Create upload/capture/evidence jobs**

`upload` downloads both bundles, runs trusted `verify-bundle`, then uploads
base and candidate sequentially using the preview token. It uploads only two
sanitized descriptors. `capture` installs Chromium, has read-only permissions
and no environment, then produces a capture artifact. `evidence` checks out
the `evidence` branch and controller separately, publishes append-only,
commits only when `addedPaths` is nonempty, pushes normally and comments PR +
issue.

- [x] **Step 5: Add the protected approval job**

The final job has:

```yaml
name: preview-approved
needs: [resolve, evidence]
environment: premerge-review
permissions:
  contents: read
  pull-requests: read
  statuses: write
```

After the environment releases it, rerun authoritative PR/head checks and call
`approve-preview`. A changed/closed PR cannot receive success.

- [x] **Step 6: Keep Production readiness stable**

Do not give `verify.yml` secrets or write permissions. Only add a candidate
bundle artifact if the implementation actually consumes it; otherwise leave
its four-job topology unchanged. Update its contract test to prove the stable
gate remains `production-readiness`.

- [x] **Step 7: Run workflow and formatting tests**

```bash
npm run test:unit -- tests/foundation/preview-workflows.test.mjs tests/foundation/production-readiness-workflow.test.mjs tests/preview-evidence
npx prettier --check .github/workflows scripts/preview-evidence tests/preview-evidence tests/foundation/preview-workflows.test.mjs
```

Expected: PASS.

- [x] **Step 8: Commit the PR workflow**

```bash
git add .github/workflows/pr-preview.yml .github/workflows/verify.yml tests/foundation/preview-workflows.test.mjs tests/foundation/production-readiness-workflow.test.mjs
git commit -m "ci: require preview evidence before merge"
```

### Task 9: Shared preview after merge

**Files:**

- Create: `.github/workflows/shared-preview.yml`
- Modify: `scripts/preview-evidence/github.ts`
- Modify: `scripts/preview-evidence/cli.ts`
- Modify: `tests/preview-evidence/github.test.ts`
- Modify: `tests/foundation/preview-workflows.test.mjs`

**Interfaces:**

- Consumes: release role of bundle/uploader/capture/evidence modules.
- Produces one exact Cloudflare version deployed at 100% to
  `comunidad-solar-preview` and one release evidence directory.

- [x] **Step 1: Write failing main-run and workflow tests**

`resolveMainRun` accepts only a successful `Production readiness` run whose
source event is `push`, head branch is `main`, and SHA still belongs to main.
The API must return exactly one merged PR for the commit and the request path
that PR changed. The external numeric repository variable
`PREVIEW_PIPELINE_BOOTSTRAP_PR` permits only that exact pipeline PR, and only
when all its changed paths belong to the allowlisted pipeline/docs roots, to
skip route capture before activation; every later main run needs a request.

The workflow test asserts no production secret/domain, profile remains
non-indexable, deployment uses `deploy-version` after upload, smoke/capture uses
the configured shared preview URL, and evidence write shares the same global
concurrency group.

- [x] **Step 2: Run focused tests and confirm RED**

```bash
npm run test:unit -- tests/preview-evidence/github.test.ts tests/foundation/preview-workflows.test.mjs
```

Expected: FAIL because shared workflow support is absent.

- [x] **Step 3: Implement main context and exact-version deploy flow**

Resolve the merged PR via `/commits/<sha>/pulls`, require `merged_at` and
`merge_commit_sha`/association with current main SHA, load its request at the
main SHA, and emit sanitized context. Build and seal `role:release` without
secrets, upload it with tag `main-<short-sha>`, then call
`versions deploy <version-id>@100%` rather than rebuilding.

- [x] **Step 4: Smoke and capture the shared public URL**

Read `vars.CLOUDFLARE_PREVIEW_URL`, require exact HTTPS origin ending in
`.workers.dev`, and verify its host identifies `comunidad-solar-preview`.
Capture the request route with candidate expected status, write
`releases/<main-sha>`, then comment the merged PR and issue with the release
manifest and shared URL.

- [x] **Step 5: Run workflow contracts and commit**

```bash
npm run test:unit -- tests/preview-evidence/github.test.ts tests/foundation/preview-workflows.test.mjs
npx prettier --check .github/workflows/shared-preview.yml scripts/preview-evidence tests/preview-evidence
git add .github/workflows/shared-preview.yml scripts/preview-evidence/github.ts scripts/preview-evidence/cli.ts tests/preview-evidence/github.test.ts tests/foundation/preview-workflows.test.mjs
git commit -m "ci: deploy merged SHA to shared preview"
```

### Task 10: Production workflow closed by default

**Files:**

- Create: `.github/workflows/production.yml`
- Create: `scripts/preview-evidence/release.ts`
- Create: `tests/preview-evidence/release.test.ts`
- Modify: `scripts/preview-evidence/cli.ts`
- Modify: `tests/foundation/preview-workflows.test.mjs`

**Interfaces:**

- Produces:
  `authorizeProductionRelease(input: ProductionReleaseInput, api: GitHubApi): Promise<ProductionReleaseContext>`.
- Consumes existing profile, bundle, upload, deploy, capture and evidence
  commands only after authorization.

- [x] **Step 1: Write failing fail-closed tests**

Reject absent, empty, differently-cased or nonliteral `PRODUCTION_ENABLED`;
non-40-hex SHA; SHA not reachable from `main`; absent release manifest on the
evidence branch; manifest whose SHA/hash differs; missing successful
`preview-approved` status; production URL outside exact configured HTTPS
origin; and production profile with `SITE_INDEXABLE=false`.

- [x] **Step 2: Write failing workflow contract**

Assert only `workflow_dispatch` with required `sha` input, top-level read-only
permissions, a first unprivileged guard, protected `environment: production`
before token use, distinct `CLOUDFLARE_PRODUCTION_*` names, exact version
deployment, smoke test, rollback descriptor artifact and no Raiola/DNS command.

- [x] **Step 3: Run focused tests and confirm RED**

```bash
npm run test:unit -- tests/preview-evidence/release.test.ts tests/foundation/preview-workflows.test.mjs
```

Expected: FAIL because production authorization/workflow do not exist.

- [x] **Step 4: Implement authorization before production capability**

The guard reads `vars.PRODUCTION_ENABLED` and exits nonzero unless it is exactly
`true`. It queries GitHub and raw evidence with read permission, validates the
release manifest and status, and emits only SHA, issue, request path and
manifest hash. Token/profile jobs cannot start unless the guard succeeds.

- [x] **Step 5: Define the reusable but inactive deployment path**

Use production Account ID, API token, encoded operator profile and public URL
only from the `production` environment. Build the trusted main SHA without
secrets, upload one version, deploy its verified ID at 100%, smoke/capture, and
publish `issue-<N>/production/<sha>/manifest.json`. Upload a small rollback
descriptor containing previous deployment ID, new version ID, SHA and run URL.

No production variable or secret is configured as part of this task, so the
guard remains closed in authoritative repository state.

- [x] **Step 6: Run contracts and commit**

```bash
npm run test:unit -- tests/preview-evidence/release.test.ts tests/foundation/preview-workflows.test.mjs
npx prettier --check .github/workflows/production.yml scripts/preview-evidence/release.ts tests/preview-evidence/release.test.ts
git add .github/workflows/production.yml scripts/preview-evidence/release.ts scripts/preview-evidence/cli.ts tests/preview-evidence/release.test.ts tests/foundation/preview-workflows.test.mjs
git commit -m "ci: add fail-closed production release workflow"
```

### Task 11: Operations, verification and safe bootstrap

**Files:**

- Modify: `docs/operations/web-change-requests.md`
- Modify: `docs/operations/production-release-runbook.md`
- Modify: `docs/operations/cloudflare.md`
- Modify: `.github/ISSUE_TEMPLATE/solicitud-cambio-web.yml`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-03-pr-preview-evidence-design.md`
- Modify: this plan to check completed steps

**Interfaces:**

- Documents the exact GitHub environment variable/secret contract:

```text
preview environment
  variable CLOUDFLARE_ACCOUNT_ID
  variable CLOUDFLARE_PREVIEW_URL
  secret   CLOUDFLARE_API_TOKEN
  secret   CLOUDFLARE_PREVIEW_CONFIG_B64

temporary bootstrap repository variable
  PREVIEW_PIPELINE_BOOTSTRAP_PR=<numeric PR number>; delete after pipeline merge

premerge-review environment
  required reviewer: current repository owner
  prevent self-review: disabled until a second reviewer exists

production environment (not enabled)
  variable PRODUCTION_ENABLED is absent or false
  no production credentials are installed during bootstrap
```

- [ ] **Step 1: Update process docs to match pre-merge reality**

Replace the old sequence that merged before preview with issue -> PR -> CI ->
two previews -> PNG evidence -> `premerge-review` -> merge -> shared preview.
Document page/section request examples, selector attributes, fork behavior,
reruns, correction after a changed SHA, evidence links and the three rollback
cases.

- [ ] **Step 2: Update Cloudflare/runbook configuration**

Document base64 encoding without echoing content:

```bash
base64 < /ruta/segura/comunidad-solar-preview.jsonc | gh secret set CLOUDFLARE_PREVIEW_CONFIG_B64 --env preview
gh secret set CLOUDFLARE_API_TOKEN --env preview
gh variable set CLOUDFLARE_ACCOUNT_ID --env preview --body "ACCOUNT_ID_FROM_CLOUDFLARE"
gh variable set CLOUDFLARE_PREVIEW_URL --env preview --body "https://comunidad-solar-preview.comunidadsolar-dev.workers.dev"
```

Explain that `ACCOUNT_ID_FROM_CLOUDFLARE` is replaced locally by the operator
and must never be
committed; do not include any real token, UUID or profile bytes. Document
environment protection and branch rule setup through GitHub UI/API.

- [ ] **Step 3: Add request-template guidance**

The issue form must ask whether the scope is full page or section, require the
exact URL/desired route, request a stable `data-evidence-id` for section
capture, name the approver, and warn that the issue must remain open until the
release comment is present.

- [ ] **Step 4: Run the complete local verification matrix**

Run each command and retain exit status:

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run test:integration
npm run test:dev
npm run verify:public
npm run verify:links
npm run verify:server
npm run deploy:dry
npm run verify:independent
git diff --check origin/main...HEAD
```

Expected: every command exits 0. The baseline was 731 passing tests; the final
count must be greater because the new suites are auto-discovered.

- [ ] **Step 5: Review secrets and workflow capabilities**

Run:

```bash
rg -n "CLOUDFLARE_API_TOKEN|CLOUDFLARE_PREVIEW_CONFIG_B64|PRODUCTION_ENABLED" --hidden --glob '!node_modules/**' --glob '!.git/**'
git status --short
git log --oneline origin/main..HEAD
```

Expected: secret names appear only in docs/workflows/tests; no value is
present. The worktree contains only intended tracked changes.

- [ ] **Step 6: Commit documentation and mark the spec implemented**

```bash
git add README.md docs/operations .github/ISSUE_TEMPLATE/solicitud-cambio-web.yml docs/superpowers/specs/2026-09-03-pr-preview-evidence-design.md docs/superpowers/plans/2026-09-03-pr-preview-evidence-pipeline.md
git commit -m "docs: operate preview evidence releases"
```

- [ ] **Step 7: Push and open the bootstrap PR**

Push `feat/pr-preview-evidence-pipeline`, open a PR that references the design
and states that `preview-approved` is not yet required, then wait for
`production-readiness`. Review the diff and checks before merge. This bootstrap
PR does not alter production or Cloudflare.

- [ ] **Step 8: Configure preview infrastructure without exposing values**

After the bootstrap code is on `main`:

1. set `PREVIEW_PIPELINE_BOOTSTRAP_PR` to the exact bootstrap PR number before
   merging it;
2. create/update GitHub environment `preview` with the four names above;
3. create `premerge-review` with the repository owner as required reviewer and
   self-review allowed;
4. create orphan branch `evidence` with `README.md`, block force-push/deletion
   and allow the Actions bot to append;
5. confirm `production` lacks `PRODUCTION_ENABLED=true` and credentials;
6. remove `PREVIEW_PIPELINE_BOOTSTRAP_PR` immediately after the bootstrap main
   run finishes; and
7. do not change Raiola or Cloudflare DNS.

- [ ] **Step 9: Execute the real issue #4 acceptance PR**

Create a separate branch from the new `main`, add
`evidence/requests/issue-4.yaml` and the isolated noindex route
`/pruebas/guia-comunidades-propietarios/`. Verify base 404/candidate 200,
desktop/mobile PNGs, permanent manifests, PR/issue comments and the waiting
environment. Approve `premerge-review`, confirm `preview-approved` belongs to
the current head, merge, and verify the same main SHA on the shared preview
with release evidence.

- [ ] **Step 10: Activate the required status only after proof**

Add `preview-approved` to the `main` branch rule only after Step 9 proves a
successful status. Retain `production-readiness`, PR requirement, resolved
conversations, linear history, and force-push/deletion blocks. Record the
branch-rule snapshot without tokens in the issue #4 release comment.

- [ ] **Step 11: Final verification and handoff**

Confirm authoritative GitHub checks, Cloudflare version IDs/URLs, raw evidence
links, shared preview response and unchanged `comunidadsolar.es`. Record
remaining production prerequisites as disabled configuration, not unfinished
pipeline code.
