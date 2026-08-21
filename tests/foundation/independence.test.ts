import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { afterEach, test } from "node:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  findSourceCheckoutReferences,
  parseIndependentArguments,
  verifyIndependent,
} from "../../scripts/verify-independent.ts";

const execFileAsync = promisify(execFile);

interface GitFixture {
  cleanupRoot: string;
  repository: string;
  sessions: string;
  tree: string;
}

const fixtures: GitFixture[] = [];

async function git(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function createRepository(
  scripts: Record<string, string> = {},
): Promise<GitFixture> {
  const cleanupRoot = await mkdtemp(join(tmpdir(), "independence-test-"));
  const repository = join(cleanupRoot, "repository");
  const sessions = join(cleanupRoot, "sessions");
  const packageJson = {
    name: "independence-fixture",
    version: "1.0.0",
    private: true,
    scripts: {
      check: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
      build: 'node -e "process.exit(0)"',
      ...scripts,
    },
  };

  await mkdir(repository, { recursive: true });
  await mkdir(sessions);
  await writeFile(join(repository, ".gitignore"), ".artifacts/\n");
  await writeFile(join(repository, "tracked.txt"), "tracked\n");
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify(packageJson)}\n`,
  );
  await writeFile(
    join(repository, "package-lock.json"),
    `${JSON.stringify({
      name: packageJson.name,
      version: packageJson.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: packageJson.name,
          version: packageJson.version,
        },
      },
    })}\n`,
  );
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.test"], {
    cwd: repository,
  });
  await execFileAsync("git", ["config", "user.name", "Independence test"], {
    cwd: repository,
  });
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "fixture"]);

  const fixture = {
    cleanupRoot,
    repository,
    sessions,
    tree: await git(repository, ["rev-parse", "HEAD^{tree}"]),
  };
  fixtures.push(fixture);
  return fixture;
}

async function sessionEntries(fixture: GitFixture): Promise<string[]> {
  return (await readdir(fixture.sessions)).sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((fixture) =>
        rm(fixture.cleanupRoot, { recursive: true, force: true }),
      ),
  );
});

test("runtime sources never reference the old checkout", async () => {
  const violations = await findSourceCheckoutReferences([
    "src",
    "public",
    "astro.config.mjs",
  ]);

  assert.deepEqual(violations, []);
});

test("source scanning detects forbidden references without following symlinks", async () => {
  const fixture = await createRepository();
  const scanRoot = join(fixture.cleanupRoot, "scan");
  const externalRoot = join(fixture.cleanupRoot, "external");

  await mkdir(join(scanRoot, "comunidadsolarweb"), { recursive: true });
  await writeFile(
    join(scanRoot, "checkout-reference.ts"),
    [
      'import "../comunidadsolarweb/runtime";',
      `const source = ${JSON.stringify(
        resolve(process.cwd(), "../comunidadsolarweb"),
      )};`,
      'import "next";',
      'import "vinext";',
    ].join("\n"),
  );
  await writeFile(
    join(scanRoot, "comunidadsolarweb", "runtime.ts"),
    "export {};\n",
  );
  await mkdir(externalRoot);
  await writeFile(join(externalRoot, "outside.ts"), 'import "next";\n');
  await symlink(externalRoot, join(scanRoot, "linked"));

  const violations = await findSourceCheckoutReferences([
    join(scanRoot, "absent"),
    scanRoot,
  ]);

  assert.deepEqual(violations, [
    "checkout-reference.ts: comunidadsolarweb",
    "checkout-reference.ts: next",
    "checkout-reference.ts: vinext",
    "comunidadsolarweb/runtime.ts: path",
    "linked: symlink",
  ]);
});

test("source scanning permits content literals named next", async () => {
  const fixture = await createRepository();
  const scanRoot = join(fixture.cleanupRoot, "scan");
  const contentPath = join(scanRoot, "community-data.ts");

  await mkdir(scanRoot);
  await writeFile(
    contentPath,
    [
      'export type MilestoneState = "active" | "current" | "next";',
      'export const nextAction = "Completar la legalización";',
    ].join("\n"),
  );

  assert.deepEqual(await findSourceCheckoutReferences([contentPath]), []);
});

test("source scanning skips binary public assets and detects backtick runtime imports", async () => {
  const fixture = await createRepository();
  const scanRoot = join(fixture.cleanupRoot, "scan");
  const publicRoot = join(scanRoot, "public");
  const runtimePath = join(scanRoot, "runtime.ts");

  await mkdir(publicRoot, { recursive: true });
  await writeFile(
    join(publicRoot, "logo.bin"),
    Buffer.concat([Buffer.from([0, 255, 0]), Buffer.from('import "next"')]),
  );
  await writeFile(runtimePath, "await import(`vinext`);\n");

  const violations = await findSourceCheckoutReferences([
    publicRoot,
    runtimePath,
  ]);

  assert.deepEqual(violations, ["runtime.ts: vinext"]);
});

test("independent verifier archives a Git tree and plans all checks", async () => {
  const fixture = await createRepository();

  const result = await verifyIndependent(
    { execute: false, source: "head" },
    {
      repositoryRoot: fixture.repository,
      temporaryDirectory: fixture.sessions,
    },
  );

  assert.equal(result.source, "head");
  assert.equal(result.tree, fixture.tree);
  assert.equal(result.archiveHasGitDirectory, false);
  assert.equal(result.archiveHasSiblingCheckout, false);
  assert.deepEqual(
    result.commands.map((command) => command.argv),
    [
      ["npm", "ci"],
      ["npm", "run", "check"],
      ["npm", "test"],
      ["npm", "run", "build"],
    ],
  );
  assert.deepEqual(
    result.commands.map((command) => command.executed),
    [false, false, false, false],
  );
  assert.equal(
    await pathExists(result.commands[0]?.cwd ?? fixture.repository),
    false,
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("staged verifier archives the exact staged tree without mutating it", async () => {
  const fixture = await createRepository();
  await writeFile(join(fixture.repository, "staged-only.txt"), "staged\n");
  await git(fixture.repository, ["add", "staged-only.txt"]);
  const expectedTree = await git(fixture.repository, ["write-tree"]);
  const statusBefore = await git(fixture.repository, [
    "status",
    "--porcelain=v1",
  ]);

  const result = await verifyIndependent(
    { execute: false, source: "staged" },
    {
      repositoryRoot: fixture.repository,
      temporaryDirectory: fixture.sessions,
    },
  );

  assert.equal(result.source, "staged");
  assert.equal(result.tree, expectedTree);
  assert.match(
    await git(fixture.repository, [
      "ls-tree",
      "-r",
      "--name-only",
      result.tree,
    ]),
    /^staged-only\.txt$/m,
  );
  assert.equal(
    await git(fixture.repository, ["status", "--porcelain=v1"]),
    statusBefore,
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("staged verifier fails closed for untracked and unstaged project paths", async () => {
  const fixture = await createRepository();
  await mkdir(join(fixture.repository, ".artifacts"));
  await writeFile(
    join(fixture.repository, ".artifacts", "evidence.txt"),
    "ignored\n",
  );

  await verifyIndependent(
    { execute: false, source: "staged" },
    {
      repositoryRoot: fixture.repository,
      temporaryDirectory: fixture.sessions,
    },
  );

  await writeFile(join(fixture.repository, "untracked.txt"), "untracked\n");
  await assert.rejects(
    verifyIndependent(
      { execute: false, source: "staged" },
      {
        repositoryRoot: fixture.repository,
        temporaryDirectory: fixture.sessions,
      },
    ),
    /sin stage.*untracked\.txt/i,
  );
  await rm(join(fixture.repository, "untracked.txt"));

  await writeFile(join(fixture.repository, "tracked.txt"), "changed\n");
  await assert.rejects(
    verifyIndependent(
      { execute: false, source: "staged" },
      {
        repositoryRoot: fixture.repository,
        temporaryDirectory: fixture.sessions,
      },
    ),
    /sin stage.*tracked\.txt/i,
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("executable archive succeeds without a sibling checkout", async () => {
  const fixture = await createRepository();

  const result = await verifyIndependent(
    { execute: true, source: "head" },
    {
      repositoryRoot: fixture.repository,
      temporaryDirectory: fixture.sessions,
    },
  );

  assert.equal(result.archiveHasGitDirectory, false);
  assert.equal(result.archiveHasSiblingCheckout, false);
  assert.deepEqual(
    result.commands.map((command) => command.executed),
    [true, true, true, true],
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("command failure removes the owned archive session", async () => {
  const fixture = await createRepository({
    check: 'node -e "process.exit(7)"',
  });

  await assert.rejects(
    verifyIndependent(
      { execute: true, source: "head" },
      {
        repositoryRoot: fixture.repository,
        temporaryDirectory: fixture.sessions,
      },
    ),
    /npm run check.*código 7/i,
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("archive and extract failures remove the owned archive session", async () => {
  const fixture = await createRepository();
  const archiveFailureDependencies = {
    repositoryRoot: fixture.repository,
    temporaryDirectory: fixture.sessions,
    gitArchive: async (): Promise<Buffer> => {
      throw new Error("fixture archive failure");
    },
  };

  await assert.rejects(
    verifyIndependent(
      { execute: false, source: "head" },
      archiveFailureDependencies,
    ),
    /fixture archive failure/i,
  );
  assert.deepEqual(await sessionEntries(fixture), []);

  const extractFailureDependencies = {
    repositoryRoot: fixture.repository,
    temporaryDirectory: fixture.sessions,
    gitArchive: async (): Promise<Buffer> => Buffer.from("not a tar"),
  };
  await assert.rejects(
    verifyIndependent(
      { execute: false, source: "head" },
      extractFailureDependencies,
    ),
    /extraer el archive/i,
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("verifier rejects local-only material tracked by the selected tree", async () => {
  const fixture = await createRepository();
  await mkdir(join(fixture.repository, ".artifacts"));
  await mkdir(join(fixture.repository, ".source-work"));
  await mkdir(join(fixture.repository, "config"));
  await mkdir(join(fixture.repository, "vendor", "node_modules"), {
    recursive: true,
  });
  await writeFile(
    join(fixture.repository, ".artifacts", "evidence.txt"),
    "x\n",
  );
  await writeFile(join(fixture.repository, ".env.production"), "SECRET=x\n");
  await writeFile(join(fixture.repository, ".dev.vars.test"), "SECRET=x\n");
  await writeFile(join(fixture.repository, ".source-work", "copy.txt"), "x\n");
  await writeFile(join(fixture.repository, "config", ".env.production"), "x\n");
  await writeFile(
    join(fixture.repository, "vendor", "node_modules", "copy.txt"),
    "x\n",
  );
  await git(fixture.repository, [
    "add",
    "-f",
    ".artifacts/evidence.txt",
    ".env.production",
    ".dev.vars.test",
    ".source-work/copy.txt",
    "config/.env.production",
    "vendor/node_modules/copy.txt",
  ]);
  await git(fixture.repository, ["commit", "-m", "unsafe fixture"]);

  await assert.rejects(
    verifyIndependent(
      { execute: false, source: "head" },
      {
        repositoryRoot: fixture.repository,
        temporaryDirectory: fixture.sessions,
      },
    ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /\.artifacts\/evidence\.txt/i);
      assert.match(message, /config\/\.env\.production/i);
      assert.match(message, /vendor\/node_modules\/copy\.txt/i);
      return true;
    },
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("verifier rejects a tracked archive symlink before extraction", async () => {
  const fixture = await createRepository();
  const externalTarget = join(fixture.cleanupRoot, "outside");
  await writeFile(externalTarget, "outside\n");
  await symlink(externalTarget, join(fixture.repository, "linked-outside"));
  await git(fixture.repository, ["add", "linked-outside"]);
  await git(fixture.repository, ["commit", "-m", "symlink fixture"]);

  await assert.rejects(
    verifyIndependent(
      { execute: false, source: "head" },
      {
        repositoryRoot: fixture.repository,
        temporaryDirectory: fixture.sessions,
      },
    ),
    /symlink.*linked-outside/i,
  );
  assert.deepEqual(await sessionEntries(fixture), []);
});

test("archive commands remove source and module inheritance from their environment", async () => {
  const cleanupRoot = await mkdtemp(
    join(tmpdir(), "independence-environment-"),
  );
  const marker = join(cleanupRoot, "environment.json");
  const preloadMarker = join(cleanupRoot, "preload-ran.txt");
  const preload = join(cleanupRoot, "forbidden-preload.cjs");
  await writeFile(
    preload,
    `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "loaded");\n`,
  );
  const fixture = await createRepository({
    check: `node -e ${JSON.stringify(
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ source: process.env.COMUNIDADSOLAR_SOURCE_ROOT ?? null, gitDir: process.env.GIT_DIR ?? null, gitWorkTree: process.env.GIT_WORK_TREE ?? null, nodePath: process.env.NODE_PATH ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, safe: process.env.INDEPENDENCE_SAFE ?? null }))`,
    )}`,
  });

  try {
    await verifyIndependent(
      { execute: true, source: "head" },
      {
        repositoryRoot: fixture.repository,
        temporaryDirectory: fixture.sessions,
        childEnvironment: {
          ...process.env,
          COMUNIDADSOLAR_SOURCE_ROOT: "/forbidden/source",
          GIT_DIR: "/forbidden/git",
          GIT_WORK_TREE: "/forbidden/worktree",
          NODE_PATH: "/forbidden/modules",
          NODE_OPTIONS: `--require=${preload}`,
          INDEPENDENCE_SAFE: "kept",
        },
      },
    );
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
      source: null,
      gitDir: null,
      gitWorkTree: null,
      nodePath: null,
      nodeOptions: null,
      safe: "kept",
    });
    assert.equal(await pathExists(preloadMarker), false);
  } finally {
    await rm(cleanupRoot, { recursive: true, force: true });
  }
});

test("verifier requires a Git repository root", async () => {
  const fixture = await createRepository();

  await assert.rejects(
    verifyIndependent(
      { execute: false, source: "head" },
      {
        repositoryRoot: fixture.cleanupRoot,
        temporaryDirectory: fixture.sessions,
      },
    ),
    /repositorio Git/i,
  );
});

test("independent CLI accepts only head or exactly --staged", () => {
  assert.deepEqual(parseIndependentArguments([]), { source: "head" });
  assert.deepEqual(parseIndependentArguments(["--staged"]), {
    source: "staged",
  });
  assert.throws(
    () => parseIndependentArguments(["--staged", "--staged"]),
    /solo acepta/i,
  );
  assert.throws(() => parseIndependentArguments(["--head"]), /solo acepta/i);
});
