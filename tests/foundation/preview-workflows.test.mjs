import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const workflowPath = ".github/workflows/pr-preview.yml";

function serialized(value) {
  return JSON.stringify(value);
}

function commands(job) {
  return job.steps
    .map((step) => step.run)
    .filter((command) => typeof command === "string");
}

function checkoutRefs(job) {
  return job.steps
    .filter(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout@"),
    )
    .map((step) => step.with?.ref);
}

function assertPinnedActions(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses === undefined) continue;
      assert.match(
        step.uses,
        /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/u,
        `${step.uses} debe estar fijada a un commit inmutable`,
      );
    }
  }
}

test("isolates untrusted builds from preview secrets and write permissions", async () => {
  const workflow = parse(await readFile(workflowPath, "utf8"));

  assert.equal(workflow.name, "PR preview evidence");
  assert.deepEqual(workflow.on, {
    workflow_run: {
      workflows: ["Production readiness"],
      types: ["completed"],
    },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), [
    "resolve",
    "profile",
    "build",
    "upload",
    "capture",
    "evidence",
    "approve",
  ]);

  const resolve = workflow.jobs.resolve;
  assert.match(resolve.if, /conclusion\s*==\s*'success'/u);
  assert.match(resolve.if, /event\s*==\s*'pull_request'/u);
  assert.deepEqual(resolve.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  assert.equal(serialized(resolve).includes("secrets."), false);
  assert.match(commands(resolve).join("\n"), /resolve-pr/u);

  const profile = workflow.jobs.profile;
  assert.equal(profile.environment, "preview");
  assert.deepEqual(profile.needs, ["resolve"]);
  assert.match(serialized(profile), /secrets\.CLOUDFLARE_PREVIEW_CONFIG_B64/u);
  assert.equal(
    serialized(workflow).match(/secrets\.CLOUDFLARE_PREVIEW_CONFIG_B64/gu)
      ?.length,
    1,
  );

  const build = workflow.jobs.build;
  assert.equal(build.environment, undefined);
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.equal(serialized(build).includes("secrets."), false);
  assert.equal(serialized(build).includes("github.token"), false);
  assert.deepEqual(
    build.strategy.matrix.include.map(({ role }) => role),
    ["base", "candidate"],
  );
  const buildCheckouts = build.steps.filter(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@"),
  );
  assert.equal(buildCheckouts.length, 2);
  assert.equal(buildCheckouts[1].with["persist-credentials"], false);
  assert.equal(buildCheckouts[1].with.ref, "${{ matrix.sha }}");
  assert.match(commands(build).join("\n"), /npm ci --ignore-scripts/u);
  assert.match(commands(build).join("\n"), /npm run build/u);
  assert.match(
    commands(build).join("\n"),
    /find dist drizzle -type f -exec chmod 0644/u,
  );
  assert.match(commands(build).join("\n"), /seal-bundle/u);
  const bundleUpload = build.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.match(bundleUpload.with.name, /matrix\.role/u);
  assert.match(bundleUpload.with.name, /matrix\.sha/u);
  assert.match(bundleUpload.with.name, /github\.run_id/u);
  assert.equal(bundleUpload.with["include-hidden-files"], true);

  const upload = workflow.jobs.upload;
  assert.equal(upload.environment, "preview");
  assert.deepEqual(upload.permissions, { contents: "read" });
  assert.match(serialized(upload), /secrets\.CLOUDFLARE_API_TOKEN/u);
  assert.equal(
    serialized(workflow).match(/secrets\.CLOUDFLARE_API_TOKEN/gu)?.length,
    1,
  );
  assert.match(commands(upload).join("\n"), /verify-bundle/u);
  assert.match(commands(upload).join("\n"), /upload-version/u);
  assert.deepEqual(checkoutRefs(upload), ["main"]);

  const capture = workflow.jobs.capture;
  assert.deepEqual(capture.permissions, { contents: "read" });
  assert.equal(capture.environment, undefined);
  assert.equal(serialized(capture).includes("secrets."), false);
  assert.match(
    commands(capture).join("\n"),
    /playwright install --with-deps chromium/u,
  );
  assert.match(commands(capture).join("\n"), /capture-pr/u);

  const evidence = workflow.jobs.evidence;
  assert.deepEqual(evidence.permissions, {
    contents: "write",
    issues: "write",
    "pull-requests": "write",
  });
  assert.deepEqual(evidence.concurrency, {
    group: "evidence-write-${{ github.repository }}",
    "cancel-in-progress": false,
  });
  assert.equal(serialized(evidence).includes("secrets."), false);
  assert.equal(serialized(evidence).includes("matrix.sha"), false);
  assert.deepEqual(checkoutRefs(evidence), ["main", "evidence"]);
  assert.match(commands(evidence).join("\n"), /publish-evidence/u);
  assert.match(
    commands(evidence).join("\n"),
    /git -C evidence push origin HEAD:evidence/u,
  );
  assert.match(commands(evidence).join("\n"), /comment-evidence/u);

  const approve = workflow.jobs.approve;
  assert.equal(approve.name, "preview-approved");
  assert.deepEqual(approve.needs, ["resolve", "evidence"]);
  assert.equal(approve.environment, "premerge-review");
  assert.deepEqual(approve.permissions, {
    contents: "read",
    "pull-requests": "read",
    statuses: "write",
  });
  assert.match(commands(approve).join("\n"), /approve-preview/u);
  assert.equal(serialized(approve).includes("secrets."), false);

  assert.equal(serialized(workflow).includes("comunidadsolar.es"), false);
  assert.equal(serialized(workflow).includes("Raiola"), false);
  assertPinnedActions(workflow);
});
