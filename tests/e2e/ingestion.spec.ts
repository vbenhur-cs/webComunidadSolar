import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { test } from "@playwright/test";

import { openIngestionControllerForTest } from "../../src/ingest/controller.ts";
import { runFixtureE2e } from "../fixtures/ingestion/run-e2e.ts";

const execFileAsync = promisify(execFile);

async function withTemporaryMainClone<T>(
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const source = process.cwd();
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-ingestion-playwright-"),
  );
  const clone = join(root, "source");
  const head = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  try {
    await execFileAsync(
      "git",
      ["clone", "--no-hardlinks", "--quiet", source, clone],
      {
        encoding: "utf8",
      },
    );
    await execFileAsync(
      "git",
      ["-C", clone, "checkout", "--quiet", "-B", "main", head.stdout.trim()],
      { encoding: "utf8" },
    );
    return await operation(clone);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("@ingestion runs the three non-recorded fixture pipelines in owned clones", async () => {
  // Each matrix entry deliberately creates an isolated no-hardlink source and
  // candidate checkout. Slow local APFS/Git hosts can take several minutes;
  // retain a bounded timeout rather than racing fixture cleanup.
  test.setTimeout(10 * 60_000);
  const previousCwd = process.cwd();
  const previousMode = process.env.INGEST_TEST_MODE;
  process.env.INGEST_TEST_MODE = "true";
  try {
    const results = await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const values = [];
      for (const invocation of [
        {
          fixture: "detailed-request",
          mode: "blocks",
          changeId: "fixture-request-blocks",
          record: false,
        },
        {
          fixture: "detailed-request",
          mode: "hybrid",
          changeId: "fixture-request-hybrid",
          record: false,
        },
        {
          fixture: "supplied-page",
          mode: "freeform",
          changeId: "fixture-page-freeform",
          record: false,
        },
      ] as const) {
        values.push(await runFixtureE2e(invocation));
      }
      return values;
    });
    for (const result of results) {
      assert.equal(result.local, "success");
      assert.equal(result.published, false);
      assert.match(result.candidate.artifactSha256, /^[a-f0-9]{64}$/u);
      assert.match(result.candidate.candidateCommit, /^[a-f0-9]{40,64}$/u);
    }
  } finally {
    process.chdir(previousCwd);
    if (previousMode === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previousMode;
  }
});

test("@ingestion rejects a missing Gate 1 before agent or publisher effects", async () => {
  const previousCwd = process.cwd();
  const previousMode = process.env.INGEST_TEST_MODE;
  process.env.INGEST_TEST_MODE = "true";
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const controller = await openIngestionControllerForTest({});
      try {
        await controller.receiveRequest({
          kind: "request",
          source: join(
            clone,
            "tests/fixtures/ingestion/detailed-request/request.yaml",
          ),
        });
        await controller.plan("nueva-pagina-autoconsumo");
        const pending = await controller.generate({
          changeId: "nueva-pagina-autoconsumo",
          adapter: "command",
        });
        assert.deepEqual(pending, { kind: "gate-pending", gate: 1 });
        const status = await controller.status("nueva-pagina-autoconsumo");
        assert.equal(status.kind, "success");
        assert.equal(status.value.state, "planned");
      } finally {
        await controller.dispose();
      }
    });
  } finally {
    process.chdir(previousCwd);
    if (previousMode === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previousMode;
  }
});
