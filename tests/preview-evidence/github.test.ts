import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type GitHubApi,
  readPullRequestContext,
  resolvePullRequestRun,
  writePullRequestContext,
  writeGitHubOutputs,
} from "../../scripts/preview-evidence/github.ts";

const repository = "vbenhur-cs/webComunidadSolar";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const requestPath = "evidence/requests/issue-4.yaml";
const requestYaml = `schema_version: 1
issue: 4
scope: page
route: /pruebas/guia/
expected_status:
  base: 404
  candidate: 200
viewports: [desktop, mobile]
`;

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

function validPayload(): Record<string, unknown> {
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

function validPullRequest(): Record<string, unknown> {
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
      route: "/pruebas/guia/",
      selector: null,
      expectedStatus: { base: 404, candidate: 200 },
      viewports: ["desktop", "mobile"],
    },
  });
});

test("rejects workflow payloads that do not identify a successful internal PR", async () => {
  const cases: Array<[string, (payload: any) => void, RegExp]> = [
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
    const payload: any = validPayload();
    mutate(payload);
    await assert.rejects(
      resolvePullRequestRun(payload, validApi()),
      expected,
      label,
    );
  }
});

test("rechecks PR state, branch, repository and head through the API", async () => {
  const cases: Array<[string, (pr: any) => void, RegExp]> = [
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
    const pr: any = validPullRequest();
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
