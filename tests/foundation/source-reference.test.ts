import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import {
  assertSourcePristine,
  EXPECTED_SOURCE_COMMIT,
  readSourceBlob,
} from "../../scripts/lib/source-reference.ts";
import { copySourceFiles } from "../../scripts/copy-source-files.ts";

const execFileAsync = promisify(execFile);

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface SourceFixture {
  repo: string;
  targetRoot: string;
  head: string;
  committedFavicon: string;
  cleanupRoot: string;
}

let fixture: SourceFixture;

beforeEach(async () => {
  const cleanupRoot = await mkdtemp(join(tmpdir(), "source-reference-"));
  const repo = join(cleanupRoot, "source");
  const targetRoot = join(cleanupRoot, "target");
  const committedFavicon = "<svg>committed favicon</svg>";

  await mkdir(join(repo, "public"), { recursive: true });
  await mkdir(join(targetRoot, "parity"), { recursive: true });
  await writeFile(join(targetRoot, "parity", "provenance.json"), "[]\n");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.test"], {
    cwd: repo,
  });
  await execFileAsync("git", ["config", "user.name", "Source fixture"], {
    cwd: repo,
  });
  await writeFile(join(repo, "public", "favicon.svg"), committedFavicon);
  await execFileAsync("git", ["add", "public/favicon.svg"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repo });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  });

  fixture = {
    repo,
    targetRoot,
    head: stdout.trim(),
    committedFavicon,
    cleanupRoot,
  };
});

async function fromTargetRoot<T>(run: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(fixture.targetRoot);
  try {
    return await run();
  } finally {
    process.chdir(originalCwd);
  }
}

afterEach(async () => {
  await rm(fixture.cleanupRoot, { recursive: true, force: true });
});

async function runSourceCheck(
  args: string[],
  options: { sourceRoot?: string; cwd?: string } = {},
): Promise<CommandResult> {
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  const environment = { ...process.env };
  if (options.sourceRoot === undefined) {
    delete environment.COMUNIDADSOLAR_SOURCE_ROOT;
  } else {
    environment.COMUNIDADSOLAR_SOURCE_ROOT = options.sourceRoot;
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      tsx,
      [join(process.cwd(), "scripts", "source-check.ts"), ...args],
      {
        cwd: options.cwd ?? process.cwd(),
        encoding: "utf8",
        env: environment,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const commandError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    return {
      code: 1,
      stdout: commandError.stdout ?? "",
      stderr: commandError.stderr ?? commandError.message,
    };
  }
}

test("rejects a source checkout on another commit", async () => {
  await assert.rejects(
    assertSourcePristine(fixture.repo, EXPECTED_SOURCE_COMMIT),
    /commit de referencia/i,
  );
});

test("rejects tracked or untracked source changes", async () => {
  await writeFile(join(fixture.repo, "untracked.txt"), "stop");
  await assert.rejects(
    assertSourcePristine(fixture.repo, fixture.head),
    /no está limpio/i,
  );

  await rm(join(fixture.repo, "untracked.txt"));
  await writeFile(join(fixture.repo, "public", "favicon.svg"), "changed");
  await assert.rejects(
    assertSourcePristine(fixture.repo, fixture.head),
    /no está limpio/i,
  );
});

test("reads the committed blob instead of the working tree", async () => {
  await writeFile(join(fixture.repo, "public", "favicon.svg"), "working tree");
  const blob = await readSourceBlob(
    "public/favicon.svg",
    fixture.repo,
    fixture.head,
  );
  assert.equal(blob.toString(), fixture.committedFavicon);
});

test("copies committed blobs into the repository with sorted provenance", async () => {
  const targetDirectory = ".source-work/source-reference-copy-test";
  const provenancePath = join(fixture.targetRoot, "parity", "provenance.json");
  const originalProvenance = await readFile(provenancePath, "utf8");
  const expectedBlob = await readSourceBlob(
    "public/favicon.svg",
    fixture.repo,
    fixture.head,
  );
  const expectedHash = createHash("sha256").update(expectedBlob).digest("hex");

  try {
    const entries = await fromTargetRoot(() =>
      copySourceFiles(
        [
          `public/favicon.svg:${targetDirectory}/z.svg`,
          `public/favicon.svg:${targetDirectory}/a.svg`,
        ],
        {
          repositoryRoot: fixture.targetRoot,
          sourceRoot: fixture.repo,
          expectedCommit: fixture.head,
        },
      ),
    );

    assert.deepEqual(
      entries.map((entry) => entry.destination),
      [`${targetDirectory}/a.svg`, `${targetDirectory}/z.svg`],
    );
    assert.equal(
      await readFile(
        join(fixture.targetRoot, targetDirectory, "a.svg"),
        "utf8",
      ),
      expectedBlob.toString(),
    );

    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    assert.deepEqual(
      provenance.filter((entry: { destination: string }) =>
        entry.destination.startsWith(targetDirectory),
      ),
      [
        {
          sourcePath: "public/favicon.svg",
          destination: `${targetDirectory}/a.svg`,
          sourceCommit: fixture.head,
          sha256: expectedHash,
          bytes: expectedBlob.byteLength,
        },
        {
          sourcePath: "public/favicon.svg",
          destination: `${targetDirectory}/z.svg`,
          sourceCommit: fixture.head,
          sha256: expectedHash,
          bytes: expectedBlob.byteLength,
        },
      ],
    );
    await assert.rejects(
      copySourceFiles(["/outside:inside"]),
      /relativa|absoluta/i,
    );
    await assert.rejects(
      copySourceFiles(["public/favicon.svg:../outside.svg"]),
      /relativa|fuera del repositorio/i,
    );
  } finally {
    await rm(join(fixture.targetRoot, targetDirectory), {
      recursive: true,
      force: true,
    });
    await writeFile(provenancePath, originalProvenance);
  }
});

test("rejects a symlink escape before creating an external directory", async () => {
  const targetDirectory = ".source-work/source-reference-symlink-test";
  const externalDirectory = join(fixture.cleanupRoot, "external");
  const targetRoot = join(fixture.targetRoot, targetDirectory);
  const escapeLink = join(targetRoot, "escape");

  await mkdir(targetRoot, { recursive: true });
  await mkdir(externalDirectory);
  await symlink(externalDirectory, escapeLink);

  try {
    await assert.rejects(
      fromTargetRoot(() =>
        copySourceFiles(
          [`public/favicon.svg:${targetDirectory}/escape/created/file.svg`],
          {
            repositoryRoot: fixture.targetRoot,
            sourceRoot: fixture.repo,
            expectedCommit: fixture.head,
          },
        ),
      ),
      /fuera del repositorio/i,
    );
    await assert.rejects(stat(join(externalDirectory, "created")), /ENOENT/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(externalDirectory, { recursive: true, force: true });
  }
});

test("orders provenance with a locale-independent lexical comparator", async () => {
  const targetDirectory = ".source-work/source-reference-order-test";
  const provenancePath = join(fixture.targetRoot, "parity", "provenance.json");
  const originalProvenance = await readFile(provenancePath, "utf8");

  try {
    const entries = await fromTargetRoot(() =>
      copySourceFiles(
        [
          `public/favicon.svg:${targetDirectory}/ä.svg`,
          `public/favicon.svg:${targetDirectory}/z.svg`,
        ],
        {
          repositoryRoot: fixture.targetRoot,
          sourceRoot: fixture.repo,
          expectedCommit: fixture.head,
        },
      ),
    );

    assert.deepEqual(
      entries.map((entry) => entry.destination),
      [`${targetDirectory}/z.svg`, `${targetDirectory}/ä.svg`],
    );
  } finally {
    await rm(join(fixture.targetRoot, targetDirectory), {
      recursive: true,
      force: true,
    });
    await writeFile(provenancePath, originalProvenance);
  }
});

test("rejects duplicate normalized destinations before copying", async () => {
  const targetDirectory = ".source-work/source-reference-duplicate-test";
  const provenancePath = join("parity", "provenance.json");
  const originalProvenance = await readFile(provenancePath, "utf8");

  try {
    await assert.rejects(
      copySourceFiles([
        `public/favicon.svg:${targetDirectory}/same.svg`,
        `public/favicon.svg:${targetDirectory}/./same.svg`,
      ]),
      /destino duplicado/i,
    );
    await assert.rejects(stat(join(targetDirectory, "same.svg")), /ENOENT/);
    assert.equal(await readFile(provenancePath, "utf8"), originalProvenance);
  } finally {
    await rm(targetDirectory, { recursive: true, force: true });
    await writeFile(provenancePath, originalProvenance);
  }
});

test("source-check treats only a missing automatic sibling as optional", async () => {
  const sourceRoot =
    "/Users/vbenhur/Documents/Projects VS/WebComunidadSolar/comunidadsolarweb";
  const strict = await runSourceCheck([], { sourceRoot });
  assert.equal(strict.code, 0);
  assert.equal(
    strict.stdout.trim(),
    `SOURCE_OK ${EXPECTED_SOURCE_COMMIT} clean`,
  );

  const explicitMissing = await runSourceCheck(["--if-present"], {
    sourceRoot: join(fixture.cleanupRoot, "missing-source"),
  });
  assert.notEqual(explicitMissing.code, 0);
  assert.doesNotMatch(explicitMissing.stdout, /SOURCE_UNAVAILABLE/);
  assert.match(explicitMissing.stderr, /no se encontró el repositorio fuente/i);

  const automaticCwd = join(fixture.cleanupRoot, "automatic-cwd");
  await mkdir(automaticCwd);
  const automaticMissing = await runSourceCheck(["--if-present"], {
    cwd: automaticCwd,
  });
  assert.equal(automaticMissing.code, 0);
  assert.equal(automaticMissing.stdout.trim(), "SOURCE_UNAVAILABLE");

  const wrongCheckout = await runSourceCheck(["--if-present"], {
    sourceRoot: fixture.repo,
  });
  assert.notEqual(wrongCheckout.code, 0);
  assert.doesNotMatch(wrongCheckout.stdout, /SOURCE_UNAVAILABLE/);
  assert.match(wrongCheckout.stderr, /commit de referencia/i);
});
