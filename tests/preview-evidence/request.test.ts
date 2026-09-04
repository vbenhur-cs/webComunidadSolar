import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  EVIDENCE_VIEWPORTS,
  sha256,
} from "../../scripts/preview-evidence/domain.ts";
import {
  loadEvidenceRequest,
  parseEvidenceRequest,
} from "../../scripts/preview-evidence/request.ts";

const validPageYaml = `schema_version: 1
issue: 4
scope: page
route: /pruebas/guia
expected_status:
  base: 404
  candidate: 200
viewports: [desktop, mobile]
`;

const validSectionYaml = `schema_version: 1
issue: 5
scope: section
route: /autoconsumo-remoto
selector: "[data-evidence-id='beneficios']"
expected_status:
  base: 200
  candidate: 200
viewports:
  - desktop
  - mobile
`;

test("normalizes the closed page request", () => {
  assert.deepEqual(
    parseEvidenceRequest(validPageYaml, "evidence/requests/issue-4.yaml"),
    {
      schemaVersion: 1,
      issue: 4,
      scope: "page",
      route: "/pruebas/guia",
      selector: null,
      expectedStatus: { base: 404, candidate: 200 },
      viewports: ["desktop", "mobile"],
    },
  );
});

test("uses the site's slashless URL convention for evidence routes", () => {
  const slashlessRequest = `schema_version: 1
issue: 4
scope: page
route: /pruebas/guia
expected_status:
  base: 404
  candidate: 200
viewports: [desktop, mobile]
`;

  assert.equal(
    parseEvidenceRequest(slashlessRequest, "evidence/requests/issue-4.yaml")
      .route,
    "/pruebas/guia",
  );
  assert.throws(
    () =>
      parseEvidenceRequest(
        slashlessRequest.replace("/pruebas/guia", "/pruebas/guia/"),
        "evidence/requests/issue-4.yaml",
      ),
    /canónic|route|ruta/i,
  );
});

test("normalizes a section request with one stable selector", () => {
  assert.deepEqual(
    parseEvidenceRequest(validSectionYaml, "evidence/requests/issue-5.yaml"),
    {
      schemaVersion: 1,
      issue: 5,
      scope: "section",
      route: "/autoconsumo-remoto",
      selector: "[data-evidence-id='beneficios']",
      expectedStatus: { base: 200, candidate: 200 },
      viewports: ["desktop", "mobile"],
    },
  );
});

test("accepts only the three stable selector forms", () => {
  for (const selector of [
    "#beneficios",
    ".beneficios",
    "[data-evidence-id='beneficios-remotos']",
  ]) {
    const yaml = validSectionYaml.replace(
      "[data-evidence-id='beneficios']",
      selector,
    );
    assert.equal(
      parseEvidenceRequest(yaml, "evidence/requests/issue-5.yaml").selector,
      selector,
    );
  }
});

test("rejects ambiguous or executable YAML before projection", () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      "duplicate key",
      validPageYaml.replace("issue: 4", "issue: 4\nissue: 4"),
      /yaml|duplicad/i,
    ],
    [
      "alias",
      validPageYaml.replace("issue: 4", "issue: &issue 4\ncopy: *issue"),
      /yaml|alias|campo/i,
    ],
    [
      "custom tag",
      validPageYaml.replace("issue: 4", "issue: !unsafe 4"),
      /yaml|tag/i,
    ],
  ];

  for (const [label, yaml, expected] of cases) {
    assert.throws(
      () => parseEvidenceRequest(yaml, "evidence/requests/issue-4.yaml"),
      expected,
      label,
    );
  }
});

test("rejects every field outside the closed request schema", () => {
  const cases: Array<[string, string]> = [
    ["root", validPageYaml.replace("scope: page", "scope: page\nextra: true")],
    [
      "status",
      validPageYaml.replace(
        "  candidate: 200",
        "  candidate: 200\n  extra: 200",
      ),
    ],
  ];

  for (const [label, yaml] of cases) {
    assert.throws(
      () => parseEvidenceRequest(yaml, "evidence/requests/issue-4.yaml"),
      /campo|schema/i,
      label,
    );
  }
});

test("binds the request issue to its canonical repository path", () => {
  for (const path of [
    "evidence/requests/issue-5.yaml",
    "evidence/requests/issue-04.yaml",
    "requests/issue-4.yaml",
    "evidence/requests/issue-4.yml",
    "evidence/requests/example-page.yaml",
  ]) {
    assert.throws(
      () => parseEvidenceRequest(validPageYaml, path),
      /path|issue/i,
    );
  }
});

test("rejects routes that are not canonical public paths", () => {
  const routes = [
    "https://example.com/pruebas",
    "//example.com/pruebas",
    "/pruebas?draft=1",
    "/pruebas#hero",
    "/pruebas/../socios",
    "/pruebas//guia",
    "/pruebas/guia/",
    "/pruebas/\\guia",
    "/pruebas/%2e%2e/socios",
    "/pruebas/\u0000",
  ];

  for (const route of routes) {
    const yaml = validPageYaml.replace("/pruebas/guia", route);
    assert.throws(
      () => parseEvidenceRequest(yaml, "evidence/requests/issue-4.yaml"),
      /route|ruta|yaml/i,
      route,
    );
  }
});

test("rejects private and API route families", () => {
  for (const route of [
    "/api/quote",
    "/socios",
    "/socios/dashboard",
    "/guia-equipo",
    "/manganafer/interesados",
  ]) {
    const yaml = validPageYaml.replace("/pruebas/guia", route);
    assert.throws(
      () => parseEvidenceRequest(yaml, "evidence/requests/issue-4.yaml"),
      /públic|privad|route|ruta/i,
      route,
    );
  }
});

test("allows only reviewed HTTP status contracts", () => {
  for (const status of [0, 201, 204, 401, 500, 999]) {
    const yaml = validPageYaml.replace("base: 404", `base: ${status}`);
    assert.throws(
      () => parseEvidenceRequest(yaml, "evidence/requests/issue-4.yaml"),
      /status|estado/i,
      String(status),
    );
  }
});

test("requires the canonical viewport tuple", () => {
  const cases = [
    "viewports: [mobile, desktop]",
    "viewports: [desktop]",
    "viewports: [desktop, tablet, mobile]",
    "viewports: desktop",
  ];
  for (const replacement of cases) {
    const yaml = validPageYaml.replace(
      "viewports: [desktop, mobile]",
      replacement,
    );
    assert.throws(
      () => parseEvidenceRequest(yaml, "evidence/requests/issue-4.yaml"),
      /viewport/i,
      replacement,
    );
  }
});

test("keeps selectors exclusive to section requests and bounded", () => {
  assert.throws(
    () =>
      parseEvidenceRequest(
        validPageYaml.replace(
          "expected_status:",
          "selector: '#hero'\nexpected_status:",
        ),
        "evidence/requests/issue-4.yaml",
      ),
    /selector|page/i,
  );

  for (const selector of [
    "",
    "main section",
    "[data-evidence-id=beneficios]",
    "[data-evidence-id='UPPER']",
    `#${"a".repeat(161)}`,
  ]) {
    const yaml = validSectionYaml.replace(
      "[data-evidence-id='beneficios']",
      selector,
    );
    assert.throws(
      () => parseEvidenceRequest(yaml, "evidence/requests/issue-5.yaml"),
      /selector|yaml/i,
      selector,
    );
  }

  assert.throws(
    () =>
      parseEvidenceRequest(
        validSectionYaml.replace(
          "selector: \"[data-evidence-id='beneficios']\"\n",
          "",
        ),
        "evidence/requests/issue-5.yaml",
      ),
    /selector/i,
  );
});

test("loads only a regular request below the declared root", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-request-"));
  try {
    const requestDirectory = join(root, "evidence", "requests");
    await mkdir(requestDirectory, { recursive: true });
    const requestPath = join(requestDirectory, "issue-4.yaml");
    await writeFile(requestPath, validPageYaml, "utf8");

    assert.equal(
      (await loadEvidenceRequest("evidence/requests/issue-4.yaml", root)).issue,
      4,
    );

    const linkedPath = join(requestDirectory, "issue-5.yaml");
    await symlink(requestPath, linkedPath);
    await assert.rejects(
      loadEvidenceRequest("evidence/requests/issue-5.yaml", root),
      /regular|symlink/i,
    );
    await assert.rejects(
      loadEvidenceRequest("../issue-4.yaml", root),
      /path|ruta/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provides hand-checked canonical hashes and viewport dimensions", () => {
  assert.equal(canonicalJson({ b: 2, a: [3, 1] }), '{"a":[3,1],"b":2}');
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.deepEqual(EVIDENCE_VIEWPORTS, [
    { name: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1 },
    { name: "mobile", width: 390, height: 844, deviceScaleFactor: 1 },
  ]);
});
