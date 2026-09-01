import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import type { ChangePlan, ValidationResult } from "../domain.ts";
import { assertNoSuppliedSecretsBytes } from "../importers/secret-scan.ts";
import {
  assertControllerExecutionCopy,
  assertControllerStagedOutputAttempt,
  createControllerExecutionCopy,
  removeControllerExecutionCopy,
  type ControllerExecutionCopy,
  type ControllerExecutionIntegrity,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";

import { validateGeneratedAccessibility } from "./accessibility.ts";
import {
  COMMAND_TIMEOUT_MS,
  sanitizeCommandOutput,
  type BrowserCaptureDevice,
  type BrowserCheck,
  type BrowserValidationProof,
  type CommandCapability,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
} from "./commands.ts";
import { validateGeneratedAssets } from "./assets.ts";
import { validateGeneratedLinks } from "./links.ts";
import { validateOutputPolicy } from "./output-policy.ts";
import { validateGeneratedRoutes } from "./routes.ts";
import { validateGeneratedSeo } from "./seo.ts";

export type {
  BrowserCaptureDevice,
  BrowserCheck,
  BrowserValidationProof,
  BrowserValidationRequest,
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "./commands.ts";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const attemptIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,63})$/u;
const executableExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const capturedOutputMaximumBytes = 64 * 1024;
const processTerminationGraceMs = 5_000;
const processTerminationSettleMs = 1_000;
const controllerNpmExecutable = join(dirname(process.execPath), "npm");
const safeEnvironment = Object.freeze({
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: "/tmp",
  LANG: "C",
  LC_ALL: "C",
  CI: "true",
  NO_COLOR: "1",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

/**
 * Task 9 proves only the staged-output handoff. Task 10 must re-materialize
 * candidate A, recheck the approved hashes, and rerun candidate-bound command
 * and build validation before treating any result as final.
 */
export const PRELIMINARY_STAGED_VALIDATION_SCOPE =
  "preliminary-staged-output" as const;

export interface PreliminaryStagedValidationEvidence {
  readonly scope: typeof PRELIMINARY_STAGED_VALIDATION_SCOPE;
  readonly planSha256: string;
  readonly approvedOutputSha256: Readonly<Record<string, string>>;
  readonly executionCopy: {
    readonly outputSha256: Readonly<Record<string, string>>;
    readonly sha256: string;
  } | null;
}

export interface ValidationEvidenceRoot {
  readonly path: string;
}

export interface ControllerPublicationProfile {
  readonly sha256: string;
  readonly environment: string | null;
}

export interface ValidationInput {
  readonly output: StagedAgentOutput;
  readonly plan: ChangePlan;
  readonly attemptId: string;
  readonly evidenceRoot: ValidationEvidenceRoot;
  /**
   * Opaque controller capability minted from exact sanitized config bytes.
   * No caller-supplied config path or environment is accepted.
   */
  readonly publicationProfile?: ControllerPublicationProfile;
}

export interface ValidationOptions {
  /** Trusted controller/test capability; command authority is not input data. */
  readonly commands?: CommandRunner;
}

interface DirectoryRecord {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface EvidenceRootRecord extends DirectoryRecord {
  readonly output: StagedAgentOutput;
  readonly attemptId: string;
  readonly planCanonical: string;
  readonly attemptPath: string;
  readonly attemptIdentity: { readonly device: number; readonly inode: number };
}

interface PublicationProfileRecord {
  readonly output: StagedAgentOutput;
  readonly attemptId: string;
  readonly planCanonical: string;
  readonly sha256: string;
  readonly environment: string | null;
  readonly bytes: Buffer;
}

interface MaterializedPublicationProfile {
  readonly path: string;
  readonly sha256: string;
  readonly environment: string | null;
}

interface ExecutionState {
  readonly copy: ControllerExecutionCopy;
  integrity: ControllerExecutionIntegrity;
  profile?: MaterializedPublicationProfile;
}

interface StepOutcome {
  readonly findings: readonly string[];
  readonly details: Record<string, unknown>;
}

interface PipelineStep {
  readonly id: string;
  readonly execute: () => Promise<StepOutcome>;
}

interface BrowserDefinition {
  readonly check: BrowserCheck;
  readonly device?: BrowserCaptureDevice;
}

interface CommandDefinition {
  readonly id: string;
  readonly args: readonly string[];
  readonly capability: CommandCapability;
  readonly publicationScoped?: boolean;
  readonly browser?: BrowserDefinition;
}

const evidenceRoots = new WeakMap<ValidationEvidenceRoot, EvidenceRootRecord>();
const consumedEvidenceRoots = new WeakSet<ValidationEvidenceRoot>();
const publicationProfiles = new WeakMap<
  ControllerPublicationProfile,
  PublicationProfileRecord
>();

function isSameOrWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return sanitizeCommandOutput(error.message);
  return "fallo no identificable del validador";
}

async function regularFileBytes(path: string): Promise<{
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly device: number;
  readonly inode: number;
}> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new TypeError(
        "El archivo controlador no es regular de enlace único",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new TypeError("El archivo controlador cambió durante la lectura");
    }
    return Object.freeze({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      device: before.dev,
      inode: before.ino,
    });
  } finally {
    await handle.close();
  }
}

function exactOutputHashes(
  output: StagedAgentOutput,
): Readonly<Record<string, string>> {
  const paths = [...output.files].sort();
  if (
    paths.length !== output.files.length ||
    new Set(paths).size !== paths.length ||
    Object.keys(output.sha256).sort().join("\0") !== paths.join("\0")
  ) {
    throw new TypeError("El inventario controlador no conserva forma exacta");
  }
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    const hash = output.sha256[path];
    if (
      !safeRelativePath(path) ||
      hash === undefined ||
      !sha256Pattern.test(hash)
    ) {
      throw new TypeError(
        "El inventario controlador contiene un path o hash inválido",
      );
    }
    hashes[path] = hash;
  }
  return Object.freeze(hashes);
}

/**
 * Mints a fresh evidence directory for one exact staged capability, plan and
 * workspace attempt. The caller never supplies an existing directory.
 */
export async function createValidationEvidenceRoot(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<ValidationEvidenceRoot> {
  if (!attemptIdPattern.test(attemptId)) {
    throw new TypeError("El identificador de intento no es seguro");
  }
  await assertControllerStagedOutputAttempt(output, plan, attemptId);
  let rootPath: string | undefined;
  try {
    rootPath = await realpath(
      await mkdtemp(join(tmpdir(), "comunidadsolar-validation-evidence-")),
    );
    const attemptPath = join(rootPath, attemptId);
    await mkdir(attemptPath, { mode: 0o700 });
    const [rootEntry, attemptEntry] = await Promise.all([
      lstat(rootPath),
      lstat(attemptPath),
    ]);
    if (
      rootEntry.isSymbolicLink() ||
      !rootEntry.isDirectory() ||
      attemptEntry.isSymbolicLink() ||
      !attemptEntry.isDirectory() ||
      (await realpath(rootPath)) !== rootPath ||
      (await realpath(attemptPath)) !== attemptPath
    ) {
      throw new TypeError("No se pudo crear una raíz de evidencia segura");
    }
    const root: ValidationEvidenceRoot = Object.freeze({ path: rootPath });
    evidenceRoots.set(
      root,
      Object.freeze({
        path: rootPath,
        device: rootEntry.dev,
        inode: rootEntry.ino,
        output,
        attemptId,
        planCanonical: canonicalJson(plan),
        attemptPath,
        attemptIdentity: Object.freeze({
          device: attemptEntry.dev,
          inode: attemptEntry.ino,
        }),
      }),
    );
    return root;
  } catch (error: unknown) {
    if (rootPath !== undefined) {
      await rm(rootPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function assertEvidenceRoot(
  root: ValidationEvidenceRoot,
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<EvidenceRootRecord> {
  const record = evidenceRoots.get(root);
  if (
    record === undefined ||
    root.path !== record.path ||
    record.output !== output ||
    record.attemptId !== attemptId ||
    record.planCanonical !== canonicalJson(plan)
  ) {
    throw new TypeError(
      "El root de evidencia no pertenece al output, plan e intento del controlador",
    );
  }
  const [rootEntry, attemptEntry] = await Promise.all([
    lstat(record.path),
    lstat(record.attemptPath),
  ]);
  if (
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    rootEntry.dev !== record.device ||
    rootEntry.ino !== record.inode ||
    attemptEntry.isSymbolicLink() ||
    !attemptEntry.isDirectory() ||
    attemptEntry.dev !== record.attemptIdentity.device ||
    attemptEntry.ino !== record.attemptIdentity.inode ||
    (await realpath(record.path)) !== record.path ||
    (await realpath(record.attemptPath)) !== record.attemptPath ||
    dirname(record.attemptPath) !== record.path ||
    isSameOrWithin(record.path, output.path) ||
    isSameOrWithin(output.path, record.path)
  ) {
    throw new TypeError(
      "El root de evidencia no es seguro o solapa el staging",
    );
  }
  return record;
}

/**
 * Mints a digest-bound sanitized profile from controller-held bytes, never a
 * caller path or environment. The plan digest is the authority for the bytes.
 */
export async function createControllerPublicationProfile(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
  sanitizedConfig: Uint8Array,
): Promise<ControllerPublicationProfile> {
  if (
    !sha256Pattern.test(plan.publication.configSha256) ||
    !(sanitizedConfig instanceof Uint8Array) ||
    sanitizedConfig.byteLength === 0 ||
    sanitizedConfig.byteLength > 1024 * 1024 ||
    (plan.publication.adapter === "local" &&
      plan.publication.environment !== null) ||
    (plan.publication.adapter === "cloudflare" &&
      (typeof plan.publication.environment !== "string" ||
        plan.publication.environment.length === 0))
  ) {
    throw new TypeError(
      "El perfil de publicación no corresponde al plan aprobado",
    );
  }
  await assertControllerStagedOutputAttempt(output, plan, attemptId);
  const bytes = Buffer.from(sanitizedConfig);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoSuppliedSecretsBytes(bytes);
  } catch {
    throw new TypeError("El perfil de publicación no está saneado");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== plan.publication.configSha256) {
    throw new TypeError("El hash del perfil no coincide con el plan");
  }
  const profile: ControllerPublicationProfile = Object.freeze({
    sha256,
    environment: plan.publication.environment,
  });
  publicationProfiles.set(
    profile,
    Object.freeze({
      output,
      attemptId,
      planCanonical: canonicalJson(plan),
      sha256,
      environment: plan.publication.environment,
      bytes,
    }),
  );
  return profile;
}

async function publicationProfileFor(
  input: ValidationInput,
): Promise<PublicationProfileRecord> {
  if (input.publicationProfile === undefined) {
    throw new TypeError(
      "publication.profile: falta el perfil saneado y ligado al plan",
    );
  }
  const record = publicationProfiles.get(input.publicationProfile);
  if (
    record === undefined ||
    input.publicationProfile.sha256 !== record.sha256 ||
    input.publicationProfile.environment !== record.environment ||
    record.output !== input.output ||
    record.attemptId !== input.attemptId ||
    record.planCanonical !== canonicalJson(input.plan) ||
    createHash("sha256").update(record.bytes).digest("hex") !== record.sha256
  ) {
    throw new TypeError(
      "publication.profile: el perfil no pertenece al output, plan e intento",
    );
  }
  return record;
}

async function writeNewControllerFile(
  path: string,
  bytes: Buffer,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await handle.write(
        bytes,
        written,
        bytes.byteLength - written,
        null,
      );
      if (result.bytesWritten === 0) {
        throw new TypeError("No se pudo materializar el perfil de publicación");
      }
      written += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

async function materializePublicationProfile(
  state: ExecutionState,
  input: ValidationInput,
): Promise<MaterializedPublicationProfile> {
  if (state.profile !== undefined) return state.profile;
  state.integrity = await assertControllerExecutionCopy(
    state.copy,
    input.output,
    input.plan,
    input.attemptId,
  );
  const profile = await publicationProfileFor(input);
  const path = join(state.copy.path, "wrangler.jsonc");
  await writeNewControllerFile(path, profile.bytes);
  const actual = await regularFileBytes(path);
  if (actual.sha256 !== profile.sha256) {
    throw new TypeError("El perfil materializado no conserva su digest");
  }
  const materialized: MaterializedPublicationProfile = Object.freeze({
    path,
    sha256: actual.sha256,
    environment: profile.environment,
  });
  state.profile = materialized;
  return materialized;
}

async function assertMaterializedPublicationProfile(
  profile: MaterializedPublicationProfile,
): Promise<void> {
  const actual = await regularFileBytes(profile.path);
  if (actual.sha256 !== profile.sha256) {
    throw new TypeError("El perfil materializado cambió durante la validación");
  }
}

async function approvedInventory(
  output: StagedAgentOutput,
  plan: ChangePlan,
  attemptId: string,
): Promise<ReadonlyMap<string, Buffer>> {
  await assertControllerStagedOutputAttempt(output, plan, attemptId);
  const hashes = exactOutputHashes(output);
  const files = new Map<string, Buffer>();
  for (const path of Object.keys(hashes).sort()) {
    const file = await regularFileBytes(join(output.path, ...path.split("/")));
    if (file.sha256 !== hashes[path]) {
      throw new TypeError(
        "El archivo de staging ya no coincide con su inventario",
      );
    }
    files.set(path, file.bytes);
  }
  await assertControllerStagedOutputAttempt(output, plan, attemptId);
  return files;
}

async function knownInternalRoutes(
  copy: ControllerExecutionCopy,
  input: ValidationInput,
): Promise<ReadonlySet<string>> {
  await assertControllerExecutionCopy(
    copy,
    input.output,
    input.plan,
    input.attemptId,
  );
  const routes = new Set<string>(["/", input.plan.targetPath]);
  const pagesRoot = join(copy.path, "src", "pages");

  async function visit(relativeDirectory: string): Promise<void> {
    const directory =
      relativeDirectory === ""
        ? pagesRoot
        : join(pagesRoot, ...relativeDirectory.split("/"));
    const handle = await opendir(directory);
    const entries: string[] = [];
    for await (const entry of handle) entries.push(entry.name);
    for (const name of entries.sort()) {
      const relativePath =
        relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      if (!safeRelativePath(relativePath)) {
        throw new TypeError("La ruta interna contiene un path inseguro");
      }
      const absolute = join(pagesRoot, ...relativePath.split("/"));
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        throw new TypeError("La ruta interna no puede atravesar enlaces");
      }
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (
        !entry.isFile() ||
        !/\.(?:astro|md|mdx)$/iu.test(name) ||
        relativePath.split("/").some((segment) => segment.includes("["))
      ) {
        continue;
      }
      const withoutExtension = relativePath.replace(
        /\.(?:astro|md|mdx)$/iu,
        "",
      );
      const segments = withoutExtension.split("/");
      if (segments.at(-1) === "index") segments.pop();
      routes.add(segments.length === 0 ? "/" : `/${segments.join("/")}`);
    }
  }

  try {
    const root = await lstat(pagesRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) {
      throw new TypeError("El árbol de rutas no es un directorio seguro");
    }
    await visit("");
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await assertControllerExecutionCopy(
    copy,
    input.output,
    input.plan,
    input.attemptId,
  );
  return Object.freeze(routes);
}

function validateImportsDependenciesAndSecrets(
  plan: ChangePlan,
  files: ReadonlyMap<string, Buffer>,
): readonly string[] {
  const findings: string[] = [];
  if (plan.dependencies.length > 0) {
    findings.push(
      "dependency.policy: las dependencias generadas no tienen grafo confiable",
    );
  }
  for (const [path, bytes] of files) {
    try {
      assertNoSuppliedSecretsBytes(bytes);
    } catch {
      findings.push(`secret.detected: ${path} parece contener una credencial`);
    }
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (executableExtensions.has(extension)) {
      findings.push(
        `import.source: ${path} es un source ejecutable no autorizado`,
      );
    }
  }
  return findings;
}

function normalizedBrowserProof(
  value: unknown,
): BrowserValidationProof | undefined {
  const proof = asRecord(value);
  const evidenceSha256 =
    proof !== null && typeof proof.evidenceSha256 === "string"
      ? proof.evidenceSha256
      : "";
  if (
    proof === null ||
    typeof proof.check !== "string" ||
    typeof proof.targetPath !== "string" ||
    !sha256Pattern.test(evidenceSha256) ||
    (proof.device !== undefined &&
      proof.device !== "desktop" &&
      proof.device !== "tablet" &&
      proof.device !== "mobile")
  ) {
    return undefined;
  }
  return Object.freeze({
    check: proof.check as BrowserCheck,
    targetPath: proof.targetPath as `/${string}`,
    ...(proof.device === undefined
      ? {}
      : { device: proof.device as BrowserCaptureDevice }),
    evidenceSha256,
  });
}

function normalizedCommandResult(value: unknown): CommandResult {
  const result = asRecord(value);
  if (result === null) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "El command runner devolvió un resultado inválido",
      timedOut: false,
      aborted: true,
      unsupported: false,
    };
  }
  const proof = normalizedBrowserProof(result.browserProof);
  return Object.freeze({
    exitCode:
      typeof result.exitCode === "number" && Number.isInteger(result.exitCode)
        ? result.exitCode
        : result.exitCode === null
          ? null
          : null,
    stdout:
      typeof result.stdout === "string"
        ? sanitizeCommandOutput(result.stdout)
        : "",
    stderr:
      typeof result.stderr === "string"
        ? sanitizeCommandOutput(result.stderr)
        : "",
    timedOut: result.timedOut === true,
    aborted: result.aborted === true,
    unsupported: result.unsupported === true,
    ...(proof === undefined ? {} : { browserProof: proof }),
  });
}

function browserProofFailure(
  command: CommandInvocation,
  result: CommandResult,
): string | null {
  if (command.browser === undefined) return null;
  const proof = result.browserProof;
  if (proof === undefined) {
    return "browser.proof: falta evidencia estructurada para la ruta solicitada";
  }
  if (
    proof.check !== command.browser.check ||
    proof.targetPath !== command.browser.targetPath ||
    proof.device !== command.browser.device
  ) {
    return "browser.proof: la evidencia no corresponde a la ruta, check o dispositivo solicitado";
  }
  return null;
}

function commandFailure(
  command: CommandInvocation,
  result: CommandResult,
): string | null {
  if (result.unsupported)
    return "command.unsupported: falta una capability exacta del controlador";
  if (result.timedOut)
    return "command.timeout: el comando superó el límite de diez minutos";
  if (result.aborted) return "command.aborted: el comando fue abortado";
  if (result.exitCode !== 0)
    return `command.exit: el comando terminó con código ${result.exitCode ?? "nulo"}`;
  return browserProofFailure(command, result);
}

function commandDetails(
  command: CommandInvocation,
  result: CommandResult,
): Record<string, unknown> {
  return {
    command: {
      argv: command.argv,
      capability: command.capability,
      cwd: "controller-execution-copy",
      timeoutMs: command.timeoutMs,
      environmentKeys: Object.keys(command.env).sort(),
      ...(command.browser === undefined ? {} : { browser: command.browser }),
    },
    result: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted,
      unsupported: result.unsupported,
      ...(result.browserProof === undefined
        ? {}
        : { browserProof: result.browserProof }),
    },
  };
}

function commandDefinitions(plan: ChangePlan): readonly CommandDefinition[] {
  const target = plan.targetPath;
  const browserArgs = (grep: string): readonly string[] => [
    "run",
    "test:e2e",
    "--",
    "--grep",
    grep,
    "--target-path",
    target,
  ];
  return [
    { id: "npm-ci", args: ["ci"], capability: "process" },
    { id: "format", args: ["run", "format:check"], capability: "process" },
    { id: "lint", args: ["run", "lint"], capability: "process" },
    { id: "check", args: ["run", "check"], capability: "process" },
    { id: "unit-tests", args: ["run", "test:unit"], capability: "process" },
    {
      id: "build",
      args: ["run", "build"],
      capability: "process",
      publicationScoped: true,
    },
    {
      id: "integration-tests",
      args: ["run", "test:integration"],
      capability: "process",
      publicationScoped: true,
    },
    {
      id: "http-tests",
      args: ["run", "test:http", "--", "--scope", "all"],
      capability: "process",
      publicationScoped: true,
    },
    {
      id: "preview",
      args: ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4321"],
      capability: "preview",
      browser: { check: "preview" },
    },
    {
      id: "e2e",
      args: [
        "run",
        "test:e2e",
        "--",
        "--grep-invert",
        "@ingestion",
        "--target-path",
        target,
      ],
      capability: "browser",
      browser: { check: "e2e" },
    },
    {
      id: "route-smoke",
      args: browserArgs("@route-smoke"),
      capability: "browser",
      browser: { check: "route-smoke" },
    },
    {
      id: "console-errors",
      args: browserArgs("@console-errors"),
      capability: "browser",
      browser: { check: "console-errors" },
    },
    {
      id: "axe",
      args: browserArgs("@axe"),
      capability: "browser",
      browser: { check: "axe" },
    },
    {
      id: "capture-desktop",
      args: browserArgs("@capture-desktop"),
      capability: "browser",
      browser: { check: "capture", device: "desktop" },
    },
    {
      id: "capture-tablet",
      args: browserArgs("@capture-tablet"),
      capability: "browser",
      browser: { check: "capture", device: "tablet" },
    },
    {
      id: "capture-mobile",
      args: browserArgs("@capture-mobile"),
      capability: "browser",
      browser: { check: "capture", device: "mobile" },
    },
    ...(plan.overwritesExistingRoute
      ? [
          {
            id: "html-visual-comparison",
            args: [
              "run",
              "parity:visual",
              "--",
              "--scope",
              "overwrite",
              "--target-path",
              target,
            ],
            capability: "browser" as const,
            browser: { check: "html-visual-comparison" as const },
          },
        ]
      : []),
  ];
}

function capture(stream: NodeJS.ReadableStream | null): {
  rendered: () => string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  stream?.on("data", (chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = capturedOutputMaximumBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const selected = buffer.subarray(0, remaining);
    chunks.push(selected);
    bytes += selected.byteLength;
    if (selected.byteLength < buffer.byteLength) truncated = true;
  });
  return {
    rendered: () =>
      sanitizeCommandOutput(
        `${Buffer.concat(chunks).toString("utf8")}${truncated ? "\n[captured output truncated]" : ""}`,
      ),
  };
}

function unsupportedResult(message: string): CommandResult {
  return Object.freeze({
    exitCode: null,
    stdout: "",
    stderr: message,
    timedOut: false,
    aborted: false,
    unsupported: true,
  });
}

function signalProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      if (errorCode(error) === "ESRCH") return;
    }
  }
  child.kill(signal);
}

/**
 * Private raw execution: only fixed commands built below can reach this
 * function. It cannot be imported as a generic argv/cwd/env executor.
 */
async function runFixedControllerCommand(
  command: CommandInvocation,
): Promise<CommandResult> {
  if (command.capability !== "process") {
    return unsupportedResult(
      `La capability ${command.capability} requiere un adapter exacto del controlador`,
    );
  }
  return await new Promise<CommandResult>((resolve) => {
    let timedOut = false;
    let spawnFailure: Error | undefined;
    let closed = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let stdout: { rendered: () => string } = { rendered: () => "" };
    let stderr: { rendered: () => string } = { rendered: () => "" };
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      forceAborted = false,
    ): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      const error =
        spawnFailure === undefined ? "" : `\n${spawnFailure.message}`;
      resolve(
        Object.freeze({
          exitCode: spawnFailure === undefined ? exitCode : null,
          stdout: stdout.rendered(),
          stderr: sanitizeCommandOutput(`${stderr.rendered()}${error}`),
          timedOut,
          aborted:
            forceAborted ||
            timedOut ||
            spawnFailure !== undefined ||
            signal !== null,
          unsupported: false,
        }),
      );
    };
    try {
      child = spawn(command.argv[0]!, command.argv.slice(1), {
        cwd: command.cwd,
        env: command.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      spawnFailure =
        error instanceof Error
          ? error
          : new Error("No se pudo iniciar el comando");
      resolve(
        Object.freeze({
          exitCode: null,
          stdout: "",
          stderr: sanitizeCommandOutput(spawnFailure.message),
          timedOut: false,
          aborted: true,
          unsupported: false,
        }),
      );
      return;
    }
    stdout = capture(child.stdout);
    stderr = capture(child.stderr);
    const timeout = setTimeout(() => {
      if (closed || child?.exitCode !== null) return;
      timedOut = true;
      signalProcessGroup(child!, "SIGTERM");
      terminationTimer = setTimeout(() => {
        if (closed) return;
        signalProcessGroup(child!, "SIGKILL");
        settlementTimer = setTimeout(() => {
          finish(null, "SIGKILL", true);
        }, processTerminationSettleMs);
      }, processTerminationGraceMs);
    }, command.timeoutMs);
    child.once("error", (error: Error) => {
      spawnFailure = error;
      finish(null, "SIGTERM", true);
    });
    child.once("close", finish);
  });
}

function commandEnvironment(
  profile: MaterializedPublicationProfile,
  publicationScoped: boolean | undefined,
): Readonly<Record<string, string>> {
  if (!publicationScoped || profile.environment === null)
    return safeEnvironment;
  return Object.freeze({
    ...safeEnvironment,
    CLOUDFLARE_CONFIG_PATH: profile.path,
    CLOUDFLARE_ENV: profile.environment,
  });
}

function fixedControllerCommand(
  definition: CommandDefinition,
  targetPath: ChangePlan["targetPath"],
  cwd: string,
  profile: MaterializedPublicationProfile,
): CommandInvocation {
  const browser =
    definition.browser === undefined
      ? undefined
      : Object.freeze({
          check: definition.browser.check,
          targetPath,
          ...(definition.browser.device === undefined
            ? {}
            : { device: definition.browser.device }),
        });
  return Object.freeze({
    id: definition.id,
    capability: definition.capability,
    argv: Object.freeze([controllerNpmExecutable, ...definition.args]),
    cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: commandEnvironment(profile, definition.publicationScoped),
    ...(browser === undefined ? {} : { browser }),
  });
}

function preliminaryEvidence(
  input: ValidationInput,
  execution: ExecutionState | undefined,
): PreliminaryStagedValidationEvidence {
  const outputSha256 = exactOutputHashes(input.output);
  return Object.freeze({
    scope: PRELIMINARY_STAGED_VALIDATION_SCOPE,
    planSha256: input.plan.planSha256,
    approvedOutputSha256: outputSha256,
    executionCopy:
      execution === undefined
        ? null
        : Object.freeze({
            outputSha256: execution.integrity.outputSha256,
            sha256: execution.integrity.sha256,
          }),
  });
}

async function persistEvidence(
  directory: string,
  index: number,
  attemptId: string,
  id: string,
  status: ValidationResult["status"],
  preliminary: PreliminaryStagedValidationEvidence,
  details: Record<string, unknown>,
): Promise<ValidationResult> {
  const filename = `${String(index).padStart(2, "0")}-${id}.json`;
  const path = join(directory, filename);
  const bytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 2,
        attemptId,
        id,
        status,
        preliminary,
        details,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const actual = await readFile(path);
  return Object.freeze({
    id,
    status,
    evidence: path,
    evidenceSha256: createHash("sha256").update(actual).digest("hex"),
  });
}

/**
 * Executes the fixed, fail-closed validation sequence over controller-minted
 * staged output. Command results are preliminary and never candidate-final.
 */
export async function runValidation(
  input: ValidationInput,
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  await assertControllerStagedOutputAttempt(
    input.output,
    input.plan,
    input.attemptId,
  );
  const evidenceRoot = await assertEvidenceRoot(
    input.evidenceRoot,
    input.output,
    input.plan,
    input.attemptId,
  );
  if (consumedEvidenceRoots.has(input.evidenceRoot)) {
    throw new TypeError("La evidencia del intento ya fue utilizada");
  }
  consumedEvidenceRoots.add(input.evidenceRoot);
  const commandRunner = options.commands ?? runFixedControllerCommand;
  let inventory: ReadonlyMap<string, Buffer> | undefined;
  let execution: ExecutionState | undefined;

  const files = async (): Promise<ReadonlyMap<string, Buffer>> => {
    if (inventory === undefined) {
      inventory = await approvedInventory(
        input.output,
        input.plan,
        input.attemptId,
      );
    }
    return inventory;
  };
  const ensureExecution = async (): Promise<ExecutionState> => {
    if (execution !== undefined) return execution;
    const copy = await createControllerExecutionCopy(
      input.output,
      input.plan,
      input.attemptId,
    );
    try {
      execution = {
        copy,
        integrity: await assertControllerExecutionCopy(
          copy,
          input.output,
          input.plan,
          input.attemptId,
        ),
      };
      return execution;
    } catch (error: unknown) {
      await removeControllerExecutionCopy(copy).catch(() => undefined);
      throw error;
    }
  };
  const validator = (
    id: string,
    check: (files: ReadonlyMap<string, Buffer>) => readonly string[],
  ): PipelineStep => ({
    id,
    execute: async () => {
      const current = await files();
      const findings = check(current);
      return { findings, details: { findings } };
    },
  });
  const commandSteps = commandDefinitions(input.plan).map(
    (definition): PipelineStep => ({
      id: definition.id,
      execute: async () => {
        const state = await ensureExecution();
        const profile = await materializePublicationProfile(state, input);
        state.integrity = await assertControllerExecutionCopy(
          state.copy,
          input.output,
          input.plan,
          input.attemptId,
        );
        await assertMaterializedPublicationProfile(profile);
        const command = fixedControllerCommand(
          definition,
          input.plan.targetPath,
          state.copy.path,
          profile,
        );
        const result = normalizedCommandResult(await commandRunner(command));
        state.integrity = await assertControllerExecutionCopy(
          state.copy,
          input.output,
          input.plan,
          input.attemptId,
        );
        await assertMaterializedPublicationProfile(profile);
        const failure = commandFailure(command, result);
        return {
          findings: failure === null ? [] : [failure],
          details: commandDetails(command, result),
        };
      },
    }),
  );
  const steps: PipelineStep[] = [
    {
      id: "output-policy",
      execute: async () => {
        const violations = await validateOutputPolicy(
          input.output.path,
          input.output,
          input.plan,
        );
        const findings = violations.map(
          (violation) => `${violation.code}: ${violation.path ?? "(global)"}`,
        );
        return { findings, details: { violations } };
      },
    },
    validator("routes", (current) =>
      validateGeneratedRoutes(input.plan, current),
    ),
    validator("assets", (current) =>
      validateGeneratedAssets(input.plan, current),
    ),
    validator("imports-dependencies-secrets", (current) =>
      validateImportsDependenciesAndSecrets(input.plan, current),
    ),
    {
      id: "links",
      execute: async () => {
        const [current, state] = await Promise.all([
          files(),
          ensureExecution(),
        ]);
        const routes = await knownInternalRoutes(state.copy, input);
        const findings = validateGeneratedLinks(input.plan, current, routes);
        return { findings, details: { findings } };
      },
    },
    validator("seo", (current) => validateGeneratedSeo(input.plan, current)),
    validator("accessibility", (current) =>
      validateGeneratedAccessibility(input.plan, current),
    ),
    ...commandSteps,
  ];

  const results: ValidationResult[] = [];
  let failed = false;
  try {
    for (const [index, step] of steps.entries()) {
      if (failed) {
        results.push(
          await persistEvidence(
            evidenceRoot.attemptPath,
            index,
            input.attemptId,
            step.id,
            "skipped",
            preliminaryEvidence(input, execution),
            { reason: "Una validación dependiente anterior falló" },
          ),
        );
        continue;
      }
      let outcome: StepOutcome;
      try {
        outcome = await step.execute();
        if (step.id === "output-policy" && outcome.findings.length === 0) {
          const state = await ensureExecution();
          outcome = {
            findings: outcome.findings,
            details: {
              ...outcome.details,
              executionCopy: { sha256: state.integrity.sha256 },
            },
          };
        }
      } catch (error: unknown) {
        outcome = {
          findings: [`validator.error: ${errorMessage(error)}`],
          details: { error: errorMessage(error) },
        };
      }
      const status: ValidationResult["status"] =
        outcome.findings.length === 0 ? "passed" : "failed";
      results.push(
        await persistEvidence(
          evidenceRoot.attemptPath,
          index,
          input.attemptId,
          step.id,
          status,
          preliminaryEvidence(input, execution),
          outcome.details,
        ),
      );
      failed = status === "failed";
    }
    return results;
  } finally {
    if (execution !== undefined) {
      await removeControllerExecutionCopy(execution.copy).catch(
        () => undefined,
      );
    }
  }
}
