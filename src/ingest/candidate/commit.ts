import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import type { ChangePlan } from "../domain.ts";
import {
  assertControllerCandidateRef,
  assertControllerCandidateCheckout,
  createControllerCandidateCheckout,
  persistControllerCandidateRef,
  removeControllerCandidateCheckout,
  withControllerCandidateCheckout,
  type ControllerCandidateCheckout,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";
import {
  candidateBuildFixture,
  validatedCandidateBuildValidations,
  type CandidateBoundBuildEvidence,
  type CandidateBuildTestCapability,
} from "./evidence.ts";
import {
  copyCandidateBundle,
  readCandidateBundleConfiguration,
  type CandidateArtifactEntry,
  type CandidateBundleConfiguration,
} from "./manifest.ts";

const gitExecutable = "/usr/bin/git";
const fixedGitArguments = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
]);
const fixedGitEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Comunidad Solar Candidate",
  GIT_AUTHOR_EMAIL: "candidate@comunidadsolar.invalid",
  GIT_COMMITTER_NAME: "Comunidad Solar Candidate",
  GIT_COMMITTER_EMAIL: "candidate@comunidadsolar.invalid",
});
const commitPattern = /^[a-f0-9]{40,64}$/u;

/** Immutable public commit identity; its private checkout is kept in a WeakMap. */
export interface CandidateCommit {
  readonly candidateCommit: string;
  readonly candidateTree: string;
}

interface CandidateCommitRecord {
  readonly checkout: ControllerCandidateCheckout;
  readonly output: StagedAgentOutput;
  readonly attemptId: string;
  readonly planCanonical: string;
  readonly baselineCommit: string;
}

const candidateCommitRecords = new WeakMap<
  CandidateCommit,
  CandidateCommitRecord
>();

function collect(child: ChildProcess, stream: "stdout" | "stderr"): Buffer[] {
  const chunks: Buffer[] = [];
  child[stream]?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return chunks;
}

async function exitCode(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

async function runGit(
  arguments_: readonly string[],
  failure: string,
): Promise<string> {
  const child = spawn(gitExecutable, [...fixedGitArguments, ...arguments_], {
    env: fixedGitEnvironment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child, "stdout");
  const errors = collect(child, "stderr");
  if ((await exitCode(child)) !== 0) {
    const detail = Buffer.concat(errors).toString("utf8").trim();
    throw new TypeError(detail === "" ? failure : `${failure}: ${detail}`);
  }
  return Buffer.concat(output).toString("utf8").trim();
}

function sortedPaths(paths: readonly string[]): string[] {
  const result = [...paths].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (result.length === 0 || new Set(result).size !== result.length) {
    throw new TypeError(
      "El candidato requiere un inventario aprobado no vacío",
    );
  }
  return result;
}

function isWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return (
    remainder === "" ||
    (!isAbsolute(remainder) &&
      remainder !== ".." &&
      !remainder.startsWith(`..${sep}`))
  );
}

function safeBuildRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

async function writeCandidateFixtureFile(
  checkoutPath: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  if (!safeBuildRelativePath(relativePath)) {
    throw new TypeError("La fixture de build contiene una ruta insegura");
  }
  const path = join(checkoutPath, ...relativePath.split("/"));
  const parent = dirname(path);
  if (!isWithin(checkoutPath, path) || !isWithin(checkoutPath, parent)) {
    throw new TypeError("La fixture de build escapa el checkout candidato");
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent) {
    throw new TypeError("La fixture de build atraviesa un directorio inseguro");
  }
  try {
    const existing = await lstat(path);
    if (
      existing.isSymbolicLink() ||
      (!existing.isFile() && !existing.isDirectory())
    ) {
      throw new TypeError("La fixture de build contiene un destino inseguro");
    }
    if (existing.isDirectory()) {
      throw new TypeError(
        "La fixture de build no puede reemplazar un directorio",
      );
    }
  } catch (error: unknown) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
  await writeFile(path, contents, { mode: 0o600 });
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

async function assertGitObjectsMatchApprovedBytes(
  checkoutPath: string,
  revision: string,
  approvedPaths: readonly string[],
): Promise<void> {
  for (const path of approvedPaths) {
    const [rawBlob, recordedBlob] = await Promise.all([
      runGit(
        ["-C", checkoutPath, "hash-object", "--no-filters", "--", path],
        "No se pudo calcular el blob aprobado",
      ),
      runGit(
        ["-C", checkoutPath, "rev-parse", `${revision}:${path}`],
        "No se pudo leer el blob candidato",
      ),
    ]);
    if (
      !commitPattern.test(rawBlob) ||
      !commitPattern.test(recordedBlob) ||
      rawBlob !== recordedBlob
    ) {
      throw new TypeError(
        "El objeto Git candidato no conserva los bytes aprobados exactamente",
      );
    }
  }
}

async function assertOnlyApprovedDiff(
  checkoutPath: string,
  baselineCommit: string,
  approvedPaths: readonly string[],
): Promise<void> {
  const changed = await runGit(
    ["-C", checkoutPath, "diff", "--name-only", "--no-renames", baselineCommit],
    "No se pudo comprobar el diff candidato",
  );
  const actualPaths = changed === "" ? [] : changed.split("\n").sort();
  if (!samePaths(actualPaths, approvedPaths)) {
    throw new TypeError("El candidato contiene un diff no aprobado");
  }
}

function candidateCommitRecord(
  candidate: CandidateCommit,
): CandidateCommitRecord {
  const record = candidateCommitRecords.get(candidate);
  if (
    record === undefined ||
    !commitPattern.test(candidate.candidateCommit) ||
    !commitPattern.test(candidate.candidateTree)
  ) {
    throw new TypeError("El commit candidato no pertenece al controlador");
  }
  return record;
}

function permittedGeneratedPath(path: string): boolean {
  return (
    path === "dist" ||
    path.startsWith("dist/") ||
    path === ".wrangler/deploy/config.json" ||
    path === ".wrangler/"
  );
}

async function assertGeneratedWranglerTree(
  checkoutPath: string,
): Promise<void> {
  const wranglerPath = join(checkoutPath, ".wrangler");
  let wrangler: Awaited<ReturnType<typeof lstat>>;
  try {
    wrangler = await lstat(wranglerPath);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  if (wrangler.isSymbolicLink() || !wrangler.isDirectory()) {
    throw new TypeError("El output de build contiene .wrangler inseguro");
  }
  const wranglerEntries = await readdir(wranglerPath);
  if (wranglerEntries.length !== 1 || wranglerEntries[0] !== "deploy") {
    throw new TypeError(
      "El build candidato contiene output .wrangler no aprobado",
    );
  }
  const deployPath = join(wranglerPath, "deploy");
  const deploy = await lstat(deployPath);
  if (deploy.isSymbolicLink() || !deploy.isDirectory()) {
    throw new TypeError("El output de build contiene deploy inseguro");
  }
  const deployEntries = await readdir(deployPath);
  if (deployEntries.length !== 1 || deployEntries[0] !== "config.json") {
    throw new TypeError(
      "El build candidato contiene output deploy no aprobado",
    );
  }
  const config = await lstat(join(deployPath, "config.json"));
  if (config.isSymbolicLink() || !config.isFile() || config.nlink !== 1) {
    throw new TypeError("El config de deploy candidato no es seguro");
  }
}

async function assertPermittedBuildStatus(
  checkoutPath: string,
  status: string,
): Promise<void> {
  for (const line of status === "" ? [] : status.split("\n")) {
    if (
      line.length < 4 ||
      (line.slice(0, 2) !== "??" && line.slice(0, 2) !== "!!") ||
      line[2] !== " " ||
      !permittedGeneratedPath(line.slice(3))
    ) {
      throw new TypeError("El build candidato contiene cambios no aprobados");
    }
  }
  await assertGeneratedWranglerTree(checkoutPath);
}

async function assertCandidateCommitIdentity(
  checkoutPath: string,
  candidate: CandidateCommit,
  baselineCommit: string,
): Promise<void> {
  const [head, parent, tree, worktreeDiff, indexDiff, status] =
    await Promise.all([
      runGit(
        ["-C", checkoutPath, "rev-parse", "HEAD"],
        "No se pudo leer el commit candidato",
      ),
      runGit(
        ["-C", checkoutPath, "rev-parse", "HEAD^"],
        "No se pudo leer el padre candidato",
      ),
      runGit(
        ["-C", checkoutPath, "rev-parse", "HEAD^{tree}"],
        "No se pudo leer el árbol candidato",
      ),
      runGit(
        ["-C", checkoutPath, "diff", "--name-only", "--no-renames", "HEAD"],
        "No se pudo comprobar el worktree candidato",
      ),
      runGit(
        ["-C", checkoutPath, "diff", "--cached", "--name-only", "--no-renames"],
        "No se pudo comprobar el índice candidato",
      ),
      runGit(
        [
          "-C",
          checkoutPath,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored=matching",
        ],
        "No se pudo comprobar el estado post-build candidato",
      ),
    ]);
  await assertPermittedBuildStatus(checkoutPath, status);
  if (
    head !== candidate.candidateCommit ||
    parent !== baselineCommit ||
    tree !== candidate.candidateTree ||
    worktreeDiff !== "" ||
    indexDiff !== ""
  ) {
    throw new TypeError(
      "El checkout ya no representa el commit candidato inmutable",
    );
  }
}

/**
 * Creates commit A from an exact controller-minted staged output. The source
 * repository and checkout remain private; only commit and tree identities are
 * returned to the candidate pipeline.
 */
export async function createCandidateCommit(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<CandidateCommit> {
  const checkout = await createControllerCandidateCheckout(
    output,
    plan,
    attemptId,
  );
  try {
    const approvedPaths = sortedPaths(output.files);
    const identity = await withControllerCandidateCheckout(
      checkout,
      output,
      plan,
      attemptId,
      async (checkoutPath) => {
        const head = await runGit(
          ["-C", checkoutPath, "rev-parse", "HEAD"],
          "No se pudo leer el baseline candidato",
        );
        if (head !== plan.baselineCommit) {
          throw new TypeError(
            "El checkout candidato no parte del baseline aprobado",
          );
        }
        await runGit(
          ["-C", checkoutPath, "add", "--", ...approvedPaths],
          "No se pudo indexar el output candidato",
        );
        const staged = await runGit(
          [
            "-C",
            checkoutPath,
            "diff",
            "--cached",
            "--name-only",
            "--no-renames",
            plan.baselineCommit,
          ],
          "No se pudo comprobar el índice candidato",
        );
        const stagedPaths = staged === "" ? [] : staged.split("\n").sort();
        if (!samePaths(stagedPaths, approvedPaths)) {
          throw new TypeError(
            "El índice candidato contiene paths no aprobados",
          );
        }
        await assertGitObjectsMatchApprovedBytes(
          checkoutPath,
          "",
          approvedPaths,
        );
        await runGit(
          [
            "-C",
            checkoutPath,
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "Candidate generated output",
          ],
          "No se pudo crear el commit candidato",
        );
        const [candidateCommit, parent, candidateTree, status] =
          await Promise.all([
            runGit(
              ["-C", checkoutPath, "rev-parse", "HEAD"],
              "No se pudo leer el commit candidato",
            ),
            runGit(
              ["-C", checkoutPath, "rev-parse", "HEAD^"],
              "No se pudo leer el padre candidato",
            ),
            runGit(
              ["-C", checkoutPath, "rev-parse", "HEAD^{tree}"],
              "No se pudo leer el árbol candidato",
            ),
            runGit(
              [
                "-C",
                checkoutPath,
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              ],
              "No se pudo comprobar la limpieza candidata",
            ),
          ]);
        if (
          parent !== plan.baselineCommit ||
          status !== "" ||
          !commitPattern.test(candidateCommit) ||
          !commitPattern.test(candidateTree)
        ) {
          throw new TypeError(
            "El commit candidato no conserva un padre y checkout limpios",
          );
        }
        await assertGitObjectsMatchApprovedBytes(
          checkoutPath,
          candidateCommit,
          approvedPaths,
        );
        await assertOnlyApprovedDiff(
          checkoutPath,
          plan.baselineCommit,
          approvedPaths,
        );
        return Object.freeze({ candidateCommit, candidateTree });
      },
    );
    await assertControllerCandidateCheckout(checkout, output, plan, attemptId);
    const candidate = Object.freeze({
      candidateCommit: identity.candidateCommit,
      candidateTree: identity.candidateTree,
    });
    candidateCommitRecords.set(
      candidate,
      Object.freeze({
        checkout,
        output,
        attemptId,
        planCanonical: canonicalJson(plan),
        baselineCommit: plan.baselineCommit,
      }),
    );
    return candidate;
  } catch (error: unknown) {
    await removeControllerCandidateCheckout(checkout).catch(() => undefined);
    throw error;
  }
}

/**
 * Applies only an immutable controller-minted fixture inside commit A. No
 * caller receives the checkout path, command authority, or a build callback.
 */
export async function runCandidateBoundBuild(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
  capability: CandidateBuildTestCapability | undefined,
): Promise<CandidateBoundBuildEvidence> {
  const fixture = candidateBuildFixture(capability);
  await withCandidateCommitCheckout(
    candidate,
    plan,
    attemptId,
    async (checkoutPath) => {
      for (const path of Object.keys(fixture.files).sort()) {
        await writeCandidateFixtureFile(
          checkoutPath,
          path,
          fixture.files[path]!,
        );
      }
    },
  );
  await assertCandidateCommitOutput(candidate, plan, attemptId);
  return Object.freeze({
    candidateCommit: candidate.candidateCommit,
    candidateTree: candidate.candidateTree,
    planSha256: plan.planSha256,
    attemptId,
    validations: validatedCandidateBuildValidations(fixture),
  });
}

export interface CandidateCapturedBuild {
  readonly sourceConfiguration: CandidateBundleConfiguration;
  readonly copiedConfiguration: CandidateBundleConfiguration;
  readonly copiedArtifacts: readonly CandidateArtifactEntry[];
}

/**
 * Reads and copies the fixed generated output as one controller-owned
 * operation. The caller receives only verified metadata, never a checkout.
 */
export async function captureCandidateBuildArtifacts(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
  bundlePath: string,
): Promise<CandidateCapturedBuild> {
  let sourceConfiguration: CandidateBundleConfiguration | undefined;
  let copiedArtifacts: readonly CandidateArtifactEntry[] | undefined;
  await withCandidateCommitCheckout(
    candidate,
    plan,
    attemptId,
    async (checkoutPath) => {
      sourceConfiguration = await readCandidateBundleConfiguration(
        checkoutPath,
        plan,
      );
      copiedArtifacts = await copyCandidateBundle(checkoutPath, bundlePath);
    },
  );
  if (sourceConfiguration === undefined || copiedArtifacts === undefined) {
    throw new TypeError("No se pudo capturar el bundle candidato");
  }
  const copiedConfiguration = await readCandidateBundleConfiguration(
    bundlePath,
    plan,
  );
  if (
    canonicalJson(copiedConfiguration) !== canonicalJson(sourceConfiguration)
  ) {
    throw new TypeError(
      "La configuración copiada no coincide con el build candidato",
    );
  }
  return Object.freeze({
    sourceConfiguration,
    copiedConfiguration,
    copiedArtifacts,
  });
}

/** Executes one controller-owned build operation inside the private checkout. */
async function withCandidateCommitCheckout<T>(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
  operation: (checkoutPath: string) => Promise<T>,
): Promise<T> {
  const record = candidateCommitRecord(candidate);
  if (
    record.planCanonical !== canonicalJson(plan) ||
    record.attemptId !== attemptId ||
    record.baselineCommit !== plan.baselineCommit
  ) {
    throw new TypeError(
      "El commit candidato no coincide con el plan o intento",
    );
  }
  return await withControllerCandidateCheckout(
    record.checkout,
    record.output,
    plan,
    attemptId,
    async (checkoutPath) => {
      await assertCandidateCommitIdentity(
        checkoutPath,
        candidate,
        record.baselineCommit,
      );
      const result = await operation(checkoutPath);
      await assertCandidateCommitIdentity(
        checkoutPath,
        candidate,
        record.baselineCommit,
      );
      return result;
    },
  );
}

/** Revalidates the approved output bytes after a candidate-bound operation. */
export async function assertCandidateCommitOutput(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
): Promise<void> {
  const record = candidateCommitRecord(candidate);
  if (
    record.planCanonical !== canonicalJson(plan) ||
    record.attemptId !== attemptId ||
    record.baselineCommit !== plan.baselineCommit
  ) {
    throw new TypeError(
      "El commit candidato no coincide con el plan o intento",
    );
  }
  await assertControllerCandidateCheckout(
    record.checkout,
    record.output,
    plan,
    attemptId,
  );
  await withControllerCandidateCheckout(
    record.checkout,
    record.output,
    plan,
    attemptId,
    async (checkoutPath) =>
      await assertCandidateCommitIdentity(
        checkoutPath,
        candidate,
        record.baselineCommit,
      ),
  );
}

/** Anchors an already verified candidate commit only when creation can finish. */
export async function persistCandidateCommit(
  candidate: CandidateCommit,
  plan: ChangePlan,
  attemptId: string,
): Promise<void> {
  const record = candidateCommitRecord(candidate);
  if (
    record.planCanonical !== canonicalJson(plan) ||
    record.attemptId !== attemptId ||
    record.baselineCommit !== plan.baselineCommit
  ) {
    throw new TypeError(
      "El commit candidato no coincide con el plan o intento",
    );
  }
  await assertCandidateCommitOutput(candidate, plan, attemptId);
  await persistControllerCandidateRef(
    record.checkout,
    record.output,
    plan,
    attemptId,
    candidate.candidateCommit,
  );
}

export async function removeCandidateCommit(
  candidate: CandidateCommit,
): Promise<void> {
  const record = candidateCommitRecord(candidate);
  await removeControllerCandidateCheckout(record.checkout);
  candidateCommitRecords.delete(candidate);
}

/** Verifies only the durable private candidate ref bound to controller input. */
export async function assertDurableCandidateCommit(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
  candidateCommit: string,
): Promise<void> {
  await assertControllerCandidateRef(output, plan, attemptId, candidateCommit);
}
