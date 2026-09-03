import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const workflowPath = ".github/workflows/pr-preview.yml";
const sharedWorkflowPath = ".github/workflows/shared-preview.yml";
const productionWorkflowPath = ".github/workflows/production.yml";

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

test("deploys only the verified current main SHA to the shared preview", async () => {
  const workflow = parse(await readFile(sharedWorkflowPath, "utf8"));

  assert.equal(workflow.name, "Shared preview release");
  assert.deepEqual(workflow.on, {
    workflow_run: {
      workflows: ["Production readiness"],
      types: ["completed"],
    },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "shared-preview-${{ github.repository }}",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), [
    "resolve",
    "profile",
    "build",
    "release",
    "capture",
    "evidence",
  ]);

  const resolve = workflow.jobs.resolve;
  assert.match(resolve.if, /conclusion\s*==\s*'success'/u);
  assert.match(resolve.if, /event\s*==\s*'push'/u);
  assert.match(resolve.if, /head_branch\s*==\s*'main'/u);
  assert.deepEqual(resolve.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  assert.equal(serialized(resolve).includes("secrets."), false);
  assert.match(serialized(resolve), /vars\.PREVIEW_PIPELINE_BOOTSTRAP_PR/u);
  assert.match(commands(resolve).join("\n"), /resolve-main/u);

  for (const name of ["profile", "build", "release", "capture", "evidence"]) {
    assert.match(
      workflow.jobs[name].if,
      /needs\.resolve\.outputs\.bootstrap\s*!=\s*'true'/u,
      `${name} debe omitir el despliegue bootstrap`,
    );
  }

  const profile = workflow.jobs.profile;
  assert.equal(profile.environment, "preview");
  assert.match(commands(profile).join("\n"), /materialize-profile/u);
  assert.match(serialized(profile), /CLOUDFLARE_PREVIEW_CONFIG_B64/u);

  const build = workflow.jobs.build;
  assert.equal(build.environment, undefined);
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.equal(serialized(build).includes("secrets."), false);
  assert.equal(serialized(build).includes("github.token"), false);
  assert.deepEqual(checkoutRefs(build), [
    "main",
    "${{ needs.resolve.outputs.source_sha }}",
  ]);
  assert.match(commands(build).join("\n"), /npm ci --ignore-scripts/u);
  assert.match(commands(build).join("\n"), /npm run build/u);
  assert.match(
    commands(build).join("\n"),
    /find dist drizzle -type f -exec chmod 0644/u,
  );
  assert.match(commands(build).join("\n"), /seal-bundle[\s\S]*--role release/u);

  const release = workflow.jobs.release;
  assert.equal(release.environment, "preview");
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.match(serialized(release), /vars\.CLOUDFLARE_ACCOUNT_ID/u);
  assert.match(serialized(release), /secrets\.CLOUDFLARE_API_TOKEN/u);
  const releaseCommands = commands(release).join("\n");
  assert.match(releaseCommands, /verify-bundle/u);
  assert.match(releaseCommands, /recheck-main/u);
  assert.match(releaseCommands, /upload-version[\s\S]*--role release/u);
  assert.match(releaseCommands, /deploy-version/u);
  assert.ok(
    releaseCommands.indexOf("recheck-main") <
      releaseCommands.indexOf("upload-version"),
  );
  assert.ok(
    releaseCommands.indexOf("upload-version") <
      releaseCommands.indexOf("deploy-version"),
  );
  assert.equal(releaseCommands.includes("wrangler deploy"), false);

  const capture = workflow.jobs.capture;
  assert.equal(capture.environment, "preview");
  assert.deepEqual(capture.permissions, { contents: "read" });
  assert.equal(serialized(capture).includes("secrets."), false);
  assert.match(serialized(capture), /vars\.CLOUDFLARE_PREVIEW_URL/u);
  assert.match(
    commands(capture).join("\n"),
    /capture-release[\s\S]*--shared-url/u,
  );
  assert.match(
    commands(capture).join("\n"),
    /playwright install --with-deps chromium/u,
  );

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
  assert.deepEqual(checkoutRefs(evidence), ["main", "evidence"]);
  assert.match(commands(evidence).join("\n"), /publish-release-evidence/u);
  assert.match(
    commands(evidence).join("\n"),
    /git -C evidence push origin HEAD:evidence/u,
  );
  assert.match(commands(evidence).join("\n"), /comment-release-evidence/u);

  const serializedWorkflow = serialized(workflow);
  assert.equal(serializedWorkflow.includes("comunidadsolar.es"), false);
  assert.equal(serializedWorkflow.includes("Raiola"), false);
  assert.equal(serializedWorkflow.includes("PRODUCTION_ENABLED"), false);
  assert.equal(serializedWorkflow.includes("CLOUDFLARE_PRODUCTION"), false);
  assert.equal(
    serializedWorkflow.match(/secrets\.CLOUDFLARE_API_TOKEN/gu)?.length,
    1,
  );
  assertPinnedActions(workflow);
});

test("keeps production manual, protected and closed before credentials", async () => {
  const workflow = parse(await readFile(productionWorkflowPath, "utf8"));

  assert.equal(workflow.name, "Production release");
  assert.deepEqual(workflow.on, {
    workflow_dispatch: {
      inputs: {
        sha: {
          description: "SHA de main aprobado para producción",
          required: true,
          type: "string",
        },
      },
    },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "production-${{ github.repository }}",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), [
    "authorize",
    "profile",
    "build",
    "deploy",
    "smoke",
    "evidence",
  ]);

  const authorize = workflow.jobs.authorize;
  assert.match(authorize.if, /github\.ref\s*==\s*'refs\/heads\/main'/u);
  assert.equal(authorize.environment, "production");
  assert.deepEqual(authorize.permissions, {
    contents: "read",
    "pull-requests": "read",
    statuses: "read",
  });
  assert.deepEqual(authorize.needs, undefined);
  assert.equal(serialized(authorize).includes("secrets."), false);
  assert.equal(serialized(authorize).includes("CLOUDFLARE_API_TOKEN"), false);
  assert.match(serialized(authorize), /vars\.PRODUCTION_ENABLED/u);
  assert.match(commands(authorize).join("\n"), /authorize-production/u);
  assert.match(serialized(authorize), /github\.event\.inputs\.sha/u);

  const profile = workflow.jobs.profile;
  assert.deepEqual(profile.needs, ["authorize"]);
  assert.equal(profile.environment, "production");
  assert.match(
    serialized(profile),
    /secrets\.CLOUDFLARE_PRODUCTION_CONFIG_B64/u,
  );
  assert.match(commands(profile).join("\n"), /materialize-production-profile/u);

  const build = workflow.jobs.build;
  assert.deepEqual(build.needs, ["authorize", "profile"]);
  assert.equal(build.environment, undefined);
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.equal(serialized(build).includes("secrets."), false);
  assert.equal(serialized(build).includes("github.token"), false);
  assert.deepEqual(checkoutRefs(build), [
    "${{ github.workflow_sha }}",
    "${{ needs.authorize.outputs.source_sha }}",
  ]);
  assert.match(commands(build).join("\n"), /npm ci --ignore-scripts/u);
  assert.match(commands(build).join("\n"), /npm run build/u);
  assert.match(
    commands(build).join("\n"),
    /seal-bundle[\s\S]*--target production/u,
  );

  const deploy = workflow.jobs.deploy;
  assert.deepEqual(deploy.needs, ["authorize", "profile", "build"]);
  assert.equal(deploy.environment, "production");
  assert.deepEqual(deploy.permissions, { contents: "read" });
  const serializedDeploy = serialized(deploy);
  assert.match(serializedDeploy, /vars\.CLOUDFLARE_PRODUCTION_ACCOUNT_ID/u);
  assert.match(serializedDeploy, /secrets\.CLOUDFLARE_PRODUCTION_API_TOKEN/u);
  assert.equal(serializedDeploy.includes("CLOUDFLARE_PREVIEW"), false);
  const deployCommands = commands(deploy).join("\n");
  assert.match(deployCommands, /verify-bundle[\s\S]*--target production/u);
  assert.match(deployCommands, /reauthorize-production/u);
  assert.match(deployCommands, /upload-production-version/u);
  assert.match(deployCommands, /deploy-production-version/u);
  assert.ok(
    deployCommands.indexOf("reauthorize-production") <
      deployCommands.indexOf("upload-production-version"),
  );
  assert.ok(
    deployCommands.indexOf("upload-production-version") <
      deployCommands.indexOf("deploy-production-version"),
  );
  assert.equal(deployCommands.includes("wrangler deploy"), false);
  const rollbackArtifact = deploy.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@") &&
      String(step.with?.name).startsWith("production-rollback-"),
  );
  assert.ok(rollbackArtifact);
  assert.equal(rollbackArtifact.with["if-no-files-found"], "error");

  const smoke = workflow.jobs.smoke;
  assert.deepEqual(smoke.needs, ["authorize", "deploy"]);
  assert.equal(smoke.environment, "production");
  assert.deepEqual(smoke.permissions, { contents: "read" });
  assert.equal(serialized(smoke).includes("secrets."), false);
  assert.match(serialized(smoke), /vars\.CLOUDFLARE_PRODUCTION_URL/u);
  assert.match(commands(smoke).join("\n"), /smoke-production/u);

  const evidence = workflow.jobs.evidence;
  assert.deepEqual(evidence.needs, ["authorize", "smoke"]);
  assert.deepEqual(evidence.permissions, { contents: "write" });
  assert.equal(serialized(evidence).includes("secrets."), false);
  assert.deepEqual(checkoutRefs(evidence), [
    "${{ github.workflow_sha }}",
    "evidence",
  ]);
  assert.match(commands(evidence).join("\n"), /publish-production-evidence/u);
  assert.match(
    commands(evidence).join("\n"),
    /git -C evidence push origin HEAD:evidence/u,
  );

  const whole = serialized(workflow);
  assert.equal(whole.includes("CLOUDFLARE_ACCOUNT_ID"), false);
  assert.equal(whole.includes("secrets.CLOUDFLARE_API_TOKEN"), false);
  assert.equal(whole.includes("comunidadsolar.es"), false);
  assert.equal(whole.includes("Raiola"), false);
  assert.equal(/\b(?:dig|nslookup|dns|nameserver)\b/iu.test(whole), false);
  assert.equal(
    whole.match(/secrets\.CLOUDFLARE_PRODUCTION_API_TOKEN/gu)?.length,
    1,
  );
  assertPinnedActions(workflow);
});
