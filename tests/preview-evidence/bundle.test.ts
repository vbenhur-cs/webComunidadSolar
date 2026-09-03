import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type BundleLimits,
  createSealedBundle,
  verifySealedBundle,
} from "../../scripts/preview-evidence/bundle.ts";
import { sha256 } from "../../scripts/preview-evidence/domain.ts";

const sourceSha = "a".repeat(40);
const previewD1Id = "11111111-2222-4333-8444-555555555555";

function profileConfig(): Record<string, unknown> {
  return {
    assets: {
      binding: "ASSETS",
      directory: "../../dist",
      run_worker_first: true,
    },
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_id: previewD1Id,
        database_name: "comunidad-solar-preview",
        migrations_dir: "../../drizzle",
      },
    ],
    main: "../../src/worker.ts",
    name: "comunidad-solar-preview",
    preview_urls: true,
    vars: { SITE_INDEXABLE: "false" },
    workers_dev: true,
  };
}

function generatedConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    topLevelName: "comunidad-solar-preview",
    name: "comunidad-solar-preview",
    main: "entry.mjs",
    no_bundle: true,
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      binding: "ASSETS",
      directory: "../client",
      run_worker_first: true,
    },
    vars: { SITE_INDEXABLE: "false" },
    d1_databases: [
      {
        binding: "DB",
        database_id: previewD1Id,
        database_name: "comunidad-solar-preview",
        migrations_dir: "../../drizzle",
      },
    ],
    routes: [],
    triggers: {},
    services: [],
    durable_objects: { bindings: [] },
    kv_namespaces: [{ binding: "SESSION" }],
    images: { binding: "IMAGES" },
    secrets_store_secrets: [],
    ...overrides,
  };
}

interface BundleFixture {
  root: string;
  source: string;
  output: string;
  profilePath: string;
  profileSha256: string;
}

async function bundleFixture(): Promise<BundleFixture> {
  const root = await mkdtemp(join(tmpdir(), "preview-bundle-"));
  const source = join(root, "source");
  const output = join(root, "sealed");
  await mkdir(join(source, "dist", "server"), { recursive: true });
  await mkdir(join(source, "dist", "client"), { recursive: true });
  await mkdir(join(source, "drizzle"));
  await mkdir(join(source, ".artifacts", "config"), { recursive: true });
  await writeFile(
    join(source, "dist", "server", "wrangler.json"),
    JSON.stringify(generatedConfig()),
  );
  await writeFile(
    join(source, "dist", "server", "entry.mjs"),
    "export default { fetch() { return new Response('ok') } };\n",
  );
  await writeFile(
    join(source, "dist", "client", "index.html"),
    "<!doctype html><title>Preview</title>\n",
  );
  await writeFile(
    join(source, "drizzle", "0000_initial.sql"),
    "CREATE TABLE example (id TEXT PRIMARY KEY);\n",
  );
  const profilePath = join(source, ".artifacts", "config", "preview.json");
  const profileBytes = `${JSON.stringify(profileConfig())}\n`;
  await writeFile(profilePath, profileBytes);
  return {
    root,
    source,
    output,
    profilePath,
    profileSha256: sha256(profileBytes),
  };
}

function input(fixture: BundleFixture) {
  return {
    sourceRoot: fixture.source,
    outputRoot: fixture.output,
    role: "candidate" as const,
    sourceSha,
    profilePath: fixture.profilePath,
    profileSha256: fixture.profileSha256,
  };
}

test("copies a deterministic closed bundle and verifies every byte", async () => {
  const fixture = await bundleFixture();
  try {
    const manifest = await createSealedBundle(input(fixture));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.role, "candidate");
    assert.equal(manifest.sourceSha, sourceSha);
    assert.equal(manifest.profileSha256, fixture.profileSha256);
    assert.match(manifest.bundleSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      [
        "dist/client/index.html",
        "dist/server/entry.mjs",
        "dist/server/wrangler.json",
        "drizzle/0000_initial.sql",
      ],
    );
    assert.deepEqual(
      await verifySealedBundle(fixture.output, {
        role: "candidate",
        sourceSha,
        profilePath: fixture.profilePath,
        profileSha256: fixture.profileSha256,
      }),
      manifest,
    );

    const stored = JSON.parse(
      await readFile(
        join(fixture.output, ".preview-evidence", "bundle-manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(stored, manifest);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects symlink and hardlink inputs before publishing output", async () => {
  for (const kind of ["symlink", "hardlink"] as const) {
    const fixture = await bundleFixture();
    try {
      const sourceFile = join(fixture.source, "dist", "client", "index.html");
      const extra = join(fixture.source, "dist", "client", `${kind}.html`);
      if (kind === "symlink") await symlink(sourceFile, extra);
      else await link(sourceFile, extra);

      await assert.rejects(
        createSealedBundle(input(fixture)),
        /symlink|hardlink|enlace/i,
      );
      await assert.rejects(readFile(fixture.output), /ENOENT|directory/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("rejects output symlinks, secret filenames and unsafe modes", async () => {
  const cases: Array<
    [string, (fixture: BundleFixture) => Promise<void>, RegExp]
  > = [
    [
      "output symlink",
      async (fixture) => {
        await symlink(join(fixture.root, "outside"), fixture.output);
      },
      /output|symlink|destino/i,
    ],
    [
      "secret file",
      async (fixture) => {
        await writeFile(join(fixture.source, "dist", ".env"), "TOKEN=value");
      },
      /secret|\.env/i,
    ],
    [
      "unsafe mode",
      async (fixture) => {
        await chmod(
          join(fixture.source, "dist", "client", "index.html"),
          0o666,
        );
      },
      /mode|permiso/i,
    ],
  ];

  for (const [label, prepare, expected] of cases) {
    const fixture = await bundleFixture();
    try {
      await prepare(fixture);
      await assert.rejects(createSealedBundle(input(fixture)), expected, label);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("enforces file count, per-file and total byte limits", async () => {
  const cases: Array<[string, BundleLimits, RegExp]> = [
    [
      "files",
      { maxFiles: 3, maxFileBytes: 1024, maxTotalBytes: 4096 },
      /archivos|files/i,
    ],
    [
      "single file",
      { maxFiles: 10, maxFileBytes: 10, maxTotalBytes: 4096 },
      /archivo|bytes|tamaño/i,
    ],
    [
      "total",
      { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 20 },
      /total|bytes|tamaño/i,
    ],
  ];

  for (const [label, limits, expected] of cases) {
    const fixture = await bundleFixture();
    try {
      await assert.rejects(
        createSealedBundle(input(fixture), { limits }),
        expected,
        label,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("fails verification after a byte change or any unlisted file", async () => {
  for (const kind of ["changed", "extra", "top-level-extra"] as const) {
    const fixture = await bundleFixture();
    try {
      await createSealedBundle(input(fixture));
      if (kind === "changed") {
        await writeFile(
          join(fixture.output, "dist", "client", "index.html"),
          "changed\n",
        );
      } else if (kind === "extra") {
        await writeFile(
          join(fixture.output, "dist", "client", "extra.html"),
          "extra\n",
        );
      } else {
        await writeFile(join(fixture.output, "unexpected.txt"), "extra\n");
      }
      await assert.rejects(
        verifySealedBundle(fixture.output, {
          role: "candidate",
          sourceSha,
          profilePath: fixture.profilePath,
          profileSha256: fixture.profileSha256,
        }),
        /integridad|inventario|hash|archivo/i,
        kind,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("rejects a source root that is itself a symlink", async () => {
  const fixture = await bundleFixture();
  const sourceLink = join(fixture.root, "source-link");
  try {
    await symlink(fixture.source, sourceLink);
    await assert.rejects(
      createSealedBundle({ ...input(fixture), sourceRoot: sourceLink }),
      /source|origen|symlink/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects unknown manifest fields rather than ignoring them", async () => {
  const fixture = await bundleFixture();
  try {
    await createSealedBundle(input(fixture));
    const path = join(
      fixture.output,
      ".preview-evidence",
      "bundle-manifest.json",
    );
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.unknown = true;
    await writeFile(path, JSON.stringify(manifest));

    await assert.rejects(
      verifySealedBundle(fixture.output, {
        role: "candidate",
        sourceSha,
        profilePath: fixture.profilePath,
        profileSha256: fixture.profileSha256,
      }),
      /campo|manifest/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects generated Wrangler topology outside the preview profile", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["worker", { name: "production-worker" }, /worker|name/i],
    ["main", { main: "other.mjs" }, /main|entry/i],
    ["bundle", { no_bundle: false }, /bundle/i],
    [
      "assets",
      {
        assets: {
          binding: "ASSETS",
          directory: "../../public",
          run_worker_first: true,
        },
      },
      /assets/i,
    ],
    [
      "indexable",
      { vars: { SITE_INDEXABLE: "true" } },
      /indexable|SITE_INDEXABLE/i,
    ],
    [
      "database",
      {
        d1_databases: [
          {
            binding: "DB",
            database_id: "99999999-2222-4333-8444-555555555555",
            database_name: "comunidad-solar-preview",
            migrations_dir: "../../drizzle",
          },
        ],
      },
      /D1|database/i,
    ],
    ["route", { routes: [{ pattern: "example.com/*" }] }, /route|dominio/i],
    [
      "service",
      { services: [{ binding: "OTHER", service: "other" }] },
      /service|binding/i,
    ],
    [
      "secret store",
      { secrets_store_secrets: [{ binding: "SECRET" }] },
      /secret/i,
    ],
  ];

  for (const [label, override, expected] of cases) {
    const fixture = await bundleFixture();
    try {
      await writeFile(
        join(fixture.source, "dist", "server", "wrangler.json"),
        JSON.stringify(generatedConfig(override)),
      );
      await assert.rejects(createSealedBundle(input(fixture)), expected, label);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("seals an explicitly indexable production bundle only for production", async () => {
  const fixture = await bundleFixture();
  try {
    const productionProfile: Record<string, unknown> = {
      ...profileConfig(),
      name: "comunidad-solar-production",
      d1_databases: [
        {
          binding: "DB",
          database_id: previewD1Id,
          database_name: "comunidad-solar-production",
          migrations_dir: "../../drizzle",
        },
      ],
      vars: { SITE_INDEXABLE: "true" },
    };
    delete productionProfile.preview_urls;
    delete productionProfile.workers_dev;
    const productionGenerated = generatedConfig({
      topLevelName: "comunidad-solar-production",
      name: "comunidad-solar-production",
      vars: { SITE_INDEXABLE: "true" },
      d1_databases: [
        {
          binding: "DB",
          database_id: previewD1Id,
          database_name: "comunidad-solar-production",
          migrations_dir: "../../drizzle",
        },
      ],
    });
    await writeFile(
      fixture.profilePath,
      `${JSON.stringify(productionProfile)}\n`,
    );
    fixture.profileSha256 = sha256(`${JSON.stringify(productionProfile)}\n`);
    await writeFile(
      join(fixture.source, "dist", "server", "wrangler.json"),
      JSON.stringify(productionGenerated),
    );
    const productionInput = {
      ...input(fixture),
      role: "release" as const,
      target: "production" as const,
    };

    const manifest = await createSealedBundle(productionInput);
    assert.equal(manifest.topology.workerName, "comunidad-solar-production");
    assert.equal(manifest.topology.database.name, "comunidad-solar-production");
    assert.equal(manifest.topology.indexable, true);
    assert.deepEqual(
      await verifySealedBundle(fixture.output, {
        role: "release",
        sourceSha,
        profilePath: fixture.profilePath,
        profileSha256: fixture.profileSha256,
        target: "production",
      }),
      manifest,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
