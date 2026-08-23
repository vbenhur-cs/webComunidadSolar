import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNormalizedRequest,
  maxRequestBytes,
  parseSafeYaml,
  readRequestBytes,
} from "../../src/ingest/importers/common.ts";
import { importRequest } from "../../src/ingest/importers/request.ts";

const fixture = (name: string): string =>
  fileURLToPath(
    new URL(`../fixtures/ingestion/detailed-request/${name}`, import.meta.url),
  );

async function withTemporaryArtifactRoot<T>(
  callback: (artifactRoot: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-request-artifacts-"),
  );
  try {
    return await callback(join(root, "artifacts"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

for (const name of ["request.json", "request.yaml", "request.md"]) {
  test(`normalizes ${name} to the same request contract`, async () => {
    const result = await withTemporaryArtifactRoot((artifactRoot) =>
      importRequest(fixture(name), { artifactRoot }),
    );

    assert.equal(result.changeId, "nueva-pagina-autoconsumo");
    assert.equal(result.targetPath, "/autoconsumo-compartido");
    assert.equal(result.acceptanceCriteria.length, 3);
    assert.equal(
      result.content,
      "Compartir energía reduce la factura.\nLa comunidad conserva el control.\n",
    );
    assert.equal(result.inputKind, "request");
    assert.match(result.inputSha256, /^[a-f0-9]{64}$/u);
  });
}

test("gives equivalent JSON, YAML, and Markdown requests the same canonical hash", async () => {
  const [json, yaml, markdown] = await withTemporaryArtifactRoot(
    (artifactRoot) =>
      Promise.all(
        ["request.json", "request.yaml", "request.md"].map((name) =>
          importRequest(fixture(name), { artifactRoot }),
        ),
      ),
  );

  assert.deepEqual(yaml, json);
  assert.deepEqual(markdown, json);
  assert.equal(json.inputSha256, yaml.inputSha256);
  assert.equal(json.inputSha256, markdown.inputSha256);
});

test("normalizes Unicode to NFC and line endings to LF before hashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-nfc-"));
  const input = join(root, "request.json");

  try {
    await writeFile(
      input,
      JSON.stringify({
        changeId: "nueva-pagina-autoconsumo",
        intent: "Explicar el autoconsumo compartido",
        targetPath: "/autoconsumo-compartido",
        acceptanceCriteria: ["La ruta responde 200"],
        content: "Energi\u0301a compartida\r\n",
      }),
      "utf8",
    );
    const result = await importRequest(input, {
      artifactRoot: join(root, "artifacts"),
    });

    assert.equal(result.content, "Energía compartida\n");
    assert.equal(result.intent, "Explicar el autoconsumo compartido");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts Markdown frontmatter with CRLF after normalizing delimiters", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-crlf-"));
  const input = join(root, "request.md");

  try {
    await writeFile(
      input,
      [
        "---",
        "changeId: nueva-pagina-autoconsumo",
        "intent: Explicar el autoconsumo compartido",
        "targetPath: /autoconsumo-compartido",
        "acceptanceCriteria:",
        "  - La ruta responde 200",
        "---",
        "",
        "Energi\u0301a compartida.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const result = await importRequest(input, {
      artifactRoot: join(root, "artifacts"),
    });

    assert.equal(result.content, "Energía compartida.\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("copies the original request under the supplied artifact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-raw-"));
  const artifactRoot = join(root, "artifacts");

  try {
    const input = fixture("request.yaml");
    const original = await readFile(input);
    const result = await importRequest(input, { artifactRoot });
    const rawDirectory = join(
      artifactRoot,
      "intake",
      result.changeId,
      result.inputSha256,
      "raw",
    );
    const files = await readdir(rawDirectory);

    assert.equal(files.length, 1);
    assert.match(files[0] ?? "", /^[a-f0-9]{64}\.yaml$/u);
    assert.deepEqual(
      await readFile(join(rawDirectory, files[0] ?? "")),
      original,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("publishes one durable, private raw leaf across identical imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-publish-"));
  const artifactRoot = join(root, "artifacts");
  const input = fixture("request.yaml");
  const original = await readFile(input);
  const probe = await open(root);
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    sync: () => Promise<void>;
  };
  const originalSync = fileHandlePrototype.sync;
  let directorySyncs = 0;

  try {
    await probe.close();
    fileHandlePrototype.sync = async function sync(): Promise<void> {
      const entry = await (
        this as unknown as {
          stat: () => Promise<{ isDirectory: () => boolean }>;
        }
      ).stat();
      if (entry.isDirectory()) {
        directorySyncs += 1;
      }
      return originalSync.call(this);
    };

    const first = await importRequest(input, { artifactRoot });
    const rawDirectory = join(
      artifactRoot,
      "intake",
      first.changeId,
      first.inputSha256,
      "raw",
    );
    const [leaf] = await readdir(rawDirectory);
    assert.notEqual(leaf, undefined);
    const target = join(rawDirectory, leaf ?? "");
    const firstStat = await stat(target);
    assert.equal(firstStat.mode & 0o777, 0o600);
    assert.deepEqual(await readFile(target), original);
    assert.deepEqual(
      (await readdir(rawDirectory)).filter((name) =>
        name.startsWith(".intake-"),
      ),
      [],
    );

    const second = await importRequest(input, { artifactRoot });
    const secondStat = await stat(target);
    assert.equal(second.inputSha256, first.inputSha256);
    assert.deepEqual(await readdir(rawDirectory), [leaf]);
    assert.equal(secondStat.dev, firstStat.dev);
    assert.equal(secondStat.ino, firstStat.ino);
    assert.deepEqual(await readFile(target), original);
    assert.deepEqual(
      (await readdir(rawDirectory)).filter((name) =>
        name.startsWith(".intake-"),
      ),
      [],
    );
    assert.equal(directorySyncs, 2);
  } finally {
    fileHandlePrototype.sync = originalSync;
    await probe.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

test("does not traverse symlinked artifact directories while copying raw input", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-link-"));
  const outside = await mkdtemp(
    join(tmpdir(), "comunidadsolar-request-outside-"),
  );

  try {
    const input = fixture("request.yaml");
    const request = await importRequest(input, {
      artifactRoot: join(root, "baseline-artifacts"),
    });
    for (const artifactRoot of [
      join(root, "intake-link-artifacts"),
      join(root, "raw-link-artifacts"),
    ]) {
      const link = artifactRoot.endsWith("intake-link-artifacts")
        ? join(artifactRoot, "intake")
        : join(
            artifactRoot,
            "intake",
            request.changeId,
            request.inputSha256,
            "raw",
          );
      await mkdir(dirname(link), { recursive: true });
      await symlink(outside, link);

      await assert.rejects(
        importRequest(input, { artifactRoot }),
        /artefacto.*enlace|symlink/i,
      );
      assert.deepEqual(await readdir(outside), []);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("rejects an existing raw artifact symlink without reading outside root", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-request-file-link-"),
  );
  const outside = await mkdtemp(
    join(tmpdir(), "comunidadsolar-request-file-outside-"),
  );

  try {
    const input = fixture("request.yaml");
    const original = await readFile(input);
    const request = await importRequest(input, {
      artifactRoot: join(root, "baseline-artifacts"),
    });
    const rawDirectory = join(
      root,
      "artifact-root",
      "intake",
      request.changeId,
      request.inputSha256,
      "raw",
    );
    const target = join(
      rawDirectory,
      `${createHash("sha256").update(original).digest("hex")}.yaml`,
    );
    const outsideFile = join(outside, "existing.yaml");
    await mkdir(rawDirectory, { recursive: true });
    await writeFile(outsideFile, original);
    await symlink(outsideFile, target);

    await assert.rejects(
      importRequest(input, { artifactRoot: join(root, "artifact-root") }),
      /artefacto.*enlace|symlink/i,
    );
    assert.deepEqual(
      (await readdir(rawDirectory)).filter((name) =>
        name.startsWith(".intake-"),
      ),
      [],
    );
    assert.deepEqual(await readFile(outsideFile), original);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("rejects a request file larger than 1 MiB before parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-size-"));
  const input = join(root, "request.json");

  try {
    await writeFile(input, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await assert.rejects(
      importRequest(input, { artifactRoot: join(root, "artifacts") }),
      /supera 1 MiB/i,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects normalized textual content larger than 100 KiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-content-"));
  const input = join(root, "request.json");

  try {
    await writeFile(
      input,
      JSON.stringify({
        changeId: "nueva-pagina-autoconsumo",
        intent: "Explicar el autoconsumo compartido",
        targetPath: "/autoconsumo-compartido",
        acceptanceCriteria: ["La ruta responde 200"],
        content: "a".repeat(100 * 1024 + 1),
      }),
      "utf8",
    );
    await assert.rejects(
      importRequest(input, { artifactRoot: join(root, "artifacts") }),
      /contenido normalizado supera/i,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not drop a forbidden __proto__ key before closed-schema validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-proto-"));
  const input = join(root, "request.json");

  try {
    await writeFile(
      input,
      '{"changeId":"nueva-pagina-autoconsumo","intent":"Explicar el autoconsumo compartido","targetPath":"/autoconsumo-compartido","acceptanceCriteria":["La ruta responde 200"],"__proto__":"unexpected"}',
      "utf8",
    );
    await assert.rejects(
      importRequest(input, { artifactRoot: join(root, "artifacts") }),
      /schema request-input/i,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("materializes every optional request field with its canonical default", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-request-defaults-"),
  );
  const input = join(root, "request.json");

  try {
    await writeFile(
      input,
      JSON.stringify({
        changeId: "nueva-pagina-autoconsumo",
        intent: "Explicar el autoconsumo compartido",
        targetPath: "/autoconsumo-compartido",
        acceptanceCriteria: ["La ruta responde 200"],
      }),
      "utf8",
    );
    const result = await importRequest(input, {
      artifactRoot: join(root, "artifacts"),
    });

    assert.deepEqual(
      {
        audience: result.audience,
        mode: result.mode,
        content: result.content,
        claims: result.claims,
        references: result.references,
        assets: result.assets,
        seo: result.seo,
        privacy: result.privacy,
        allowedExternalLinks: result.allowedExternalLinks,
      },
      {
        audience: null,
        mode: "auto",
        content: "",
        claims: [],
        references: [],
        assets: [],
        seo: { title: null, description: null, index: true },
        privacy: { private: false, area: null },
        allowedExternalLinks: [],
      },
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("requires Markdown frontmatter and rejects a tampered normalized hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-hash-"));
  const input = join(root, "request.md");

  try {
    await writeFile(input, "Sin frontmatter\n", "utf8");
    await assert.rejects(importRequest(input), /requiere frontmatter YAML/i);

    const request = await withTemporaryArtifactRoot((artifactRoot) =>
      importRequest(fixture("request.json"), { artifactRoot }),
    );
    assert.throws(
      () =>
        assertNormalizedRequest({
          ...request,
          inputSha256: "0".repeat(64),
        }),
      /hash de la solicitud normalizada no coincide/i,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects aliases and custom YAML tags before schema normalization", async () => {
  await withTemporaryArtifactRoot(async (artifactRoot) =>
    assert.rejects(
      importRequest(fixture("unsafe.yaml"), { artifactRoot }),
      /YAML no permitido/i,
    ),
  );
});

test("rejects YAML aliases without a custom tag", () => {
  assert.throws(
    () => parseSafeYaml("first: &shared { visible: true }\nsecond: *shared\n"),
    /YAML no permitido/i,
  );
});

test("rejects duplicate YAML keys without aliases or tags", () => {
  assert.throws(
    () => parseSafeYaml("value: primero\nvalue: segundo\n"),
    /YAML no permitido/i,
  );
});

test("accepts only the YAML core tag set", () => {
  const core = [
    ["!!null", "null", null],
    ["!!bool", "true", true],
    ["!!int", "1", 1],
    ["!!float", "1.5", 1.5],
    ["!!str", "texto", "texto"],
    ["!!map", "{ nested: true }", { nested: true }],
    ["!!seq", "[uno, dos]", ["uno", "dos"]],
  ] as const;
  for (const [tag, serialized, expected] of core) {
    assert.deepEqual(parseSafeYaml(`value: ${tag} ${serialized}\n`), {
      value: expected,
    });
  }

  for (const source of [
    "value: !!binary SGVsbG8=\n",
    "value: !!timestamp 2026-01-01\n",
    "value: !!js/function function(){}\n",
  ]) {
    assert.throws(() => parseSafeYaml(source), /YAML no permitido/i);
  }
});

test("reads one regular input handle and rejects growth beyond 1 MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-request-read-"));
  const input = join(root, "request.json");
  const linked = join(root, "request-link.json");

  try {
    await writeFile(input, Buffer.alloc(maxRequestBytes));
    await symlink(input, linked);
    await assert.rejects(readRequestBytes(linked), /archivo regular|enlace/i);
    await assert.rejects(readRequestBytes(root), /archivo regular/i);
    await assert.rejects(
      readRequestBytes(input, {
        afterOpenStat: async () =>
          writeFile(input, Buffer.alloc(maxRequestBytes + 1)),
      }),
      /supera 1 MiB/i,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
