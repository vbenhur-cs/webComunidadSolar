import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type GitHubApi } from "../../scripts/preview-evidence/github.ts";
import { runPreviewEvidenceCli } from "../../scripts/preview-evidence/cli.ts";

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

class CliGitHubApi implements GitHubApi {
  async get(path: string): Promise<unknown> {
    const values: Record<string, unknown> = {
      [`/repos/${repository}/pulls/4`]: {
        number: 4,
        state: "open",
        changed_files: 1,
        html_url: `https://github.com/${repository}/pull/4`,
        body: "Resuelve #4",
        base: { ref: "main", sha: baseSha },
        head: {
          ref: "feature/issue-4",
          sha: headSha,
          repo: { full_name: repository },
        },
      },
      [`/repos/${repository}/pulls/4/files?per_page=100&page=1`]: [
        { filename: requestPath, status: "added" },
      ],
      [`/repos/${repository}/contents/evidence/requests/issue-4.yaml?ref=${headSha}`]:
        {
          type: "file",
          path: requestPath,
          encoding: "base64",
          size: Buffer.byteLength(requestYaml),
          content: Buffer.from(requestYaml).toString("base64"),
        },
      [`/repos/${repository}/issues/4`]: {
        number: 4,
        state: "open",
        html_url: `https://github.com/${repository}/issues/4`,
      },
    };
    if (!Object.hasOwn(values, path)) throw new Error("Unexpected API path");
    return structuredClone(values[path]);
  }

  async post(): Promise<unknown> {
    throw new Error("Unexpected POST");
  }

  async patch(): Promise<unknown> {
    throw new Error("Unexpected PATCH");
  }
}

function eventPayload(): Record<string, unknown> {
  return {
    action: "completed",
    repository: { full_name: repository, default_branch: "main" },
    workflow_run: {
      id: 987,
      html_url: `https://github.com/${repository}/actions/runs/987`,
      conclusion: "success",
      event: "pull_request",
      head_branch: "feature/issue-4",
      head_sha: headSha,
      head_repository: { full_name: repository },
      pull_requests: [{ number: 4 }],
    },
  };
}

test("resolve-pr writes a sealed context and safe GitHub outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-"));
  try {
    const event = join(root, "event.json");
    const output = join(root, "github-output");
    const context = join(root, "context.json");
    await writeFile(event, JSON.stringify(eventPayload()), "utf8");
    await writeFile(output, "", "utf8");

    await runPreviewEvidenceCli(
      [
        "resolve-pr",
        "--event",
        event,
        "--output",
        output,
        "--context",
        context,
      ],
      { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: repository },
      { createApi: () => new CliGitHubApi(), stdout: () => undefined },
    );

    const stored = JSON.parse(await readFile(context, "utf8"));
    const outputs = await readFile(output, "utf8");
    assert.equal(stored.headSha, headSha);
    assert.equal(stored.request.route, "/pruebas/guia/");
    assert.match(outputs, /pr_number<<[^\n]+\n4\n/u);
    assert.match(outputs, new RegExp(`head_sha<<[^\\n]+\\n${headSha}\\n`, "u"));
    assert.match(outputs, /context_sha256<<[^\n]+\n[a-f0-9]{64}\n/u);
    assert.equal(outputs.includes("test-token"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown command before reading environment values", async () => {
  const secret = "secret-must-not-escape";
  await assert.rejects(
    runPreviewEvidenceCli(["unknown"], { GITHUB_TOKEN: secret }),
    (error: unknown) => {
      assert.equal(String(error).includes(secret), false);
      return /comando|uso/i.test(String(error));
    },
  );
});

test("validate-request checks the real file without GitHub credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-request-"));
  try {
    const requestDirectory = join(root, "evidence", "requests");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(requestDirectory, { recursive: true });
    await writeFile(
      join(requestDirectory, "issue-4.yaml"),
      requestYaml,
      "utf8",
    );
    const messages: string[] = [];

    await runPreviewEvidenceCli(
      [
        "validate-request",
        "--path",
        "evidence/requests/issue-4.yaml",
        "--root",
        root,
      ],
      {},
      { stdout: (message) => messages.push(message) },
    );

    assert.deepEqual(messages, [
      "EVIDENCE_REQUEST_OK issue=4 route=/pruebas/guia/\n",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
