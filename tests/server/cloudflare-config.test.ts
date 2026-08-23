import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  prepareCloudflareConfig,
  type CloudflareArtifactWriter,
} from "../../scripts/prepare-cloudflare-config.ts";

const productionD1Id = "11111111-2222-4333-8444-555555555555";

function validConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: "comunidad-solar-preview",
      main: "./dist/server/entry.mjs",
      compatibility_date: "2026-08-21",
      compatibility_flags: ["nodejs_compat"],
      assets: {
        binding: "ASSETS",
        directory: "./dist",
        run_worker_first: true,
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "comunidad-solar-preview",
          database_id: productionD1Id,
          migrations_dir: "./drizzle",
        },
      ],
      vars: { SITE_INDEXABLE: "true" },
      ...overrides,
    },
    null,
    2,
  );
}

test("prepares a deterministic sanitized operator profile without mutating its input", async () => {
  const root = await mkdirTemp();
  try {
    const inputPath = join(root, "operator.jsonc");
    const artifactRoot = join(root, "artifacts", "config");
    const contents = validConfig();
    await writeFile(inputPath, contents, "utf8");

    const first = await prepareCloudflareConfig(inputPath, undefined, {
      artifactRoot,
    });
    const second = await prepareCloudflareConfig(inputPath, undefined, {
      artifactRoot,
    });
    const output = await readFile(first.outputPath, "utf8");

    assert.equal(await readFile(inputPath, "utf8"), contents);
    assert.equal(
      relative(artifactRoot, first.outputPath).startsWith(".."),
      false,
    );
    assert.deepEqual(first, second);
    assert.equal(first.environment, null);
    assert.equal(first.indexable, true);
    assert.equal(
      first.sha256,
      createHash("sha256").update(output).digest("hex"),
    );
    const profile = JSON.parse(output) as {
      assets: { directory: string };
      d1_databases: Array<{ migrations_dir: string }>;
      main: string;
    };
    assert.deepEqual(profile, {
      assets: {
        binding: "ASSETS",
        directory: rebaseFromArtifact(
          artifactRoot,
          join(process.cwd(), "dist"),
        ),
        run_worker_first: true,
      },
      d1_databases: [
        {
          binding: "DB",
          database_id: productionD1Id,
          database_name: "comunidad-solar-preview",
          migrations_dir: rebaseFromArtifact(
            artifactRoot,
            join(process.cwd(), "drizzle"),
          ),
        },
      ],
      compatibility_date: "2026-08-21",
      compatibility_flags: ["nodejs_compat"],
      main: rebaseFromArtifact(
        artifactRoot,
        join(process.cwd(), "dist", "server", "entry.mjs"),
      ),
      name: "comunidad-solar-preview",
      vars: { SITE_INDEXABLE: "true" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe operator config and symlink paths before writing a profile", async () => {
  const root = await mkdirTemp();
  try {
    const artifactRoot = join(root, "artifacts", "config");
    const inputPath = join(root, "operator.jsonc");
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["name", { name: "not a valid worker" }, /name/i],
      ["main", { main: "../outside.mjs" }, /main/i],
      ["main root", { main: "." }, /main/i],
      [
        "assets",
        {
          assets: {
            binding: "ASSETS",
            directory: "../outside",
            run_worker_first: true,
          },
        },
        /assets/i,
      ],
      [
        "assets root",
        {
          assets: {
            binding: "ASSETS",
            directory: ".",
            run_worker_first: true,
          },
        },
        /assets/i,
      ],
      [
        "database",
        {
          d1_databases: [
            {
              binding: "OTHER",
              database_name: "comunidad-solar-preview",
              database_id: productionD1Id,
            },
          ],
        },
        /DB/i,
      ],
      [
        "extra database",
        {
          d1_databases: [
            {
              binding: "DB",
              database_name: "comunidad-solar-preview",
              database_id: productionD1Id,
            },
            {
              binding: "UNDECLARED",
              database_name: "other",
              database_id: productionD1Id,
            },
          ],
        },
        /exactamente/i,
      ],
      [
        "zero database",
        {
          d1_databases: [
            {
              binding: "DB",
              database_name: "comunidad-solar-preview",
              database_id: "00000000-0000-4000-8000-000000000000",
            },
          ],
        },
        /database_id/i,
      ],
      [
        "secret",
        { vars: { MANGANAFER_QUOTING_BEARER_TOKEN: "not-a-secret" } },
        /secret/i,
      ],
    ];

    for (const [label, override, expected] of cases) {
      await writeFile(inputPath, validConfig(override), "utf8");
      await assert.rejects(
        prepareCloudflareConfig(inputPath, undefined, { artifactRoot }),
        expected,
        label,
      );
    }

    await writeFile(inputPath, validConfig(), "utf8");
    const linkedInput = join(root, "linked.jsonc");
    await symlink(inputPath, linkedInput);
    await assert.rejects(
      prepareCloudflareConfig(linkedInput, undefined, { artifactRoot }),
      /symlink/i,
    );
    await assert.rejects(lstat(artifactRoot), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a non-local valid UUID whose first group is zero", async () => {
  const root = await mkdirTemp();
  try {
    const inputPath = join(root, "operator.jsonc");
    await writeFile(
      inputPath,
      validConfig({
        d1_databases: [
          {
            binding: "DB",
            database_name: "comunidad-solar-preview",
            database_id: "00000000-1111-4111-8111-111111111111",
            migrations_dir: "./drizzle",
          },
        ],
      }),
      "utf8",
    );

    await prepareCloudflareConfig(inputPath, undefined, {
      artifactRoot: join(root, "artifacts", "config"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires the safe Worker compatibility profile", async () => {
  const root = await mkdirTemp();
  try {
    const inputPath = join(root, "operator.jsonc");
    await writeFile(
      inputPath,
      validConfig({
        compatibility_date: undefined,
        compatibility_flags: undefined,
      }),
      "utf8",
    );

    await assert.rejects(
      prepareCloudflareConfig(inputPath, undefined, {
        artifactRoot: join(root, "artifacts", "config"),
      }),
      /compatibility/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a partial sanitized profile when its exclusive write fails", async () => {
  const root = await mkdirTemp();
  try {
    const inputPath = join(root, "operator.jsonc");
    const artifactRoot = join(root, "artifacts", "config");
    await writeFile(inputPath, validConfig(), "utf8");
    const artifactWriter: CloudflareArtifactWriter = {
      randomUUID: () => "partial-write",
      writeTemporary: async (path, contents) => {
        await writeFile(path, contents.slice(0, 12), "utf8");
        throw new Error("simulated partial write");
      },
      linkTemporary: async () => {
        assert.fail("a failed temporary write must not publish its final path");
      },
      removeTemporary: async (path) => rm(path, { force: true }),
    };

    await assert.rejects(
      prepareCloudflareConfig(inputPath, undefined, {
        artifactRoot,
        artifactWriter,
      }),
      /simulated partial write/i,
    );

    assert.deepEqual(await readdir(artifactRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selects only a named safe environment and preserves indexability in the profile hash", async () => {
  const root = await mkdirTemp();
  try {
    const inputPath = join(root, "operator.jsonc");
    const artifactRoot = join(root, "artifacts", "config");
    await writeFile(
      inputPath,
      validConfig({
        env: { preview: { vars: { SITE_INDEXABLE: "false" } } },
      }),
      "utf8",
    );

    const prepared = await prepareCloudflareConfig(inputPath, "preview", {
      artifactRoot,
    });
    assert.equal(prepared.environment, "preview");
    assert.equal(prepared.indexable, false);
    await assert.rejects(
      prepareCloudflareConfig(inputPath, "../production", { artifactRoot }),
      /environment/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a literal secret in an unselected operator environment", async () => {
  const root = await mkdirTemp();
  try {
    const inputPath = join(root, "operator.jsonc");
    await writeFile(
      inputPath,
      validConfig({
        env: {
          preview: { vars: { SITE_INDEXABLE: "false" } },
          production: {
            vars: { MANGANAFER_QUOTING_BEARER_TOKEN: "literal-secret" },
          },
        },
      }),
      "utf8",
    );

    await assert.rejects(
      prepareCloudflareConfig(inputPath, "preview", {
        artifactRoot: join(root, "artifacts", "config"),
      }),
      /secret/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "comunidadsolar-cloudflare-config-"));
}

function rebaseFromArtifact(artifactRoot: string, target: string): string {
  const rebased = relative(artifactRoot, target).split("\\").join("/");
  return rebased.startsWith(".") ? rebased : `./${rebased}`;
}
