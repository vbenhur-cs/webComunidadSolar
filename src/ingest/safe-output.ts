const redacted = "[redactado]";

const changeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/u;
const attemptIdPattern = /^attempt-\d{6}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40,64}$/u;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
  });
}

function ownValue(record: PlainRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return undefined;
  }
  return descriptor.value;
}

function optionalString(
  record: PlainRecord,
  key: string,
  valid: (value: string) => boolean,
): string | undefined {
  const value = ownValue(record, key);
  return typeof value === "string" && valid(value) ? value : undefined;
}

function optionalInteger(record: PlainRecord, key: string): number | undefined {
  const value = ownValue(record, key);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function optionalBoolean(
  record: PlainRecord,
  key: string,
  expected: boolean,
): boolean | undefined {
  return ownValue(record, key) === expected ? expected : undefined;
}

function safeCandidate(
  value: unknown,
):
  | { readonly artifactSha256: string; readonly candidateCommit: string }
  | null
  | undefined {
  if (value === null) return null;
  if (!isPlainRecord(value)) return undefined;
  const artifactSha256 = optionalString(value, "artifactSha256", (entry) =>
    sha256Pattern.test(entry),
  );
  const candidateCommit = optionalString(value, "candidateCommit", (entry) =>
    commitPattern.test(entry),
  );
  if (artifactSha256 === undefined || candidateCommit === undefined) {
    return undefined;
  }
  return Object.freeze({ artifactSha256, candidateCommit });
}

const changeStates = new Set([
  "received",
  "normalized",
  "planned",
  "gate1_approved",
  "generated",
  "validated",
  "gate2_approved",
  "published",
  "rejected",
  "failed",
]);

/**
 * Projects controller result facts into a fresh, closed JSON shape. It never
 * walks arbitrary objects: unrecognised fields and values are simply absent.
 */
export function safeCliJson(value: unknown): object | typeof redacted {
  if (!isPlainRecord(value)) return redacted;
  const result: Record<string, unknown> = {};
  const changeId = optionalString(value, "changeId", (entry) =>
    changeIdPattern.test(entry),
  );
  if (changeId !== undefined) result.changeId = changeId;
  const inputKind = optionalString(
    value,
    "inputKind",
    (entry) => entry === "request" || entry === "page",
  );
  if (inputKind !== undefined) result.inputKind = inputKind;
  const state = optionalString(value, "state", (entry) =>
    changeStates.has(entry),
  );
  if (state !== undefined) result.state = state;
  const planSha256 = optionalString(value, "planSha256", (entry) =>
    sha256Pattern.test(entry),
  );
  if (planSha256 !== undefined) result.planSha256 = planSha256;
  const selectedMode = optionalString(
    value,
    "selectedMode",
    (entry) => entry === "blocks" || entry === "freeform" || entry === "hybrid",
  );
  if (selectedMode !== undefined) result.selectedMode = selectedMode;
  const gate = ownValue(value, "gate");
  if (gate === 1 || gate === 2) result.gate = gate;
  const attemptId = optionalString(value, "attemptId", (entry) =>
    attemptIdPattern.test(entry),
  );
  if (attemptId !== undefined) result.attemptId = attemptId;
  const candidateCommit = optionalString(value, "candidateCommit", (entry) =>
    commitPattern.test(entry),
  );
  if (candidateCommit !== undefined) result.candidateCommit = candidateCommit;
  const artifactSha256 = optionalString(value, "artifactSha256", (entry) =>
    sha256Pattern.test(entry),
  );
  if (artifactSha256 !== undefined) result.artifactSha256 = artifactSha256;
  const revision = optionalInteger(value, "revision");
  if (revision !== undefined) result.revision = revision;
  const pendingGate = ownValue(value, "pendingGate");
  if (pendingGate === null || pendingGate === 1 || pendingGate === 2) {
    result.pendingGate = pendingGate;
  }
  const candidate = safeCandidate(ownValue(value, "candidate"));
  if (candidate !== undefined) result.candidate = candidate;
  const checkOnly = optionalBoolean(value, "checkOnly", true);
  if (checkOnly !== undefined) result.checkOnly = checkOnly;
  const local = optionalString(value, "local", (entry) => entry === "success");
  if (local !== undefined) result.local = local;
  return Object.keys(result).length === 0 ? redacted : Object.freeze(result);
}

function safeAuditChange(value: unknown): object | null {
  if (!isPlainRecord(value)) return null;
  const changeId = optionalString(value, "changeId", (entry) =>
    changeIdPattern.test(entry),
  );
  const state = optionalString(value, "state", (entry) =>
    changeStates.has(entry),
  );
  const revision = optionalInteger(value, "revision");
  const candidate = safeCandidate(ownValue(value, "candidate"));
  if (
    changeId === undefined ||
    state === undefined ||
    revision === undefined ||
    candidate === undefined
  ) {
    return null;
  }
  return Object.freeze({ changeId, state, revision, candidate });
}

function safeMissing(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(?:change|fixture):([a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9]))$/u.exec(value);
  return match === null ? null : value;
}

/** Projects the audit contract into its fixed public output schema. */
export function safeIngestionAuditJson(
  value: unknown,
): object | typeof redacted {
  if (!isPlainRecord(value) || typeof ownValue(value, "ok") !== "boolean") {
    return redacted;
  }
  const changes = ownValue(value, "changes");
  const missing = ownValue(value, "missing");
  if (!Array.isArray(changes) || !Array.isArray(missing)) return redacted;
  const safeChanges = changes.map(safeAuditChange);
  const safeMissingEntries = missing.map(safeMissing);
  if (
    safeChanges.some((change) => change === null) ||
    safeMissingEntries.some((entry) => entry === null)
  ) {
    return redacted;
  }
  return Object.freeze({
    ok: ownValue(value, "ok"),
    changes: Object.freeze(safeChanges),
    missing: Object.freeze(safeMissingEntries),
  });
}

/**
 * Generic values have no output schema and are never recursively serialised.
 * This compatibility boundary is intentionally fail-closed; production callers
 * must use one of the concrete allowlisted projections above.
 */
export function safeJson(value: unknown): typeof redacted {
  void value;
  return redacted;
}

/** Error messages and stacks are unclassified input, so never serialize them. */
export function safeError(error: unknown): "fallo operativo" {
  void error;
  return "fallo operativo";
}
