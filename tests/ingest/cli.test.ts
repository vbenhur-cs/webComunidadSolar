import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runCli, type CliController } from "../../src/ingest/cli.ts";
import { openIngestionAuditController } from "../../src/ingest/controller.ts";
import {
  safeCliJson,
  safeError,
  safeJson,
} from "../../src/ingest/safe-output.ts";

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
  assert.match(result.stdout, /"state":"planned"/);
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
            state: "planned",
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
  assert.match(result.stdout, /"state":"planned"/u);
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
    "[redactado]",
  );
});

test("safe output redacts paths and credentials without relying on delimiters", () => {
  const unsafeValues = [
    "x-/tmp/private",
    "x+/tmp/private",
    "x|/tmp/private",
    "x&/tmp/private",
    "x./tmp/private",
    "Bearer bearer-token-never-print",
    "cookie=session-never-print",
  ];

  for (const value of unsafeValues) {
    assert.equal(safeJson({ note: value }), "[redactado]");
    assert.equal(safeError(new Error(`failure ${value}`)), "fallo operativo");
  }
});

test("safe output closes unknown byte containers and sid errors while CLI preserves allowlisted status facts", async () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;

  assert.equal(safeError(new Error("sid=9ad836f1c7b6")), "fallo operativo");
  assert.equal(
    safeJson({ payload: Buffer.from("Bearer supersecret-cookie=abc") }),
    "[redactado]",
  );
  assert.equal(
    safeJson(new Uint8Array([66, 101, 97, 114, 101, 114])),
    "[redactado]",
  );
  assert.equal(safeJson(cyclic), "[redactado]");
  assert.equal(
    safeJson({
      nested: { value: new Uint8Array([99, 111, 111, 107, 105, 101]) },
    }),
    "[redactado]",
  );
  assert.equal(
    safeCliJson({ payload: Buffer.from("Bearer supersecret-cookie=abc") }),
    "[redactado]",
  );

  const result = await runCli(["status", "safe-change", "--json"], {
    controller: controller({
      async status() {
        return {
          kind: "success",
          value: {
            changeId: "safe-change",
            state: "planned",
            revision: 4,
            attemptId: "attempt-000001",
            pendingGate: 1,
            candidate: null,
            payload: Buffer.from("Bearer supersecret-cookie=abc"),
            nested: { token: "sid=9ad836f1c7b6" },
          },
        };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    changeId: "safe-change",
    state: "planned",
    revision: 4,
    attemptId: "attempt-000001",
    pendingGate: 1,
    candidate: null,
  });
  assert.doesNotMatch(
    result.stdout,
    /supersecret|cookie|sid=|payload|nested|token/iu,
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

test("CLI never reflects untrusted command or parser input in rejections", async () => {
  const sentinel = "/tmp/cli-secret-sentinel";
  let calls = 0;
  const guarded = controller({
    async status() {
      calls += 1;
      return { kind: "success", value: { changeId: "safe-change" } };
    },
  });

  const results = await Promise.all([
    runCli([sentinel], { controller: guarded }),
    runCli(["status", "safe-change", "--unknown", sentinel], {
      controller: guarded,
    }),
    runCli(["status", sentinel, "extra-argument"], {
      controller: guarded,
    }),
  ]);

  for (const result of results) {
    assert.equal(result.exitCode, 3);
    assert.doesNotMatch(result.stderr, /cli-secret-sentinel|\/tmp\//iu);
  }
  assert.equal(results[0]?.stderr, "Comando no permitido\n");
  assert.equal(results[1]?.stderr, "Opciones inválidas\n");
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
