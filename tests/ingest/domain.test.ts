import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  sha256Canonical,
} from "../../src/ingest/canonical-json.ts";
import { allowedTransition } from "../../src/ingest/domain.ts";
import { validateSchema } from "../../src/ingest/schema-validator.ts";

const hash = (character: string) => character.repeat(64);
const commit = "b".repeat(40);

const validInput = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  changeId: "nueva-pagina-autoconsumo",
  intent: "Explicar el autoconsumo compartido",
  targetPath: "/autoconsumo-compartido",
  acceptanceCriteria: ["La ruta responde 200"],
  ...overrides,
});

const validRequest = (overrides: Record<string, unknown> = {}) => ({
  ...validInput(),
  inputKind: "request",
  audience: null,
  mode: "auto",
  content: "Contenido normalizado",
  claims: [],
  references: [],
  assets: [],
  seo: { title: null, description: null, index: true },
  privacy: { private: false, area: null },
  allowedExternalLinks: [],
  inputSha256: hash("a"),
  ...overrides,
});

const validPlan = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  changeId: "nueva-pagina-autoconsumo",
  baselineCommit: commit,
  requestSha256: hash("a"),
  selectedMode: "blocks",
  targetPath: "/autoconsumo-compartido",
  overwritesExistingRoute: false,
  files: [
    { path: "src/pages/autoconsumo-compartido.astro", operation: "create" },
  ],
  components: [],
  islands: [],
  dependencies: [],
  validations: ["npm run check"],
  publication: {
    adapter: "local",
    configSha256: hash("c"),
    environment: null,
    siteIndexable: false,
  },
  planSha256: hash("d"),
  ...overrides,
});

const validApproval = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  environment: "production",
  gate: 1,
  changeId: "nueva-pagina-autoconsumo",
  actor: "operador",
  approvedAt: "2026-08-23T10:00:00.000Z",
  subjectSha256: hash("e"),
  baselineCommit: commit,
  candidateCommit: null,
  artifactSha256: null,
  ...overrides,
});

const validAttempt = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  changeId: "nueva-pagina-autoconsumo",
  attemptId: "attempt-001",
  status: "validated",
  resumeState: null,
  adapter: "fixture",
  startedAt: "2026-08-23T10:00:00.000Z",
  finishedAt: "2026-08-23T10:01:00.000Z",
  requestSha256: hash("a"),
  planSha256: hash("d"),
  baselineCommit: commit,
  generatedFiles: ["src/pages/autoconsumo-compartido.astro"],
  logs: {
    stdout: "logs/stdout.txt",
    stderr: null,
    finalMessage: null,
  },
  validations: [
    {
      id: "typecheck",
      status: "passed",
      evidence: "evidence/typecheck.txt",
      evidenceSha256: hash("f"),
    },
  ],
  failure: null,
  ...overrides,
});

const validCandidate = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  changeId: "nueva-pagina-autoconsumo",
  attemptId: "attempt-001",
  requestSha256: hash("a"),
  planSha256: hash("d"),
  baselineCommit: commit,
  candidateCommit: "c".repeat(40),
  artifactSha256: hash("f"),
  buildProfile: validPlan().publication,
  routes: ["/autoconsumo-compartido"],
  files: ["src/pages/autoconsumo-compartido.astro"],
  validations: [
    {
      id: "typecheck",
      status: "passed",
      evidence: "evidence/typecheck.txt",
    },
  ],
  artifacts: [
    {
      path: "evidence/typecheck.txt",
      sha256: hash("f"),
      bytes: 12,
    },
  ],
  preview: { command: "npm run preview", url: "http://127.0.0.1:4321" },
  knownDifferences: [],
  ...overrides,
});

const validCandidateDossierPreimage = (
  overrides: Record<string, unknown> = {},
) => ({
  schemaVersion: 1,
  kind: "sealed-candidate-preimage",
  candidateSchemaVersion: 1,
  changeId: "nueva-pagina-autoconsumo",
  attemptId: "attempt-000001",
  requestSha256: hash("a"),
  planSha256: hash("d"),
  baselineCommit: commit,
  candidateCommit: "c".repeat(40),
  artifactSha256: hash("f"),
  buildProfile: {
    adapter: "local",
    configSha256: hash("c"),
    environmentSha256: null,
    siteIndexable: false,
  },
  routes: [{ index: 0, valueSha256: hash("1") }],
  files: [{ index: 0, valueSha256: hash("2") }],
  validations: [
    {
      index: 0,
      id: "typecheck",
      status: "passed",
      evidencePathSha256: hash("3"),
      evidenceSha256: hash("4"),
    },
  ],
  artifacts: [
    {
      index: 0,
      sourcePathSha256: hash("5"),
      dossierPathSha256: hash("6"),
      sha256: hash("f"),
      bytes: 12,
    },
  ],
  preview: { commandSha256: hash("7"), urlSha256: hash("8") },
  knownDifferences: [],
  ...overrides,
});

test("canonical JSON has a hand-checked stable representation and digest", () => {
  const left = { b: 2, a: [3, { d: 4, c: 5 }] };
  const right = { a: [3, { c: 5, d: 4 }], b: 2 };

  assert.equal(canonicalJson(left), '{"a":[3,{"c":5,"d":4}],"b":2}');
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(
    sha256Canonical(left),
    "a6f69edf708062e50cc8668b6e0ec14b540803930d10f02db84e74b339448c52",
  );
  assert.equal(sha256Canonical(left), sha256Canonical(right));
});

test("canonical JSON rejects values that cannot identify an intake exactly", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const arrayWithSymbol = Object.assign([], { [Symbol("hidden")]: "hidden" });

  for (const value of [
    undefined,
    () => undefined,
    Symbol("value"),
    1n,
    NaN,
    Infinity,
    cycle,
    arrayWithSymbol,
  ]) {
    assert.throws(
      () => canonicalJson(value),
      /can[oó]nico|serializ|ciclo|finito/i,
    );
  }
});

test("canonical JSON rejects sparse, hidden, and accessor-owned properties without reading accessors", () => {
  const sparse = new Array(1);
  const arrayWithExtraProperty = ["visible"] as string[] & {
    extra?: string;
  };
  arrayWithExtraProperty.extra = "hidden-from-json";
  const arrayWithHiddenProperty = ["visible"];
  Object.defineProperty(arrayWithHiddenProperty, "hidden", {
    value: "hidden-from-json",
  });

  let arrayGetterReads = 0;
  const arrayWithAccessor = ["visible"];
  Object.defineProperty(arrayWithAccessor, "0", {
    configurable: true,
    enumerable: true,
    get() {
      arrayGetterReads += 1;
      return "must-not-be-read";
    },
  });

  let objectGetterReads = 0;
  const objectWithAccessor = {};
  Object.defineProperty(objectWithAccessor, "hidden", {
    enumerable: true,
    get() {
      objectGetterReads += 1;
      return "must-not-be-read";
    },
  });
  const objectWithHiddenProperty = {};
  Object.defineProperty(objectWithHiddenProperty, "hidden", {
    value: "hidden-from-json",
  });

  for (const value of [
    sparse,
    arrayWithExtraProperty,
    arrayWithHiddenProperty,
    arrayWithAccessor,
    objectWithAccessor,
    objectWithHiddenProperty,
  ]) {
    assert.throws(() => canonicalJson(value), /can[oó]nico|propiedad/i);
  }

  assert.equal(arrayGetterReads, 0);
  assert.equal(objectGetterReads, 0);
});

test("accepts one valid instance of each closed ingestion schema", () => {
  const completeInput = validInput({
    audience: "Vecindario",
    mode: "hybrid",
    content: "Contenido aportado",
    claims: ["Ahorro local"],
    references: ["https://example.test/referencia"],
    assets: [
      {
        path: "assets/solar.png",
        sha256: hash("1"),
        mediaType: "image/png",
      },
    ],
    seo: { title: "Autoconsumo", description: null, index: true },
    privacy: { private: true, area: "equipo" },
    allowedExternalLinks: ["https://example.test"],
  });

  for (const [name, value] of [
    ["request-input", completeInput],
    ["normalized-request", validRequest()],
    ["change-plan", validPlan()],
    ["approval", validApproval()],
    ["attempt", validAttempt()],
    ["candidate", validCandidate()],
    ["candidate-dossier-preimage", validCandidateDossierPreimage()],
  ] as const) {
    assert.deepEqual(validateSchema(name, value), value, name);
  }
});

test("request input is a raw closed projection and rejects derived fields", () => {
  assert.deepEqual(validateSchema("request-input", validInput()), validInput());
  assert.throws(
    () => validateSchema("request-input", validInput({ inputKind: "request" })),
    /inputKind|additional|propiedad/i,
  );
  assert.throws(
    () =>
      validateSchema("request-input", validInput({ inputSha256: hash("a") })),
    /inputSha256|additional|propiedad/i,
  );
});

test("all schemas reject unknown properties", () => {
  for (const [name, value] of [
    ["request-input", validInput()],
    ["normalized-request", validRequest()],
    ["change-plan", validPlan()],
    ["approval", validApproval()],
    ["attempt", validAttempt()],
    ["candidate", validCandidate()],
    ["candidate-dossier-preimage", validCandidateDossierPreimage()],
  ] as const) {
    assert.throws(
      () => validateSchema(name, { ...value, unexpected: true }),
      /additional|propiedad|unexpected/i,
      name,
    );
  }
});

test("closed nested contracts reject fields outside their canonical shape", () => {
  for (const [name, value] of [
    ["request-input", validInput({ seo: { index: true, unexpected: true } })],
    [
      "normalized-request",
      validRequest({
        assets: [
          {
            path: "assets/solar.png",
            sha256: hash("1"),
            mediaType: "image/png",
            unexpected: true,
          },
        ],
      }),
    ],
    [
      "change-plan",
      validPlan({
        publication: { ...validPlan().publication, unexpected: true },
      }),
    ],
    [
      "attempt",
      validAttempt({
        logs: {
          stdout: "logs/stdout.txt",
          stderr: null,
          finalMessage: null,
          unexpected: true,
        },
      }),
    ],
    [
      "candidate",
      validCandidate({
        preview: {
          command: "npm run preview",
          url: "http://127.0.0.1:4321",
          unexpected: true,
        },
      }),
    ],
  ] as const) {
    assert.throws(
      () => validateSchema(name, value),
      /additional|propiedad|unexpected/i,
      name,
    );
  }
});

test("enforces normalized request path, criteria, hashes, and privacy invariants", () => {
  for (const targetPath of [
    "/api/internal",
    "/ruta/api",
    "/ruta/",
    "/ruta//doble",
    "/ruta/../otra",
    "/ruta?x=1",
    "/ruta#fragmento",
    "/_interno",
    "/ruta.html",
    "/ruta/[slug]",
  ]) {
    assert.throws(
      () => validateSchema("normalized-request", validRequest({ targetPath })),
      /targetPath|ruta|path/i,
      targetPath,
    );
  }

  assert.throws(
    () =>
      validateSchema(
        "normalized-request",
        validRequest({ acceptanceCriteria: [] }),
      ),
    /acceptanceCriteria/i,
  );
  for (const acceptanceCriteria of [
    [""],
    ["x".repeat(501)],
    Array.from({ length: 51 }, () => "criterio"),
  ]) {
    assert.throws(
      () =>
        validateSchema(
          "normalized-request",
          validRequest({ acceptanceCriteria }),
        ),
      /acceptanceCriteria/i,
    );
  }
  for (const changeId of ["ab", "Cambio-invalido", "cambio-", "a".repeat(65)]) {
    assert.throws(
      () => validateSchema("normalized-request", validRequest({ changeId })),
      /changeId/i,
    );
  }
  assert.throws(
    () =>
      validateSchema(
        "normalized-request",
        validRequest({ inputSha256: hash("A") }),
      ),
    /inputSha256|hash/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "normalized-request",
        validRequest({ inputSha256: "a".repeat(63) }),
      ),
    /inputSha256|hash/i,
  );

  for (const [name, value] of [
    [
      "request-input",
      validInput({ privacy: { private: false, area: "equipo" } }),
    ],
    [
      "normalized-request",
      validRequest({ privacy: { private: true, area: null } }),
    ],
  ] as const) {
    assert.throws(
      () => validateSchema(name, value),
      /privacy|area|private/i,
      name,
    );
  }
});

test("requires an executable closed plan profile", () => {
  assert.throws(
    () => validateSchema("change-plan", validPlan({ selectedMode: "auto" })),
    /selectedMode|mode/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "change-plan",
        validPlan({
          publication: {
            ...validPlan().publication,
            environment: "preview",
          },
        }),
      ),
    /environment|local/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "change-plan",
        validPlan({
          publication: {
            adapter: "cloudflare",
            configSha256: hash("c"),
            environment: null,
            siteIndexable: true,
          },
        }),
      ),
    /environment|cloudflare/i,
  );
});

test("binds the two approval gates to their required candidate and artifact fields", () => {
  assert.throws(
    () =>
      validateSchema("approval", validApproval({ artifactSha256: hash("f") })),
    /gate|artifact|candidate/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "approval",
        validApproval({ gate: 2, candidateCommit: null, artifactSha256: null }),
      ),
    /gate|artifact|candidate/i,
  );
  assert.doesNotThrow(() =>
    validateSchema(
      "approval",
      validApproval({
        gate: 2,
        candidateCommit: "c".repeat(40),
        artifactSha256: hash("f"),
      }),
    ),
  );
});

test("enforces attempt lifecycle, sanitized log paths, and validation outcomes", () => {
  assert.throws(
    () =>
      validateSchema(
        "attempt",
        validAttempt({
          validations: [
            {
              id: "build",
              status: "skipped",
              evidence: null,
              evidenceSha256: null,
            },
          ],
        }),
      ),
    /validated|validation|skipped/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "attempt",
        validAttempt({ status: "failed", failure: null }),
      ),
    /failed|failure|finished/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "attempt",
        validAttempt({
          status: "failed",
          finishedAt: null,
          failure: { code: "build", message: "falló" },
        }),
      ),
    /failed|failure|finished/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "attempt",
        validAttempt({ status: "rejected", failure: null }),
      ),
    /rejected|failure|finished/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "attempt",
        validAttempt({
          status: "running",
          finishedAt: "2026-08-23T10:01:00.000Z",
        }),
      ),
    /running|finished|failure/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "attempt",
        validAttempt({
          status: "running",
          failure: { code: "unexpected", message: "aún no" },
        }),
      ),
    /running|finished|failure/i,
  );
  assert.throws(
    () =>
      validateSchema(
        "attempt",
        validAttempt({
          logs: { stdout: "../raw.log", stderr: null, finalMessage: null },
        }),
      ),
    /logs|path|ruta/i,
  );
});

test("requires complete passed evidence for a validated attempt", () => {
  for (const overrides of [
    { validations: [] },
    {
      validations: [
        {
          id: "build",
          status: "passed",
          evidence: null,
          evidenceSha256: null,
        },
      ],
    },
    { finishedAt: null },
    { failure: { code: "unexpected", message: "no aplicable" } },
    { resumeState: "gate1_approved" },
  ]) {
    assert.throws(
      () => validateSchema("attempt", validAttempt(overrides)),
      /validated|validation|evidence|finished|failure|resume/i,
    );
  }
});

test("requires checkpointed failed and rejected attempts while preserving running nulls", () => {
  for (const status of ["failed", "rejected"] as const) {
    assert.throws(
      () =>
        validateSchema(
          "attempt",
          validAttempt({
            status,
            resumeState: null,
            failure: { code: "build", message: "falló" },
          }),
        ),
      /resume|failed|rejected/i,
    );
  }

  assert.doesNotThrow(() =>
    validateSchema(
      "attempt",
      validAttempt({ status: "running", finishedAt: null, failure: null }),
    ),
  );
});

test("rejects a candidate that would expose a failed validation as publishable", () => {
  assert.throws(
    () =>
      validateSchema(
        "candidate",
        validCandidate({
          validations: [
            { id: "build", status: "failed", evidence: "evidence/build.txt" },
          ],
        }),
      ),
    /validation|failed/i,
  );
  assert.throws(
    () => validateSchema("candidate", validCandidate({ validations: [] })),
    /validation|minitems/i,
  );
});

test("allows only the state-machine edges that keep both human gates in order", () => {
  const requiredEdges = [
    ["received", "normalized"],
    ["normalized", "planned"],
    ["planned", "gate1_approved"],
    ["gate1_approved", "generated"],
    ["generated", "validated"],
    ["validated", "gate2_approved"],
    ["gate2_approved", "published"],
  ] as const;

  for (const [from, to] of requiredEdges) {
    assert.equal(allowedTransition(from, to), true, `${from} -> ${to}`);
  }

  for (const [from, to] of [
    ["planned", "generated"],
    ["validated", "published"],
    ["published", "failed"],
    ["rejected", "planned"],
  ] as const) {
    assert.equal(allowedTransition(from, to), false, `${from} -> ${to}`);
  }
});
