import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runCli, type CliController } from "../../src/ingest/cli.ts";
import { openIngestionAuditController } from "../../src/ingest/controller.ts";
import { safeError, safeJson } from "../../src/ingest/safe-output.ts";

function controller(overrides: Partial<CliController> = {}): CliController {
  return {
    async receiveRequest() {
      return { kind: "success", value: { changeId: "safe-change" } };
    },
    async plan() {
      return { kind: "success", value: { changeId: "safe-change" } };
    },
    async approve() {
      return { kind: "success", value: { changeId: "safe-change" } };
    },
    async generate() {
      return { kind: "success", value: { changeId: "safe-change" } };
    },
    async validate() {
      return { kind: "success", value: { changeId: "safe-change" } };
    },
    async preview() {
      return { kind: "success", value: { changeId: "safe-change" } };
    },
    async status() {
      return { kind: "success", value: { changeId: "safe-change" } };
    },
    ...overrides,
  };
}

test("CLI returns 2 exactly when Gate 1 is pending", async () => {
  const result = await runCli(
    ["generate", "planned-change", "--adapter", "codex"],
    {
      controller: controller({
        async generate() {
          return { kind: "gate-pending", gate: 1 };
        },
      }),
    },
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Gate 1 pendiente/i);
});

test("production CLI rejects fixture adapters and hidden e2e commands before controller work", async () => {
  let calls = 0;
  const guarded = controller({
    async generate() {
      calls += 1;
      return { kind: "success", value: { changeId: "safe-change" } };
    },
  });

  const fixture = await runCli(
    ["generate", "fixture-forbidden", "--adapter", "fixture"],
    { controller: guarded },
  );
  const hidden = await runCli(["e2e", "--fixture", "detailed-request"], {
    controller: guarded,
  });

  assert.equal(fixture.exitCode, 3);
  assert.equal(hidden.exitCode, 3);
  assert.equal(calls, 0);
});

test("production audit and CLI reject fixture tag configuration", async () => {
  const previousCodex = process.env.CODEX_EXECUTABLE;
  const previousCommand = process.env.INGEST_COMMAND_AGENT_CONFIG;
  let opened:
    Awaited<ReturnType<typeof openIngestionAuditController>> | undefined;
  delete process.env.CODEX_EXECUTABLE;
  delete process.env.INGEST_COMMAND_AGENT_CONFIG;
  try {
    await assert.rejects(async () => {
      opened = await (
        openIngestionAuditController as unknown as (
          options: unknown,
        ) => ReturnType<typeof openIngestionAuditController>
      )({ fixtureAuditTags: { "fixture-request-blocks": "a".repeat(40) } });
    }, /auditoría.*configuración|configuración.*auditoría/i);
  } finally {
    await opened?.dispose().catch(() => undefined);
    if (previousCodex === undefined) delete process.env.CODEX_EXECUTABLE;
    else process.env.CODEX_EXECUTABLE = previousCodex;
    if (previousCommand === undefined)
      delete process.env.INGEST_COMMAND_AGENT_CONFIG;
    else process.env.INGEST_COMMAND_AGENT_CONFIG = previousCommand;
  }

  let calls = 0;
  const result = await runCli(
    ["status", "safe-change", "--fixture-audit-tags", "fixture-request-blocks"],
    {
      controller: controller({
        async status() {
          calls += 1;
          return { kind: "success", value: { changeId: "safe-change" } };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(calls, 0);
});

test("status JSON redacts intake paths, secrets and capability-shaped fields", async () => {
  const result = await runCli(["status", "safe-change", "--json"], {
    controller: controller({
      async status() {
        return {
          kind: "success",
          value: {
            changeId: "safe-change",
            state: "planned",
            intakePath: "/Users/operator/PRIVATE KEY.txt",
            secret: "PRIVATE KEY",
            capability: { token: "never-print" },
            safeFact: "planned",
          },
        };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"safeFact":"planned"/);
  assert.doesNotMatch(result.stdout, /PRIVATE KEY|\/Users\/|never-print/);
});

test("CLI output and operational errors remove environment, argv and runtime internals", async () => {
  const result = await runCli(["status", "safe-change", "--json"], {
    controller: controller({
      async status() {
        return {
          kind: "success",
          value: {
            changeId: "safe-change",
            environment: { API_KEY: "api-key-never-print" },
            argv: ["--token", "argv-never-print"],
            pid: 4242,
            bundle: "/tmp/private-bundle",
            repository: "/Users/operator/private-repository",
            internal: { capability: "never-print" },
            renderedLocation: "file:///tmp/private-artifact",
            hostLocation: "C:\\private\\artifact",
            safeFact: "planned",
          },
        };
      },
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"safeFact":"planned"/u);
  assert.doesNotMatch(
    result.stdout,
    /api-key-never-print|argv-never-print|4242|private-bundle|private-repository|private-artifact|C:\\private|never-print|environment|argv|pid|bundle|repository|internal|capability/iu,
  );

  const failed = await runCli(["status", "safe-change"], {
    controller: controller({
      async status() {
        throw new Error(
          "API_KEY=api-key-never-print argv=argv-never-print pid=4242 bundle=/tmp/private-bundle",
        );
      },
    }),
  });
  assert.equal(failed.exitCode, 1);
  assert.doesNotMatch(
    failed.stderr,
    /api-key-never-print|argv-never-print|4242|private-bundle|API_KEY|argv|pid|bundle|Error:|\bat\s/iu,
  );

  const failedPath = await runCli(["status", "safe-change"], {
    controller: controller({
      async status() {
        throw new Error("fallo al leer file:///tmp/private-artifact");
      },
    }),
  });
  assert.equal(failedPath.exitCode, 1);
  assert.doesNotMatch(failedPath.stderr, /private-artifact|file:\/\//iu);
});

test("safe output redacts absolute paths after punctuation delimiters", () => {
  assert.equal(safeError(new Error("failure(/tmp/benign)")), "fallo operativo");
  assert.deepEqual(
    safeJson({ nested: { note: "x[/Users/example/private]" } }),
    { nested: { note: "[redactado]" } },
  );
});

test("unknown and malformed options fail before a transition", async () => {
  let calls = 0;
  const result = await runCli(["status", "safe-change", "--unexpected"], {
    controller: controller({
      async status() {
        calls += 1;
        return { kind: "success", value: { changeId: "safe-change" } };
      },
    }),
  });

  assert.equal(result.exitCode, 3);
  assert.equal(calls, 0);
});

test("an option documented for another command fails before a transition", async () => {
  let calls = 0;
  const result = await runCli(["status", "safe-change", "--adapter", "codex"], {
    controller: controller({
      async status() {
        calls += 1;
        return { kind: "success", value: { changeId: "safe-change" } };
      },
    }),
  });

  assert.equal(result.exitCode, 3);
  assert.equal(calls, 0);
});

test("production CLI and controller source graphs do not import fixture or test infrastructure", async () => {
  const root = process.cwd();
  const sources = await Promise.all(
    ["src/ingest/cli.ts", "src/ingest/controller.ts"].map(async (path) => ({
      path,
      source: await readFile(join(root, path), "utf8"),
    })),
  );

  for (const { path, source } of sources) {
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:fixture|tests|e2e)[^"']*["']/iu,
      path,
    );
    assert.doesNotMatch(
      source,
      /FixtureAgent|TestApprovalPrompt|--record|fixtureAuditTags/iu,
    );
  }
});

test("the production controller exposes no injectable approval prompt authority", async () => {
  const root = process.cwd();
  const [controllerSource, promptModule] = await Promise.all([
    readFile(join(root, "src/ingest/controller.ts"), "utf8"),
    import("../../src/ingest/approvals/prompt.ts"),
  ]);

  assert.doesNotMatch(
    controllerSource,
    /approvalPrompt|ApprovalPromptCapability|ControllerApprovalTestPrompt/iu,
  );
  assert.equal(
    "createControllerApprovalTestPrompt" in promptModule,
    false,
    "a production-reachable module must not mint controller/production approvals",
  );
});
