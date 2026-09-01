import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runCli, type CliController } from "../../src/ingest/cli.ts";

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
    assert.doesNotMatch(source, /FixtureAgent|TestApprovalPrompt|--record/iu);
  }
});
