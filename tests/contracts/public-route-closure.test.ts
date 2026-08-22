import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { blogPosts } from "../../src/content/blog-data.ts";
import { communityPages } from "../../src/content/community-data.ts";
import { remoteProjects } from "../../src/content/remote-project-data.ts";
import {
  PHASE3_DEFERRED_PUBLIC_ROUTES,
  isPhase3DeferredPublicRoute,
  isPhase2PublicRoute,
  requireExactPhase3DeferredPublicRoutes,
} from "../../src/lib/site/public-route-closure.ts";
import { buildRobotsPolicy } from "../../src/lib/site/robots.ts";
import {
  buildSitemap,
  coreSitemapRoutes,
  isGeneratedSitemapMetadata,
} from "../../src/lib/site/sitemap.ts";
import {
  pageRegistry,
  staticSlugPaths,
} from "../../src/lib/site/page-registry.ts";
import {
  auditInternalLinks,
  createLinkWorkerRuntime,
  startLinkWorkerRuntime,
  verifyInternalLinks,
} from "../../scripts/verify-links.ts";
import type { RouteMatrixEntry } from "../../scripts/lib/route-inventory.ts";

const fixedNow = new Date("2026-08-21T00:00:00.000Z");

function matrixEntry(path: string, status = "verified"): RouteMatrixEntry {
  return {
    path,
    kind: "page",
    sourceFile: "fixture.ts",
    fixtureId: null,
    expectedStatus: 200,
    expectedLocation: null,
    privateArea: null,
    visualTemplate: "fixture",
    status,
  };
}

test("declares the exact Phase 3 deferred public route with owner and reason", () => {
  assert.deepEqual(PHASE3_DEFERRED_PUBLIC_ROUTES, [
    {
      path: "/comunidades-energeticas/manganafer",
      owner: "Phase 3",
      reason:
        "La landing Manganáfer y sus islas de formulario dependen de sus APIs de servidor.",
    },
  ]);
  assert.equal(
    isPhase3DeferredPublicRoute("/comunidades-energeticas/manganafer"),
    true,
  );
  assert.equal(isPhase3DeferredPublicRoute("/comunidades-energeticas"), false);
  assert.equal(isPhase2PublicRoute(matrixEntry("/asset.png")), true);
  assert.equal(
    isPhase2PublicRoute({ ...matrixEntry("/moved"), kind: "redirect" }),
    true,
  );
  assert.equal(
    isPhase2PublicRoute({ ...matrixEntry("/gone"), kind: "gone" }),
    true,
  );
  assert.equal(
    isPhase2PublicRoute({ ...matrixEntry("/api"), kind: "api" }),
    false,
  );
  assert.equal(
    isPhase2PublicRoute({ ...matrixEntry("/socios"), kind: "private-page" }),
    false,
  );
});

test("requires each frozen sitemap consumer to enumerate exactly the declared Phase 3 deferment", () => {
  assert.doesNotThrow(() =>
    requireExactPhase3DeferredPublicRoutes(
      [
        "/comunidades-energeticas/villaverde-getafe",
        "/comunidades-energeticas/manganafer",
      ],
      "fixture sitemap",
    ),
  );
  assert.throws(
    () =>
      requireExactPhase3DeferredPublicRoutes(
        ["/comunidades-energeticas/villaverde-getafe"],
        "fixture sitemap",
      ),
    /fixture sitemap.*manganafer/,
  );
});

test("materializes every core slug including the four legal documents", () => {
  assert.equal(staticSlugPaths.length, 18);
  assert.equal(new Set(staticSlugPaths).size, 18);
  assert.deepEqual(
    staticSlugPaths.filter((slug) =>
      [
        "politica-privacidad",
        "cookies",
        "aviso-legal",
        "terminos-y-condiciones",
      ].includes(slug),
    ),
    ["aviso-legal", "cookies", "politica-privacidad", "terminos-y-condiciones"],
  );
  for (const key of ["privacy", "cookies", "legal", "terms"] as const) {
    assert.equal(
      staticSlugPaths.includes(pageRegistry[key].path.slice(1)),
      true,
    );
  }
});

test("builds the deterministic source sitemap exactly once per indexable route", () => {
  const entries = buildSitemap(fixedNow);
  const urls = entries.map((entry) => entry.url);

  assert.deepEqual(coreSitemapRoutes, [
    "",
    "/nosotros",
    "/comunidades-energeticas",
    "/comunidades-energeticas/manganafer",
    "/autoconsumo-remoto",
    "/autoconsumo-en-mi-tejado",
    "/baterias",
    "/aerotermia",
    "/rentabiliza-tu-activo",
    "/comunidades-energeticas-operativas",
    "/comercializadora-y-tarifas",
    "/mantenimiento",
    "/soy-comunero",
    "/contacto",
    "/blog",
    "/eventos",
  ]);
  assert.equal(entries.length, 16 + 21 + 3 + 19);
  assert.equal(new Set(urls).size, entries.length);
  assert.deepEqual(
    entries.map((entry) => ({
      ...entry,
      lastModified: entry.lastModified.toISOString(),
    })),
    buildSitemap(new Date(fixedNow)).map((entry) => ({
      ...entry,
      lastModified: entry.lastModified.toISOString(),
    })),
  );
  assert.equal(
    urls.includes(
      "https://comunidadsolar.es/comunidades-energeticas/manganafer",
    ),
    true,
  );

  for (const community of communityPages) {
    assert.equal(
      urls.includes(
        `https://comunidadsolar.es/comunidades-energeticas/${community.slug}`,
      ),
      true,
    );
  }
  for (const project of remoteProjects) {
    assert.equal(
      urls.includes(
        `https://comunidadsolar.es/autoconsumo-remoto/${project.slug}`,
      ),
      true,
    );
  }
  for (const post of blogPosts) {
    assert.equal(
      urls.includes(`https://comunidadsolar.es/blog/${post.slug}`),
      true,
    );
  }
});

test("accepts only origin-local, indexable generated sitemap metadata", () => {
  const publicMetadata = {
    path: "/actualidad/solar",
    lastModified: "2026-08-21T00:00:00.000Z",
    changeFrequency: "monthly",
    priority: 0.6,
    privacy: { private: false },
    seo: { index: true },
  } as const;
  assert.equal(isGeneratedSitemapMetadata(publicMetadata), true);
  for (const path of [
    "//evil.test/escape",
    "/actualidad?campaign=outside",
    "/actualidad#fragment",
    "/actualidad\u0000unsafe",
    "/actualidad\u001funsafe",
    "/actualidad\u007funsafe",
    "/actualidad%00unsafe",
  ]) {
    assert.equal(
      isGeneratedSitemapMetadata({ ...publicMetadata, path }),
      false,
    );
  }
  assert.equal(
    isGeneratedSitemapMetadata({
      ...publicMetadata,
      privacy: { private: "yes" },
    }),
    false,
  );
  assert.equal(
    isGeneratedSitemapMetadata({ ...publicMetadata, seo: { index: "yes" } }),
    false,
  );

  const urls = buildSitemap(fixedNow, [
    publicMetadata,
    { ...publicMetadata, path: "/privada", privacy: { private: true } },
    { ...publicMetadata, path: "/noindex", seo: { index: false } },
  ]).map((entry) => entry.url);
  assert.equal(
    urls.includes("https://comunidadsolar.es/actualidad/solar"),
    true,
  );
  assert.equal(urls.includes("https://comunidadsolar.es/privada"), false);
  assert.equal(urls.includes("https://comunidadsolar.es/noindex"), false);
});

test("keeps all Phase 2 public pages verified while retaining the declared Phase 3 deferment", async () => {
  const matrix = JSON.parse(
    await readFile(join(process.cwd(), "parity/route-matrix.json"), "utf8"),
  ) as RouteMatrixEntry[];
  const unresolved = matrix.filter(
    (entry) => isPhase2PublicRoute(entry) && entry.status !== "verified",
  );

  assert.deepEqual(unresolved, []);
});

test("resolves links, accepts manifest redirects and gone routes, and reports only the declared Phase 3 deferment", async () => {
  const routes = [
    matrixEntry("/"),
    matrixEntry("/ready"),
    { ...matrixEntry("/moved"), kind: "redirect", expectedStatus: 308 },
    { ...matrixEntry("/gone"), kind: "gone", expectedStatus: 410 },
    matrixEntry("/comunidades-energeticas/manganafer", "pending"),
  ] as RouteMatrixEntry[];
  const documents = [
    {
      path: "/",
      html: [
        '<main id="home">',
        '<a href="/ready#details">Lista</a>',
        '<a href="/moved">Trasladado</a>',
        '<a href="/gone">Retirado</a>',
        '<a href="/comunidades-energeticas/manganafer">Manganáfer</a>',
        '<a href="#home">Inicio</a>',
        '<a href="//external.example.test/not-a-local-link">Externo</a>',
        "</main>",
      ].join(""),
    },
    { path: "/ready", html: '<main id="details">Lista</main>' },
  ];
  const fetched: string[] = [];
  const fetchPath = async (path: string) => {
    fetched.push(path);
    if (path === "/ready")
      return new Response('<main id="details">Lista</main>');
    if (path === "/moved") return new Response(null, { status: 308 });
    if (path === "/gone") return new Response(null, { status: 410 });
    if (path === "/comunidades-energeticas/manganafer") {
      return new Response("Not Found", { status: 404 });
    }
    return new Response("Not Found", { status: 404 });
  };

  const report = await auditInternalLinks({ documents, routes, fetchPath });

  assert.deepEqual(report.violations, []);
  assert.deepEqual(fetched, ["/ready", "/moved", "/gone"]);
  assert.deepEqual(report.deferred, [
    {
      sourcePath: "/",
      targetPath: "/comunidades-energeticas/manganafer",
      owner: "Phase 3",
      reason:
        "La landing Manganáfer y sus islas de formulario dependen de sus APIs de servidor.",
    },
  ]);
  assert.deepEqual(
    await verifyInternalLinks({ documents, routes, fetchPath }),
    [],
  );
});

test("resolves relative and same-origin absolute links without treating protocol-relative hosts as local", async () => {
  const routes = [
    matrixEntry("/docs/page"),
    matrixEntry("/docs/child"),
    matrixEntry("/ready"),
  ];
  const documents = [
    {
      path: "/docs/page",
      html: [
        '<a href="./child#details">Relativa</a>',
        '<a href="../ready#main">Padre</a>',
        '<a href="https://comunidadsolar.es/ready#main">Absoluta</a>',
        '<a href="//external.example.test/not-local">Externa</a>',
      ].join(""),
    },
    { path: "/docs/child", html: '<main id="details">Ficha</main>' },
    { path: "/ready", html: '<main id="main">Lista</main>' },
  ];
  const fetched: string[] = [];
  const report = await auditInternalLinks({
    documents,
    routes,
    fetchPath: async (path) => {
      fetched.push(path);
      if (path === "/docs/child") {
        return new Response('<main id="details">Ficha</main>');
      }
      if (path === "/ready")
        return new Response('<main id="main">Lista</main>');
      return new Response("Not Found", { status: 404 });
    },
  });

  assert.equal(report.checkedLinks, 3);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(fetched, ["/docs/child", "/ready"]);
});

test("bounds hung link-worker readiness and completes raw teardown before returning", async () => {
  const events: string[] = [];
  await assert.rejects(
    createLinkWorkerRuntime(
      {
        ready: new Promise<void>(() => undefined),
        fetch: async () => new Response("unused"),
        dispose: async () => {
          events.push("dispose");
          await new Promise<void>(() => undefined);
        },
        raw: {
          teardown: async () => {
            events.push("raw-teardown");
          },
        },
      },
      30,
    ),
    /esperar el Worker de enlaces listo/,
  );
  assert.deepEqual(events, ["dispose", "raw-teardown"]);
});

test("bounds link-worker startup and cleans a worker that resolves after its deadline", async () => {
  let resolveWorker!: (
    worker: Parameters<typeof createLinkWorkerRuntime>[0],
  ) => void;
  const pendingWorker = new Promise<
    Parameters<typeof createLinkWorkerRuntime>[0]
  >((resolve) => {
    resolveWorker = resolve;
  });
  let resolveCleanup!: () => void;
  const cleaned = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });

  await assert.rejects(
    startLinkWorkerRuntime(() => pendingWorker, 30),
    /iniciar el Worker de enlaces/,
  );
  resolveWorker({
    ready: Promise.resolve(),
    fetch: async () => new Response("unused"),
    dispose: async () => {
      resolveCleanup();
    },
    raw: { teardown: async () => {} },
  });
  await cleaned;
});

test("bounds link fetches and finishes Worker cleanup before reporting the timeout", async () => {
  const events: string[] = [];
  await assert.rejects(
    auditInternalLinks({
      routes: [matrixEntry("/"), matrixEntry("/ready")],
      documents: [
        {
          path: "/",
          html: '<a href="/ready">Lista</a>',
        },
      ],
      lifecycleTimeoutMs: 30,
      startWorker: async () => ({
        ready: Promise.resolve(),
        fetch: async () => {
          events.push("fetch");
          return new Promise<Response>(() => undefined);
        },
        dispose: async () => {
          events.push("dispose");
        },
        raw: {
          teardown: async () => {
            events.push("raw-teardown");
          },
        },
      }),
    }),
    /resolver el enlace/,
  );
  assert.deepEqual(events, ["fetch", "dispose"]);
});

test("reports missing fragments and statuses that diverge from the route manifest", async () => {
  const routes = [
    matrixEntry("/"),
    matrixEntry("/ready"),
    matrixEntry("/wrong"),
  ];
  const report = await auditInternalLinks({
    routes,
    documents: [
      {
        path: "/",
        html: '<a href="/ready#missing">Ancla rota</a><a href="/wrong">Ruta rota</a>',
      },
      { path: "/ready", html: '<main id="present">Contenido</main>' },
    ],
    fetchPath: async (path) =>
      path === "/ready"
        ? new Response('<main id="present">Contenido</main>')
        : new Response("Not Found", { status: 404 }),
  });

  assert.deepEqual(report.deferred, []);
  assert.deepEqual(report.violations, [
    {
      sourcePath: "/",
      targetPath: "/ready#missing",
      reason: "fragment-missing",
    },
    {
      sourcePath: "/",
      targetPath: "/wrong",
      reason: "status-mismatch",
      expectedStatus: 200,
      actualStatus: 404,
    },
  ]);
});

test("builds the source robots policy exactly in both indexability modes", () => {
  assert.equal(
    buildRobotsPolicy(false),
    [
      "User-Agent: *",
      "Disallow: /",
      "",
      "Sitemap: https://comunidadsolar.es/sitemap.xml",
      "Host: https://comunidadsolar.es",
      "",
    ].join("\n"),
  );
  assert.equal(
    buildRobotsPolicy(true),
    [
      "User-Agent: *",
      "Allow: /",
      "Disallow: /socios",
      "Disallow: /guia-equipo",
      "Disallow: /guia-equipo-nueva-web-comunidad-solar.md",
      "Disallow: /manganafer",
      "",
      "Sitemap: https://comunidadsolar.es/sitemap.xml",
      "Host: https://comunidadsolar.es",
      "",
    ].join("\n"),
  );
});

test("exposes the deterministic link-closure gate", async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    packageJson.scripts?.["verify:links"],
    "tsx scripts/verify-links.ts",
  );
});
