import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const changeGuidePath = "docs/operations/web-change-requests.md";
const runbookPath = "docs/operations/production-release-runbook.md";
const cloudflarePath = "docs/operations/cloudflare.md";
const issueTemplatePath = ".github/ISSUE_TEMPLATE/solicitud-cambio-web.yml";

test("documents preview evidence and approval before merge", async () => {
  const guide = await readFile(changeGuidePath, "utf8");

  const orderedMilestones = [
    "Issue abierta",
    "Pull Request",
    "Production readiness",
    "preview base",
    "preview candidata",
    "evidencia PNG",
    "premerge-review",
    "merge en `main`",
    "preview compartida",
  ];
  let cursor = -1;
  for (const milestone of orderedMilestones) {
    const index = guide.indexOf(milestone, cursor + 1);
    assert.notEqual(index, -1, `falta el hito documentado: ${milestone}`);
    assert.ok(index > cursor, `${milestone} aparece fuera de orden`);
    cursor = index;
  }

  assert.match(guide, /evidence\/requests\/issue-<N>\.yaml/u);
  assert.match(guide, /scope: page/u);
  assert.match(guide, /scope: section/u);
  assert.match(guide, /\[data-evidence-id='beneficios'\]/u);
  assert.match(guide, /fork[\s\S]*rama interna/iu);
  assert.match(guide, /SHA nuevo[\s\S]*aprobaci[oó]n\s+nueva/iu);
  assert.match(guide, /Antes del merge[\s\S]*cerrar la PR/iu);
  assert.match(guide, /Despu[eé]s del merge[\s\S]*git revert/iu);
  assert.match(guide, /Worker desplegado[\s\S]*versi[oó]n anterior/iu);
  assert.match(guide, /issue[\s\S]*abierta[\s\S]*comentario de release/iu);
  assert.doesNotMatch(
    guide,
    /solo entonces se integra en `main`[\s\S]*prepare la versi[oó]n de revisi[oó]n/iu,
  );
});

test("documents the exact GitHub preview and disabled production contract", async () => {
  const [runbook, cloudflare] = await Promise.all([
    readFile(runbookPath, "utf8"),
    readFile(cloudflarePath, "utf8"),
  ]);
  const docs = `${runbook}\n${cloudflare}`;

  for (const value of [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_PREVIEW_URL",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_PREVIEW_CONFIG_B64",
    "PREVIEW_PIPELINE_BOOTSTRAP_PR",
    "premerge-review",
    "PRODUCTION_ENABLED",
  ]) {
    assert.match(docs, new RegExp(value, "u"), `${value} no está documentado`);
  }

  assert.match(
    cloudflare,
    /base64 < \/ruta\/segura\/comunidad-solar-preview\.jsonc \| gh secret set CLOUDFLARE_PREVIEW_CONFIG_B64 --env preview/u,
  );
  assert.match(cloudflare, /gh secret set CLOUDFLARE_API_TOKEN --env preview/u);
  assert.match(
    cloudflare,
    /gh variable set CLOUDFLARE_ACCOUNT_ID --env preview --body "ACCOUNT_ID_FROM_CLOUDFLARE"/u,
  );
  assert.match(
    cloudflare,
    /gh variable set CLOUDFLARE_PREVIEW_URL --env preview --body "https:\/\/comunidad-solar-preview\.comunidadsolar-dev\.workers\.dev"/u,
  );
  assert.match(cloudflare, /required reviewer/iu);
  assert.match(cloudflare, /prevent self-review[\s\S]*desactiv/iu);
  assert.match(cloudflare, /producci[oó]n[\s\S]*sin credenciales/iu);
  assert.match(cloudflare, /PRODUCTION_ENABLED[\s\S]*(ausente|false)/iu);
  assert.match(runbook, /\.github\/workflows\/pr-preview\.yml/u);
  assert.match(runbook, /\.github\/workflows\/shared-preview\.yml/u);
  assert.match(runbook, /\.github\/workflows\/production\.yml/u);
});

test("issue form captures evidence scope, route, selector and release ownership", async () => {
  const form = parse(await readFile(issueTemplatePath, "utf8"));
  const fields = new Map(
    form.body.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );

  const scope = fields.get("evidence_scope");
  assert.ok(scope);
  assert.deepEqual(scope.attributes.options, [
    "Página completa",
    "Sección concreta",
  ]);
  assert.equal(scope.validations.required, true);

  const route = fields.get("exact_route");
  assert.ok(route);
  assert.equal(route.validations.required, true);
  assert.match(route.attributes.description, /ruta exacta/iu);

  const selector = fields.get("evidence_selector");
  assert.ok(selector);
  assert.equal(selector.validations.required, true);
  assert.match(selector.attributes.description, /data-evidence-id/iu);

  const approver = fields.get("approver");
  assert.ok(approver);
  assert.equal(approver.validations.required, true);

  const confirmations = fields.get("confirmations");
  assert.ok(confirmations);
  assert.ok(
    confirmations.attributes.options.some((option) =>
      /issue[\s\S]*abierta[\s\S]*comentario de release/iu.test(option.label),
    ),
  );
});
