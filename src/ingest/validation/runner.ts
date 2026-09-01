import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "../canonical-json.ts";
import type { ChangePlan, ValidationResult } from "../domain.ts";
import { assertNoSuppliedSecretsBytes } from "../importers/secret-scan.ts";
import {
  assertControllerStagedOutput,
  type StagedAgentOutput,
} from "../workspaces/policy.ts";

import { validateGeneratedAccessibility } from "./accessibility.ts";
import {
  controllerCommand,
  runControllerCommand,
  sanitizeCommandOutput,
  type CloudflareCommandProfile,
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

export interface ValidationEvidenceRoot {
  readonly path: string;
}

export interface ControllerPublicationProfile {
  readonly path: string;
  readonly sha256: string;
  readonly environment: string;
}

export interface ValidationInput {
  readonly output: StagedAgentOutput;
  readonly plan: ChangePlan;
  readonly attemptId: string;
  readonly evidenceRoot: ValidationEvidenceRoot;
  /** Required only for Cloudflare plans and minted from a controller profile. */
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

interface PublicationProfileRecord extends DirectoryRecord {
  readonly sha256: string;
  readonly environment: string;
  readonly planCanonical: string;
}

interface StepOutcome {
  readonly findings: readonly string[];
  readonly details: Record<string, unknown>;
}

interface PipelineStep {
  readonly id: string;
  readonly execute: () => Promise<StepOutcome>;
}

interface CommandDefinition {
  readonly id: string;
  readonly args: readonly string[];
  readonly capability: CommandCapability;
  readonly publicationScoped?: boolean;
}

const evidenceRoots = new WeakMap<ValidationEvidenceRoot, DirectoryRecord>();
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

/** Mints an opaque controller evidence-root capability from an existing directory. */
export async function createValidationEvidenceRoot(
  path: string,
): Promise<ValidationEvidenceRoot> {
  if (!isAbsolute(path)) {
    throw new TypeError("El root de evidencia debe ser una ruta absoluta");
  }
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError("El root de evidencia debe ser un directorio regular");
  }
  const canonical = await realpath(path);
  const canonicalEntry = await lstat(canonical);
  if (canonicalEntry.isSymbolicLink() || !canonicalEntry.isDirectory()) {
    throw new TypeError("El root de evidencia no conserva identidad canónica");
  }
  const root: ValidationEvidenceRoot = Object.freeze({ path: canonical });
  evidenceRoots.set(
    root,
    Object.freeze({
      path: canonical,
      device: canonicalEntry.dev,
      inode: canonicalEntry.ino,
    }),
  );
  return root;
}

async function assertEvidenceRoot(
  root: ValidationEvidenceRoot,
  stagingPath: string,
): Promise<DirectoryRecord> {
  const record = evidenceRoots.get(root);
  if (record === undefined || root.path !== record.path) {
    throw new TypeError("El root de evidencia no pertenece a este controlador");
  }
  const entry = await lstat(record.path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.dev !== record.device ||
    entry.ino !== record.inode ||
    (await realpath(record.path)) !== record.path ||
    isSameOrWithin(record.path, stagingPath) ||
    isSameOrWithin(stagingPath, record.path)
  ) {
    throw new TypeError(
      "El root de evidencia no es seguro o solapa el staging",
    );
  }
  return record;
}

async function createAttemptDirectory(
  root: DirectoryRecord,
  attemptId: string,
): Promise<string> {
  if (!attemptIdPattern.test(attemptId)) {
    throw new TypeError("El identificador de intento no es seguro");
  }
  const path = join(root.path, attemptId);
  if (!isSameOrWithin(root.path, path) || path === root.path) {
    throw new TypeError(
      "El identificador de intento escapa del root de evidencia",
    );
  }
  await mkdir(path, { mode: 0o700 });
  const entry = await lstat(path);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(path)) !== path
  ) {
    throw new TypeError("El directorio de intento no es seguro");
  }
  return path;
}

/**
 * Mints a Cloudflare config capability only after its digest matches the exact
 * approved publication profile. It never accepts env values from the caller.
 */
export async function createControllerPublicationProfile(
  path: string,
  plan: ChangePlan,
): Promise<ControllerPublicationProfile> {
  if (
    plan.publication.adapter !== "cloudflare" ||
    typeof plan.publication.environment !== "string" ||
    plan.publication.environment.length === 0 ||
    !sha256Pattern.test(plan.publication.configSha256) ||
    !isAbsolute(path)
  ) {
    throw new TypeError("El perfil Cloudflare no corresponde al plan aprobado");
  }
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new TypeError("El perfil Cloudflare debe ser un archivo regular");
  }
  const canonical = await realpath(path);
  const file = await regularFileBytes(canonical);
  if (file.sha256 !== plan.publication.configSha256) {
    throw new TypeError(
      "El hash del perfil Cloudflare no coincide con el plan",
    );
  }
  const profile: ControllerPublicationProfile = Object.freeze({
    path: canonical,
    sha256: file.sha256,
    environment: plan.publication.environment,
  });
  publicationProfiles.set(
    profile,
    Object.freeze({
      path: canonical,
      sha256: file.sha256,
      environment: plan.publication.environment,
      planCanonical: canonicalJson(plan),
      device: file.device,
      inode: file.inode,
    }),
  );
  return profile;
}

async function cloudflareProfileFor(
  plan: ChangePlan,
  supplied: ControllerPublicationProfile | undefined,
  stagingPath: string,
): Promise<CloudflareCommandProfile | undefined> {
  if (plan.publication.adapter === "local") {
    if (supplied !== undefined) {
      throw new TypeError("El plan local no admite un perfil Cloudflare");
    }
    return undefined;
  }
  if (supplied === undefined) return undefined;
  const record = publicationProfiles.get(supplied);
  if (
    record === undefined ||
    supplied.path !== record.path ||
    supplied.sha256 !== record.sha256 ||
    supplied.environment !== record.environment ||
    canonicalJson(plan) !== record.planCanonical ||
    isSameOrWithin(stagingPath, record.path) ||
    isSameOrWithin(record.path, stagingPath)
  ) {
    throw new TypeError(
      "El perfil Cloudflare no pertenece al plan controlador",
    );
  }
  const entry = await lstat(record.path);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.dev !== record.device ||
    entry.ino !== record.inode ||
    (await realpath(record.path)) !== record.path
  ) {
    throw new TypeError("La identidad del perfil Cloudflare cambió");
  }
  const current = await regularFileBytes(record.path);
  if (current.sha256 !== record.sha256) {
    throw new TypeError("El perfil Cloudflare cambió durante la validación");
  }
  return Object.freeze({ path: record.path, environment: record.environment });
}

async function approvedInventory(
  output: StagedAgentOutput,
  plan: ChangePlan,
): Promise<ReadonlyMap<string, Buffer>> {
  await assertControllerStagedOutput(output, plan);
  const paths = [...output.files].sort();
  if (
    paths.length !== output.files.length ||
    new Set(paths).size !== paths.length ||
    Object.keys(output.sha256).sort().join("\0") !== paths.join("\0")
  ) {
    throw new TypeError("El inventario controlador no conserva forma exacta");
  }
  const files = new Map<string, Buffer>();
  for (const path of paths) {
    const expected = output.sha256[path];
    if (
      !safeRelativePath(path) ||
      expected === undefined ||
      !sha256Pattern.test(expected)
    ) {
      throw new TypeError(
        "El inventario controlador contiene un path o hash inválido",
      );
    }
    const file = await regularFileBytes(join(output.path, ...path.split("/")));
    if (file.sha256 !== expected) {
      throw new TypeError(
        "El archivo de staging ya no coincide con su inventario",
      );
    }
    files.set(path, file.bytes);
  }
  return files;
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
  });
}

function commandFailure(result: CommandResult): string | null {
  if (result.unsupported)
    return "command.unsupported: falta una capability exacta del controlador";
  if (result.timedOut)
    return "command.timeout: el comando superó el límite de diez minutos";
  if (result.aborted) return "command.aborted: el comando fue abortado";
  if (result.exitCode !== 0)
    return `command.exit: el comando terminó con código ${result.exitCode ?? "nulo"}`;
  return null;
}

function commandDetails(
  command: CommandInvocation,
  result: CommandResult,
): Record<string, unknown> {
  return {
    command: {
      argv: command.argv,
      capability: command.capability,
      cwd: "controller-staging",
      timeoutMs: command.timeoutMs,
      environmentKeys: Object.keys(command.env).sort(),
    },
    result: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted,
      unsupported: result.unsupported,
    },
  };
}

function commandDefinitions(overwrite: boolean): readonly CommandDefinition[] {
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
    },
    {
      id: "e2e",
      args: ["run", "test:e2e", "--", "--grep-invert", "@ingestion"],
      capability: "browser",
    },
    {
      id: "route-smoke",
      args: ["run", "test:e2e", "--", "--grep", "@route-smoke"],
      capability: "browser",
    },
    {
      id: "console-errors",
      args: ["run", "test:e2e", "--", "--grep", "@console-errors"],
      capability: "browser",
    },
    {
      id: "axe",
      args: ["run", "test:e2e", "--", "--grep", "@axe"],
      capability: "browser",
    },
    {
      id: "capture-desktop",
      args: ["run", "test:e2e", "--", "--grep", "@capture-desktop"],
      capability: "browser",
    },
    {
      id: "capture-tablet",
      args: ["run", "test:e2e", "--", "--grep", "@capture-tablet"],
      capability: "browser",
    },
    {
      id: "capture-mobile",
      args: ["run", "test:e2e", "--", "--grep", "@capture-mobile"],
      capability: "browser",
    },
    ...(overwrite
      ? [
          {
            id: "html-visual-comparison",
            args: ["run", "parity:visual", "--", "--scope", "overwrite"],
            capability: "browser" as const,
          },
        ]
      : []),
  ];
}

async function persistEvidence(
  directory: string,
  index: number,
  attemptId: string,
  id: string,
  status: ValidationResult["status"],
  details: Record<string, unknown>,
): Promise<ValidationResult> {
  const filename = `${String(index).padStart(2, "0")}-${id}.json`;
  const path = join(directory, filename);
  const bytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, attemptId, id, status, details }, null, 2)}\n`,
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
 * staging. A failed step records later steps as skipped for this attempt only.
 */
export async function runValidation(
  input: ValidationInput,
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  await assertControllerStagedOutput(input.output, input.plan);
  const evidenceRoot = await assertEvidenceRoot(
    input.evidenceRoot,
    input.output.path,
  );
  const attemptDirectory = await createAttemptDirectory(
    evidenceRoot,
    input.attemptId,
  );
  const commandRunner = options.commands ?? runControllerCommand;
  let inventory: ReadonlyMap<string, Buffer> | undefined;
  const files = async (): Promise<ReadonlyMap<string, Buffer>> => {
    if (inventory === undefined)
      inventory = await approvedInventory(input.output, input.plan);
    return inventory;
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
  const commands = commandDefinitions(input.plan.overwritesExistingRoute).map(
    (definition): PipelineStep => ({
      id: definition.id,
      execute: async () => {
        let profile: CloudflareCommandProfile | undefined;
        if (definition.publicationScoped) {
          if (
            input.plan.publication.adapter === "cloudflare" &&
            input.publicationProfile === undefined
          ) {
            return {
              findings: [
                "publication.profile: falta el perfil Cloudflare saneado y ligado al plan",
              ],
              details: { findings: ["publication.profile: unavailable"] },
            };
          }
          profile = await cloudflareProfileFor(
            input.plan,
            input.publicationProfile,
            input.output.path,
          );
        }
        const command = controllerCommand(
          definition.id,
          definition.args,
          input.output.path,
          definition.capability,
          profile,
        );
        const result = normalizedCommandResult(await commandRunner(command));
        const failure = commandFailure(result);
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
    validator("links", (current) =>
      validateGeneratedLinks(input.plan, current),
    ),
    validator("seo", (current) => validateGeneratedSeo(input.plan, current)),
    validator("accessibility", (current) =>
      validateGeneratedAccessibility(input.plan, current),
    ),
    ...commands,
  ];

  const results: ValidationResult[] = [];
  let failed = false;
  for (const [index, step] of steps.entries()) {
    if (failed) {
      results.push(
        await persistEvidence(
          attemptDirectory,
          index,
          input.attemptId,
          step.id,
          "skipped",
          { reason: "Una validación dependiente anterior falló" },
        ),
      );
      continue;
    }
    let outcome: StepOutcome;
    try {
      outcome = await step.execute();
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
        attemptDirectory,
        index,
        input.attemptId,
        step.id,
        status,
        outcome.details,
      ),
    );
    failed = status === "failed";
  }
  return results;
}
