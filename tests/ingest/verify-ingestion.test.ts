import assert from "node:assert/strict";
import test from "node:test";

import { verifyIngestion } from "../../scripts/verify-ingestion.ts";

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
