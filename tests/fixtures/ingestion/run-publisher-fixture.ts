import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.INGEST_TEST_MODE !== "true") {
  throw new TypeError("Esta fixture exige INGEST_TEST_MODE=true");
}

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDirectory, "../../..");
const tsx = join(repositoryRoot, "node_modules", ".bin", "tsx");
const publishersTest = join(
  repositoryRoot,
  "tests",
  "ingest",
  "publishers.test.ts",
);
const testPattern =
  "^(publishes the exact verified local bundle and stops its preview group|Cloudflare runs only a fixed local dry-run through an opaque test capability)$";

const child = spawn(
  tsx,
  ["--test", "--test-name-pattern", testPattern, publishersTest],
  {
    cwd: repositoryRoot,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: "/tmp",
      LANG: "C",
      LC_ALL: "C",
      CI: "true",
      NO_COLOR: "1",
      INGEST_TEST_MODE: "true",
    },
    shell: false,
    stdio: "inherit",
  },
);

const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
  child.once("error", rejectExit);
  child.once("close", (code) => resolveExit(code ?? 1));
});
if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  console.log(
    JSON.stringify({
      fixture: "publisher",
      local: "published-in-temporary-clone",
      cloudflare: "fixed-local-dry-run-only",
      externalDeploy: false,
    }),
  );
}
