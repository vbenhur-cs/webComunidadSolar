import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  sha256,
} from "../../scripts/preview-evidence/domain.ts";
import type {
  ProductionRollbackDescriptor,
  ProductionVersionDescriptor,
} from "../../scripts/preview-evidence/cloudflare.ts";
import type { GitHubApi } from "../../scripts/preview-evidence/github.ts";
import {
  authorizeProductionRelease,
  materializeProductionProfile,
  publishProductionEvidence,
  readProductionReleaseContext,
  smokeProduction,
  validateProductionUrl,
  writeProductionReleaseContext,
  type ProductionReleaseInput,
} from "../../scripts/preview-evidence/release.ts";

const repository = "vbenhur-cs/webComunidadSolar";
const sourceSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const requestPath = "evidence/requests/issue-4.yaml";
const releaseManifestPath = `issue-4/releases/${sourceSha}/manifest.json`;
const sharedOrigin =
  "https://comunidad-solar-preview.comunidadsolar-dev.workers.dev";
const versionId = "33333333-3333-4333-8333-333333333333";
const productionD1Id = "99999999-8888-4777-8666-555555555555";

class MemoryGitHubApi implements GitHubApi {
  readonly responses = new Map<string, unknown>();
  readonly calls: string[] = [];

  async get(path: string): Promise<unknown> {
    this.calls.push(path);
    if (!this.responses.has(path)) {
      throw new Error(`Unexpected GitHub path: ${path}`);
    }
    return structuredClone(this.responses.get(path));
  }

  async post(): Promise<unknown> {
    throw new Error("Unexpected GitHub POST");
  }

  async patch(): Promise<unknown> {
    throw new Error("Unexpected GitHub PATCH");
  }
}

function productionInput(
  overrides: Partial<ProductionReleaseInput> = {},
): ProductionReleaseInput {
  return {
    enabled: "true",
    repository,
    sourceSha,
    runId: 2001,
    runUrl: `https://github.com/${repository}/actions/runs/2001`,
    ...overrides,
  };
}

function capture(viewport: "desktop" | "mobile", width: number) {
  const filename = `release-${viewport}.png`;
  return {
    role: "release",
    kind: "page",
    sourceSha,
    versionId,
    origin: sharedOrigin,
    url: `${sharedOrigin}/pruebas/guia`,
    route: "/pruebas/guia",
    status: 200,
    viewport: {
      name: viewport,
      width,
      height: viewport === "desktop" ? 1000 : 844,
      deviceScaleFactor: 1,
    },
    selector: null,
    filename,
    bytes: 1234,
    width,
    height: 900,
    sha256: viewport === "desktop" ? "c".repeat(64) : "d".repeat(64),
    pageErrors: 0,
    sameOriginFailures: 0,
    crossOriginFailures: {},
  };
}

function releaseManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "release",
    issue: 4,
    prNumber: 9,
    requestPath,
    route: "/pruebas/guia",
    selector: null,
    source: {
      baseSha: null,
      candidateSha: null,
      releaseSha: sourceSha,
    },
    capturedAt: "2026-09-04T00:00:00.000Z",
    run: {
      id: 1001,
      url: `https://github.com/${repository}/actions/runs/1001`,
      attempt: 1,
    },
    tools: {
      node: "22.22.3",
      playwright: "1.62.1",
      browser: "Chromium 140.0.0.0",
    },
    captures: [capture("desktop", 1440), capture("mobile", 390)],
  };
}

function content(path: string, value: unknown): Record<string, unknown> {
  const body = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  return {
    type: "file",
    path,
    encoding: "base64",
    size: body.length,
    sha: "e".repeat(40),
    content: body.toString("base64"),
  };
}

function validApi(manifest: unknown = releaseManifest()): MemoryGitHubApi {
  const api = new MemoryGitHubApi();
  api.responses.set(`/repos/${repository}/compare/${sourceSha}...main`, {
    status: "ahead",
    merge_base_commit: { sha: sourceSha },
  });
  api.responses.set(
    `/repos/${repository}/commits/${sourceSha}/pulls?per_page=100`,
    [{ number: 9 }],
  );
  api.responses.set(`/repos/${repository}/pulls/9`, {
    number: 9,
    state: "closed",
    merged: true,
    merged_at: "2026-09-03T20:00:00Z",
    merge_commit_sha: sourceSha,
    changed_files: 1,
    html_url: `https://github.com/${repository}/pull/9`,
    head: { sha: candidateSha, repo: { full_name: repository } },
    base: { ref: "main" },
  });
  api.responses.set(`/repos/${repository}/pulls/9/files?per_page=100&page=1`, [
    { filename: requestPath, status: "added" },
  ]);
  api.responses.set(
    `/repos/${repository}/contents/${releaseManifestPath}?ref=evidence`,
    content(releaseManifestPath, manifest),
  );
  api.responses.set(
    `/repos/${repository}/commits/${candidateSha}/status?per_page=100`,
    {
      sha: candidateSha,
      statuses: [
        {
          context: "preview-approved",
          state: "success",
          target_url: `https://github.com/${repository}/actions/runs/987`,
        },
      ],
    },
  );
  return api;
}

test("authorizes only a reachable evidenced release with human preview approval", async () => {
  const api = validApi();
  const context = await authorizeProductionRelease(productionInput(), api);
  const expectedManifest = Buffer.from(
    `${canonicalJson(releaseManifest())}\n`,
    "utf8",
  );

  assert.deepEqual(context, {
    schemaVersion: 1,
    repository,
    runId: 2001,
    runUrl: `https://github.com/${repository}/actions/runs/2001`,
    sourceSha,
    prNumber: 9,
    prUrl: `https://github.com/${repository}/pull/9`,
    issueNumber: 4,
    requestPath,
    route: "/pruebas/guia",
    expectedStatus: 200,
    previewApprovedSha: candidateSha,
    releaseManifestPath,
    releaseManifestSha256: sha256(expectedManifest),
    releaseVersionId: versionId,
  });
});

test("fails closed before API access unless PRODUCTION_ENABLED is literal true", async () => {
  for (const enabled of [
    undefined,
    "",
    "True",
    "TRUE",
    "1",
    " true",
    "true ",
  ]) {
    const api = validApi();
    await assert.rejects(
      authorizeProductionRelease(productionInput({ enabled }), api),
      /PRODUCTION_ENABLED|producci[oó]n|true/i,
    );
    assert.deepEqual(api.calls, []);
  }

  const api = validApi();
  await assert.rejects(
    authorizeProductionRelease(
      productionInput({ sourceSha: "not-a-sha" }),
      api,
    ),
    /sha/i,
  );
  assert.deepEqual(api.calls, []);
});

test("rejects a SHA that is not reachable from main", async () => {
  for (const response of [
    { status: "diverged", merge_base_commit: { sha: "f".repeat(40) } },
    { status: "ahead", merge_base_commit: { sha: "f".repeat(40) } },
  ]) {
    const api = validApi();
    api.responses.set(
      `/repos/${repository}/compare/${sourceSha}...main`,
      response,
    );
    await assert.rejects(
      authorizeProductionRelease(productionInput(), api),
      /main|reachable|alcanzable|ancestro/i,
    );
  }
});

test("rejects absent, mismatched or malformed release evidence", async () => {
  const absent = validApi();
  absent.responses.delete(
    `/repos/${repository}/contents/${releaseManifestPath}?ref=evidence`,
  );
  await assert.rejects(
    authorizeProductionRelease(productionInput(), absent),
    /manifest|evidencia|Unexpected/i,
  );

  const wrongSource = releaseManifest();
  (wrongSource.source as Record<string, unknown>).releaseSha = "f".repeat(40);
  await assert.rejects(
    authorizeProductionRelease(productionInput(), validApi(wrongSource)),
    /manifest|release|sha/i,
  );

  const wrongHash = releaseManifest();
  (
    (wrongHash.captures as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >
  ).sha256 = "not-a-hash";
  await assert.rejects(
    authorizeProductionRelease(productionInput(), validApi(wrongHash)),
    /hash|sha256|manifest/i,
  );
});

test("requires the latest preview-approved status on the candidate SHA", async () => {
  const missing = validApi();
  missing.responses.set(
    `/repos/${repository}/commits/${candidateSha}/status?per_page=100`,
    { sha: candidateSha, statuses: [] },
  );
  await assert.rejects(
    authorizeProductionRelease(productionInput(), missing),
    /preview-approved|status|aprob/i,
  );

  const failed = validApi();
  failed.responses.set(
    `/repos/${repository}/commits/${candidateSha}/status?per_page=100`,
    {
      sha: candidateSha,
      statuses: [
        {
          context: "preview-approved",
          state: "failure",
          target_url: `https://github.com/${repository}/actions/runs/987`,
        },
        {
          context: "preview-approved",
          state: "success",
          target_url: `https://github.com/${repository}/actions/runs/986`,
        },
      ],
    },
  );
  await assert.rejects(
    authorizeProductionRelease(productionInput(), failed),
    /preview-approved|status|success/i,
  );

  const unsafeTarget = validApi();
  unsafeTarget.responses.set(
    `/repos/${repository}/commits/${candidateSha}/status?per_page=100`,
    {
      sha: candidateSha,
      statuses: [
        {
          context: "preview-approved",
          state: "success",
          target_url: `https://github.com/${repository}/issues/4`,
        },
      ],
    },
  );
  await assert.rejects(
    authorizeProductionRelease(productionInput(), unsafeTarget),
    /aprobaci[oó]n|actions|run|url/i,
  );
});

test("keeps production navigation inside the exact configured HTTPS origin", () => {
  assert.equal(
    validateProductionUrl(
      "https://www.comunidadsolar.es/",
      "https://www.comunidadsolar.es/pruebas/guia",
    ),
    "https://www.comunidadsolar.es/pruebas/guia",
  );
  for (const candidate of [
    "http://www.comunidadsolar.es/pruebas/guia",
    "https://evil.example/pruebas/guia",
    "https://www.comunidadsolar.es:444/pruebas/guia",
    "https://user@www.comunidadsolar.es/pruebas/guia",
    "https://www.comunidadsolar.es/pruebas/guia?token=x",
  ]) {
    assert.throws(
      () => validateProductionUrl("https://www.comunidadsolar.es/", candidate),
      /producci[oó]n|url|origen|https/i,
    );
  }
});

function productionProfile(indexable: "true" | "false" = "true"): string {
  return JSON.stringify({
    name: "comunidad-solar-production",
    main: "./src/worker.ts",
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      binding: "ASSETS",
      directory: "./dist",
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "comunidad-solar-production",
        database_id: productionD1Id,
        migrations_dir: "./drizzle",
      },
    ],
    vars: { SITE_INDEXABLE: indexable },
  });
}

test("materializes only an explicitly indexable production profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-profile-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "drizzle"));
    await writeFile(join(root, "src", "worker.ts"), "export default {};\n");
    const output = join(root, ".artifacts", "production-profile");
    const encoded = Buffer.from(productionProfile(), "utf8").toString("base64");

    const artifact = await materializeProductionProfile(encoded, output, root);
    const sanitized = JSON.parse(await readFile(artifact.path, "utf8"));
    assert.deepEqual(await readdir(output), ["config"]);
    assert.equal(artifact.workerName, "comunidad-solar-production");
    assert.equal(artifact.databaseName, "comunidad-solar-production");
    assert.equal(artifact.databaseId, productionD1Id);
    assert.equal(artifact.indexable, true);
    assert.deepEqual(sanitized.vars, { SITE_INDEXABLE: "true" });
    assert.equal(sanitized.workers_dev, undefined);
    assert.equal(sanitized.preview_urls, undefined);

    const disabledOutput = join(root, ".artifacts", "disabled-profile");
    await assert.rejects(
      materializeProductionProfile(
        Buffer.from(productionProfile("false"), "utf8").toString("base64"),
        disabledOutput,
        root,
      ),
      /SITE_INDEXABLE|indexable|producci[oó]n/i,
    );
    assert.deepEqual(await readdir(disabledOutput), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seals the authorized production context and rejects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-context-"));
  try {
    const context = await authorizeProductionRelease(
      productionInput(),
      validApi(),
    );
    const path = join(root, "context.json");
    const sealed = await writeProductionReleaseContext(path, context);
    assert.equal(sealed.path, path);
    assert.match(sealed.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      await readProductionReleaseContext(path, sealed.sha256),
      context,
    );

    const altered = { ...context, route: "/otra/" };
    await writeFile(path, `${canonicalJson(altered)}\n`);
    await assert.rejects(
      readProductionReleaseContext(path, sealed.sha256),
      /hash|integridad|context/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("smokes the exact production route and publishes one append-only record", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-evidence-"));
  const context = await authorizeProductionRelease(
    productionInput(),
    validApi(),
  );
  const descriptor: ProductionVersionDescriptor = {
    schemaVersion: 1,
    sourceSha,
    bundleSha256: "f".repeat(64),
    workerName: "comunidad-solar-production",
    versionId,
    tag: `production-${sourceSha.slice(0, 7)}`,
  };
  const rollback: ProductionRollbackDescriptor = {
    schemaVersion: 1,
    workerName: "comunidad-solar-production",
    sourceSha,
    previousDeploymentId: "11111111-1111-4111-8111-111111111111",
    previousVersions: [
      {
        versionId: "22222222-2222-4222-8222-222222222222",
        percentage: 100,
      },
    ],
    newDeploymentId: "33333333-3333-4333-8333-333333333333",
    newVersionId: versionId,
    runUrl: context.runUrl,
  };
  try {
    const record = await smokeProduction(
      {
        context,
        descriptor,
        rollback,
        configuredOrigin: "https://www.comunidadsolar.es/",
        runAttempt: 1,
      },
      async (url) => ({ status: 200, finalUrl: url }),
      () => new Date("2026-09-04T00:30:00.000Z"),
    );
    assert.equal(
      record.productionUrl,
      "https://www.comunidadsolar.es/pruebas/guia",
    );
    assert.equal(record.status, 200);
    assert.equal(
      record.rollback.previousDeploymentId,
      rollback.previousDeploymentId,
    );

    const first = await publishProductionEvidence(record, root);
    assert.deepEqual(first, {
      relativePath: `issue-4/production/${sourceSha}/manifest.json`,
      state: "new",
    });
    assert.deepEqual(await publishProductionEvidence(record, root), {
      relativePath: `issue-4/production/${sourceSha}/manifest.json`,
      state: "existing",
    });
    const stored = JSON.parse(
      await readFile(join(root, first.relativePath), "utf8"),
    );
    assert.deepEqual(stored, record);
    await assert.rejects(
      publishProductionEvidence(
        { ...record, checkedAt: "2026-09-04T00:31:00.000Z" },
        root,
      ),
      /append-only|colisi[oó]n|existe/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
