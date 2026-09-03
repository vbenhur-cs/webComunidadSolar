import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareCloudflarePreviewConfig } from "../../scripts/prepare-cloudflare-config.ts";
import { materializePreviewProfile } from "../../scripts/preview-evidence/profile.ts";

const previewD1Id = "11111111-2222-4333-8444-555555555555";

function validPreviewConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "comunidad-solar-preview",
    main: "./src/worker.ts",
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: true,
    assets: {
      binding: "ASSETS",
      directory: "./dist",
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "comunidad-solar-preview",
        database_id: previewD1Id,
        migrations_dir: "./drizzle",
      },
    ],
    vars: { SITE_INDEXABLE: "false" },
    ...overrides,
  });
}

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "preview-profile-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "drizzle"));
  await writeFile(join(root, "src", "worker.ts"), "export default {};\n");
  return root;
}

test("preserves the routing flags only in a non-indexable preview profile", async () => {
  const root = await projectFixture();
  try {
    const input = join(root, "operator.jsonc");
    await writeFile(input, validPreviewConfig(), "utf8");

    const prepared = await prepareCloudflarePreviewConfig(input, undefined, {
      projectRoot: root,
      artifactRoot: join(root, ".artifacts", "config"),
    });
    const profile = JSON.parse(await readFile(prepared.outputPath, "utf8"));

    assert.equal(prepared.destination.workerName, "comunidad-solar-preview");
    assert.equal(prepared.destination.database.id, previewD1Id);
    assert.equal(prepared.indexable, false);
    assert.equal(profile.workers_dev, true);
    assert.equal(profile.preview_urls, true);
    assert.deepEqual(profile.vars, { SITE_INDEXABLE: "false" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects any profile that weakens the fixed preview boundary", async () => {
  const root = await projectFixture();
  try {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["workers dev", { workers_dev: false }, /workers_dev/i],
      ["preview urls", { preview_urls: false }, /preview_urls/i],
      ["indexable", { vars: { SITE_INDEXABLE: "true" } }, /indexable/i],
      ["worker", { name: "another-worker" }, /worker|name/i],
      [
        "local d1",
        {
          d1_databases: [
            {
              binding: "DB",
              database_name: "comunidad-solar-preview",
              database_id: "00000000-0000-4000-8000-000000000000",
              migrations_dir: "./drizzle",
            },
          ],
        },
        /database_id|preview/i,
      ],
    ];

    for (const [label, override, expected] of cases) {
      const input = join(root, `${randomUUID()}.jsonc`);
      await writeFile(input, validPreviewConfig(override), "utf8");
      await assert.rejects(
        prepareCloudflarePreviewConfig(input, undefined, {
          projectRoot: root,
          artifactRoot: join(root, ".artifacts", label.replace(" ", "-")),
        }),
        expected,
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materializes only a sanitized profile and removes decoded operator bytes", async () => {
  const root = await projectFixture();
  try {
    const artifactRoot = join(root, ".artifacts");
    const encoded = Buffer.from(validPreviewConfig(), "utf8").toString(
      "base64",
    );

    const artifact = await materializePreviewProfile(
      `${encoded}\n`,
      artifactRoot,
      root,
    );
    const entries = await readdir(artifactRoot);
    const profile = JSON.parse(await readFile(artifact.path, "utf8"));

    assert.deepEqual(entries, ["config"]);
    assert.equal(artifact.workerName, "comunidad-solar-preview");
    assert.equal(artifact.databaseName, "comunidad-solar-preview");
    assert.equal(artifact.databaseId, previewD1Id);
    assert.equal(artifact.indexable, false);
    assert.equal(profile.workers_dev, true);
    assert.equal(profile.preview_urls, true);
    assert.equal(JSON.stringify(profile).includes(encoded), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes decoded bytes and redacts them when preview validation fails", async () => {
  const root = await projectFixture();
  try {
    const artifactRoot = join(root, ".artifacts");
    const forbidden = "operator-secret-must-not-escape";
    const invalid = validPreviewConfig({
      vars: {
        SITE_INDEXABLE: "false",
        API_TOKEN: forbidden,
      },
    });

    await assert.rejects(
      materializePreviewProfile(
        Buffer.from(invalid, "utf8").toString("base64"),
        artifactRoot,
        root,
      ),
      (error: unknown) => {
        assert.equal(String(error).includes(forbidden), false);
        return /secret|token/i.test(String(error));
      },
    );
    assert.deepEqual(await readdir(artifactRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed or oversized base64 before writing a decoded file", async () => {
  const root = await projectFixture();
  try {
    const artifactRoot = join(root, ".artifacts");
    await assert.rejects(
      materializePreviewProfile("not base64!", artifactRoot, root),
      /base64|perfil/i,
    );
    await assert.rejects(
      materializePreviewProfile(
        Buffer.alloc(65 * 1024, 1).toString("base64"),
        artifactRoot,
        root,
      ),
      /64 KiB|tamaño/i,
    );
    assert.deepEqual(await readdir(artifactRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
