import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  CodexAgent,
  createCodexExecutableCapability,
  type CodexExecutableCapability,
} from "./agents/codex.ts";
import { CommandAgent, type CommandAgentConfig } from "./agents/command.ts";
import { createOperatorIsolationBroker } from "./agents/isolation.ts";
import {
  runProcess,
  type AgentAdapter,
  type AgentRunResult,
  type BrokerRunInput,
  type BrokerRunResult,
} from "./agents/types.ts";
import {
  approveGate1,
  approveGate2,
  verifyApproval,
} from "./approvals/service.ts";
import {
  createCandidate,
  loadCandidate,
  openControllerCandidateStore,
  releaseControllerCandidateStore,
  verifyCandidateArtifact,
  verifyCandidateEvidence,
  type CandidateLocalPublicationTestCapability,
  type CandidatePreviewTestCapability,
  type ControllerCandidateStore,
} from "./candidate/manifest.ts";
import type { CandidateBuildTestCapability } from "./candidate/evidence.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  assertCandidateDossierProjectionBinding,
  candidateDossierPreimageSha256,
  candidateDossierCommitmentFromProjection,
  parseCandidateDossierPreimage,
  sanitizedDossierSha256,
  type CandidateDossierPreimage,
  type SanitizedCandidateProjection,
} from "./dossier-integrity.ts";
import { createSanitizedCandidateDossier } from "./dossier.ts";
import type {
  ApprovalRecord,
  AttemptRecord,
  CandidateManifest,
  ChangePlan,
  ChangeRecord,
  ChangeState,
  NormalizedRequest,
  ValidationResult,
} from "./domain.ts";
import {
  fixedGitArgs,
  fixedGitExecutable,
  sanitizedGitEnv,
} from "./git-env.ts";
import { importPage } from "./importers/page.ts";
import { importRequest } from "./importers/request.ts";
import { assertNormalizedRequest } from "./importers/common.ts";
import { ingestPaths, type IngestPaths } from "./paths.ts";
import { LocalPublisher } from "./publishers/local.ts";
import type { OperatorProfile } from "./publishers/types.ts";
import {
  createChangePlan,
  preparePlanningPublication,
  type PreparedPlanningPublication,
} from "./planning/plan.ts";
import { validateSchema } from "./schema-validator.ts";
import { safeError } from "./safe-output.ts";
import {
  createStateStore,
  writeAtomic,
  type LockedChange,
  type StateStore,
} from "./state-store.ts";
import {
  createControllerPublicationProfile,
  createValidationEvidenceRoot,
  runValidation,
  type ValidationOptions,
} from "./validation/runner.ts";
import {
  removeStagedAgentOutput,
  validateAgentWorkspaceOutput,
} from "./workspaces/policy.ts";
import {
  createAgentWorkspace,
  removeAgentWorkspace,
  workspaceInputs,
  type AgentWorkspace,
} from "./workspaces/service.ts";

const execFileAsync = promisify(execFile);
const changeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/u;
const attemptIdPattern = /^attempt-\d{6}$/u;
const safeRelativePath =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const schemaPath = "schemas/ingestion/agent-result.schema.json";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40,64}$/u;
const fixtureRecordChangeIds = new Set([
  "fixture-request-blocks",
  "fixture-request-hybrid",
  "fixture-page-freeform",
]);

export type ControllerResult =
  | { readonly kind: "success"; readonly value: Record<string, unknown> }
  | { readonly kind: "gate-pending"; readonly gate: 1 | 2 };

export interface IngestionAudit {
  readonly ok: boolean;
  readonly changes: readonly {
    readonly changeId: string;
    readonly state: ChangeState;
    readonly revision: number;
    readonly candidate: {
      readonly artifactSha256: string;
      readonly candidateCommit: string;
    } | null;
  }[];
  readonly missing: readonly string[];
}

export interface IngestionController {
  receiveRequest(input: {
    readonly kind: "request" | "page";
    readonly source: string;
    readonly metadata?: string;
  }): Promise<ControllerResult>;
  plan(changeId: string): Promise<ControllerResult>;
  approve(input: {
    readonly changeId: string;
    readonly gate: 1 | 2;
    readonly actor: string;
  }): Promise<ControllerResult>;
  generate(input: {
    readonly changeId: string;
    readonly adapter: "codex" | "command";
  }): Promise<ControllerResult>;
  validate(changeId: string): Promise<ControllerResult>;
  preview(input: {
    readonly changeId: string;
    readonly checkOnly: true;
  }): Promise<ControllerResult>;
  /** A contained local check; it deliberately leaves durable state at Gate 2. */
  publishLocal(input: {
    readonly changeId: string;
    readonly operator: OperatorProfile;
  }): Promise<ControllerResult>;
  status(changeId: string): Promise<ControllerResult>;
  audit(): Promise<IngestionAudit>;
  dispose(): Promise<void>;
}

/**
 * Opaque test dependencies only permit declarative pre-existing capabilities.
 * They do not accept a repository root, checkout, bundle, executable, argv,
 * environment, or callback selected by the caller.
 */
export interface IngestionControllerTestRuntime {
  readonly candidateBuildCapability?: CandidateBuildTestCapability;
  readonly candidatePreviewCapability?: CandidatePreviewTestCapability;
  readonly localPublicationCapability?: CandidateLocalPublicationTestCapability;
  readonly validationOptions?: ValidationOptions;
  readonly now?: () => Date;
}

interface ControllerRuntime extends IngestionControllerTestRuntime {
  readonly commandConfig: CommandAgentConfig | null;
  readonly codexCapability: CodexExecutableCapability | null;
}

interface ControllerOpenOptions {
  /** Audit reads durable facts only and must not initialize an agent. */
  readonly initializeAgents?: boolean;
  /** Internal sealed reader used only by the test-only audit composition. */
  readonly auditTagReader?: AuditTagReader;
}

interface FixtureAuditTagFact {
  readonly changeId: string;
  readonly candidateCommit: string;
  readonly sealedCandidateSha256: string;
  readonly sanitizedProjectionSha256: string;
  readonly gate2SubjectSha256: string;
  readonly dossierSha256: string;
}

type AuditTagReader = (
  projectRoot: string,
) => Promise<ReadonlyMap<string, FixtureAuditTagFact>>;

const auditTestSealBrand: unique symbol = Symbol("ingestionAuditTestSeal");

/** Declarative, test-only facts; never a production audit configuration. */
export interface IngestionAuditTestSeal {
  readonly [auditTestSealBrand]: true;
}

export interface IngestionAuditTestTag {
  readonly changeId: string;
  readonly candidateCommit: string;
  readonly sealedCandidateSha256: string;
  readonly sanitizedProjectionSha256: string;
  readonly gate2SubjectSha256: string;
  readonly dossierSha256: string;
}

const auditTestSeals = new WeakMap<
  IngestionAuditTestSeal,
  ReadonlyMap<string, FixtureAuditTagFact>
>();

interface SessionCandidate {
  readonly canonical: string;
  readonly candidate: CandidateManifest;
}

/**
 * Preview authority is intentionally process- and store-instance-local. A
 * fresh controller must reopen only the durable manifest, which has no test
 * preview capability and therefore remains fail-closed.
 */
const sessionCandidates = new WeakMap<
  ControllerCandidateStore,
  Map<string, SessionCandidate>
>();

function sessionCandidateKey(changeId: string, attemptId: string): string {
  return `${changeId}\0${attemptId}`;
}

function rememberSessionCandidate(
  store: ControllerCandidateStore,
  candidate: CandidateManifest,
): void {
  const candidates = sessionCandidates.get(store) ?? new Map();
  candidates.set(sessionCandidateKey(candidate.changeId, candidate.attemptId), {
    canonical: canonicalJson(candidate),
    candidate,
  });
  sessionCandidates.set(store, candidates);
}

function assertChangeId(changeId: string): void {
  if (!changeIdPattern.test(changeId)) {
    throw new TypeError("El identificador de cambio no es seguro");
  }
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return (
    value === "" ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith("../"))
  );
}

async function trustedRegularFile(
  path: string,
  label: string,
): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new TypeError(`${label} no es un archivo regular seguro`);
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
      throw new TypeError(`${label} cambió durante la lectura`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function missingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Returns false only when the complete optional directory is absent. */
async function trustedDirectoryIfPresent(
  path: string,
  label: string,
): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (await realpath(path)) !== resolve(path)
    ) {
      throw new TypeError(`${label} no es un directorio seguro`);
    }
    return true;
  } catch (error: unknown) {
    if (missingPath(error)) return false;
    throw error;
  }
}

async function collectTrustedRelativeFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (!isWithin(root, path)) {
      throw new TypeError("El dossier fixture escapa su directorio sellado");
    }
    if (entry.isDirectory()) {
      if (!(await trustedDirectoryIfPresent(path, "El dossier fixture"))) {
        throw new TypeError("Falta un directorio del dossier fixture");
      }
      files.push(...(await collectTrustedRelativeFiles(root, path)));
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new TypeError("El dossier fixture contiene una ruta no permitida");
    }
    await trustedRegularFile(path, "El archivo del dossier fixture");
    files.push(relative(root, path));
  }
  return files.sort();
}

function parsedFixtureTagFact(
  source: string,
  changeId: string,
  candidateCommit: string,
): FixtureAuditTagFact {
  const separator = source.indexOf("\n\n");
  if (separator < 0) {
    throw new TypeError("La etiqueta fixture no contiene un sello canónico");
  }
  const message = source.slice(separator + 2);
  let value: unknown;
  try {
    value = JSON.parse(message) as unknown;
  } catch {
    throw new TypeError("La etiqueta fixture no contiene un sello JSON válido");
  }
  if (`${canonicalJson(value)}\n` !== message) {
    throw new TypeError("La etiqueta fixture no contiene un sello canónico");
  }
  const seal = exactDurableRecord(value, "El sello fixture", [
    "candidateCommit",
    "changeId",
    "dossierSha256",
    "gate2SubjectSha256",
    "sanitizedProjectionSha256",
    "schemaVersion",
    "sealedCandidateSha256",
  ]);
  if (
    seal.schemaVersion !== 1 ||
    durableChangeId(seal, "changeId", "El sello fixture") !== changeId ||
    durableCommit(seal, "candidateCommit", "El sello fixture") !==
      candidateCommit
  ) {
    throw new TypeError("La etiqueta fixture no coincide con su candidato");
  }
  return Object.freeze({
    changeId,
    candidateCommit,
    sealedCandidateSha256: durableHash(
      seal,
      "sealedCandidateSha256",
      "El sello fixture",
    ),
    sanitizedProjectionSha256: durableHash(
      seal,
      "sanitizedProjectionSha256",
      "El sello fixture",
    ),
    gate2SubjectSha256: durableHash(
      seal,
      "gate2SubjectSha256",
      "El sello fixture",
    ),
    dossierSha256: durableHash(seal, "dossierSha256", "El sello fixture"),
  });
}

async function fixtureTagCommits(
  projectRoot: string,
): Promise<ReadonlyMap<string, FixtureAuditTagFact>> {
  const prefix = "refs/tags/ingestion-fixture/";
  const found = await execFileAsync(
    fixedGitExecutable,
    fixedGitArgs([
      "-C",
      projectRoot,
      "for-each-ref",
      "--format=%(refname)",
      "refs/tags/ingestion-fixture",
    ]),
    { encoding: "utf8", env: sanitizedGitEnv() },
  );
  const refs = found.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const tags = new Map<string, FixtureAuditTagFact>();
  for (const ref of refs) {
    if (!ref.startsWith(prefix)) {
      throw new TypeError("La etiqueta fixture no pertenece a su namespace");
    }
    const changeId = ref.slice(prefix.length);
    if (!fixtureRecordChangeIds.has(changeId) || tags.has(changeId)) {
      throw new TypeError(
        "La etiqueta fixture no pertenece a la matriz cerrada",
      );
    }
    const resolved = await execFileAsync(
      fixedGitExecutable,
      fixedGitArgs([
        "-C",
        projectRoot,
        "rev-parse",
        "--verify",
        `${ref}^{commit}`,
      ]),
      { encoding: "utf8", env: sanitizedGitEnv() },
    ).catch(() => {
      throw new TypeError(
        "La etiqueta fixture no resuelve un commit candidato",
      );
    });
    const commit = resolved.stdout.trim();
    if (!commitPattern.test(commit)) {
      throw new TypeError("La etiqueta fixture no resuelve un commit válido");
    }
    const tag = await execFileAsync(
      fixedGitExecutable,
      fixedGitArgs(["-C", projectRoot, "cat-file", "tag", `${ref}^{tag}`]),
      { encoding: "utf8", env: sanitizedGitEnv() },
    ).catch(() => {
      throw new TypeError("La etiqueta fixture debe ser un sello anotado");
    });
    tags.set(changeId, parsedFixtureTagFact(tag.stdout, changeId, commit));
  }
  return tags;
}

/**
 * Creates opaque, declarative tag facts only for isolated test composition.
 * The public audit opener and production CLI do not accept this capability.
 */
export function createIngestionAuditTestSeal(
  tags: readonly IngestionAuditTestTag[],
): IngestionAuditTestSeal {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("El sello de auditoría sólo existe en modo de pruebas");
  }
  if (!Array.isArray(tags)) {
    throw new TypeError("El sello de auditoría no tiene una lista válida");
  }
  const facts = new Map<string, FixtureAuditTagFact>();
  for (const value of tags) {
    const tag = exactDurableRecord(value, "El sello de auditoría", [
      "candidateCommit",
      "changeId",
      "dossierSha256",
      "gate2SubjectSha256",
      "sanitizedProjectionSha256",
      "sealedCandidateSha256",
    ]);
    const changeId = durableChangeId(tag, "changeId", "El sello de auditoría");
    if (!fixtureRecordChangeIds.has(changeId) || facts.has(changeId)) {
      throw new TypeError("El sello de auditoría no pertenece a la matriz");
    }
    facts.set(
      changeId,
      Object.freeze({
        changeId,
        candidateCommit: durableCommit(
          tag,
          "candidateCommit",
          "El sello de auditoría",
        ),
        sealedCandidateSha256: durableHash(
          tag,
          "sealedCandidateSha256",
          "El sello de auditoría",
        ),
        sanitizedProjectionSha256: durableHash(
          tag,
          "sanitizedProjectionSha256",
          "El sello de auditoría",
        ),
        gate2SubjectSha256: durableHash(
          tag,
          "gate2SubjectSha256",
          "El sello de auditoría",
        ),
        dossierSha256: durableHash(
          tag,
          "dossierSha256",
          "El sello de auditoría",
        ),
      }),
    );
  }
  const seal = Object.freeze({
    [auditTestSealBrand]: true as const,
  }) as IngestionAuditTestSeal;
  auditTestSeals.set(seal, facts);
  return seal;
}

async function verifyFixtureDossier(input: {
  readonly projectRoot: string;
  readonly paths: IngestPaths;
  readonly record: ChangeRecord;
  readonly request: NormalizedRequest;
  readonly plan: ChangePlan;
  readonly attempt: AttemptRecord;
  readonly candidate: CandidateManifest;
}): Promise<boolean> {
  const changesRoot = join(input.projectRoot, "changes");
  if (
    !(await trustedDirectoryIfPresent(changesRoot, "La raíz de expedientes"))
  ) {
    return false;
  }
  const root = join(changesRoot, input.candidate.changeId);
  if (!(await trustedDirectoryIfPresent(root, "El dossier fixture"))) {
    return false;
  }
  if (
    input.record.state !== "gate2_approved" &&
    input.record.state !== "published"
  ) {
    throw new TypeError("Un dossier fixture exige Gate 2 durable");
  }
  const gate1 = await readApproval(input.paths, 1);
  const gate2 = await readApproval(input.paths, 2);
  verifyApproval(gate1, input.plan, input.plan.baselineCommit);
  verifyApproval(gate2, input.candidate, input.candidate.baselineCommit);
  const dossier = createSanitizedCandidateDossier({
    request: input.request,
    plan: input.plan,
    gate1,
    gate2,
    attempt: input.attempt,
    candidate: input.candidate,
  });
  const expected = new Map(
    dossier.files.map((file) => [
      file.path,
      Buffer.from(file.contents, "utf8"),
    ]),
  );
  const actual = await collectTrustedRelativeFiles(root);
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  ) {
    throw new TypeError(
      "El dossier fixture no conserva sus hechos sanitizados",
    );
  }
  for (const [path, contents] of expected) {
    const target = resolve(root, ...path.split("/"));
    if (!isWithin(root, target)) {
      throw new TypeError("El dossier fixture tiene una ruta no permitida");
    }
    const actualContents = await trustedRegularFile(
      target,
      "El archivo del dossier fixture",
    );
    if (!actualContents.equals(contents)) {
      throw new TypeError("El dossier fixture no coincide con el candidato");
    }
  }
  return true;
}

type DurableRecord = Record<string, unknown>;

interface DurableValidationFact {
  readonly id: string;
  readonly evidence: string;
  /** Candidate evidence digest from the sealed durable preimage. */
  readonly evidenceSha256: string;
}

interface DurableCandidateFacts {
  readonly changeId: string;
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly planSha256: string;
  readonly baselineCommit: string;
  readonly candidateCommit: string;
  readonly artifactSha256: string;
  readonly sealedCandidateSha256: string;
  readonly sanitizedProjectionSha256: string;
  readonly approvalSubjectSha256: string;
  readonly buildProfile: unknown;
  /** Ordered validation facts bound across candidate, preimage and attempt. */
  readonly validations: readonly DurableValidationFact[];
}

function durableRecord(value: unknown, label: string): DurableRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} no es un objeto durable válido`);
  }
  return value as DurableRecord;
}

function exactDurableRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): DurableRecord {
  const record = durableRecord(value, label);
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} no conserva una forma saneada exacta`);
  }
  return record;
}

function durableString(
  record: DurableRecord,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} no contiene ${key} seguro`);
  }
  return value;
}

function durableHash(
  record: DurableRecord,
  key: string,
  label: string,
): string {
  const value = durableString(record, key, label);
  if (!sha256Pattern.test(value)) {
    throw new TypeError(`${label} no contiene ${key} SHA-256`);
  }
  return value;
}

function durableCommit(
  record: DurableRecord,
  key: string,
  label: string,
): string {
  const value = durableString(record, key, label);
  if (!commitPattern.test(value)) {
    throw new TypeError(`${label} no contiene ${key} commit`);
  }
  return value;
}

function durableChangeId(
  record: DurableRecord,
  key: string,
  label: string,
): string {
  const value = durableString(record, key, label);
  if (!changeIdPattern.test(value)) {
    throw new TypeError(`${label} no contiene ${key} de cambio seguro`);
  }
  return value;
}

function durableStringArray(
  value: unknown,
  label: string,
  valid: (entry: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} no es una lista saneada`);
  }
  const result = value.map((entry) => {
    if (typeof entry !== "string" || !valid(entry)) {
      throw new TypeError(`${label} contiene una ruta o valor no permitido`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} contiene valores repetidos`);
  }
  return Object.freeze(result);
}

function durableValidationId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    throw new TypeError(`${label} no tiene identificador de validación seguro`);
  }
  return value;
}

function durableCandidateFacts(
  value: unknown,
  preimage: CandidateDossierPreimage,
): DurableCandidateFacts {
  const candidate = exactDurableRecord(value, "El candidato fixture", [
    "approvalSubjectSha256",
    "artifactSha256",
    "artifacts",
    "attemptId",
    "baselineCommit",
    "buildProfile",
    "candidateCommit",
    "changeId",
    "files",
    "knownDifferences",
    "planSha256",
    "preview",
    "requestSha256",
    "routes",
    "sanitizedProjectionSha256",
    "schemaVersion",
    "sealedCandidateSha256",
    "validations",
  ]);
  if (candidate.schemaVersion !== 1) {
    throw new TypeError("El candidato fixture tiene una versión inválida");
  }
  const changeId = durableChangeId(
    candidate,
    "changeId",
    "El candidato fixture",
  );
  const attemptId = durableString(
    candidate,
    "attemptId",
    "El candidato fixture",
  );
  if (!attemptIdPattern.test(attemptId)) {
    throw new TypeError("El candidato fixture tiene un intento inválido");
  }
  const requestSha256 = durableHash(
    candidate,
    "requestSha256",
    "El candidato fixture",
  );
  const planSha256 = durableHash(
    candidate,
    "planSha256",
    "El candidato fixture",
  );
  const baselineCommit = durableCommit(
    candidate,
    "baselineCommit",
    "El candidato fixture",
  );
  const candidateCommit = durableCommit(
    candidate,
    "candidateCommit",
    "El candidato fixture",
  );
  const artifactSha256 = durableHash(
    candidate,
    "artifactSha256",
    "El candidato fixture",
  );
  const approvalSubjectSha256 = durableHash(
    candidate,
    "approvalSubjectSha256",
    "El candidato fixture",
  );
  const sealedCandidateSha256 = durableHash(
    candidate,
    "sealedCandidateSha256",
    "El candidato fixture",
  );
  const sanitizedProjectionSha256 = durableHash(
    candidate,
    "sanitizedProjectionSha256",
    "El candidato fixture",
  );
  const routes = durableStringArray(
    candidate.routes,
    "Las rutas candidatas",
    (route) => route.startsWith("/"),
  );
  const files = durableStringArray(
    candidate.files,
    "Los archivos candidatos",
    (path) => safeRelativePath.test(path),
  );
  const buildProfile = exactDurableRecord(
    candidate.buildProfile,
    "El perfil de build candidato",
    ["adapter", "configSha256", "environment", "siteIndexable"],
  );
  const adapter = buildProfile.adapter;
  const environment = buildProfile.environment;
  if (
    (adapter !== "local" && adapter !== "cloudflare") ||
    !sha256Pattern.test(
      durableString(
        buildProfile,
        "configSha256",
        "El perfil de build candidato",
      ),
    ) ||
    (environment !== null && typeof environment !== "string") ||
    typeof buildProfile.siteIndexable !== "boolean"
  ) {
    throw new TypeError("El perfil de build candidato no está saneado");
  }
  if (!Array.isArray(candidate.artifacts)) {
    throw new TypeError("Los artefactos candidatos no son una lista");
  }
  const artifacts: Array<SanitizedCandidateProjection["artifacts"][number]> =
    [];
  for (const artifact of candidate.artifacts) {
    const record = exactDurableRecord(artifact, "Un artefacto candidato", [
      "bytes",
      "path",
      "sha256",
    ]);
    const path = durableString(record, "path", "Un artefacto candidato");
    if (!path.startsWith("bundle/") || !safeRelativePath.test(path)) {
      throw new TypeError("Un artefacto candidato tiene una ruta no permitida");
    }
    const sha256 = durableHash(record, "sha256", "Un artefacto candidato");
    if (
      typeof record.bytes !== "number" ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0
    ) {
      throw new TypeError("Un artefacto candidato no tiene bytes válidos");
    }
    artifacts.push(Object.freeze({ path, sha256, bytes: record.bytes }));
  }
  const preview = exactDurableRecord(
    candidate.preview,
    "El preview candidato",
    ["command"],
  );
  if (preview.command !== "sealed verified candidate preview") {
    throw new TypeError("El preview candidato no está saneado");
  }
  if (!Array.isArray(candidate.knownDifferences)) {
    throw new TypeError("Las diferencias candidatas no son una lista");
  }
  const knownDifferences: Array<
    SanitizedCandidateProjection["knownDifferences"][number]
  > = [];
  for (const difference of candidate.knownDifferences) {
    const record = exactDurableRecord(difference, "Una diferencia candidata", [
      "approvalRequired",
    ]);
    if (record.approvalRequired !== true) {
      throw new TypeError("Una diferencia candidata no conserva Gate 2");
    }
    knownDifferences.push(Object.freeze({ approvalRequired: true }));
  }
  if (!Array.isArray(candidate.validations)) {
    throw new TypeError("Las validaciones candidatas no son una lista");
  }
  const validations: DurableValidationFact[] = [];
  const validationIds = new Set<string>();
  const candidateValidations: Array<
    SanitizedCandidateProjection["validations"][number]
  > = [];
  for (const [index, validation] of candidate.validations.entries()) {
    const record = exactDurableRecord(validation, "Una validación candidata", [
      "evidence",
      "evidenceSha256",
      "id",
      "status",
    ]);
    const id = durableValidationId(record.id, "Una validación candidata");
    const evidence = durableString(
      record,
      "evidence",
      "Una validación candidata",
    );
    const evidenceSha256 = durableHash(
      record,
      "evidenceSha256",
      "Una validación candidata",
    );
    const preimageValidation = preimage.validations[index];
    if (
      record.status !== "passed" ||
      evidence !== `evidence/${id}.json` ||
      validationIds.has(id) ||
      preimageValidation === undefined ||
      preimageValidation.id !== id ||
      preimageValidation.status !== "passed" ||
      evidenceSha256 !== preimageValidation.evidenceSha256
    ) {
      throw new TypeError("Una validación candidata no conserva su evidencia");
    }
    validationIds.add(id);
    validations.push(
      Object.freeze({
        id,
        evidence,
        evidenceSha256,
      }),
    );
    candidateValidations.push(
      Object.freeze({ id, status: "passed", evidence, evidenceSha256 }),
    );
  }
  if (validations.length === 0) {
    throw new TypeError(
      "El candidato fixture no tiene evidencia de validación",
    );
  }
  if (validations.length !== preimage.validations.length) {
    throw new TypeError("La preimagen no coincide con sus validaciones");
  }
  const projection: SanitizedCandidateProjection = Object.freeze({
    schemaVersion: 1,
    changeId,
    attemptId,
    requestSha256,
    planSha256,
    baselineCommit,
    candidateCommit,
    artifactSha256,
    buildProfile: Object.freeze({
      adapter,
      configSha256: durableHash(
        buildProfile,
        "configSha256",
        "El perfil de build candidato",
      ),
      environment,
      siteIndexable: buildProfile.siteIndexable,
    }),
    routes,
    files,
    artifacts: Object.freeze(artifacts),
    validations: Object.freeze(candidateValidations),
    preview: Object.freeze({ command: "sealed verified candidate preview" }),
    knownDifferences: Object.freeze(knownDifferences),
  });
  if (candidateDossierPreimageSha256(preimage) !== sealedCandidateSha256) {
    throw new TypeError(
      "El candidato fixture no conserva su preimagen sellada",
    );
  }
  assertCandidateDossierProjectionBinding(preimage, projection);
  const commitment = candidateDossierCommitmentFromProjection(
    sealedCandidateSha256,
    projection,
  );
  if (
    commitment.sanitizedProjectionSha256 !== sanitizedProjectionSha256 ||
    commitment.approvalSubjectSha256 !== approvalSubjectSha256
  ) {
    throw new TypeError(
      "El candidato fixture no conserva su compromiso saneado",
    );
  }
  return Object.freeze({
    changeId,
    attemptId,
    requestSha256,
    planSha256,
    baselineCommit,
    candidateCommit,
    artifactSha256,
    sealedCandidateSha256,
    sanitizedProjectionSha256,
    approvalSubjectSha256,
    buildProfile: projection.buildProfile,
    validations: Object.freeze(validations),
  });
}

function assertDurableAttempt(
  value: unknown,
  candidate: DurableCandidateFacts,
): void {
  const attempt = exactDurableRecord(value, "El intento fixture", [
    "adapter",
    "attemptId",
    "baselineCommit",
    "changeId",
    "failure",
    "finishedAt",
    "generatedFiles",
    "logs",
    "planSha256",
    "requestSha256",
    "resumeState",
    "schemaVersion",
    "startedAt",
    "status",
    "validations",
  ]);
  if (
    attempt.schemaVersion !== 1 ||
    attempt.status !== "validated" ||
    attempt.resumeState !== null ||
    typeof attempt.adapter !== "string" ||
    attempt.failure !== null ||
    typeof attempt.startedAt !== "string" ||
    typeof attempt.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(attempt.startedAt)) ||
    !Number.isFinite(Date.parse(attempt.finishedAt))
  ) {
    throw new TypeError("El intento fixture no conserva sus hechos validados");
  }
  if (
    durableChangeId(attempt, "changeId", "El intento fixture") !==
      candidate.changeId ||
    durableString(attempt, "attemptId", "El intento fixture") !==
      candidate.attemptId ||
    durableHash(attempt, "requestSha256", "El intento fixture") !==
      candidate.requestSha256 ||
    durableHash(attempt, "planSha256", "El intento fixture") !==
      candidate.planSha256 ||
    durableCommit(attempt, "baselineCommit", "El intento fixture") !==
      candidate.baselineCommit
  ) {
    throw new TypeError("El intento fixture no coincide con el candidato");
  }
  durableStringArray(attempt.generatedFiles, "Los archivos generados", (path) =>
    safeRelativePath.test(path),
  );
  const logs = exactDurableRecord(attempt.logs, "Los logs del intento", [
    "finalMessage",
    "stderr",
    "stdout",
  ]);
  if (
    logs.stdout !== null ||
    logs.stderr !== null ||
    logs.finalMessage !== null
  ) {
    throw new TypeError("El intento fixture no tiene logs saneados");
  }
  if (!Array.isArray(attempt.validations)) {
    throw new TypeError("Las validaciones del intento no son una lista");
  }
  if (attempt.validations.length !== candidate.validations.length) {
    throw new TypeError("Falta evidencia sellada del candidato fixture");
  }
  for (const [index, validation] of attempt.validations.entries()) {
    const record = exactDurableRecord(validation, "Una validación de intento", [
      "evidence",
      "evidenceSha256",
      "id",
      "status",
    ]);
    const id = durableValidationId(record.id, "Una validación de intento");
    const candidateValidation = candidate.validations[index];
    const evidenceSha256 = durableHash(
      record,
      "evidenceSha256",
      "Una validación de intento",
    );
    if (
      candidateValidation === undefined ||
      record.status !== "passed" ||
      id !== candidateValidation.id ||
      record.evidence !== candidateValidation.evidence ||
      evidenceSha256 !== candidateValidation.evidenceSha256
    ) {
      throw new TypeError(
        "La evidencia del intento no coincide con el candidato",
      );
    }
  }
}

async function durableFixtureDossierIds(
  projectRoot: string,
): Promise<ReadonlySet<string>> {
  const changes = join(projectRoot, "changes");
  if (!(await trustedDirectoryIfPresent(changes, "La raíz de expedientes"))) {
    return new Set();
  }
  const ids = new Set<string>();
  const entries = await readdir(changes, { withFileTypes: true });
  for (const entry of entries) {
    if (fixtureRecordChangeIds.has(entry.name)) ids.add(entry.name);
  }
  return ids;
}

async function verifyDurableFixtureDossier(
  projectRoot: string,
  changeId: string,
  seal: FixtureAuditTagFact,
): Promise<{
  readonly artifactSha256: string;
  readonly candidateCommit: string;
}> {
  const root = join(projectRoot, "changes", changeId);
  if (!(await trustedDirectoryIfPresent(root, "El dossier fixture"))) {
    throw new TypeError("Falta el dossier fixture durable");
  }
  const candidateFile = await readCanonicalDossierFile(
    join(root, "candidate.json"),
    "El candidato fixture durable",
  );
  const preimageFile = await readCanonicalDossierFile(
    join(root, "candidate-manifest.json"),
    "La preimagen candidata fixture durable",
  );
  const preimage = parseCandidateDossierPreimage(preimageFile.value);
  const candidate = durableCandidateFacts(candidateFile.value, preimage);
  const expected = [
    "approvals/gate-1.json",
    "approvals/gate-2.json",
    `attempts/${candidate.attemptId}.json`,
    "candidate.json",
    "candidate-manifest.json",
    "plan.json",
    "request.json",
  ].sort();
  const actual = await collectTrustedRelativeFiles(root);
  if (
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  ) {
    throw new TypeError(
      "El dossier fixture no conserva exactamente sus archivos",
    );
  }
  const [requestFile, planFile, gate1File, gate2File, attemptFile] =
    await Promise.all([
      readCanonicalDossierFile(
        join(root, "request.json"),
        "La solicitud fixture",
      ),
      readCanonicalDossierFile(join(root, "plan.json"), "El plan fixture"),
      readCanonicalDossierFile(
        join(root, "approvals", "gate-1.json"),
        "El Gate 1 fixture",
      ),
      readCanonicalDossierFile(
        join(root, "approvals", "gate-2.json"),
        "El Gate 2 fixture",
      ),
      readCanonicalDossierFile(
        join(root, "attempts", `${candidate.attemptId}.json`),
        "El intento fixture",
      ),
    ]);
  const request = exactDurableRecord(
    requestFile.value,
    "La solicitud fixture",
    [
      "changeId",
      "inputKind",
      "inputSha256",
      "mode",
      "privacy",
      "schemaVersion",
      "targetPath",
    ],
  );
  if (
    request.schemaVersion !== 1 ||
    (request.inputKind !== "request" && request.inputKind !== "page") ||
    typeof request.mode !== "string" ||
    typeof request.targetPath !== "string" ||
    !request.targetPath.startsWith("/")
  ) {
    throw new TypeError("La solicitud fixture no conserva hechos saneados");
  }
  const privacy = exactDurableRecord(request.privacy, "La privacidad fixture", [
    "area",
    "private",
  ]);
  if (
    typeof privacy.private !== "boolean" ||
    (privacy.area !== null && typeof privacy.area !== "string")
  ) {
    throw new TypeError("La privacidad fixture no es válida");
  }
  const plan = validateSchema<ChangePlan>("change-plan", planFile.value);
  const gate1 = validateSchema<ApprovalRecord>("approval", gate1File.value);
  const gate2 = validateSchema<ApprovalRecord>("approval", gate2File.value);
  if (
    durableChangeId(request, "changeId", "La solicitud fixture") !== changeId ||
    durableHash(request, "inputSha256", "La solicitud fixture") !==
      candidate.requestSha256 ||
    plan.changeId !== changeId ||
    plan.requestSha256 !== candidate.requestSha256 ||
    plan.planSha256 !== candidate.planSha256 ||
    plan.baselineCommit !== candidate.baselineCommit ||
    canonicalJson(plan.publication) !== canonicalJson(candidate.buildProfile) ||
    gate1.environment !== "test" ||
    gate1.gate !== 1 ||
    gate1.changeId !== changeId ||
    gate1.baselineCommit !== candidate.baselineCommit ||
    gate1.subjectSha256 !== plan.planSha256 ||
    gate1.candidateCommit !== null ||
    gate1.artifactSha256 !== null ||
    gate2.environment !== "test" ||
    gate2.gate !== 2 ||
    gate2.changeId !== changeId ||
    gate2.baselineCommit !== candidate.baselineCommit ||
    gate2.subjectSha256 !== candidate.approvalSubjectSha256 ||
    gate2.candidateCommit !== candidate.candidateCommit ||
    gate2.artifactSha256 !== candidate.artifactSha256
  ) {
    throw new TypeError("El dossier fixture no conserva sus bindings sellados");
  }
  if (
    seal.changeId !== changeId ||
    seal.candidateCommit !== candidate.candidateCommit ||
    seal.sealedCandidateSha256 !== candidate.sealedCandidateSha256 ||
    seal.sanitizedProjectionSha256 !== candidate.sanitizedProjectionSha256 ||
    seal.gate2SubjectSha256 !== gate2.subjectSha256
  ) {
    throw new TypeError("El sello fixture no coincide con Gate 2 ni candidato");
  }
  const dossierSha256 = sanitizedDossierSha256([
    { path: "candidate.json", contents: candidateFile.contents },
    { path: "candidate-manifest.json", contents: preimageFile.contents },
    { path: "request.json", contents: requestFile.contents },
    { path: "plan.json", contents: planFile.contents },
    { path: "approvals/gate-1.json", contents: gate1File.contents },
    { path: "approvals/gate-2.json", contents: gate2File.contents },
    {
      path: `attempts/${candidate.attemptId}.json`,
      contents: attemptFile.contents,
    },
  ]);
  if (dossierSha256 !== seal.dossierSha256) {
    throw new TypeError("El sello fixture no conserva el dossier completo");
  }
  assertDurableAttempt(attemptFile.value, candidate);
  return Object.freeze({
    artifactSha256: candidate.artifactSha256,
    candidateCommit: candidate.candidateCommit,
  });
}

async function readCanonicalJson(
  path: string,
  label: string,
): Promise<unknown> {
  const bytes = await trustedRegularFile(path, label);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError(`${label} no contiene JSON válido`);
  }
  if (canonicalJson(value) !== source) {
    throw new TypeError(`${label} no es canónico`);
  }
  return value;
}

/** Dossiers deliberately use one terminal newline, unlike mutable state JSON. */
async function readCanonicalDossierFile(
  path: string,
  label: string,
): Promise<{ readonly value: unknown; readonly contents: string }> {
  const bytes = await trustedRegularFile(path, label);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError(`${label} no contiene JSON válido`);
  }
  if (`${canonicalJson(value)}\n` !== source) {
    throw new TypeError(`${label} no es canónico`);
  }
  return Object.freeze({ value, contents: source });
}

async function assertControllerRoot(input: string): Promise<string> {
  const root = await realpath(input);
  const entry = await lstat(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError("La raíz del controlador no es segura");
  }
  const result = await execFileAsync(
    fixedGitExecutable,
    fixedGitArgs(["-C", root, "rev-parse", "--show-toplevel"]),
    { encoding: "utf8", env: sanitizedGitEnv() },
  ).catch(() => {
    throw new TypeError("La raíz del controlador no es un repositorio Git");
  });
  if (result.stdout.trim() !== root) {
    throw new TypeError("El controlador exige la raíz Git del proyecto");
  }
  return root;
}

async function protectedMain(root: string): Promise<string> {
  const result = await execFileAsync(
    fixedGitExecutable,
    fixedGitArgs([
      "-C",
      root,
      "rev-parse",
      "--verify",
      "refs/heads/main^{commit}",
    ]),
    { encoding: "utf8", env: sanitizedGitEnv() },
  ).catch(() => {
    throw new TypeError("No se pudo leer la referencia protegida main");
  });
  const commit = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new TypeError("La referencia protegida main no es un commit válido");
  }
  return commit;
}

function attemptPath(paths: IngestPaths, attemptId: string): string {
  if (!attemptIdPattern.test(attemptId)) {
    throw new TypeError("El identificador de intento no es seguro");
  }
  return join(paths.attemptsDir, `${attemptId}.json`);
}

function policyFor(plan: ChangePlan): Buffer {
  return Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      allowedFiles: plan.files.map((file) => file.path).sort(),
      dependencies: plan.dependencies,
      targetPath: plan.targetPath,
    }),
    "utf8",
  );
}

function attemptRecord(
  record: ChangeRecord,
  plan: ChangePlan,
  adapter: string | null,
): AttemptRecord {
  return validateSchema<AttemptRecord>("attempt", {
    schemaVersion: 1,
    changeId: record.changeId,
    attemptId: record.currentAttemptId,
    status: "running",
    resumeState: "gate1_approved",
    adapter,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    requestSha256: plan.requestSha256,
    planSha256: plan.planSha256,
    baselineCommit: plan.baselineCommit,
    generatedFiles: [],
    logs: { stdout: null, stderr: null, finalMessage: null },
    validations: [],
    failure: null,
  });
}

function safeGeneratedFiles(result: AgentRunResult): string[] {
  const files = [...result.generatedFiles].sort();
  if (
    files.length !== result.generatedFiles.length ||
    new Set(files).size !== files.length ||
    files.some((file) => !safeRelativePath.test(file))
  ) {
    throw new TypeError("El agente devolvió archivos generados no seguros");
  }
  return files;
}

function durablePreliminaryValidationResults(
  candidate: CandidateManifest,
): ValidationResult[] {
  const preliminary = candidate.validations
    .filter(
      (validation) =>
        validation.evidence === `evidence/preliminary/${validation.id}.json`,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (preliminary.length === 0) {
    throw new TypeError("El candidato no conserva evidencia preliminar");
  }
  return preliminary.map((validation) => {
    if (
      validation.evidenceSha256 === undefined ||
      !/^[a-f0-9]{64}$/u.test(validation.evidenceSha256)
    ) {
      throw new TypeError("El candidato no conserva hashes de evidencia");
    }
    return {
      id: validation.id,
      status: validation.status,
      evidence: `candidates/${candidate.attemptId}/${validation.evidence}`,
      evidenceSha256: validation.evidenceSha256,
    };
  });
}

function preliminaryValidationFailure(
  validations: readonly ValidationResult[],
): TypeError {
  const failed = validations
    .filter((validation) => validation.status !== "passed")
    .map((validation) => validation.id)
    .filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/u.test(id))
    .sort();
  const suffix = failed.length === 0 ? "" : `: ${failed.join(", ")}`;
  return new TypeError(`La validación preliminar del candidato falló${suffix}`);
}

function completedAttempt(
  running: AttemptRecord,
  result: AgentRunResult,
  candidate: CandidateManifest,
): AttemptRecord {
  return validateSchema<AttemptRecord>("attempt", {
    ...running,
    status: "generated",
    generatedFiles: safeGeneratedFiles(result),
    validations: durablePreliminaryValidationResults(candidate),
  });
}

function validatedAttempt(running: AttemptRecord): AttemptRecord {
  return validateSchema<AttemptRecord>("attempt", {
    ...running,
    status: "validated",
    resumeState: null,
    finishedAt: new Date().toISOString(),
    failure: null,
  });
}

function failedAttempt(running: AttemptRecord, error: unknown): AttemptRecord {
  return validateSchema<AttemptRecord>("attempt", {
    ...running,
    status: "failed",
    finishedAt: new Date().toISOString(),
    failure: { code: "controller-failure", message: safeError(error) },
  });
}

async function writeAttempt(
  paths: IngestPaths,
  attempt: AttemptRecord,
): Promise<void> {
  await writeAtomic(
    attemptPath(paths, attempt.attemptId),
    Buffer.from(canonicalJson(attempt), "utf8"),
  );
}

async function readAttempt(
  paths: IngestPaths,
  attemptId: string,
): Promise<AttemptRecord> {
  return validateSchema<AttemptRecord>(
    "attempt",
    await readCanonicalJson(attemptPath(paths, attemptId), "El intento"),
  );
}

async function readRequest(paths: IngestPaths): Promise<NormalizedRequest> {
  return assertNormalizedRequest(
    await readCanonicalJson(paths.request, "La solicitud normalizada"),
  );
}

async function readPlan(paths: IngestPaths): Promise<ChangePlan> {
  return validateSchema<ChangePlan>(
    "change-plan",
    await readCanonicalJson(paths.plan, "El plan"),
  );
}

async function readApproval(
  paths: IngestPaths,
  gate: 1 | 2,
): Promise<ApprovalRecord> {
  return validateSchema<ApprovalRecord>(
    "approval",
    await readCanonicalJson(
      join(paths.approvalsDir, `gate-${gate}.json`),
      "La aprobación",
    ),
  );
}

function parseCommandConfig(): CommandAgentConfig | null {
  const source = process.env.INGEST_COMMAND_AGENT_CONFIG;
  if (source === undefined || source === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError("INGEST_COMMAND_AGENT_CONFIG no contiene JSON válido");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { command?: unknown }).command !== "string" ||
    !Array.isArray((parsed as { args?: unknown }).args) ||
    !(parsed as { args: unknown[] }).args.every(
      (value) => typeof value === "string",
    )
  ) {
    throw new TypeError(
      "INGEST_COMMAND_AGENT_CONFIG no es una configuración segura",
    );
  }
  const value = parsed as {
    command: string;
    args: string[];
    timeoutMs?: unknown;
  };
  if (
    value.command.includes("\0") ||
    value.args.some((arg) => arg.includes("\0"))
  ) {
    throw new TypeError(
      "INGEST_COMMAND_AGENT_CONFIG contiene valores no seguros",
    );
  }
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.timeoutMs))
  ) {
    throw new TypeError(
      "INGEST_COMMAND_AGENT_CONFIG tiene un timeout inválido",
    );
  }
  return {
    command: value.command,
    args: [...value.args],
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
  };
}

async function defaultCodexCapability(): Promise<CodexExecutableCapability | null> {
  const path = process.env.CODEX_EXECUTABLE;
  if (path === undefined || path === "") return null;
  return await createCodexExecutableCapability(path);
}

function controllerBroker(workspace: AgentWorkspace) {
  const expected = workspace.path;
  return createOperatorIsolationBroker(
    async (input: BrokerRunInput): Promise<BrokerRunResult> => {
      if (
        input.workspace !== expected ||
        input.workspace !== resolve(expected)
      ) {
        throw new TypeError("El broker no autoriza ese workspace");
      }
      const result = await runProcess(input.command, [...input.args], {
        cwd: expected,
        env: { ...input.env },
        input: input.stdin,
        shell: false,
        timeoutMs: input.timeoutMs,
      });
      return { ...result, timedOut: result.timedOut ?? false };
    },
  );
}

async function makeWorkspaceRoot(): Promise<string> {
  const path = await mkdtemp(
    join(tmpdir(), "comunidadsolar-controller-workspaces-"),
  );
  await chmod(path, 0o700);
  return await realpath(path);
}

async function writeAgentAuthorities(
  paths: IngestPaths,
  plan: ChangePlan,
  projectRoot: string,
  attemptId: string,
): Promise<{ readonly policyPath: string; readonly resultSchemaPath: string }> {
  const root = join(paths.attemptsDir, attemptId);
  const policyPath = join(root, "policy.json");
  const resultSchemaPath = join(root, "agent-result.schema.json");
  if (
    !isWithin(paths.attemptsDir, root) ||
    !isWithin(root, policyPath) ||
    !isWithin(root, resultSchemaPath)
  ) {
    throw new TypeError("Las autoridades del agente escapan del estado");
  }
  const schema = await trustedRegularFile(
    join(projectRoot, schemaPath),
    "El schema de agente",
  );
  await Promise.all([
    writeAtomic(policyPath, policyFor(plan)),
    writeAtomic(resultSchemaPath, schema),
  ]);
  return Object.freeze({ policyPath, resultSchemaPath });
}

async function currentPreparedPublication(
  projectRoot: string,
  paths: IngestPaths,
  plan: ChangePlan,
): Promise<PreparedPlanningPublication> {
  const publication = await preparePlanningPublication({
    adapter: plan.publication.adapter,
    environment: plan.publication.environment ?? undefined,
    projectRoot,
    stateArtifactRoot: join(paths.changeDir, "publication"),
  });
  if (canonicalJson(publication) !== canonicalJson(plan.publication)) {
    throw new TypeError("El perfil de publicación ya no coincide con el plan");
  }
  return publication;
}

class DefaultIngestionController implements IngestionController {
  private disposed = false;

  constructor(
    private readonly projectRoot: string,
    private readonly stateStore: StateStore,
    private readonly candidateStore: ControllerCandidateStore,
    private readonly runtime: ControllerRuntime,
    private readonly auditTagReader: AuditTagReader,
  ) {}

  private assertOpen(): void {
    if (this.disposed) throw new TypeError("El controlador ya fue liberado");
  }

  private async paths(changeId: string): Promise<IngestPaths> {
    assertChangeId(changeId);
    return await ingestPaths(changeId, { projectRoot: this.projectRoot });
  }

  private async state(changeId: string): Promise<ChangeRecord> {
    const record = await this.stateStore.readChange(changeId);
    await this.stateStore.verifyJournal(changeId);
    return record;
  }

  private async requireLockedState(
    locked: LockedChange,
    expected: ChangeState,
  ): Promise<ChangeRecord> {
    const record = await locked.read();
    if (record.state !== expected) {
      throw new TypeError(`El cambio no está en el estado ${expected}`);
    }
    return record;
  }

  private async withChangeOperation<T>(
    changeId: string,
    operation: (locked: LockedChange) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    assertChangeId(changeId);
    return await this.stateStore.withChangeLock(changeId, operation);
  }

  /**
   * Every use reloads the durable manifest first. A matching in-session object
   * may retain only its already-minted opaque preview capability; it cannot
   * replace durable candidate authority or survive a new controller store.
   */
  private async candidateFor(
    changeId: string,
    attemptId: string,
  ): Promise<CandidateManifest> {
    const durable = await loadCandidate({
      store: this.candidateStore,
      changeId,
      attemptId,
    });
    const cached = sessionCandidates
      .get(this.candidateStore)
      ?.get(sessionCandidateKey(changeId, attemptId));
    if (cached === undefined) return durable;
    if (
      cached.candidate.changeId !== changeId ||
      cached.candidate.attemptId !== attemptId ||
      cached.canonical !== canonicalJson(durable)
    ) {
      throw new TypeError(
        "El candidato de sesión no coincide con el manifiesto durable",
      );
    }
    await verifyCandidateArtifact(cached.candidate);
    return cached.candidate;
  }

  private async adapter(
    name: "codex" | "command",
    workspace: AgentWorkspace,
  ): Promise<AgentAdapter> {
    const broker = controllerBroker(workspace);
    if (name === "codex") {
      return new CodexAgent(this.runtime.codexCapability, broker, workspace);
    }
    if (this.runtime.commandConfig === null) {
      throw new TypeError(
        "No existe una configuración CommandAgent del operador",
      );
    }
    return new CommandAgent(this.runtime.commandConfig, broker, workspace);
  }

  async receiveRequest(input: {
    readonly kind: "request" | "page";
    readonly source: string;
    readonly metadata?: string;
  }): Promise<ControllerResult> {
    this.assertOpen();
    if (
      input.kind === "page" &&
      input.metadata !== undefined &&
      input.metadata.length === 0
    ) {
      throw new TypeError("Los metadatos de página no pueden estar vacíos");
    }
    const preflight =
      input.kind === "request"
        ? await importRequest(input.source, { persistRaw: false })
        : await importPage(input.source, input.metadata, { persistRaw: false });
    return await this.withChangeOperation(
      preflight.changeId,
      async (locked) => {
        const paths = await this.paths(preflight.changeId);
        try {
          await locked.read();
          throw new TypeError("El cambio ya tiene estado durable");
        } catch (error: unknown) {
          if (
            !(error instanceof Error) ||
            error.message !== "El estado del cambio no existe"
          ) {
            throw error;
          }
        }
        const artifactRoot = join(this.projectRoot, ".artifacts");
        const request =
          input.kind === "request"
            ? await importRequest(input.source, {
                artifactRoot,
                expectedChangeId: preflight.changeId,
              })
            : await importPage(input.source, input.metadata, {
                artifactRoot,
                expectedChangeId: preflight.changeId,
              });
        await writeAtomic(
          paths.request,
          Buffer.from(canonicalJson(request), "utf8"),
        );
        await locked.transition({
          type: "received",
          to: "received",
          payload: {
            inputKind: request.inputKind,
            inputSha256: request.inputSha256,
          },
        });
        await locked.transition({
          type: "normalized",
          to: "normalized",
          payload: { inputSha256: request.inputSha256 },
        });
        return {
          kind: "success",
          value: {
            changeId: request.changeId,
            inputKind: request.inputKind,
            state: "normalized",
          },
        };
      },
    );
  }

  async plan(changeId: string): Promise<ControllerResult> {
    this.assertOpen();
    return await this.withChangeOperation(changeId, async (locked) => {
      const record = await this.requireLockedState(locked, "normalized");
      const paths = await this.paths(changeId);
      const request = await readRequest(paths);
      const baselineCommit = await protectedMain(this.projectRoot);
      const publication = await preparePlanningPublication({
        projectRoot: this.projectRoot,
        stateArtifactRoot: join(paths.changeDir, "publication"),
      });
      const plan = createChangePlan(request, {
        baselineCommit,
        sourceManifestPath: join(
          this.projectRoot,
          "parity",
          "source-manifest.json",
        ),
        projectRoot: this.projectRoot,
        publication,
      });
      if (record.changeId !== plan.changeId) {
        throw new TypeError("El plan no coincide con el cambio bloqueado");
      }
      await writeAtomic(paths.plan, Buffer.from(canonicalJson(plan), "utf8"));
      await locked.transition({
        type: "planned",
        to: "planned",
        payload: {
          planSha256: plan.planSha256,
          baselineCommit: plan.baselineCommit,
        },
      });
      return {
        kind: "success",
        value: {
          changeId,
          state: "planned",
          planSha256: plan.planSha256,
          selectedMode: plan.selectedMode,
        },
      };
    });
  }

  async approve(input: {
    readonly changeId: string;
    readonly gate: 1 | 2;
    readonly actor: string;
  }): Promise<ControllerResult> {
    this.assertOpen();
    return await this.withChangeOperation(input.changeId, async (locked) => {
      const expected = input.gate === 1 ? "planned" : "validated";
      const current = await this.requireLockedState(locked, expected);
      const paths = await this.paths(input.changeId);
      const plan = await readPlan(paths);
      let approval: ApprovalRecord;
      if (input.gate === 1) {
        approval = await approveGate1({
          ...paths,
          plan,
          actor: input.actor,
          repositoryRoot: this.projectRoot,
          now: this.runtime.now,
        });
      } else {
        const [candidate, attempt] = await Promise.all([
          this.candidateFor(input.changeId, current.currentAttemptId),
          readAttempt(paths, current.currentAttemptId),
        ]);
        await verifyCandidateArtifact(candidate);
        await verifyCandidateEvidence(candidate, attempt);
        approval = await approveGate2({
          ...paths,
          plan,
          candidate,
          actor: input.actor,
          repositoryRoot: this.projectRoot,
          now: this.runtime.now,
        });
      }
      await locked.transition({
        type: input.gate === 1 ? "gate1-approved" : "gate2-approved",
        to: input.gate === 1 ? "gate1_approved" : "gate2_approved",
        payload: { gate: approval.gate, subjectSha256: approval.subjectSha256 },
      });
      return {
        kind: "success",
        value: {
          changeId: input.changeId,
          gate: input.gate,
          state: input.gate === 1 ? "gate1_approved" : "gate2_approved",
        },
      };
    });
  }

  async generate(input: {
    readonly changeId: string;
    readonly adapter: "codex" | "command";
  }): Promise<ControllerResult> {
    this.assertOpen();
    return await this.withChangeOperation(input.changeId, async (locked) => {
      const current = await locked.read();
      if (current.state === "planned") return { kind: "gate-pending", gate: 1 };
      if (current.state !== "gate1_approved") {
        throw new TypeError("El cambio no está listo para generar");
      }
      const paths = await this.paths(input.changeId);
      const [request, plan, gate1, baseline] = await Promise.all([
        readRequest(paths),
        readPlan(paths),
        readApproval(paths, 1),
        protectedMain(this.projectRoot),
      ]);
      if (
        request.changeId !== input.changeId ||
        plan.changeId !== input.changeId
      ) {
        throw new TypeError(
          "Las autoridades del cambio no comparten identidad",
        );
      }
      verifyApproval(gate1, plan, baseline);
      const running = attemptRecord(current, plan, input.adapter);
      await writeAttempt(paths, running);
      let workspaceRoot: string | undefined;
      let workspace: AgentWorkspace | undefined;
      let output:
        Awaited<ReturnType<typeof validateAgentWorkspaceOutput>> | undefined;
      try {
        const [authorities, publication] = await Promise.all([
          writeAgentAuthorities(
            paths,
            plan,
            this.projectRoot,
            current.currentAttemptId,
          ),
          currentPreparedPublication(this.projectRoot, paths, plan),
        ]);
        workspaceRoot = await makeWorkspaceRoot();
        workspace = await createAgentWorkspace({
          repositoryRoot: this.projectRoot,
          workspaceRoot,
          approvedPlan: plan,
          changeId: input.changeId,
          attemptId: current.currentAttemptId,
          baselineCommit: plan.baselineCommit,
          requestPath: paths.request,
          planPath: paths.plan,
          policyPath: authorities.policyPath,
          resultSchemaPath: authorities.resultSchemaPath,
        });
        const agent = await this.adapter(input.adapter, workspace);
        const result = await agent.run(workspaceInputs(workspace));
        output = await validateAgentWorkspaceOutput(workspace, plan);
        const [evidenceRoot, profile] = await Promise.all([
          createValidationEvidenceRoot(output, plan, current.currentAttemptId),
          createControllerPublicationProfile(
            output,
            plan,
            current.currentAttemptId,
            publication,
          ),
        ]);
        const validations = await runValidation(
          {
            output,
            plan,
            attemptId: current.currentAttemptId,
            evidenceRoot,
            publicationProfile: profile,
          },
          this.runtime.validationOptions,
        );
        if (validations.some((validation) => validation.status !== "passed")) {
          throw preliminaryValidationFailure(validations);
        }
        const candidate = await createCandidate({
          output,
          plan,
          attemptId: current.currentAttemptId,
          preliminaryValidations: validations,
          store: this.candidateStore,
          buildCapability: this.runtime.candidateBuildCapability,
          previewCapability: this.runtime.candidatePreviewCapability,
        });
        await writeAtomic(
          paths.candidate,
          Buffer.from(canonicalJson(candidate), "utf8"),
        );
        await writeAttempt(paths, completedAttempt(running, result, candidate));
        await locked.transition({
          type: "generated",
          to: "generated",
          payload: {
            attemptId: current.currentAttemptId,
            candidateCommit: candidate.candidateCommit,
            artifactSha256: candidate.artifactSha256,
          },
        });
        rememberSessionCandidate(this.candidateStore, candidate);
        return {
          kind: "success",
          value: {
            changeId: input.changeId,
            state: "generated",
            attemptId: current.currentAttemptId,
            candidateCommit: candidate.candidateCommit,
            artifactSha256: candidate.artifactSha256,
          },
        };
      } catch (error: unknown) {
        await writeAttempt(paths, failedAttempt(running, error)).catch(
          () => undefined,
        );
        throw error;
      } finally {
        if (output !== undefined)
          await removeStagedAgentOutput(output).catch(() => undefined);
        if (workspace !== undefined)
          await removeAgentWorkspace(workspace).catch(() => undefined);
        if (workspaceRoot !== undefined)
          await rm(workspaceRoot, { recursive: true, force: true }).catch(
            () => undefined,
          );
      }
    });
  }

  async validate(changeId: string): Promise<ControllerResult> {
    this.assertOpen();
    return await this.withChangeOperation(changeId, async (locked) => {
      const current = await this.requireLockedState(locked, "generated");
      const paths = await this.paths(changeId);
      const [plan, attempt, candidate] = await Promise.all([
        readPlan(paths),
        readAttempt(paths, current.currentAttemptId),
        this.candidateFor(changeId, current.currentAttemptId),
      ]);
      if (
        attempt.changeId !== changeId ||
        attempt.planSha256 !== plan.planSha256 ||
        candidate.planSha256 !== plan.planSha256
      ) {
        throw new TypeError("El intento o candidato no coincide con el plan");
      }
      await verifyCandidateArtifact(candidate);
      await verifyCandidateEvidence(candidate, attempt);
      await writeAttempt(paths, validatedAttempt(attempt));
      await locked.transition({
        type: "validated",
        to: "validated",
        payload: { artifactSha256: candidate.artifactSha256 },
      });
      return {
        kind: "success",
        value: {
          changeId,
          state: "validated",
          artifactSha256: candidate.artifactSha256,
        },
      };
    });
  }

  async preview(input: {
    readonly changeId: string;
    readonly checkOnly: true;
  }): Promise<ControllerResult> {
    this.assertOpen();
    return await this.withChangeOperation(input.changeId, async (locked) => {
      const current = await locked.read();
      if (current.state === "generated")
        return { kind: "gate-pending", gate: 2 };
      if (current.state !== "validated" && current.state !== "gate2_approved") {
        throw new TypeError("El cambio no está listo para preview");
      }
      const paths = await this.paths(input.changeId);
      const [candidate, attempt] = await Promise.all([
        this.candidateFor(input.changeId, current.currentAttemptId),
        readAttempt(paths, current.currentAttemptId),
      ]);
      await verifyCandidateArtifact(candidate);
      await verifyCandidateEvidence(candidate, attempt);
      return {
        kind: "success",
        value: {
          changeId: input.changeId,
          checkOnly: true,
          artifactSha256: candidate.artifactSha256,
          routes: candidate.routes,
        },
      };
    });
  }

  async publishLocal(input: {
    readonly changeId: string;
    readonly operator: OperatorProfile;
  }): Promise<ControllerResult> {
    this.assertOpen();
    return await this.withChangeOperation(input.changeId, async (locked) => {
      const before = await this.requireLockedState(locked, "gate2_approved");
      const paths = await this.paths(input.changeId);
      const [candidate, attempt] = await Promise.all([
        this.candidateFor(input.changeId, before.currentAttemptId),
        readAttempt(paths, before.currentAttemptId),
      ]);
      await verifyCandidateArtifact(candidate);
      await verifyCandidateEvidence(candidate, attempt);
      const result = await new LocalPublisher().publish({
        candidate,
        operator: input.operator,
        ...(this.runtime.localPublicationCapability === undefined
          ? {}
          : { testCapability: this.runtime.localPublicationCapability }),
      });
      const after = await this.requireLockedState(locked, "gate2_approved");
      if (
        after.currentAttemptId !== before.currentAttemptId ||
        after.revision !== before.revision ||
        result.artifactSha256 !== candidate.artifactSha256
      ) {
        throw new TypeError(
          "La comprobación local no puede alterar el estado durable del cambio",
        );
      }
      return {
        kind: "success",
        value: {
          changeId: input.changeId,
          state: "gate2_approved",
          local: "success",
          artifactSha256: candidate.artifactSha256,
        },
      };
    });
  }

  async status(changeId: string): Promise<ControllerResult> {
    this.assertOpen();
    const current = await this.state(changeId);
    let candidate: { artifactSha256: string; candidateCommit: string } | null =
      null;
    if (
      ["generated", "validated", "gate2_approved", "published"].includes(
        current.state,
      )
    ) {
      try {
        const loaded = await loadCandidate({
          store: this.candidateStore,
          changeId,
          attemptId: current.currentAttemptId,
        });
        candidate = {
          artifactSha256: loaded.artifactSha256,
          candidateCommit: loaded.candidateCommit,
        };
      } catch {
        candidate = null;
      }
    }
    return {
      kind: "success",
      value: {
        changeId,
        state: current.state,
        revision: current.revision,
        attemptId: current.currentAttemptId,
        pendingGate:
          current.state === "planned"
            ? 1
            : current.state === "validated"
              ? 2
              : null,
        candidate,
      },
    };
  }

  async audit(): Promise<IngestionAudit> {
    this.assertOpen();
    // Records outlive their execution clone.  Read their tag facts up front,
    // but never construct an agent merely to inspect those durable facts.
    const fixtureTags = await this.auditTagReader(this.projectRoot);
    const stateRoot = join(this.projectRoot, ".change-state");
    let entries: string[] = [];
    try {
      entries = (
        await (
          await import("node:fs/promises")
        ).readdir(stateRoot, { withFileTypes: true })
      )
        .filter(
          (entry) => entry.isDirectory() && changeIdPattern.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort();
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        entries = [];
      } else {
        throw error;
      }
    }
    const changes: Array<IngestionAudit["changes"][number]> = [];
    const missing: string[] = [];
    for (const changeId of entries) {
      try {
        const change = await this.stateStore.withChangeLock(
          changeId,
          async (locked) => {
            const record = await locked.read();
            await this.stateStore.verifyJournal(changeId);
            const paths = await this.paths(changeId);
            const requiresPlan =
              record.state !== "received" &&
              record.state !== "failed" &&
              record.state !== "rejected";
            const request = await readRequest(paths);
            if (!requiresPlan) {
              return Object.freeze({
                changeId,
                state: record.state,
                revision: record.revision,
                candidate: null,
              });
            }
            const plan = await readPlan(paths);
            let candidate: {
              artifactSha256: string;
              candidateCommit: string;
            } | null = null;
            if (
              [
                "generated",
                "validated",
                "gate2_approved",
                "published",
              ].includes(record.state)
            ) {
              const [loaded, persisted, attempt, gate1] = await Promise.all([
                loadCandidate({
                  store: this.candidateStore,
                  changeId,
                  attemptId: record.currentAttemptId,
                }),
                readCanonicalJson(paths.candidate, "El candidato durable"),
                readAttempt(paths, record.currentAttemptId),
                readApproval(paths, 1),
              ]);
              const durable = validateSchema<CandidateManifest>(
                "candidate",
                persisted,
              );
              if (
                canonicalJson(durable) !== canonicalJson(loaded) ||
                request.changeId !== changeId ||
                request.inputSha256 !== loaded.requestSha256 ||
                plan.changeId !== changeId ||
                plan.requestSha256 !== loaded.requestSha256 ||
                plan.planSha256 !== loaded.planSha256 ||
                plan.baselineCommit !== loaded.baselineCommit ||
                canonicalJson(plan.publication) !==
                  canonicalJson(loaded.buildProfile) ||
                attempt.changeId !== changeId ||
                attempt.attemptId !== record.currentAttemptId ||
                attempt.requestSha256 !== loaded.requestSha256 ||
                attempt.planSha256 !== loaded.planSha256 ||
                attempt.baselineCommit !== loaded.baselineCommit ||
                (record.state === "generated" &&
                  attempt.status !== "generated") ||
                (record.state !== "generated" && attempt.status !== "validated")
              ) {
                throw new TypeError(
                  "El candidato durable no conserva sus bindings de auditoría",
                );
              }
              verifyApproval(gate1, plan, plan.baselineCommit);
              if (
                record.state === "gate2_approved" ||
                record.state === "published"
              ) {
                verifyApproval(
                  await readApproval(paths, 2),
                  loaded,
                  loaded.baselineCommit,
                );
              }
              await verifyCandidateArtifact(loaded);
              await verifyCandidateEvidence(loaded, attempt);
              const dossierPresent = await verifyFixtureDossier({
                projectRoot: this.projectRoot,
                paths,
                record,
                request,
                plan,
                attempt,
                candidate: loaded,
              });
              const tag = fixtureTags.get(changeId) ?? null;
              if (
                tag !== null &&
                (!dossierPresent ||
                  tag.candidateCommit !== loaded.candidateCommit)
              ) {
                throw new TypeError(
                  "La etiqueta fixture no coincide con su dossier candidato",
                );
              }
              candidate = {
                artifactSha256: loaded.artifactSha256,
                candidateCommit: loaded.candidateCommit,
              };
            }
            return Object.freeze({
              changeId,
              state: record.state,
              revision: record.revision,
              candidate,
            });
          },
        );
        changes.push(change);
      } catch {
        missing.push(`change:${changeId}`);
      }
    }

    // A normal audit often runs after the fixture clone has been removed, so
    // `.change-state` is intentionally only supplemental.  The source-side
    // tag and sanitized dossier are the durable record and must exist as a
    // matched, internally-bound pair.
    const dossierIds = await durableFixtureDossierIds(this.projectRoot);
    const durableIds = new Set([...fixtureTags.keys(), ...dossierIds]);
    const reported = new Set(changes.map((change) => change.changeId));
    for (const changeId of [...durableIds].sort()) {
      try {
        const tag = fixtureTags.get(changeId);
        if (tag === undefined || !dossierIds.has(changeId)) {
          throw new TypeError("Falta un hecho durable del fixture");
        }
        const dossier = await verifyDurableFixtureDossier(
          this.projectRoot,
          changeId,
          tag,
        );
        if (dossier.candidateCommit !== tag.candidateCommit) {
          throw new TypeError(
            "La etiqueta fixture no coincide con su dossier durable",
          );
        }
        if (!reported.has(changeId)) {
          changes.push({
            changeId,
            state: "gate2_approved",
            revision: 0,
            candidate: {
              artifactSha256: dossier.artifactSha256,
              candidateCommit: dossier.candidateCommit,
            },
          });
          reported.add(changeId);
        }
      } catch {
        missing.push(`fixture:${changeId}`);
      }
    }
    return Object.freeze({
      ok: missing.length === 0,
      changes: Object.freeze(
        changes.sort((left, right) =>
          left.changeId < right.changeId
            ? -1
            : left.changeId > right.changeId
              ? 1
              : 0,
        ),
      ),
      missing: Object.freeze(missing.sort()),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    sessionCandidates.delete(this.candidateStore);
    await releaseControllerCandidateStore(this.candidateStore);
  }
}

async function openWithRuntime(
  runtime: IngestionControllerTestRuntime = {},
  options: ControllerOpenOptions = {},
): Promise<IngestionController> {
  const projectRoot = await assertControllerRoot(process.cwd());
  const candidateStore = await openControllerCandidateStore();
  try {
    const initializeAgents = options.initializeAgents !== false;
    const [commandConfig, codexCapability] = initializeAgents
      ? await Promise.all([
          Promise.resolve(parseCommandConfig()),
          defaultCodexCapability(),
        ])
      : [null, null];
    return new DefaultIngestionController(
      projectRoot,
      createStateStore({ projectRoot }),
      candidateStore,
      Object.freeze({
        ...runtime,
        commandConfig,
        codexCapability,
      }),
      options.auditTagReader ?? fixtureTagCommits,
    );
  } catch (error) {
    await releaseControllerCandidateStore(candidateStore).catch(
      () => undefined,
    );
    throw error;
  }
}

/** Opens the production composition root from the trusted startup directory. */
export async function openIngestionController(): Promise<IngestionController> {
  return await openWithRuntime();
}

/**
 * Opens only the durable audit graph. Agent configuration is deliberately
 * rejected as an invocation error instead of being inspected or initialized.
 */
export async function openIngestionAuditController(): Promise<IngestionController> {
  if (arguments.length !== 0) {
    throw new TypeError("La auditoría no admite configuración externa");
  }
  if (
    (process.env.CODEX_EXECUTABLE !== undefined &&
      process.env.CODEX_EXECUTABLE !== "") ||
    (process.env.INGEST_COMMAND_AGENT_CONFIG !== undefined &&
      process.env.INGEST_COMMAND_AGENT_CONFIG !== "")
  ) {
    throw new TypeError("La auditoría no admite configuración de agentes");
  }
  return await openWithRuntime({}, { initializeAgents: false });
}

/**
 * Test-only audit composition for declarative, pre-existing tag seals. It
 * accepts no executable, path, argv, callback, or environment override.
 */
export async function openIngestionAuditControllerForTest(
  seal: IngestionAuditTestSeal,
): Promise<IngestionController> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("La auditoría fixture sólo existe en modo de pruebas");
  }
  const facts = auditTestSeals.get(seal);
  if (facts === undefined) {
    throw new TypeError("La auditoría fixture exige un sello sellado");
  }
  return await openWithRuntime(
    {},
    {
      initializeAgents: false,
      auditTagReader: async () => new Map(facts),
    },
  );
}

/** Test-only composition with opaque capabilities; production calls the opener above. */
export async function openIngestionControllerForTest(
  runtime: IngestionControllerTestRuntime,
): Promise<IngestionController> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "El runtime controlador sólo existe en modo de pruebas",
    );
  }
  return await openWithRuntime(runtime);
}
