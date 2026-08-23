import assert from "node:assert/strict";
import test from "node:test";

import {
  hydrateTeamGuideMarkdown,
  teamGuideDownloadPath,
} from "../../src/lib/guide/runtime.ts";
import {
  parseGuideInline,
  parseGuideMarkdown,
  teamGuideMarkdownResponse,
} from "../../src/lib/guide/markdown.ts";

const allowedIdentity = {
  displayName: "Equipo Solar",
  email: "equipo@comunidadsolar.es",
  fullName: "Equipo Solar",
};

test("hydrates every published team-guide route-count token", () => {
  const output = hydrateTeamGuideMarkdown(
    "{{BASE_PAGE_COUNT}}/{{COMMUNITY_PAGE_COUNT}}/{{REMOTE_PROJECT_COUNT}}/{{BLOG_STORY_COUNT}}/{{TOTAL_CONTENT_ROUTES}}",
  );

  assert.equal(output, "21/21/3/19/64");
});

test("parses guide blocks from the first section without flattening tables or fences", () => {
  const blocks = parseGuideMarkdown(`
# Omitido del documento

## 1. Acción & Sol
Párrafo **fuerte** con \`código\`.

> Primera línea
> Segunda línea

- Uno
- Dos

1. Primero
2. Segundo

| Columna A | Columna B |
| --- | --- |
| Valor A | Valor B |

\`\`\`ts
const value = 1;
\`\`\`

---
`);

  assert.deepEqual(blocks, [
    {
      kind: "heading",
      level: 2,
      text: "1. Acción & Sol",
      id: "1-accion-sol",
    },
    { kind: "paragraph", text: "Párrafo **fuerte** con `código`." },
    { kind: "quote", text: "Primera línea Segunda línea" },
    { kind: "list", ordered: false, items: ["Uno", "Dos"] },
    { kind: "list", ordered: true, items: ["Primero", "Segundo"] },
    {
      kind: "table",
      headers: ["Columna A", "Columna B"],
      rows: [["Valor A", "Valor B"]],
    },
    { kind: "code", language: "ts", value: "const value = 1;" },
    { kind: "rule" },
  ]);
});

test("preserves the guide inline emphasis, code, and link boundaries", () => {
  assert.deepEqual(
    parseGuideInline(
      "Texto **fuerte** con `código` y [externo](https://example.test/docs).",
    ),
    [
      { kind: "text", value: "Texto " },
      { kind: "strong", value: "fuerte" },
      { kind: "text", value: " con " },
      { kind: "code", value: "código" },
      { kind: "text", value: " y " },
      {
        kind: "link",
        value: "externo",
        href: "https://example.test/docs",
        external: true,
      },
      { kind: "text", value: "." },
    ],
  );
});

test("redirects an anonymous team-guide download to the reserved sign-in route", () => {
  const response = teamGuideMarkdownResponse({
    request: new Request(
      `https://private.example.test${teamGuideDownloadPath}`,
    ),
    identity: null,
    env: {},
    source: "Counts: {{TOTAL_CONTENT_ROUTES}}",
  });

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    `https://private.example.test/signin-with-chatgpt?return_to=${encodeURIComponent(teamGuideDownloadPath)}`,
  );
});

test("fails closed for unconfigured and denied team-guide downloads", () => {
  for (const env of [{}, { TEAM_ALLOWED_EMAILS: "other@comunidadsolar.es" }]) {
    const response = teamGuideMarkdownResponse({
      request: new Request(
        `https://private.example.test${teamGuideDownloadPath}`,
      ),
      identity: allowedIdentity,
      env,
      source: "Counts: {{TOTAL_CONTENT_ROUTES}}",
    });

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(
      response.headers.get("x-robots-tag"),
      "noindex, nofollow, noarchive",
    );
    assert.equal(
      response.headers.get("content-type"),
      "text/plain;charset=UTF-8",
    );
  }
});

test("returns a private nosniff Markdown attachment only to an allowed team identity", async () => {
  const response = teamGuideMarkdownResponse({
    request: new Request(
      `https://private.example.test${teamGuideDownloadPath}`,
    ),
    identity: allowedIdentity,
    env: { TEAM_ALLOWED_EMAILS: "equipo@comunidadsolar.es" },
    source: "Counts: {{TOTAL_CONTENT_ROUTES}}",
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/markdown; charset=utf-8",
  );
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="guia-equipo-nueva-web-comunidad-solar.md"',
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
  assert.equal(await response.text(), "Counts: 64");
});
