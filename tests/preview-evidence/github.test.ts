import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  approvePreviewForCurrentPullRequest,
  assertCurrentMainHead,
  type GitHubApi,
  readPullRequestContext,
  resolveMainRun,
  resolvePullRequestRun,
  setPreviewApprovalStatus,
  upsertEvidenceComments,
  upsertReleaseEvidenceComments,
  writePullRequestContext,
  writeGitHubOutputs,
} from "../../scripts/preview-evidence/github.ts";
import type { PublishEvidenceResult } from "../../scripts/preview-evidence/evidence.ts";

const repository = "vbenhur-cs/webComunidadSolar";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const requestPath = "evidence/requests/issue-4.yaml";
const requestYaml = `schema_version: 1
issue: 4
scope: page
route: /pruebas/guia
expected_status:
  base: 404
  candidate: 200
viewports: [desktop, mobile]
`;

interface WorkflowPayloadFixture {
  action: string;
  repository: { full_name: string; default_branch: string };
  workflow_run: {
    id: number;
    html_url: string;
    conclusion: string;
    event: string;
    head_branch: string;
    head_sha: string;
    head_repository: { full_name: string };
    pull_requests: Array<{ number: number }>;
  };
}

interface PullRequestFixture {
  number: number;
  state: string;
  changed_files: number;
  html_url: string;
  body: string;
  base: { ref: string; sha: string };
  head: {
    sha: string;
    ref: string;
    repo: { full_name: string };
  };
}

class MemoryGitHubApi implements GitHubApi {
  readonly responses = new Map<string, unknown>();

  async get(path: string): Promise<unknown> {
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

function validPayload(): WorkflowPayloadFixture {
  return {
    action: "completed",
    repository: {
      full_name: repository,
      default_branch: "main",
    },
    workflow_run: {
      id: 987,
      html_url:
        "https://github.com/vbenhur-cs/webComunidadSolar/actions/runs/987",
      conclusion: "success",
      event: "pull_request",
      head_branch: "feature/issue-4",
      head_sha: headSha,
      head_repository: { full_name: repository },
      pull_requests: [{ number: 4 }],
    },
  };
}

function validPullRequest(): PullRequestFixture {
  return {
    number: 4,
    state: "open",
    changed_files: 1,
    html_url: "https://github.com/vbenhur-cs/webComunidadSolar/pull/4",
    body: "Implementa la solicitud #4.",
    base: { ref: "main", sha: baseSha },
    head: {
      sha: headSha,
      ref: "feature/issue-4",
      repo: { full_name: repository },
    },
  };
}

function validApi(): MemoryGitHubApi {
  const api = new MemoryGitHubApi();
  api.responses.set(`/repos/${repository}/pulls/4`, validPullRequest());
  api.responses.set(`/repos/${repository}/pulls/4/files?per_page=100&page=1`, [
    { filename: requestPath, status: "added" },
  ]);
  api.responses.set(
    `/repos/${repository}/contents/evidence/requests/issue-4.yaml?ref=${headSha}`,
    {
      type: "file",
      path: requestPath,
      encoding: "base64",
      size: Buffer.byteLength(requestYaml),
      content: Buffer.from(requestYaml, "utf8").toString("base64"),
    },
  );
  api.responses.set(`/repos/${repository}/issues/4`, {
    number: 4,
    state: "open",
    html_url: "https://github.com/vbenhur-cs/webComunidadSolar/issues/4",
  });
  return api;
}

interface MainWorkflowPayloadFixture extends WorkflowPayloadFixture {
  workflow_run: WorkflowPayloadFixture["workflow_run"] & {
    head_branch: string;
  };
}

function validMainPayload(): MainWorkflowPayloadFixture {
  const payload = validPayload();
  payload.workflow_run.event = "push";
  payload.workflow_run.head_branch = "main";
  payload.workflow_run.pull_requests = [];
  return payload;
}

function validMergedPullRequest(): Record<string, unknown> {
  return {
    number: 9,
    state: "closed",
    merged: true,
    merged_at: "2026-09-03T20:00:00Z",
    merge_commit_sha: headSha,
    changed_files: 2,
    html_url: `https://github.com/${repository}/pull/9`,
    body: "Implementa la solicitud #4.",
    base: { ref: "main", sha: baseSha },
    head: {
      sha: "c".repeat(40),
      ref: "feature/issue-4",
      repo: { full_name: repository },
    },
  };
}

function validMainApi(): MemoryGitHubApi {
  const api = new MemoryGitHubApi();
  api.responses.set(`/repos/${repository}/branches/main`, {
    name: "main",
    commit: { sha: headSha },
  });
  api.responses.set(
    `/repos/${repository}/commits/${headSha}/pulls?per_page=100`,
    [{ number: 9 }],
  );
  api.responses.set(`/repos/${repository}/pulls/9`, validMergedPullRequest());
  api.responses.set(`/repos/${repository}/pulls/9/files?per_page=100&page=1`, [
    { filename: requestPath, status: "added" },
    { filename: "src/pages/pruebas/guia.astro", status: "added" },
  ]);
  api.responses.set(
    `/repos/${repository}/contents/evidence/requests/issue-4.yaml?ref=${headSha}`,
    {
      type: "file",
      path: requestPath,
      encoding: "base64",
      size: Buffer.byteLength(requestYaml),
      content: Buffer.from(requestYaml, "utf8").toString("base64"),
    },
  );
  api.responses.set(`/repos/${repository}/issues/4`, {
    number: 4,
    state: "open",
    html_url: `https://github.com/${repository}/issues/4`,
  });
  return api;
}

test("resolves a green main head and its unique merged PR into a release context", async () => {
  const resolved = await resolveMainRun(validMainPayload(), validMainApi());

  assert.deepEqual(resolved, {
    kind: "release",
    context: {
      schemaVersion: 1,
      repository,
      issueNumber: 4,
      issueUrl: `https://github.com/${repository}/issues/4`,
      prNumber: 9,
      prUrl: `https://github.com/${repository}/pull/9`,
      runId: 987,
      runUrl: `https://github.com/${repository}/actions/runs/987`,
      sourceSha: headSha,
      requestPath,
      request: {
        schemaVersion: 1,
        issue: 4,
        scope: "page",
        route: "/pruebas/guia",
        selector: null,
        expectedStatus: { base: 404, candidate: 200 },
        viewports: ["desktop", "mobile"],
      },
    },
  });
});

test("rejects main runs that are not the successful current main head", async () => {
  const cases: Array<
    [string, (payload: MainWorkflowPayloadFixture) => void, RegExp]
  > = [
    [
      "conclusion",
      (payload) => {
        payload.workflow_run.conclusion = "failure";
      },
      /success|exitosa/i,
    ],
    [
      "source event",
      (payload) => {
        payload.workflow_run.event = "pull_request";
      },
      /push/i,
    ],
    [
      "head branch",
      (payload) => {
        payload.workflow_run.head_branch = "develop";
      },
      /main/i,
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    const payload = validMainPayload();
    mutate(payload);
    await assert.rejects(
      resolveMainRun(payload, validMainApi()),
      expected,
      label,
    );
  }

  const moved = validMainApi();
  moved.responses.set(`/repos/${repository}/branches/main`, {
    name: "main",
    commit: { sha: "d".repeat(40) },
  });
  await assert.rejects(
    resolveMainRun(validMainPayload(), moved),
    /main|sha|punta/i,
  );
});

test("requires one exact merged PR associated with the current main SHA", async () => {
  for (const associations of [[], [{ number: 9 }, { number: 10 }]]) {
    const api = validMainApi();
    api.responses.set(
      `/repos/${repository}/commits/${headSha}/pulls?per_page=100`,
      associations,
    );
    await assert.rejects(
      resolveMainRun(validMainPayload(), api),
      /exactamente una|merged|fusionada|pull request/i,
    );
  }

  const cases: Array<[string, unknown, RegExp]> = [
    ["not merged", null, /merged|fusionada/i],
    ["wrong merge sha", "d".repeat(40), /merge|sha|main/i],
  ];
  for (const [label, mergedAtOrSha, expected] of cases) {
    const api = validMainApi();
    const pr = validMergedPullRequest();
    if (label === "not merged") {
      pr.merged = false;
      pr.merged_at = mergedAtOrSha;
    } else {
      pr.merge_commit_sha = mergedAtOrSha;
    }
    api.responses.set(`/repos/${repository}/pulls/9`, pr);
    await assert.rejects(
      resolveMainRun(validMainPayload(), api),
      expected,
      label,
    );
  }
});

test("requires the merged PR request at the exact main SHA", async () => {
  const missing = validMainApi();
  missing.responses.set(`/repos/${repository}/pulls/9`, {
    ...validMergedPullRequest(),
    changed_files: 1,
  });
  missing.responses.set(
    `/repos/${repository}/pulls/9/files?per_page=100&page=1`,
    [{ filename: "src/pages/index.astro", status: "modified" }],
  );
  await assert.rejects(
    resolveMainRun(validMainPayload(), missing),
    /request|solicitud|bootstrap/i,
  );

  const multiple = validMainApi();
  multiple.responses.set(`/repos/${repository}/pulls/9`, {
    ...validMergedPullRequest(),
    changed_files: 2,
  });
  multiple.responses.set(
    `/repos/${repository}/pulls/9/files?per_page=100&page=1`,
    [
      { filename: requestPath, status: "added" },
      { filename: "evidence/requests/issue-5.yaml", status: "added" },
    ],
  );
  await assert.rejects(
    resolveMainRun(validMainPayload(), multiple),
    /exactamente una|request|solicitud/i,
  );
});

test("permits bootstrap only for the configured PR and allowlisted pipeline paths", async () => {
  const bootstrapApi = validMainApi();
  bootstrapApi.responses.set(`/repos/${repository}/pulls/9`, {
    ...validMergedPullRequest(),
    changed_files: 8,
  });
  bootstrapApi.responses.set(
    `/repos/${repository}/pulls/9/files?per_page=100&page=1`,
    [
      { filename: ".github/workflows/shared-preview.yml", status: "added" },
      { filename: "scripts/preview-evidence/github.ts", status: "modified" },
      {
        filename:
          "docs/superpowers/specs/2026-09-03-pr-preview-evidence-design.md",
        status: "modified",
      },
      {
        filename: "tests/foundation/preview-documentation.test.mjs",
        status: "added",
      },
      {
        filename: "tests/fixtures/ingestion/stress-locks.ts",
        status: "modified",
      },
      {
        filename: "tests/ingest/state-store.test.ts",
        status: "modified",
      },
      {
        filename: "tests/e2e/editorial.spec.ts",
        status: "modified",
      },
      {
        filename: "src/ingest/state-store.ts",
        status: "modified",
      },
    ],
  );

  assert.deepEqual(
    await resolveMainRun(validMainPayload(), bootstrapApi, "9"),
    {
      kind: "bootstrap",
      repository,
      runId: 987,
      runUrl: `https://github.com/${repository}/actions/runs/987`,
      prNumber: 9,
      prUrl: `https://github.com/${repository}/pull/9`,
      sourceSha: headSha,
    },
  );

  await assert.rejects(
    resolveMainRun(validMainPayload(), bootstrapApi, "8"),
    /bootstrap|request|solicitud/i,
  );
  await assert.rejects(
    resolveMainRun(validMainPayload(), bootstrapApi, "09"),
    /bootstrap|num[eé]ric|configuraci[oó]n/i,
  );

  const escaped = validMainApi();
  escaped.responses.set(`/repos/${repository}/pulls/9`, {
    ...validMergedPullRequest(),
    changed_files: 1,
  });
  escaped.responses.set(
    `/repos/${repository}/pulls/9/files?per_page=100&page=1`,
    [{ filename: "src/pages/index.astro", status: "modified" }],
  );
  await assert.rejects(
    resolveMainRun(validMainPayload(), escaped, "9"),
    /allowlist|permitid|bootstrap/i,
  );
});

test("rechecks the exact main head immediately before release", async () => {
  const resolved = await resolveMainRun(validMainPayload(), validMainApi());
  assert.equal(resolved.kind, "release");
  if (resolved.kind !== "release") return;

  const current = new MemoryGitHubApi();
  current.responses.set(`/repos/${repository}/branches/main`, {
    name: "main",
    commit: { sha: headSha },
  });
  await assert.doesNotReject(assertCurrentMainHead(current, resolved.context));

  const moved = new MemoryGitHubApi();
  moved.responses.set(`/repos/${repository}/branches/main`, {
    name: "main",
    commit: { sha: "d".repeat(40) },
  });
  await assert.rejects(
    assertCurrentMainHead(moved, resolved.context),
    /main|sha|cambi[oó]|punta/i,
  );
});

test("resolves one internal green PR into an authoritative sanitized context", async () => {
  const context = await resolvePullRequestRun(validPayload(), validApi());

  assert.deepEqual(context, {
    repository,
    runId: 987,
    runUrl: "https://github.com/vbenhur-cs/webComunidadSolar/actions/runs/987",
    prNumber: 4,
    prUrl: "https://github.com/vbenhur-cs/webComunidadSolar/pull/4",
    issueNumber: 4,
    issueUrl: "https://github.com/vbenhur-cs/webComunidadSolar/issues/4",
    baseSha,
    headSha,
    requestPath,
    request: {
      schemaVersion: 1,
      issue: 4,
      scope: "page",
      route: "/pruebas/guia",
      selector: null,
      expectedStatus: { base: 404, candidate: 200 },
      viewports: ["desktop", "mobile"],
    },
  });
});

test("rejects workflow payloads that do not identify a successful internal PR", async () => {
  const cases: Array<
    [string, (payload: WorkflowPayloadFixture) => void, RegExp]
  > = [
    [
      "conclusion",
      (payload) => {
        payload.workflow_run.conclusion = "failure";
      },
      /success|exitosa/i,
    ],
    [
      "source event",
      (payload) => {
        payload.workflow_run.event = "push";
      },
      /pull_request/i,
    ],
    [
      "fork payload",
      (payload) => {
        payload.workflow_run.head_repository.full_name = "outside/fork";
      },
      /intern|fork|repositorio/i,
    ],
    [
      "head sha",
      (payload) => {
        payload.workflow_run.head_sha = "short";
      },
      /sha/i,
    ],
    [
      "multiple PRs",
      (payload) => {
        payload.workflow_run.pull_requests.push({ number: 5 });
      },
      /pull request|PR/i,
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    const payload = validPayload();
    mutate(payload);
    await assert.rejects(
      resolvePullRequestRun(payload, validApi()),
      expected,
      label,
    );
  }
});

test("rechecks PR state, branch, repository and head through the API", async () => {
  const cases: Array<[string, (pr: PullRequestFixture) => void, RegExp]> = [
    [
      "closed",
      (pr) => {
        pr.state = "closed";
      },
      /abierta|open/i,
    ],
    [
      "base branch",
      (pr) => {
        pr.base.ref = "develop";
      },
      /main|base/i,
    ],
    [
      "head mismatch",
      (pr) => {
        pr.head.sha = "c".repeat(40);
      },
      /head|sha/i,
    ],
    [
      "fork API",
      (pr) => {
        pr.head.repo.full_name = "outside/fork";
      },
      /intern|fork|repositorio/i,
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    const api = validApi();
    const pr = validPullRequest();
    mutate(pr);
    api.responses.set(`/repos/${repository}/pulls/4`, pr);
    await assert.rejects(
      resolvePullRequestRun(validPayload(), api),
      expected,
      label,
    );
  }
});

test("requires exactly one changed evidence request and rejects migrations", async () => {
  const cases: Array<[string, Array<Record<string, unknown>>, number, RegExp]> =
    [
      [
        "missing request",
        [{ filename: "README.md", status: "modified" }],
        1,
        /request|solicitud/i,
      ],
      [
        "multiple requests",
        [
          { filename: requestPath, status: "added" },
          { filename: "evidence/requests/issue-5.yaml", status: "added" },
        ],
        2,
        /exactamente una|request/i,
      ],
      [
        "migration",
        [
          { filename: requestPath, status: "added" },
          { filename: "drizzle/0002_change.sql", status: "added" },
        ],
        2,
        /migraci|drizzle/i,
      ],
    ];

  for (const [label, files, changedFiles, expected] of cases) {
    const api = validApi();
    api.responses.set(`/repos/${repository}/pulls/4`, {
      ...validPullRequest(),
      changed_files: changedFiles,
    });
    api.responses.set(
      `/repos/${repository}/pulls/4/files?per_page=100&page=1`,
      files,
    );
    await assert.rejects(
      resolvePullRequestRun(validPayload(), api),
      expected,
      label,
    );
  }

  const oversized = validApi();
  oversized.responses.set(`/repos/${repository}/pulls/4`, {
    ...validPullRequest(),
    changed_files: 301,
  });
  await assert.rejects(
    resolvePullRequestRun(validPayload(), oversized),
    /300|archivos/i,
  );
});

test("requires the open source issue to be linked from the PR", async () => {
  const missingLink = validApi();
  missingLink.responses.set(`/repos/${repository}/pulls/4`, {
    ...validPullRequest(),
    body: "Cambio sin referencia trazable.",
  });
  await assert.rejects(
    resolvePullRequestRun(validPayload(), missingLink),
    /issue|enlaz/i,
  );

  const closedIssue = validApi();
  closedIssue.responses.set(`/repos/${repository}/issues/4`, {
    number: 4,
    state: "closed",
    html_url: "https://github.com/vbenhur-cs/webComunidadSolar/issues/4",
  });
  await assert.rejects(
    resolvePullRequestRun(validPayload(), closedIssue),
    /issue.*abierta|open/i,
  );
});

test("rejects malformed or mismatched GitHub content before returning context", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "wrong encoding",
      {
        type: "file",
        path: requestPath,
        encoding: "utf8",
        size: 10,
        content: requestYaml,
      },
      /base64|content/i,
    ],
    [
      "oversized",
      {
        type: "file",
        path: requestPath,
        encoding: "base64",
        size: 70_000,
        content: "YQ==",
      },
      /64 KiB|tamaño/i,
    ],
    [
      "wrong path",
      {
        type: "file",
        path: "README.md",
        encoding: "base64",
        size: 4,
        content: "YQ==",
      },
      /path|ruta/i,
    ],
  ];

  for (const [label, content, expected] of cases) {
    const api = validApi();
    api.responses.set(
      `/repos/${repository}/contents/evidence/requests/issue-4.yaml?ref=${headSha}`,
      content,
    );
    await assert.rejects(
      resolvePullRequestRun(validPayload(), api),
      expected,
      label,
    );
  }
});

test("writes multiline GitHub outputs without command injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "github-output-"));
  try {
    const path = join(root, "output");
    await writeFile(path, "", "utf8");
    await writeGitHubOutputs(path, {
      head_sha: headSha,
      context_path: "/tmp/context\nsecond-line",
    });
    const written = await readFile(path, "utf8");

    assert.match(written, new RegExp(`head_sha<<([^\\n]+)\\n${headSha}\\n\\1`));
    assert.match(
      written,
      /context_path<<([^\n]+)\n\/tmp\/context\nsecond-line\n\1/u,
    );
    assert.equal(written.includes("::set-output"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe GitHub output keys and symlink destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "github-output-"));
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    await writeFile(target, "", "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, link);

    await assert.rejects(
      writeGitHubOutputs(target, { "unsafe-key": "value" }),
      /key|output/i,
    );
    await assert.rejects(
      writeGitHubOutputs(link, { safe_key: "value" }),
      /symlink|regular/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seals and reloads the sanitized PR context by digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "github-context-"));
  try {
    const path = join(root, "context.json");
    const context = await resolvePullRequestRun(validPayload(), validApi());
    const sealed = await writePullRequestContext(path, context);

    assert.equal(sealed.path, path);
    assert.match(sealed.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      await readPullRequestContext(path, sealed.sha256),
      context,
    );

    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.headSha = "c".repeat(40);
    await writeFile(path, JSON.stringify(parsed), "utf8");
    await assert.rejects(
      readPullRequestContext(path, sealed.sha256),
      /hash|integridad/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class RecordingGitHubApi implements GitHubApi {
  readonly responses = new Map<string, unknown>();
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];

  async get(path: string): Promise<unknown> {
    this.calls.push({ method: "GET", path });
    if (!this.responses.has(path)) {
      throw new Error(`Unexpected GitHub path: ${path}`);
    }
    return structuredClone(this.responses.get(path));
  }

  async post(path: string, body: unknown): Promise<unknown> {
    this.calls.push({ method: "POST", path, body: structuredClone(body) });
    return { id: 100 };
  }

  async patch(path: string, body: unknown): Promise<unknown> {
    this.calls.push({ method: "PATCH", path, body: structuredClone(body) });
    return { id: 101 };
  }
}

function reportingContext() {
  return {
    repository,
    runId: 987,
    runUrl: `https://github.com/${repository}/actions/runs/987`,
    prNumber: 9,
    prUrl: `https://github.com/${repository}/pull/9`,
    issueNumber: 4,
    issueUrl: `https://github.com/${repository}/issues/4`,
    baseSha,
    headSha,
    requestPath,
    request: {
      schemaVersion: 1 as const,
      issue: 4,
      scope: "page" as const,
      route: "/pruebas/guia",
      selector: null,
      expectedStatus: { base: 404 as const, candidate: 200 as const },
      viewports: ["desktop", "mobile"] as const,
    },
  };
}

function publication(): PublishEvidenceResult {
  return {
    schemaVersion: 1,
    kind: "pull-request",
    repository,
    issueNumber: 4,
    prNumber: 9,
    source: { baseSha, headSha, releaseSha: null },
    runUrl: `https://github.com/${repository}/actions/runs/987`,
    entries: [
      {
        role: "base",
        sourceSha: baseSha,
        relativeDirectory: `issue-4/baseline/${baseSha}`,
        previewUrl:
          "https://pr-9-base-aaaaaaa-comunidad-solar-preview.comunidadsolar-dev.workers.dev/pruebas/guia",
        manifestUrl: `https://github.com/${repository}/blob/evidence/issue-4/baseline/${baseSha}/manifest.json`,
        pngs: [
          {
            filename: "before-desktop.png",
            rawUrl: `https://raw.githubusercontent.com/${repository}/evidence/issue-4/baseline/${baseSha}/before-desktop.png`,
          },
          {
            filename: "before-mobile.png",
            rawUrl: `https://raw.githubusercontent.com/${repository}/evidence/issue-4/baseline/${baseSha}/before-mobile.png`,
          },
        ],
      },
      {
        role: "candidate",
        sourceSha: headSha,
        relativeDirectory: `issue-4/candidates/${headSha}`,
        previewUrl:
          "https://pr-9-head-bbbbbbb-comunidad-solar-preview.comunidadsolar-dev.workers.dev/pruebas/guia",
        manifestUrl: `https://github.com/${repository}/blob/evidence/issue-4/candidates/${headSha}/manifest.json`,
        pngs: [
          {
            filename: "after-desktop.png",
            rawUrl: `https://raw.githubusercontent.com/${repository}/evidence/issue-4/candidates/${headSha}/after-desktop.png`,
          },
          {
            filename: "after-mobile.png",
            rawUrl: `https://raw.githubusercontent.com/${repository}/evidence/issue-4/candidates/${headSha}/after-mobile.png`,
          },
        ],
      },
    ],
    addedPaths: [],
    existingPaths: [
      `issue-4/baseline/${baseSha}/before-desktop.png`,
      `issue-4/baseline/${baseSha}/before-mobile.png`,
      `issue-4/baseline/${baseSha}/manifest.json`,
      `issue-4/candidates/${headSha}/after-desktop.png`,
      `issue-4/candidates/${headSha}/after-mobile.png`,
      `issue-4/candidates/${headSha}/manifest.json`,
    ],
    commitMessage: "evidence: record issue 4 candidate bbbbbbb",
  };
}

function releasePublication(): PublishEvidenceResult {
  return {
    schemaVersion: 1,
    kind: "release",
    repository,
    issueNumber: 4,
    prNumber: 9,
    source: { baseSha: null, headSha: null, releaseSha: headSha },
    runUrl: `https://github.com/${repository}/actions/runs/1001`,
    entries: [
      {
        role: "release",
        sourceSha: headSha,
        relativeDirectory: `issue-4/releases/${headSha}`,
        previewUrl:
          "https://comunidad-solar-preview.comunidadsolar-dev.workers.dev/pruebas/guia",
        manifestUrl: `https://github.com/${repository}/blob/evidence/issue-4/releases/${headSha}/manifest.json`,
        pngs: [
          {
            filename: "release-desktop.png",
            rawUrl: `https://raw.githubusercontent.com/${repository}/evidence/issue-4/releases/${headSha}/release-desktop.png`,
          },
          {
            filename: "release-mobile.png",
            rawUrl: `https://raw.githubusercontent.com/${repository}/evidence/issue-4/releases/${headSha}/release-mobile.png`,
          },
        ],
      },
    ],
    addedPaths: [],
    existingPaths: [
      `issue-4/releases/${headSha}/manifest.json`,
      `issue-4/releases/${headSha}/release-desktop.png`,
      `issue-4/releases/${headSha}/release-mobile.png`,
    ],
    commitMessage: "evidence: record issue 4 release bbbbbbb",
  };
}

test("creates bounded evidence comments on the PR and linked issue", async () => {
  const api = new RecordingGitHubApi();
  api.responses.set(`/repos/${repository}/issues/9/comments?per_page=100`, []);
  api.responses.set(`/repos/${repository}/issues/4/comments?per_page=100`, []);
  const evidenceCommitSha = "e".repeat(40);

  await upsertEvidenceComments(api, {
    context: reportingContext(),
    publication: publication(),
    evidenceCommitSha,
  });

  const writes = api.calls.filter((call) => call.method !== "GET");
  assert.deepEqual(
    writes.map((call) => [call.method, call.path]),
    [
      ["POST", `/repos/${repository}/issues/9/comments`],
      ["POST", `/repos/${repository}/issues/4/comments`],
    ],
  );
  for (const call of writes) {
    assert.deepEqual(Object.keys(call.body as object), ["body"]);
    const body = (call.body as { body: string }).body;
    assert.match(
      body,
      new RegExp(`<!-- preview-evidence:issue-4:${headSha} -->`, "u"),
    );
    assert.match(body, new RegExp(baseSha, "u"));
    assert.match(body, new RegExp(headSha, "u"));
    assert.match(body, /pr-9-base-aaaaaaa-[^\s)]+\.workers\.dev/u);
    assert.match(body, /pr-9-head-bbbbbbb-[^\s)]+\.workers\.dev/u);
    assert.match(body, /raw\.githubusercontent\.com/u);
    assert.match(body, /manifest\.json/u);
    assert.match(body, new RegExp(`/commit/${evidenceCommitSha}`, "u"));
    assert.match(body, /pendiente.*revisi[oó]n humana/i);
    assert.ok(Buffer.byteLength(body) < 64 * 1024);
  }
});

test("comments the immutable shared-preview release on the merged PR and issue", async () => {
  const api = new RecordingGitHubApi();
  api.responses.set(`/repos/${repository}/issues/9/comments?per_page=100`, []);
  api.responses.set(`/repos/${repository}/issues/4/comments?per_page=100`, []);
  const evidenceCommitSha = "e".repeat(40);

  await upsertReleaseEvidenceComments(api, {
    context: {
      schemaVersion: 1,
      repository,
      issueNumber: 4,
      issueUrl: `https://github.com/${repository}/issues/4`,
      prNumber: 9,
      prUrl: `https://github.com/${repository}/pull/9`,
      runId: 1001,
      runUrl: `https://github.com/${repository}/actions/runs/1001`,
      sourceSha: headSha,
      requestPath,
      request: reportingContext().request,
    },
    publication: releasePublication(),
    evidenceCommitSha,
  });

  const writes = api.calls.filter((call) => call.method !== "GET");
  assert.deepEqual(
    writes.map((call) => [call.method, call.path]),
    [
      ["POST", `/repos/${repository}/issues/9/comments`],
      ["POST", `/repos/${repository}/issues/4/comments`],
    ],
  );
  for (const call of writes) {
    const body = (call.body as { body: string }).body;
    assert.match(
      body,
      new RegExp(`<!-- preview-release:issue-4:${headSha} -->`, "u"),
    );
    assert.match(body, new RegExp(headSha, "u"));
    assert.match(body, /comunidad-solar-preview[^\s)]+\.workers\.dev/u);
    assert.match(body, /release-desktop\.png/u);
    assert.match(body, new RegExp(`/commit/${evidenceCommitSha}`, "u"));
    assert.match(body, /release|desplegad[ao]|compartid[ao]/i);
    assert.ok(Buffer.byteLength(body) < 64 * 1024);
  }
});

test("patches one exact marker and rejects duplicate markers before writing", async () => {
  const marker = `<!-- preview-evidence:issue-4:${headSha} -->`;
  const api = new RecordingGitHubApi();
  api.responses.set(`/repos/${repository}/issues/9/comments?per_page=100`, [
    { id: 91, body: `old\n${marker}` },
  ]);
  api.responses.set(`/repos/${repository}/issues/4/comments?per_page=100`, [
    { id: 41, body: marker },
  ]);
  await upsertEvidenceComments(api, {
    context: reportingContext(),
    publication: publication(),
    evidenceCommitSha: "e".repeat(40),
  });
  assert.deepEqual(
    api.calls
      .filter((call) => call.method === "PATCH")
      .map((call) => call.path),
    [
      `/repos/${repository}/issues/comments/91`,
      `/repos/${repository}/issues/comments/41`,
    ],
  );

  const duplicate = new RecordingGitHubApi();
  duplicate.responses.set(
    `/repos/${repository}/issues/9/comments?per_page=100`,
    [
      { id: 91, body: marker },
      { id: 92, body: `prefix\n${marker}\nsuffix` },
    ],
  );
  duplicate.responses.set(
    `/repos/${repository}/issues/4/comments?per_page=100`,
    [],
  );
  await assert.rejects(
    upsertEvidenceComments(duplicate, {
      context: reportingContext(),
      publication: publication(),
      evidenceCommitSha: "e".repeat(40),
    }),
    /m[uú]ltiples|marcador/i,
  );
  assert.equal(
    duplicate.calls.some((call) => call.method !== "GET"),
    false,
  );
});

test("scans bounded long unrelated comments without treating them as markers", async () => {
  const api = new RecordingGitHubApi();
  api.responses.set(`/repos/${repository}/issues/9/comments?per_page=100`, [
    { id: 90, body: "x".repeat(10_000) },
  ]);
  api.responses.set(`/repos/${repository}/issues/4/comments?per_page=100`, []);
  await upsertEvidenceComments(api, {
    context: reportingContext(),
    publication: publication(),
    evidenceCommitSha: "e".repeat(40),
  });
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 2);
});

test("sets preview-approved only on the exact candidate SHA", async () => {
  const api = new RecordingGitHubApi();
  const targetUrl = `https://github.com/${repository}/actions/runs/987`;
  await setPreviewApprovalStatus(
    api,
    repository,
    headSha,
    "success",
    targetUrl,
  );
  assert.deepEqual(api.calls, [
    {
      method: "POST",
      path: `/repos/${repository}/statuses/${headSha}`,
      body: {
        state: "success",
        context: "preview-approved",
        description: "Preview y evidencia aprobadas por una persona",
        target_url: targetUrl,
      },
    },
  ]);

  const invalid = new RecordingGitHubApi();
  await assert.rejects(
    setPreviewApprovalStatus(
      invalid,
      repository,
      "short",
      "success",
      targetUrl,
    ),
    /SHA/i,
  );
  await assert.rejects(
    setPreviewApprovalStatus(
      invalid,
      repository,
      headSha,
      "success",
      "https://example.com/actions/runs/987",
    ),
    /URL|run|GitHub/i,
  );
  assert.deepEqual(invalid.calls, []);
});

test("rechecks the open PR head immediately before approval", async () => {
  const api = new RecordingGitHubApi();
  api.responses.set(`/repos/${repository}/pulls/9`, {
    number: 9,
    state: "open",
    head: { sha: headSha },
  });
  await approvePreviewForCurrentPullRequest(api, reportingContext());
  assert.deepEqual(
    api.calls.map((call) => [call.method, call.path]),
    [
      ["GET", `/repos/${repository}/pulls/9`],
      ["POST", `/repos/${repository}/statuses/${headSha}`],
    ],
  );

  const changed = new RecordingGitHubApi();
  changed.responses.set(`/repos/${repository}/pulls/9`, {
    number: 9,
    state: "open",
    head: { sha: "c".repeat(40) },
  });
  await assert.rejects(
    approvePreviewForCurrentPullRequest(changed, reportingContext()),
    /cambi[oó]|head|SHA/i,
  );
  assert.equal(
    changed.calls.some((call) => call.method === "POST"),
    false,
  );
});
