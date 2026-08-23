import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname as localHostname } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { canonicalJson, sha256Canonical } from "./canonical-json.ts";
import {
  allowedTransition,
  type ChangeRecord,
  type ChangeState,
  type JournalEvent,
  type ResumeState,
  type TransitionEvent,
} from "./domain.ts";
import {
  createJournalEvent,
  parseJournal,
  serializeJournal,
  verifyJournalEvents,
} from "./journal.ts";
import {
  defaultStateRoot,
  ingestPaths,
  type IngestPathOptions,
  type IngestPaths,
} from "./paths.ts";

const staleLockMs = 30 * 60 * 1000;
const eventTypePattern = /^[a-z][a-z0-9-]{0,63}$/;
const recordKeys = [
  "attemptNumber",
  "changeId",
  "createdAt",
  "currentAttemptId",
  "resumeState",
  "revision",
  "schemaVersion",
  "state",
  "updatedAt",
] as const;
const states = new Set<ChangeState>([
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
const resumeStates = new Set<ResumeState>([
  "received",
  "normalized",
  "planned",
  "gate1_approved",
]);

interface LockOwner {
  pid: number;
  hostname: string;
  createdAt: string;
  token?: string;
}

interface AcquiredLock {
  ownerBytes: Uint8Array;
  /**
   * A stale lock can predate the first persisted state.  The recovery event
   * must follow the initial received event, so it is appended after the
   * callback has made that state durable.
   */
  recoveryPending: boolean;
}

export interface StateStoreOptions extends IngestPathOptions {
  now?: () => Date;
  hostname?: () => string;
  isPidAlive?: (pid: number) => boolean | Promise<boolean>;
  atomicWriter?: (path: string, bytes: Uint8Array) => Promise<void>;
  /** @internal Test-only hooks; no production caller should supply these. */
  testHooks?: {
    /** Deterministic boundary for stale-lock race regression tests. */
    afterStaleLockVerified?: () => Promise<void>;
    /** Deterministic boundary before an expired guard is atomically claimed. */
    afterRecoveryGuardVerified?: () => Promise<void>;
    /** Deterministic boundary after a recovery guard is durably acquired. */
    afterRecoveryGuardAcquired?: () => Promise<void>;
  };
}

export interface StateStore {
  withChangeLock<T>(changeId: string, fn: () => Promise<T>): Promise<T>;
  readChange(changeId: string): Promise<ChangeRecord>;
  transition(changeId: string, event: TransitionEvent): Promise<ChangeRecord>;
  retryChange(changeId: string): Promise<ChangeRecord>;
  verifyJournal(changeId: string): Promise<JournalEvent[]>;
}

export interface AtomicWriteOptions {
  /** Allows deterministic fault injection after temp fsync and before rename. */
  beforeRename?: (temporaryPath: string) => void | Promise<void>;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("El reloj del estado no devolvió una fecha válida");
  }
  return value.toISOString();
}

function isChangeState(value: unknown): value is ChangeState {
  return typeof value === "string" && states.has(value as ChangeState);
}

function isResumeState(value: unknown): value is ResumeState {
  return typeof value === "string" && resumeStates.has(value as ResumeState);
}

function attemptId(attemptNumber: number): string {
  return `attempt-${String(attemptNumber).padStart(6, "0")}`;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const found = Object.keys(value).sort();
  return (
    found.length === keys.length &&
    found.every((key, index) => key === keys[index])
  );
}

function assertChangeRecord(
  value: unknown,
  changeId: string,
): asserts value is ChangeRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("El estado persistido no es un objeto válido");
  }
  if (!hasExactKeys(value, recordKeys)) {
    throw new TypeError("El estado persistido contiene campos no permitidos");
  }
  const record = value as Partial<ChangeRecord>;
  if (
    record.schemaVersion !== 1 ||
    record.changeId !== changeId ||
    !isChangeState(record.state) ||
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.attemptNumber !== "number" ||
    !Number.isSafeInteger(record.attemptNumber) ||
    record.attemptNumber < 1 ||
    record.currentAttemptId !== attemptId(record.attemptNumber) ||
    !isResumeState(record.resumeState) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new TypeError("El estado persistido no cumple el contrato canónico");
  }
}

async function readRegularFile(path: string): Promise<Uint8Array | null> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new TypeError(
        "El estado no puede leer enlaces simbólicos ni rutas no regulares",
      );
    }
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  return readFile(path);
}

async function ensureAtomicParent(path: string): Promise<void> {
  let cursor = dirname(path);
  const missing: string[] = [];

  for (;;) {
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError(
          "La escritura atómica requiere un directorio seguro",
        );
      }
      break;
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new TypeError(
          "No se encontró un directorio seguro para escribir",
        );
      }
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }

  let safeParent = await realpath(cursor);
  for (const segment of missing) {
    const next = resolve(safeParent, segment);
    try {
      await mkdir(next);
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }
    const entry = await lstat(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError("La escritura atómica requiere un directorio seguro");
    }
    safeParent = await realpath(next);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeFileAtomically(path: string): Promise<void> {
  await unlink(path);
  await fsyncDirectory(dirname(path));
}

export async function writeAtomic(
  path: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = resolve(path);
  const parent = dirname(target);
  await ensureAtomicParent(target);

  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new TypeError(
        "La escritura atómica no puede reemplazar una ruta no regular",
      );
    }
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  const temporary = resolve(
    parent,
    `.tmp-${process.pid}-${randomUUID()}-${basename(target)}`,
  );
  let temporaryCreated = false;

  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeRename?.(temporary);
    await rename(temporary, target);
    temporaryCreated = false;
    await fsyncDirectory(parent);
  } catch (error) {
    if (temporaryCreated) {
      try {
        await unlink(temporary);
      } catch (cleanupError: unknown) {
        if (!isNodeError(cleanupError, "ENOENT")) {
          throw new AggregateError(
            [error, cleanupError],
            "La escritura atómica y su limpieza fallaron",
          );
        }
      }
    }
    throw error;
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

function parseLockOwner(bytes: Uint8Array): LockOwner {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new TypeError("El lock existente no contiene un propietario válido");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("El lock existente no contiene un propietario válido");
  }
  const owner = value as Partial<LockOwner>;
  const keys = Object.keys(value).sort();
  const expectedKeys =
    owner.token === undefined
      ? ["createdAt", "hostname", "pid"]
      : ["createdAt", "hostname", "pid", "token"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.hostname !== "string" ||
    owner.hostname.length === 0 ||
    typeof owner.createdAt !== "string" ||
    !Number.isFinite(Date.parse(owner.createdAt)) ||
    (owner.token !== undefined && typeof owner.token !== "string")
  ) {
    throw new TypeError("El lock existente no contiene un propietario válido");
  }
  return owner as LockOwner;
}

async function removeOwnedLock(
  path: string,
  ownerBytes: Uint8Array,
): Promise<void> {
  const current = await readRegularFile(path);
  if (current === null) {
    throw new Error("El lock propio desapareció antes de poder liberarlo");
  }
  if (
    current.length !== ownerBytes.length ||
    !current.every((byte, index) => byte === ownerBytes[index])
  ) {
    throw new Error("El lock cambió de propietario antes de poder liberarlo");
  }
  await unlink(path);
}

async function createExclusiveOwnerFile(
  path: string,
  ownerBytes: Uint8Array,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(ownerBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function recoveryQuarantinePath(paths: IngestPaths): string {
  return resolve(
    dirname(paths.recoveryGuard),
    `.recovery-guard-quarantine-${process.pid}-${randomUUID()}`,
  );
}

async function restoreQuarantinedGuard(
  paths: IngestPaths,
  quarantine: string,
): Promise<void> {
  try {
    await link(quarantine, paths.recoveryGuard);
  } catch (error: unknown) {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }
  }
  await removeFileAtomically(quarantine);
}

function combinePrimaryAndCleanup(primary: unknown, cleanup: unknown): never {
  throw new AggregateError(
    [primary, cleanup],
    "La operación de estado falló y no pudo liberar el lock",
  );
}

function stateRootOptions(options: StateStoreOptions): IngestPathOptions {
  return {
    projectRoot: options.projectRoot,
    stateRoot: options.stateRoot,
  };
}

function isRecoveryEligible(
  owner: LockOwner,
  now: string,
  hostname: string,
): boolean {
  return (
    Date.parse(now) - Date.parse(owner.createdAt) > staleLockMs &&
    owner.hostname === hostname
  );
}

function recordFromJournal(
  changeId: string,
  events: readonly JournalEvent[],
): ChangeRecord {
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) {
    throw new TypeError("El journal no contiene el estado inicial");
  }
  let attemptNumber = 1;
  let resumeState: ResumeState = "received";

  for (const event of events) {
    if (event.type === "retry") {
      attemptNumber += 1;
    }
    if (isResumeState(event.to)) {
      resumeState = event.to;
    }
  }

  return {
    schemaVersion: 1,
    changeId,
    state: last.to,
    revision: events.length,
    attemptNumber,
    currentAttemptId: attemptId(attemptNumber),
    resumeState,
    createdAt: first.at,
    updatedAt: last.at,
  };
}

export function createStateStore(options: StateStoreOptions = {}): StateStore {
  const now = options.now ?? (() => new Date());
  const hostname = options.hostname ?? localHostname;
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;
  const atomicWriter = options.atomicWriter ?? writeAtomic;

  async function pathsFor(changeId: string): Promise<IngestPaths> {
    return ingestPaths(changeId, stateRootOptions(options));
  }

  async function readState(paths: IngestPaths): Promise<ChangeRecord | null> {
    const bytes = await readRegularFile(paths.state);
    if (bytes === null) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new TypeError("El estado persistido no contiene JSON válido");
    }
    assertChangeRecord(value, basename(paths.changeDir));
    return value;
  }

  async function readJournal(paths: IngestPaths): Promise<JournalEvent[]> {
    const bytes = await readRegularFile(paths.journal);
    const parsed = parseJournal(
      bytes === null ? "" : new TextDecoder().decode(bytes),
    );
    return verifyJournalEvents(parsed);
  }

  async function verifyJournalFor(
    paths: IngestPaths,
    record?: ChangeRecord,
  ): Promise<JournalEvent[]> {
    const current = record ?? (await readState(paths));
    if (current === null) {
      throw new Error("El estado del cambio no existe");
    }
    const events = await readJournal(paths);
    const last = events.at(-1);
    if (
      events.length !== current.revision ||
      last === undefined ||
      last.to !== current.state ||
      last.at !== current.updatedAt ||
      events[0]?.at !== current.createdAt
    ) {
      throw new TypeError(
        "El journal está truncado o no coincide con la revisión",
      );
    }
    if (
      canonicalJson(current) !==
      canonicalJson(recordFromJournal(current.changeId, events))
    ) {
      throw new TypeError("El estado no coincide con el journal verificable");
    }
    return events;
  }

  async function persistTransition(
    paths: IngestPaths,
    previous: ChangeRecord | null,
    event: TransitionEvent,
    options: { internalLockRecovery?: boolean } = {},
  ): Promise<ChangeRecord> {
    if (typeof event.type !== "string" || !eventTypePattern.test(event.type)) {
      throw new TypeError("El tipo de transición es obligatorio");
    }
    if (event.type === "retry") {
      throw new TypeError("El tipo retry está reservado para retryChange");
    }
    if (event.type === "lock-recovered" && !options.internalLockRecovery) {
      throw new TypeError("La transición de estado no está permitida");
    }
    const at = timestamp(now);
    let existingEvents: JournalEvent[] = [];
    if (previous === null) {
      const orphanedEvents = await readJournal(paths);
      if (orphanedEvents.length > 0) {
        throw new TypeError(
          "El journal existe sin el estado correspondiente y no puede sobrescribirse",
        );
      }
      if (event.to !== "received") {
        throw new TypeError(
          "La transición inicial debe crear el estado received",
        );
      }
    } else {
      existingEvents = await verifyJournalFor(paths, previous);
      const isLockRecovery = options.internalLockRecovery === true;
      if (
        (isLockRecovery && event.to !== previous.state) ||
        (!isLockRecovery && !allowedTransition(previous.state, event.to))
      ) {
        throw new TypeError("La transición de estado no está permitida");
      }
    }
    const next: ChangeRecord =
      previous === null
        ? {
            schemaVersion: 1,
            changeId: basename(paths.changeDir),
            state: "received",
            revision: 1,
            attemptNumber: 1,
            currentAttemptId: attemptId(1),
            resumeState: "received",
            createdAt: at,
            updatedAt: at,
          }
        : {
            ...previous,
            state: event.to,
            revision: previous.revision + 1,
            resumeState: isResumeState(event.to)
              ? event.to
              : previous.resumeState,
            updatedAt: at,
          };
    const journalEvent = createJournalEvent({
      sequence: next.revision,
      at,
      type: event.type,
      from: previous?.state ?? null,
      to: next.state,
      payloadSha256: sha256Canonical(event.payload),
      previousEventSha256: existingEvents.at(-1)?.eventSha256 ?? null,
    });
    const nextEvents = [...existingEvents, journalEvent];
    const previousJournal = serializeJournal(existingEvents);

    await atomicWriter(paths.journal, serializeJournal(nextEvents));
    try {
      await atomicWriter(
        paths.state,
        new TextEncoder().encode(canonicalJson(next)),
      );
    } catch (error) {
      try {
        if (previous === null) {
          await removeFileAtomically(paths.journal);
        } else {
          await atomicWriter(paths.journal, previousJournal);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "No se pudo restaurar el journal tras fallar la transición",
        );
      }
      throw error;
    }
    return next;
  }

  async function recordLockRecovery(paths: IngestPaths): Promise<void> {
    const previous = await readState(paths);
    if (previous === null) {
      return;
    }
    await persistTransition(
      paths,
      previous,
      {
        type: "lock-recovered",
        to: previous.state,
        payload: { recovered: true },
      },
      { internalLockRecovery: true },
    );
  }

  async function acquireLockUnderGuard(
    paths: IngestPaths,
  ): Promise<AcquiredLock> {
    const owner: LockOwner = {
      pid: process.pid,
      hostname: hostname(),
      createdAt: timestamp(now),
      token: randomUUID(),
    };
    const ownerBytes = new TextEncoder().encode(canonicalJson(owner));

    try {
      await createExclusiveOwnerFile(paths.lock, ownerBytes);
      return { ownerBytes, recoveryPending: false };
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }

    const existing = await readRegularFile(paths.lock);
    if (existing === null) {
      try {
        await createExclusiveOwnerFile(paths.lock, ownerBytes);
        return { ownerBytes, recoveryPending: false };
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        throw new Error("El cambio está bloqueado por otro proceso");
      }
    }
    const existingOwner = parseLockOwner(existing);
    const staleByAgeAndHost = isRecoveryEligible(
      existingOwner,
      timestamp(now),
      hostname(),
    );
    const stale = staleByAgeAndHost && !(await isPidAlive(existingOwner.pid));
    if (!stale) {
      throw new Error("El cambio está bloqueado por otro proceso");
    }

    const beforeRemoval = await readRegularFile(paths.lock);
    if (
      beforeRemoval === null ||
      beforeRemoval.length !== existing.length ||
      !beforeRemoval.every((byte, index) => byte === existing[index])
    ) {
      throw new Error("El cambio está bloqueado por otro proceso");
    }
    await options.testHooks?.afterStaleLockVerified?.();
    await unlink(paths.lock);
    try {
      await createExclusiveOwnerFile(paths.lock, ownerBytes);
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        throw new Error("El cambio está bloqueado por otro proceso");
      }
      throw error;
    }
    try {
      const previous = await readState(paths);
      if (previous !== null) {
        await recordLockRecovery(paths);
      }
      return { ownerBytes, recoveryPending: previous === null };
    } catch (error) {
      try {
        await removeOwnedLock(paths.lock, ownerBytes);
      } catch (cleanupError) {
        combinePrimaryAndCleanup(error, cleanupError);
      }
      throw error;
    }
  }

  async function reclaimStaleRecoveryGuard(paths: IngestPaths): Promise<void> {
    const existing = await readRegularFile(paths.recoveryGuard);
    if (existing === null) {
      throw new Error("El cambio está bloqueado por otro proceso");
    }
    const existingOwner = parseLockOwner(existing);
    const stale =
      isRecoveryEligible(existingOwner, timestamp(now), hostname()) &&
      !(await isPidAlive(existingOwner.pid));
    if (!stale) {
      throw new Error("El cambio está bloqueado por otro proceso");
    }

    await options.testHooks?.afterRecoveryGuardVerified?.();
    const quarantine = recoveryQuarantinePath(paths);
    try {
      await rename(paths.recoveryGuard, quarantine);
      await fsyncDirectory(dirname(paths.recoveryGuard));
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        throw new Error("El cambio está bloqueado por otro proceso");
      }
      throw error;
    }

    const moved = await readRegularFile(quarantine);
    if (moved === null || !bytesEqual(moved, existing)) {
      const primary = new Error("El cambio está bloqueado por otro proceso");
      try {
        await restoreQuarantinedGuard(paths, quarantine);
      } catch (cleanupError) {
        combinePrimaryAndCleanup(primary, cleanupError);
      }
      throw primary;
    }

    await removeFileAtomically(quarantine);
  }

  async function acquireRecoveryGuard(paths: IngestPaths): Promise<Uint8Array> {
    const guardOwner: LockOwner = {
      pid: process.pid,
      hostname: hostname(),
      createdAt: timestamp(now),
      token: randomUUID(),
    };
    const guardBytes = new TextEncoder().encode(canonicalJson(guardOwner));
    try {
      await createExclusiveOwnerFile(paths.recoveryGuard, guardBytes);
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      await reclaimStaleRecoveryGuard(paths);
      try {
        await createExclusiveOwnerFile(paths.recoveryGuard, guardBytes);
      } catch (retryError: unknown) {
        if (isNodeError(retryError, "EEXIST")) {
          throw new Error("El cambio está bloqueado por otro proceso");
        }
        throw retryError;
      }
    }
    return guardBytes;
  }

  async function acquireLock(paths: IngestPaths): Promise<AcquiredLock> {
    let guardBytes: Uint8Array | undefined;
    let acquired: AcquiredLock | undefined;
    let failed = false;
    let primary: unknown;
    try {
      guardBytes = await acquireRecoveryGuard(paths);
      await options.testHooks?.afterRecoveryGuardAcquired?.();
      acquired = await acquireLockUnderGuard(paths);
    } catch (error) {
      failed = true;
      primary = error;
    }

    if (guardBytes !== undefined) {
      try {
        await removeOwnedLock(paths.recoveryGuard, guardBytes);
      } catch (guardCleanupError) {
        if (acquired !== undefined) {
          try {
            await removeOwnedLock(paths.lock, acquired.ownerBytes);
          } catch (lockCleanupError) {
            throw new AggregateError(
              [guardCleanupError, lockCleanupError],
              "No se pudo liberar la guardia de adquisición ni su lock asociado",
            );
          }
        }
        if (failed) {
          combinePrimaryAndCleanup(primary, guardCleanupError);
        }
        throw guardCleanupError;
      }
    }

    if (failed) {
      throw primary;
    }
    return acquired as AcquiredLock;
  }

  async function withChangeLock<T>(
    changeId: string,
    fn: () => Promise<T>,
    afterPendingRecovery?: () => Promise<T>,
  ): Promise<T> {
    const paths = await pathsFor(changeId);
    const acquired = await acquireLock(paths);
    let result: T | undefined;
    let failed = false;
    let primary: unknown;
    try {
      result = await fn();
      if (acquired.recoveryPending && (await readState(paths)) !== null) {
        await recordLockRecovery(paths);
        if (afterPendingRecovery !== undefined) {
          result = await afterPendingRecovery();
        }
      }
    } catch (error) {
      failed = true;
      primary = error;
    }
    try {
      await removeOwnedLock(paths.lock, acquired.ownerBytes);
    } catch (cleanupError) {
      if (failed) {
        combinePrimaryAndCleanup(primary, cleanupError);
      }
      throw cleanupError;
    }
    if (failed) {
      throw primary;
    }
    return result as T;
  }

  async function readChange(changeId: string): Promise<ChangeRecord> {
    const paths = await pathsFor(changeId);
    const record = await readState(paths);
    if (record === null) {
      throw new Error("El estado del cambio no existe");
    }
    await verifyJournalFor(paths, record);
    return record;
  }

  async function transition(
    changeId: string,
    event: TransitionEvent,
  ): Promise<ChangeRecord> {
    return withChangeLock(
      changeId,
      async () => {
        const paths = await pathsFor(changeId);
        const previous = await readState(paths);
        return persistTransition(paths, previous, event);
      },
      async () => readChange(changeId),
    );
  }

  async function retryChange(changeId: string): Promise<ChangeRecord> {
    return withChangeLock(changeId, async () => {
      const paths = await pathsFor(changeId);
      const previous = await readChange(changeId);
      if (previous.state !== "failed" && previous.state !== "rejected") {
        throw new TypeError(
          "Solo se puede reintentar un cambio failed o rejected",
        );
      }
      const at = timestamp(now);
      const events = await verifyJournalFor(paths, previous);
      const next: ChangeRecord = {
        ...previous,
        state: previous.resumeState,
        revision: previous.revision + 1,
        attemptNumber: previous.attemptNumber + 1,
        currentAttemptId: attemptId(previous.attemptNumber + 1),
        updatedAt: at,
      };
      const journalEvent = createJournalEvent({
        sequence: next.revision,
        at,
        type: "retry",
        from: previous.state,
        to: next.state,
        payloadSha256: sha256Canonical({ attemptNumber: next.attemptNumber }),
        previousEventSha256: events.at(-1)?.eventSha256 ?? null,
      });
      const previousJournal = serializeJournal(events);
      await atomicWriter(
        paths.journal,
        serializeJournal([...events, journalEvent]),
      );
      try {
        await atomicWriter(
          paths.state,
          new TextEncoder().encode(canonicalJson(next)),
        );
      } catch (error) {
        try {
          await atomicWriter(paths.journal, previousJournal);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "No se pudo restaurar el journal tras fallar el reintento",
          );
        }
        throw error;
      }
      return next;
    });
  }

  async function verifyJournal(changeId: string): Promise<JournalEvent[]> {
    const paths = await pathsFor(changeId);
    return verifyJournalFor(paths);
  }

  return { withChangeLock, readChange, transition, retryChange, verifyJournal };
}

const defaultStore = createStateStore({ stateRoot: defaultStateRoot() });

export const withChangeLock = defaultStore.withChangeLock;
export const readChange = defaultStore.readChange;
export const transition = defaultStore.transition;
export const retryChange = defaultStore.retryChange;
export const verifyJournal = defaultStore.verifyJournal;
