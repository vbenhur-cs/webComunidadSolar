import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const workflowPath = ".github/workflows/verify.yml";

function stepCommands(job) {
  return job.steps
    .map((step) => step.run)
    .filter((command) => typeof command === "string");
}

function assertPinnedAction(action) {
  assert.match(
    action,
    /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/u,
    `${action} debe estar fijada a un commit inmutable`,
  );
}

test("makes production-readiness the stable provider-neutral merge gate", async () => {
  const workflow = parse(await readFile(workflowPath, "utf8"));

  assert.equal(workflow.name, "Production readiness");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(workflow.concurrency.group, /github\.workflow/u);
  assert.match(workflow.concurrency.group, /github\.ref/u);

  const triggers = workflow.on;
  assert.deepEqual(triggers.push.branches, ["main"]);
  assert.deepEqual(triggers.pull_request.branches, ["main"]);
  assert.deepEqual(triggers.workflow_dispatch, {});

  const quality = workflow.jobs.quality;
  assert.equal(quality["timeout-minutes"], 30);
  assert.equal(quality.permissions.contents, "read");
  assert.deepEqual(stepCommands(quality), [
    "npm ci",
    "npm run source:check -- --if-present",
    "npm run format:check",
    "npm run lint",
    "npm run check",
    "npm test",
  ]);

  const runtime = workflow.jobs["runtime-contracts"];
  assert.equal(runtime["timeout-minutes"], 30);
  assert.deepEqual(stepCommands(runtime), [
    "npm ci",
    "npx playwright install --with-deps chromium",
    "npm run test:integration",
    "npm run test:dev",
    "npm run verify:public",
    "npm run verify:links",
    "npm run verify:server",
    "npm run deploy:dry",
  ]);

  const independent = workflow.jobs["independent-build"];
  assert.equal(independent["timeout-minutes"], 30);
  assert.deepEqual(stepCommands(independent), [
    "npm ci",
    "npm run verify:independent",
  ]);

  for (const job of [quality, runtime, independent]) {
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(job.steps[1].with["node-version"], "22.12.0");
    assert.equal(job.steps[1].with.cache, "npm");
    assertPinnedAction(job.steps[0].uses);
    assertPinnedAction(job.steps[1].uses);
  }

  const gate = workflow.jobs["production-readiness"];
  assert.equal(gate.name, "production-readiness");
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, [
    "quality",
    "runtime-contracts",
    "independent-build",
  ]);
  assert.equal(gate["timeout-minutes"], 5);
  assert.match(stepCommands(gate)[0], /QUALITY_RESULT/u);
  assert.match(stepCommands(gate)[0], /RUNTIME_RESULT/u);
  assert.match(stepCommands(gate)[0], /INDEPENDENT_RESULT/u);
});
