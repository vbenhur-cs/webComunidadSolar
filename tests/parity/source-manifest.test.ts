import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { SourceRef } from "../../scripts/lib/source-reference.ts";
import {
  appFileToRoute,
  buildSourceManifest,
  type SourceManifest,
  type SourceRepository,
  writeSourceManifest,
} from "../../scripts/lib/route-inventory.ts";

const sourceRef: SourceRef = {
  repository: "../comunidadsolarweb",
  branch: "main",
  commit: "68ea294c54dc5e15e20f470fc421a239927565a8",
};

const temporaryRoots: string[] = [];

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

function createMemorySourceFixture(): SourceRepository {
  const genericSlugs = [
    "nosotros",
    "autoconsumo-remoto",
    "comunidades-energeticas",
    "autoconsumo-en-mi-tejado",
    "baterias",
    "aerotermia",
    "rentabiliza-tu-activo",
    "comunidades-energeticas-operativas",
    "blog",
    "eventos",
    "soy-comunero",
    "contacto",
    "comercializadora-y-tarifas",
    "mantenimiento",
    "politica-privacidad",
    "cookies",
    "aviso-legal",
    "terminos-y-condiciones",
  ];
  const pages = genericSlugs
    .map((slug) => `  ${JSON.stringify(slug)}: { key: ${JSON.stringify(slug)} },`)
    .join("\n");
  const preservedWordPressPaths = [
    "/",
    "/preservada",
    ...Array.from({ length: 117 }, (_, index) => `/preservada-${index + 1}`),
  ];
  const wordpressPaths = [
    "/anterior",
    "/retirada",
    "/pendiente",
    ...preservedWordPressPaths,
  ];
  const files: Record<string, string> = {
    "app/[slug]/page.tsx": `
      const pages: Record<string, { key: string }> = {
      ${pages}
      };
    `,
    "app/api/manganafer-interest/export/route.ts": "export function GET() {}",
    "app/api/manganafer-interest/route.ts": "export function POST() {}",
    "app/api/manganafer-quote/route.ts": "export function POST() {}",
    "app/autoconsumo-remoto/[project]/page.tsx": "export default null;",
    "app/blog-data.ts": `
      export const blogPosts = [{ slug: "primer-post" }] as const;
    `,
    "app/blog/[post]/page.tsx": "export default null;",
    "app/community-data.ts": `
      export const communityPages = [{ slug: "comunidad-de-prueba" }] as const;
    `,
    "app/comunidades-energeticas/[community]/page.tsx": "export default null;",
    "app/comunidades-energeticas/manganafer/page.tsx": "export default null;",
    "app/guia-equipo-nueva-web-comunidad-solar.md/route.ts":
      "export function GET() {}",
    "app/guia-equipo/page.tsx": "export default null;",
    "app/legacy-routes.ts": `
      export const legacyRedirects = [{ from: "/anterior", to: "/nuevo" }] as const;
      export const legacyGonePaths = ["/retirada"] as const;
      export const legacyRoutesPendingDecision = [{ path: "/pendiente" }] as const;
      export const legacyPreservedPaths = ${JSON.stringify(preservedWordPressPaths)} as const;
      export const legacyWordPressSitemapPaths = ${JSON.stringify(wordpressPaths)} as const;
    `,
    "app/manganafer/interesados/page.tsx": "export default null;",
    "app/page.tsx": "export default null;",
    "app/robots.ts": "export default function robots() { return {}; }",
    "app/sitemap.ts": "export default function sitemap() { return []; }",
    "app/socios/page.tsx": "export default null;",
    "app/subvenciones/route.ts": "export function GET() {}",
    "app/remote-project-data.ts": `
      export const remoteProjects = [{ slug: "proyecto-remoto" }] as const;
    `,
    "public/logo.svg": "<svg>logo</svg>",
    "public/media/card.webp": "webp-bytes",
  };

  return {
    async assertPristine() {
      return sourceRef;
    },
    async listFiles() {
      return Object.keys(files).reverse();
    },
    async readBlob(path) {
      const file = files[path];
      if (file === undefined) throw new Error(`Missing memory blob: ${path}`);
      return Buffer.from(file);
    },
  };
}

async function readSourceManifest(path: string): Promise<SourceManifest> {
  return JSON.parse(await readFile(path, "utf8")) as SourceManifest;
}

test("the frozen manifest inventories every known route family", async () => {
  const manifest = await readSourceManifest("parity/source-manifest.json");
  const byKind = Object.groupBy(manifest.routes, (route) => route.kind);

  assert.equal(byKind.redirect?.length, 103);
  assert.equal(byKind.gone?.length, 19);
  assert.equal(
    manifest.routes.filter((route) => route.visualTemplate === "community-detail")
      .length,
    21,
  );
  assert.equal(
    manifest.routes.filter((route) => route.visualTemplate === "blog-detail")
      .length,
    19,
  );
  assert.equal(
    manifest.routes.filter((route) => route.visualTemplate === "remote-detail")
      .length,
    3,
  );
  assert.equal(
    new Set(manifest.routes.map((route) => `${route.kind}:${route.path}`)).size,
    manifest.routes.length,
  );
});

test("accounts for all 122 audited WordPress paths", async () => {
  const manifest = await readSourceManifest("parity/source-manifest.json");

  assert.equal(manifest.wordpressAudit.total, 122);
  assert.deepEqual(manifest.wordpressAudit.unclassified, []);
});

test("builds the same source manifest from an injected memory source", async () => {
  const source = createMemorySourceFixture();
  const options = { source, generatedAt: "2026-08-21T00:00:00.000Z" };
  const manifest = await buildSourceManifest(options);

  assert.deepEqual(manifest, await buildSourceManifest(options));
  assert.deepEqual(manifest.source, sourceRef);
  assert.deepEqual(
    manifest.routes
      .filter((route) => route.sourceFile === "app/[slug]/page.tsx")
      .map((route) => route.path),
    [
      "/aerotermia",
      "/autoconsumo-en-mi-tejado",
      "/autoconsumo-remoto",
      "/aviso-legal",
      "/baterias",
      "/blog",
      "/comercializadora-y-tarifas",
      "/comunidades-energeticas",
      "/comunidades-energeticas-operativas",
      "/contacto",
      "/cookies",
      "/eventos",
      "/mantenimiento",
      "/nosotros",
      "/politica-privacidad",
      "/rentabiliza-tu-activo",
      "/soy-comunero",
      "/terminos-y-condiciones",
    ],
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.path === "/anterior"),
    {
      path: "/anterior",
      kind: "redirect",
      sourceFile: "app/legacy-routes.ts",
      fixtureId: null,
      expectedStatus: 308,
      expectedLocation: "/nuevo",
      privateArea: null,
      visualTemplate: null,
    },
  );
  assert.deepEqual(
    manifest.assets.find((asset) => asset.path === "public/logo.svg"),
    {
      path: "public/logo.svg",
      sha256: "54e453435420c5897976760c98a79083ca79a9af46c8abc9f4dd5097d5e59d80",
      bytes: 15,
    },
  );
  assert.deepEqual(manifest.wordpressAudit, { total: 122, unclassified: [] });
});

test("maps Next app entries to their route patterns", () => {
  assert.equal(appFileToRoute("app/page.tsx"), "/");
  assert.equal(
    appFileToRoute("app/api/manganafer-interest/route.ts"),
    "/api/manganafer-interest",
  );
});

test("preserves prior route-matrix entries while adding new contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-manifest-matrix-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "parity"), { recursive: true });
  await writeFile(
    join(root, "parity", "route-matrix.json"),
    `${JSON.stringify([
      {
        path: "/historica",
        kind: "page",
        sourceFile: "app/historica/page.tsx",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: null,
        visualTemplate: "generic-page",
        status: "verified",
      },
    ])}\n`,
  );

  await writeSourceManifest(
    await buildSourceManifest({
      source: createMemorySourceFixture(),
      generatedAt: "2026-08-21T00:00:00.000Z",
    }),
    { root },
  );

  const matrix = JSON.parse(
    await readFile(join(root, "parity", "route-matrix.json"), "utf8"),
  ) as Array<{ path: string; status: string }>;
  assert.equal(matrix.find((entry) => entry.path === "/historica")?.status, "verified");
  assert.equal(matrix.find((entry) => entry.path === "/anterior")?.status, "pending");
});
