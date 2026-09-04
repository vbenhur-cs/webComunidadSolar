import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStateStore } from "../../../src/ingest/state-store.ts";

const changeId = "stress-lock";
const workerCount = 8;
// Hosted CI can take more than five seconds to schedule eight Node children
// while the parallel verification jobs are also installing and building.
const coordinationTimeoutMs = 15_000;
const fixturePath = fileURLToPath(import.meta.url);

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(
  path: string,
  timeoutMs = coordinationTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await pause(10);
  }
  throw new Error("El stress de locks excedió su espera de archivo");
}

async function waitForResultCount(
  resultsDir: string,
  expected: number,
  timeoutMs = coordinationTimeoutMs,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(resultsDir);
    if (entries.length === expected) {
      return entries;
    }
    await pause(10);
  }
  throw new Error("El stress de locks no reunió todos los resultados");
}

async function findLockResidues(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (
      entry.name.startsWith(".tmp-") ||
      entry.name === ".lock" ||
      entry.name === ".recovery-guard" ||
      entry.name.startsWith(".recovery-guard-quarantine-")
    ) {
      found.push(child);
    }
    if (entry.isDirectory()) {
      found.push(...(await findLockResidues(child)));
    }
  }
  return found;
}

function waitForClose(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function runWorker(
  stateRoot: string,
  startPath: string,
  releasePath: string,
  resultsDir: string,
): Promise<void> {
  await waitForFile(startPath);
  const store = createStateStore({ stateRoot });
  try {
    await store.withChangeLock(changeId, async () => {
      await writeFile(join(resultsDir, `owner-${process.pid}`), "owner", {
        flag: "wx",
      });
      await waitForFile(releasePath);
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /bloqueado por otro proceso/i.test(error.message)
    ) {
      await writeFile(join(resultsDir, `blocked-${process.pid}`), "blocked", {
        flag: "wx",
      });
      return;
    }
    throw error;
  }
}

async function runStress(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-stress-locks-"));
  const stateRoot = join(root, ".change-state");
  const startPath = join(root, "start");
  const releasePath = join(root, "release");
  const resultsDir = join(root, "results");
  const workers: ChildProcess[] = [];
  const exits: Promise<number>[] = [];

  try {
    await mkdir(resultsDir);
    const store = createStateStore({ stateRoot });
    await store.transition(changeId, {
      type: "request-received",
      to: "received",
      payload: { fixture: "stress" },
    });

    for (let index = 0; index < workerCount; index += 1) {
      const worker = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fixturePath,
          "--worker",
          stateRoot,
          startPath,
          releasePath,
          resultsDir,
        ],
        { stdio: "ignore" },
      );
      workers.push(worker);
      exits.push(waitForClose(worker));
    }
    await writeFile(startPath, "start", { flag: "wx" });

    const entries = await waitForResultCount(resultsDir, workerCount);
    const owners = entries.filter((entry) => entry.startsWith("owner-"));
    const blocked = entries.filter((entry) => entry.startsWith("blocked-"));
    if (owners.length !== 1 || blocked.length !== workerCount - 1) {
      throw new Error("El stress de locks no tuvo un único propietario");
    }
    await writeFile(releasePath, "release", { flag: "wx" });

    const exitCodes = await Promise.all(exits);
    if (exitCodes.some((code) => code !== 0)) {
      throw new Error("Un proceso del stress de locks terminó con error");
    }
    const residues = await findLockResidues(root);
    if (residues.length !== 0) {
      throw new Error("El stress de locks dejó residuos operativos");
    }
    process.stdout.write(
      `STRESS_LOCKS_OK owners=${owners.length} blocked=${blocked.length} residue=${residues.length}\n`,
    );
  } finally {
    await writeFile(releasePath, "release").catch(() => undefined);
    for (const worker of workers) {
      worker.kill("SIGTERM");
    }
    await Promise.all(exits.map((exit) => exit.catch(() => 1)));
    await rm(root, { force: true, recursive: true });
  }
}

if (process.argv[2] === "--worker") {
  const [stateRoot, startPath, releasePath, resultsDir] = process.argv.slice(3);
  if (
    [stateRoot, startPath, releasePath, resultsDir].some(
      (value) => value === undefined,
    )
  ) {
    throw new Error("El worker del stress no recibió sus rutas");
  }
  await runWorker(stateRoot, startPath, releasePath, resultsDir);
} else {
  await runStress();
}
