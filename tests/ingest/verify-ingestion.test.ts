import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { verifyIngestion } from "../../scripts/verify-ingestion.ts";

const execFileAsync = promisify(execFile);

test("ingestion audit fails closed when a durable candidate fact is missing", async () => {
  const audit = await verifyIngestion({
    controller: {
      async audit() {
        return {
          ok: false,
          changes: [
            {
              changeId: "safe-change",
              state: "validated",
              revision: 7,
              candidate: null,
            },
          ],
          missing: ["change:safe-change"],
        };
      },
    },
  });

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.missing, ["change:safe-change"]);
  assert.doesNotMatch(JSON.stringify(audit), /\/Users\/|PRIVATE KEY/);
});

test("standalone verifier fails closed without exposing configured agent values or a stack", async () => {
  const result = await execFileAsync("npm", ["run", "verify:ingestion"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_EXECUTABLE: "/tmp/verifier-must-not-open-codex",
      API_KEY: "api-key-never-print",
    },
  }).then(
    () => ({ code: 0, stdout: "", stderr: "" }),
    (error: {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
    }),
  );

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /verifier-must-not-open-codex|api-key-never-print|CODEX_EXECUTABLE|API_KEY|argv|bundle|pid|Error:|\bat\s/iu,
  );
});
