import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  link,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importPage } from "../../src/ingest/importers/page.ts";
import {
  maxCompressedArchiveBytes,
  maxGeneralFileBytes,
  maxImageFileBytes,
  validateSuppliedPackagePaths,
} from "../../src/ingest/importers/archive.ts";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/ingestion/${name}`, import.meta.url));

async function withTemporaryArtifactRoot<T>(
  callback: (artifactRoot: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-page-artifacts-"));
  try {
    return await callback(join(root, "artifacts"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const metadata = [
  "changeId: pagina-importada-prueba",
  "intent: Validar una página aportada sin ejecutar su contenido",
  "targetPath: /pagina-importada-prueba",
  "acceptanceCriteria:",
  "  - La página se conserva como datos inertes",
].join("\n");

const forbiddenMetadataJson = [
  "{",
  '  "changeId": "pagina-importada-prueba",',
  '  "intent": "Validar una página aportada sin ejecutar su contenido",',
  '  "targetPath": "/pagina-importada-prueba",',
  '  "acceptanceCriteria": ["La página se conserva como datos inertes"],',
  '  "__proto__": "forbidden"',
  "}",
].join("\n");

async function withTemporaryPackage<T>(
  callback: (root: string, artifactRoot: string) => Promise<T>,
): Promise<T> {
  const workspace = await mkdtemp(
    join(tmpdir(), "comunidadsolar-page-package-"),
  );
  const root = join(workspace, "input");
  await mkdir(root);
  try {
    return await callback(root, join(workspace, "artifacts"));
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function assertNoPublishedRawArtifacts(
  artifactRoot: string,
): Promise<void> {
  await assert.rejects(readdir(join(artifactRoot, "intake")), {
    code: "ENOENT",
  });
}

test("extracts body structure and assets without running supplied scripts", async () => {
  delete (globalThis as { __suppliedPageExecuted?: boolean })
    .__suppliedPageExecuted;
  const result = await withTemporaryArtifactRoot((artifactRoot) =>
    importPage(fixture("supplied-page"), fixture("page-meta.yaml"), {
      artifactRoot,
    }),
  );

  assert.equal(result.inputKind, "page");
  assert.match(result.content, /<main/u);
  assert.doesNotMatch(
    result.content,
    /<script|<object|<embed|onload=|onclick=/iu,
  );
  assert.equal(result.assets.length, 2);
  assert.deepEqual(result.assets.map((asset) => asset.mediaType).sort(), [
    "image/svg+xml",
    "text/css",
  ]);
  assert.equal(
    (globalThis as { __suppliedPageExecuted?: boolean }).__suppliedPageExecuted,
    undefined,
  );
});

for (const name of [
  "archives/zip-slip.zip",
  "archives/symlink.zip",
  "archives/too-many-files.zip",
  "archives/executable.zip",
  "archives/secret.zip",
]) {
  test(`rejects hostile package ${name}`, async () => {
    await withTemporaryArtifactRoot((artifactRoot) =>
      assert.rejects(
        importPage(fixture(name), undefined, { artifactRoot }),
        /paquete rechazado/i,
      ),
    );
  });
}

for (const [name, message] of [
  ["archives/absolute-path.zip", /paquete rechazado/i],
  ["archives/nul-path.zip", /paquete rechazado/i],
  ["archives/empty-path.zip", /paquete rechazado/i],
  ["archives/case-collision.zip", /rutas que colisionan/i],
  ["archives/nfc-collision.zip", /rutas que colisionan/i],
  ["archives/dotfile.zip", /paquete rechazado|metadatos|ocult/i],
  ["archives/node-modules.zip", /ruta.*segura/i],
] as const) {
  test(`rejects invalid package path ${name}`, async () => {
    await withTemporaryArtifactRoot((artifactRoot) =>
      assert.rejects(
        importPage(fixture(name), undefined, { artifactRoot }),
        message,
      ),
    );
  });
}

test("rejects case-folded and NFC-equivalent directory components before folder traversal", () => {
  assert.throws(
    () => validateSuppliedPackagePaths(["Foo/a.css", "foo/b.css"]),
    /rutas que colisionan/i,
  );
  assert.throws(
    () => validateSuppliedPackagePaths(["cafe\u0301/a.css", "café/b.css"]),
    /rutas que colisionan/i,
  );
  assert.throws(
    () => validateSuppliedPackagePaths(["Straße/a.css", "STRASSE/b.css"]),
    /rutas que colisionan/i,
  );
  assert.throws(
    () => validateSuppliedPackagePaths(["Σ/a.css", "ς/b.css"]),
    /rutas que colisionan/i,
  );
  assert.throws(
    () => validateSuppliedPackagePaths(["İ/a.css", "i\u0307/b.css"]),
    /rutas que colisionan/i,
  );
});

test("keeps distinct accented siblings distinct under caseless matching", () => {
  assert.deepEqual(validateSuppliedPackagePaths(["energía.css", "niñez.css"]), [
    "energía.css",
    "niñez.css",
  ]);
  assert.deepEqual(validateSuppliedPackagePaths(["ı.css", "I.css"]), [
    "ı.css",
    "I.css",
  ]);
});

test("counts ZIP directory entries toward the 500-entry ceiling", async () => {
  await withTemporaryArtifactRoot((artifactRoot) =>
    assert.rejects(
      importPage(fixture("archives/too-many-directories.zip"), undefined, {
        artifactRoot,
      }),
      /supera 500 entradas/i,
    ),
  );
});

for (const [name, message] of [
  ["archives/encrypted.zip", /cifrad/i],
  ["archives/special-unix-entry.zip", /especial/i],
  ["archives/declared-size-mismatch.zip", /tamaño declarado/i],
] as const) {
  test(`rejects ${name} before it can become raw data`, async () => {
    await withTemporaryArtifactRoot((artifactRoot) =>
      assert.rejects(
        importPage(fixture(name), undefined, { artifactRoot }),
        message,
      ),
    );
  });
}

test("rejects a supplied secret assignment before creating raw artifacts", async () => {
  await withTemporaryArtifactRoot((artifactRoot) =>
    assert.rejects(
      importPage(fixture("archives/secret-assignment.zip"), undefined, {
        artifactRoot,
      }),
      /secreto|token/i,
    ),
  );
});

for (const [name, assignment, secretBody] of [
  [
    "double-quoted API key",
    'const API_KEY = "fixture-quoted-value";',
    "fixture-quoted-value",
  ],
  [
    "single-quoted password",
    "const password = 'fixture-password-value';",
    "fixture-password-value",
  ],
] as const) {
  test(`rejects a ${name} without exposing its value`, async () => {
    await withTemporaryPackage(async (root, artifactRoot) => {
      await writeFile(join(root, "page.tsx"), assignment, "utf8");
      const metadataPath = join(dirname(root), "metadata.yaml");
      await writeFile(
        metadataPath,
        `${metadata}\nentrypoint: page.tsx\n`,
        "utf8",
      );

      await assert.rejects(
        importPage(root, metadataPath, { artifactRoot }),
        (error: unknown) => {
          assert.match(String(error), /secreto|token/i);
          assert.equal(String(error).includes(secretBody), false);
          return true;
        },
      );
      await assertNoPublishedRawArtifacts(artifactRoot);
    });
  });
}

test("rejects a secret in raw ZIP container metadata before raw publication", async () => {
  await withTemporaryArtifactRoot(async (artifactRoot) => {
    await assert.rejects(
      importPage(
        fixture("archives/archive-comment-secret.zip"),
        fixture("page-meta.yaml"),
        { artifactRoot },
      ),
      /secreto|token/i,
    );
    await assertNoPublishedRawArtifacts(artifactRoot);
  });
});

test("rejects a secret in externally supplied page metadata", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\naudience: API_KEY=fixture-only-value\n`,
      "utf8",
    );

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /secreto|token/i,
    );
    await assertNoPublishedRawArtifacts(artifactRoot);
  });
});

test("does not mistake an equal-byte local asset for external metadata", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
    await writeFile(join(root, "styles.css"), metadata, "utf8");
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.deepEqual(
      result.assets.map((asset) => asset.path),
      ["styles.css"],
    );
  });
});

test("rejects a synthetic sk-prefix in metadata and a signed binary asset without exposing it", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    const token = `sk-${"a".repeat(24)}`;
    await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, `${metadata}\naudience: ${token}\n`, "utf8");
    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      (error: unknown) => {
        assert.match(String(error), /secreto|token/i);
        assert.equal(String(error).includes(token), false);
        return true;
      },
    );
    await assertNoPublishedRawArtifacts(artifactRoot);

    await writeFile(metadataPath, metadata, "utf8");
    await writeFile(
      join(root, "solar.png"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(token, "ascii"),
      ]),
    );
    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      (error: unknown) => {
        assert.match(String(error), /secreto|token/i);
        assert.equal(String(error).includes(token), false);
        return true;
      },
    );
    await assertNoPublishedRawArtifacts(artifactRoot);
  });
});

for (const placement of ["external", "incorporated"] as const) {
  test(`rejects an own forbidden metadata key when it is ${placement}`, async () => {
    await withTemporaryPackage(async (root, artifactRoot) => {
      await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
      const metadataPath =
        placement === "external"
          ? join(dirname(root), "metadata.json")
          : join(root, "page-meta.json");
      await writeFile(metadataPath, forbiddenMetadataJson, "utf8");

      await assert.rejects(
        importPage(root, placement === "external" ? metadataPath : undefined, {
          artifactRoot,
        }),
        /schema.*additional|solicitud|propiedades|property/i,
      );
      await assertNoPublishedRawArtifacts(artifactRoot);
    });
  });
}

test("enforces compressed, general-file, and image-file package limits before raw publication", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    const archivePath = join(dirname(root), "too-large.zip");
    await writeFile(archivePath, "not read", "utf8");
    await truncate(archivePath, maxCompressedArchiveBytes + 1);
    await assert.rejects(
      importPage(archivePath, undefined, { artifactRoot }),
      /límite permitido/i,
    );

    const pagePath = join(root, "page.html");
    await writeFile(pagePath, "<main>Página</main>", "utf8");
    await truncate(pagePath, maxGeneralFileBytes + 1);
    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /límite permitido/i,
    );

    await rm(pagePath);
    await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
    const imagePath = join(root, "solar.svg");
    await writeFile(imagePath, "<svg></svg>", "utf8");
    await truncate(imagePath, maxImageFileBytes + 1);
    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /límite permitido/i,
    );
  });
});

test("imports a valid ZIP lazily as inert page bytes and local assets", async () => {
  await withTemporaryArtifactRoot(async (artifactRoot) => {
    const result = await importPage(
      fixture("archives/valid-page.zip"),
      fixture("page-meta.yaml"),
      { artifactRoot },
    );
    assert.equal(result.inputKind, "page");
    assert.match(result.content, /Página ZIP aportada/u);
    assert.deepEqual(
      result.assets.map((asset) => asset.path),
      ["solar.svg", "styles.css"],
    );
  });
});

test("uses page-meta inside the supplied package when the external metadata argument is omitted", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(join(root, "page.html"), "<main>Metadatos locales</main>");
    await writeFile(join(root, "page-meta.yaml"), metadata, "utf8");

    const result = await importPage(root, undefined, { artifactRoot });
    assert.equal(result.inputKind, "page");
    assert.match(result.content, /Metadatos locales/u);
  });
});

test("requires a single page entrypoint unless page metadata declares one", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(join(root, "first.html"), "<main>Primera</main>", "utf8");
    await writeFile(join(root, "second.html"), "<main>Segunda</main>", "utf8");
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /único entrypoint/i,
    );

    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: second.html\n`,
      "utf8",
    );
    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.match(result.content, /Segunda/u);
    assert.doesNotMatch(result.content, /Primera/u);
  });
});

for (const placement of ["external", "incorporated"] as const) {
  test(`allows one hidden page entrypoint exactly declared in ${placement} metadata`, async () => {
    await withTemporaryPackage(async (root, artifactRoot) => {
      await writeFile(
        join(root, ".landing.astro"),
        "<main>Entrada oculta declarada</main>",
        "utf8",
      );
      const metadataPath =
        placement === "external"
          ? join(dirname(root), "metadata.yaml")
          : join(root, "page-meta.yaml");
      await writeFile(
        metadataPath,
        `${metadata}\nentrypoint: .landing.astro\n`,
        "utf8",
      );

      const result = await importPage(
        root,
        placement === "external" ? metadataPath : undefined,
        { artifactRoot },
      );
      assert.match(result.content, /Entrada oculta declarada/u);
      assert.deepEqual(result.assets, []);
    });
  });
}

test("rejects an undeclared hidden page path", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, ".landing.astro"),
      "<main>Entrada oculta no declarada</main>",
      "utf8",
    );
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /paquete rechazado|ocult.*declar/i,
    );
    await assertNoPublishedRawArtifacts(artifactRoot);
  });
});

test("keeps hidden assets and hidden directories forbidden", () => {
  assert.throws(
    () => validateSuppliedPackagePaths([".hidden.css"]),
    /ruta.*segura/i,
  );
  assert.throws(
    () => validateSuppliedPackagePaths([".hidden/page.astro"]),
    /ruta.*segura/i,
  );
});

test("rejects a case-folded node_modules path before inventorying it", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await mkdir(join(root, "NODE_MODULES"));
    await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
    await writeFile(join(root, "NODE_MODULES", "style.css"), "body {}", "utf8");
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /ruta.*segura/i,
    );
  });
});

test("rejects a supplied symlink without reading its target", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    const outside = await mkdtemp(
      join(tmpdir(), "comunidadsolar-page-outside-"),
    );
    try {
      await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
      await writeFile(join(outside, "style.css"), "body {}", "utf8");
      await symlink(join(outside, "style.css"), join(root, "style.css"));
      const metadataPath = join(root, "metadata.yaml");
      await writeFile(metadataPath, metadata, "utf8");

      await assert.rejects(
        importPage(root, metadataPath, { artifactRoot }),
        /paquete rechazado.*enlace/i,
      );
      assert.equal(
        (await readFile(join(outside, "style.css"), "utf8")).trim(),
        "body {}",
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("rejects executable permission bits on a regular directory leaf", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    const pagePath = join(root, "page.html");
    await writeFile(pagePath, "<main>Página</main>", "utf8");
    await chmod(pagePath, 0o755);
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /ejecutable/i,
    );
    await assertNoPublishedRawArtifacts(artifactRoot);
  });
});

test("rejects executable permission bits on a ZIP leaf", async () => {
  await withTemporaryArtifactRoot(async (artifactRoot) => {
    await assert.rejects(
      importPage(
        fixture("archives/mode-executable.zip"),
        fixture("page-meta.yaml"),
        { artifactRoot },
      ),
      /ejecutable/i,
    );
    await assertNoPublishedRawArtifacts(artifactRoot);
  });
});

for (const suppliedKind of ["directory", "single file"] as const) {
  test(`rejects an external hardlink supplied as a ${suppliedKind}`, async () => {
    await withTemporaryPackage(async (root, artifactRoot) => {
      const outside = join(dirname(root), "outside.html");
      await writeFile(outside, "<main>Exterior</main>", "utf8");
      const suppliedPath = join(root, "page.html");
      await link(outside, suppliedPath);
      const metadataPath = join(dirname(root), "metadata.yaml");
      await writeFile(metadataPath, metadata, "utf8");

      await assert.rejects(
        importPage(
          suppliedKind === "directory" ? root : suppliedPath,
          metadataPath,
          { artifactRoot },
        ),
        /paquete rechazado/i,
      );
      await assertNoPublishedRawArtifacts(artifactRoot);
    });
  });
}

test("rejects an asset whose bytes do not match its declared type", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
    await writeFile(join(root, "solar.svg"), "not an SVG", "utf8");
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /firma permitidos/i,
    );
  });
});

for (const [name, svg] of [
  ["script", "<svg><script>void 0</script></svg>"],
  ["event attribute", '<svg onload="void 0"></svg>'],
  ["javascript reference", '<svg><a href="javascript:void 0" /></svg>'],
  [
    "external reference",
    '<svg><image href="https://assets.invalid.example.test/solar.png" /></svg>',
  ],
] as const) {
  test(`rejects an active SVG ${name} before raw publication`, async () => {
    await withTemporaryPackage(async (root, artifactRoot) => {
      await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
      await writeFile(join(root, "solar.svg"), svg, "utf8");
      const metadataPath = join(root, "metadata.yaml");
      await writeFile(metadataPath, metadata, "utf8");

      await assert.rejects(
        importPage(root, metadataPath, { artifactRoot }),
        /firma permitidos/i,
      );
      await assertNoPublishedRawArtifacts(artifactRoot);
    });
  });
}

for (const [name, svg] of [
  [
    "HTML data reference",
    '<svg><image href="data:text/html;base64,PGgxPk5vPC9oMT4=" /></svg>',
  ],
  [
    "style import",
    "<svg><style>@import url(https://assets.invalid.example.test/style.css);</style></svg>",
  ],
  [
    "style URL reference",
    '<svg><rect style="fill: url(https://assets.invalid.example.test/paint)" /></svg>',
  ],
  [
    "presentation URL reference",
    '<svg><rect fill="url(//assets.invalid.example.test/paint)" /></svg>',
  ],
] as const) {
  test(`rejects an active SVG ${name} before raw publication`, async () => {
    await withTemporaryPackage(async (root, artifactRoot) => {
      await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
      await writeFile(join(root, "solar.svg"), svg, "utf8");
      const metadataPath = join(root, "metadata.yaml");
      await writeFile(metadataPath, metadata, "utf8");

      await assert.rejects(
        importPage(root, metadataPath, { artifactRoot }),
        /firma permitidos/i,
      );
      await assertNoPublishedRawArtifacts(artifactRoot);
    });
  });
}

test("keeps SVG references local to its own fragment", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(join(root, "page.html"), "<main>Página</main>", "utf8");
    await writeFile(
      join(root, "solar.svg"),
      '<svg><defs><linearGradient id="paint" /></defs><rect fill="url(#paint)" style="stroke: url(#paint)" href="#paint" /></svg>',
      "utf8",
    );
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.deepEqual(
      result.assets.map((asset) => asset.path),
      ["solar.svg"],
    );
  });
});

test("does not download a remote resource while inspecting supplied HTML", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, "page.html"),
      '<main><img src="https://remote.invalid.example.test/solar.svg" alt="solar"></main>',
      "utf8",
    );
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("no external fetch is allowed");
    }) as typeof fetch;
    try {
      const result = await importPage(root, metadataPath, { artifactRoot });
      assert.equal(result.assets.length, 0);
      assert.match(result.content, /remote\.invalid/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("treats supplied TSX as text and never evaluates it", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    delete (globalThis as { __suppliedTsxExecuted?: boolean })
      .__suppliedTsxExecuted;
    await writeFile(
      join(root, "page.tsx"),
      "globalThis.__suppliedTsxExecuted = true; export default () => <main />;",
      "utf8",
    );
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.match(result.content, /__suppliedTsxExecuted/u);
    assert.equal(
      (globalThis as { __suppliedTsxExecuted?: boolean }).__suppliedTsxExecuted,
      undefined,
    );
  });
});

test("inventories local TSX imports without importing or evaluating them", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    delete (globalThis as { __suppliedImportExecuted?: boolean })
      .__suppliedImportExecuted;
    await writeFile(
      join(root, "page.tsx"),
      [
        'import "./styles.css";',
        'import Card from "./Card.tsx";',
        'import React from "react";',
        "export default () => <Card />;",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "Card.tsx"),
      "globalThis.__suppliedImportExecuted = true; export default () => null;",
      "utf8",
    );
    await writeFile(join(root, "styles.css"), "main {}", "utf8");
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: page.tsx\n`,
      "utf8",
    );

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.deepEqual(
      result.assets.map((asset) => asset.path),
      ["Card.tsx", "styles.css"],
    );
    assert.equal(
      (globalThis as { __suppliedImportExecuted?: boolean })
        .__suppliedImportExecuted,
      undefined,
    );
  });
});

test("inventories multiline static imports and comment-separated literal imports", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, "page.tsx"),
      [
        "import {",
        "  Card,",
        "} from",
        "'./Card.tsx';",
        'void import /* inert inventory */ ("./Widget.tsx");',
        "export default () => <Card />;",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "Card.tsx"),
      "export const Card = () => null;",
      "utf8",
    );
    await writeFile(
      join(root, "Widget.tsx"),
      "export default () => null;",
      "utf8",
    );
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: page.tsx\n`,
      "utf8",
    );

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.deepEqual(
      result.assets.map((asset) => asset.path),
      ["Card.tsx", "Widget.tsx"],
    );
  });
});

test("inventories literal dynamic imports and CommonJS require calls without evaluating them", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, "page.tsx"),
      [
        'void import("./Card.tsx");',
        'const Widget = require("./Widget.tsx");',
        'require("./styles.css");',
        "export default () => <main />;",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "Card.tsx"),
      "export default () => null;",
      "utf8",
    );
    await writeFile(
      join(root, "Widget.tsx"),
      "export default () => null;",
      "utf8",
    );
    await writeFile(join(root, "styles.css"), "main {}", "utf8");
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: page.tsx\n`,
      "utf8",
    );

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.deepEqual(
      result.assets.map((asset) => asset.path),
      ["Card.tsx", "Widget.tsx", "styles.css"],
    );
  });
});

test("rejects dynamic source import expressions instead of inventing an incomplete inventory", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, "page.tsx"),
      [
        'const componentPath = "./Card.tsx";',
        "void import(componentPath);",
        "export default () => <main />;",
      ].join("\n"),
      "utf8",
    );
    const metadataPath = join(root, "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: page.tsx\n`,
      "utf8",
    );

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /importación.*dinámica/i,
    );
  });
});

test("rejects a comment-separated genuinely dynamic import expression", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, "page.tsx"),
      [
        'const componentPath = "./Card.tsx";',
        "void import /* inert inventory */ (componentPath);",
        "export default () => <main />;",
      ].join("\n"),
      "utf8",
    );
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: page.tsx\n`,
      "utf8",
    );

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /importación.*dinámica/i,
    );
  });
});

test("imports Markdown as inert text", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(join(root, "page.md"), "# Página Markdown", "utf8");
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.equal(result.content, "# Página Markdown");
  });
});

test("imports Astro as inert text without evaluating it", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    delete (globalThis as { __suppliedAstroExecuted?: boolean })
      .__suppliedAstroExecuted;
    const source = [
      "---",
      "globalThis.__suppliedAstroExecuted = true;",
      "---",
      "<main>Página Astro</main>",
    ].join("\n");
    await writeFile(join(root, "page.astro"), source, "utf8");
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.equal(result.content, source);
    assert.equal(
      (globalThis as { __suppliedAstroExecuted?: boolean })
        .__suppliedAstroExecuted,
      undefined,
    );
  });
});

test("inventories local imports inside an inert Astro script block", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, "page.astro"),
      [
        "<script>",
        "import {",
        "  Card,",
        "} from './Card.tsx';",
        'void import /* inert inventory */ ("./Widget.tsx");',
        "</script>",
        "<main>Página Astro</main>",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "Card.tsx"),
      "export const Card = () => null;",
      "utf8",
    );
    await writeFile(
      join(root, "Widget.tsx"),
      "export default () => null;",
      "utf8",
    );
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: page.astro\n`,
      "utf8",
    );

    const result = await importPage(root, metadataPath, { artifactRoot });
    assert.deepEqual(
      result.assets.map((asset) => asset.path),
      ["Card.tsx", "Widget.tsx"],
    );
  });
});

test("rejects a genuinely dynamic import inside an Astro script block", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    await writeFile(
      join(root, "page.astro"),
      [
        "<script>",
        'const componentPath = "./Card.tsx";',
        "void import /* inert inventory */ (componentPath);",
        "</script>",
        "<main>Página Astro</main>",
      ].join("\n"),
      "utf8",
    );
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(
      metadataPath,
      `${metadata}\nentrypoint: page.astro\n`,
      "utf8",
    );

    await assert.rejects(
      importPage(root, metadataPath, { artifactRoot }),
      /importación.*dinámica/i,
    );
  });
});

test("imports one supplied page file with external metadata", async () => {
  await withTemporaryPackage(async (root, artifactRoot) => {
    const pagePath = join(root, "single.html");
    await writeFile(pagePath, "<main>Página individual</main>", "utf8");
    const metadataPath = join(dirname(root), "metadata.yaml");
    await writeFile(metadataPath, metadata, "utf8");

    const result = await importPage(pagePath, metadataPath, { artifactRoot });
    assert.match(result.content, /Página individual/u);
    assert.deepEqual(result.assets, []);
  });
});

test("copies every supplied raw input as a private hashed leaf", async () => {
  await withTemporaryArtifactRoot(async (artifactRoot) => {
    const result = await importPage(
      fixture("supplied-page"),
      fixture("page-meta.yaml"),
      { artifactRoot },
    );
    const rawDirectory = join(
      artifactRoot,
      "intake",
      result.changeId,
      result.inputSha256,
      "raw",
    );
    const expected = await Promise.all(
      [
        fixture("supplied-page/page.html"),
        fixture("supplied-page/styles.css"),
        fixture("supplied-page/solar.svg"),
        fixture("page-meta.yaml"),
      ].map(async (path) => {
        const bytes = await readFile(path);
        return `${createHash("sha256").update(bytes).digest("hex")}${path.slice(path.lastIndexOf("."))}`;
      }),
    );
    const files = await readdir(rawDirectory);
    assert.deepEqual(files, [...expected].sort());
    for (const file of files) {
      assert.equal((await stat(join(rawDirectory, file))).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      files.filter((name) => name.startsWith(".intake-")),
      [],
    );
  });
});

test("rejects an existing raw leaf whose private mode was weakened", async () => {
  await withTemporaryArtifactRoot(async (artifactRoot) => {
    const result = await importPage(
      fixture("supplied-page"),
      fixture("page-meta.yaml"),
      { artifactRoot },
    );
    const rawDirectory = join(
      artifactRoot,
      "intake",
      result.changeId,
      result.inputSha256,
      "raw",
    );
    const [rawLeaf] = await readdir(rawDirectory);
    assert.notEqual(rawLeaf, undefined);
    const target = join(rawDirectory, rawLeaf);
    await chmod(target, 0o644);

    await assert.rejects(
      importPage(fixture("supplied-page"), fixture("page-meta.yaml"), {
        artifactRoot,
      }),
      /artefacto crudo|ruta de artefacto/i,
    );
    assert.equal((await stat(target)).mode & 0o777, 0o644);
  });
});
