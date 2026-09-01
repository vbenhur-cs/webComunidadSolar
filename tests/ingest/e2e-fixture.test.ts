import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createControllerApprovalTestPrompt } from "../../src/ingest/approvals/prompt.ts";
import { openIngestionControllerForTest } from "../../src/ingest/controller.ts";
import {
  parseFixtureInvocation,
  runFixtureE2e,
} from "../fixtures/ingestion/run-e2e.ts";

const execFileAsync = promisify(execFile);

process.env.INGEST_TEST_MODE ??= "true";

async function withTemporaryMainClone<T>(
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const source = process.cwd();
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-ingestion-e2e-test-"),
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

test("fixture E2E parser accepts exactly the closed non-record matrix", () => {
  assert.deepEqual(
    parseFixtureInvocation([
      "--fixture",
      "detailed-request",
      "--mode",
      "blocks",
      "--change-id",
      "fixture-request-blocks",
    ]),
    {
      fixture: "detailed-request",
      mode: "blocks",
      changeId: "fixture-request-blocks",
      record: false,
    },
  );
  assert.deepEqual(
    parseFixtureInvocation([
      "--fixture",
      "detailed-request",
      "--mode",
      "hybrid",
      "--change-id",
      "fixture-request-hybrid",
    ]),
    {
      fixture: "detailed-request",
      mode: "hybrid",
      changeId: "fixture-request-hybrid",
      record: false,
    },
  );
  assert.deepEqual(
    parseFixtureInvocation([
      "--fixture",
      "supplied-page",
      "--mode",
      "freeform",
      "--change-id",
      "fixture-page-freeform",
    ]),
    {
      fixture: "supplied-page",
      mode: "freeform",
      changeId: "fixture-page-freeform",
      record: false,
    },
  );
});

test("fixture E2E parser rejects non-matrix and hidden values before any clone can start", () => {
  for (const argv of [
    [
      "--fixture",
      "detailed-request",
      "--mode",
      "freeform",
      "--change-id",
      "fixture-request-blocks",
    ],
    [
      "--fixture",
      "unknown",
      "--mode",
      "blocks",
      "--change-id",
      "fixture-request-blocks",
    ],
    [
      "--fixture",
      "detailed-request",
      "--mode",
      "blocks",
      "--change-id",
      "other",
    ],
    [
      "--fixture",
      "detailed-request",
      "--mode",
      "blocks",
      "--change-id",
      "fixture-request-blocks",
      "--unknown",
    ],
  ]) {
    assert.throws(
      () => parseFixtureInvocation(argv),
      /matriz|opciones|exactamente/i,
    );
  }
});

test("fixture record parsing stays limited to the same three closed combinations", () => {
  assert.equal(
    parseFixtureInvocation([
      "--record",
      "--fixture",
      "supplied-page",
      "--mode",
      "freeform",
      "--change-id",
      "fixture-page-freeform",
    ]).record,
    true,
  );
  assert.throws(
    () =>
      parseFixtureInvocation([
        "--record",
        "--fixture",
        "supplied-page",
        "--mode",
        "blocks",
        "--change-id",
        "fixture-page-freeform",
      ]),
    /matriz/i,
  );
  assert.throws(
    () =>
      parseFixtureInvocation([
        "--fixture",
        "detailed-request",
        "--mode",
        "blocks",
        "--change-id",
        "fixture-request-blocks",
        "--record",
        "--record",
      ]),
    /exactamente|opciones/i,
  );
});

test("fixture record code copies a sanitized dossier and has no external promotion path", async () => {
  const source = await readFile(
    join(process.cwd(), "tests/fixtures/ingestion/run-e2e.ts"),
    "utf8",
  );
  assert.match(source, /createSanitizedCandidateDossier/u);
  assert.match(source, /dossier\.files/u);
  assert.doesNotMatch(source, /CloudflarePublisher|\bmerge\b|--execute/u);
});

test("fixture E2E retains preview authority only within its controller session", async () => {
  const previousCwd = process.cwd();
  try {
    const result = await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      return await runFixtureE2e({
        fixture: "detailed-request",
        mode: "blocks",
        changeId: "fixture-request-blocks",
        record: false,
      });
    });
    assert.equal(result.local, "success");
    assert.equal(result.published, false);
    assert.match(result.candidate.artifactSha256, /^[a-f0-9]{64}$/u);
  } finally {
    process.chdir(previousCwd);
  }
});

test("controller keeps Gate 1 durable when CommandAgent cannot start", async () => {
  const previousCwd = process.cwd();
  const previousCommandConfig = process.env.INGEST_COMMAND_AGENT_CONFIG;
  process.env.INGEST_TEST_MODE = "true";
  delete process.env.INGEST_COMMAND_AGENT_CONFIG;
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const planner = await openIngestionControllerForTest({});
      try {
        await planner.receiveRequest({
          kind: "request",
          source: join(
            clone,
            "tests/fixtures/ingestion/detailed-request/request.yaml",
          ),
        });
        await planner.plan("nueva-pagina-autoconsumo");
      } finally {
        await planner.dispose();
      }

      const plan = JSON.parse(
        await readFile(
          join(clone, ".change-state", "nueva-pagina-autoconsumo", "plan.json"),
          "utf8",
        ),
      ) as { readonly planSha256: string };
      const controller = await openIngestionControllerForTest({
        approvalPrompt: createControllerApprovalTestPrompt({
          answer: plan.planSha256.slice(0, 12),
        }),
      });
      try {
        const approval = await controller.approve({
          changeId: "nueva-pagina-autoconsumo",
          gate: 1,
          actor: "test-human",
        });
        assert.equal(approval.kind, "success");
        await assert.rejects(
          controller.generate({
            changeId: "nueva-pagina-autoconsumo",
            adapter: "command",
          }),
          /No existe una configuración CommandAgent/u,
        );
        const status = await controller.status("nueva-pagina-autoconsumo");
        assert.equal(status.kind, "success");
        assert.equal(status.value.state, "gate1_approved");
        const attempt = JSON.parse(
          await readFile(
            join(
              clone,
              ".change-state",
              "nueva-pagina-autoconsumo",
              "attempts",
              "attempt-000001.json",
            ),
            "utf8",
          ),
        ) as { readonly status: string };
        assert.equal(attempt.status, "failed");
      } finally {
        await controller.dispose();
      }
    });
  } finally {
    process.chdir(previousCwd);
    if (previousCommandConfig === undefined)
      delete process.env.INGEST_COMMAND_AGENT_CONFIG;
    else process.env.INGEST_COMMAND_AGENT_CONFIG = previousCommandConfig;
  }
});
