import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import type {
  ChangeRecord,
  JournalEvent,
  TransitionEvent,
} from "../../src/ingest/domain.ts";
import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import {
  createJournalEvent,
  serializeJournal,
  verifyJournalEvents,
} from "../../src/ingest/journal.ts";
import { ingestPaths } from "../../src/ingest/paths.ts";
import { createStateStore, writeAtomic } from "../../src/ingest/state-store.ts";

const changeId = "landing-solar";
const startedAt = "2026-08-23T12:00:00.000Z";
const laterAt = "2026-08-23T12:31:00.000Z";
const execFileAsync = promisify(execFile);

type Store = ReturnType<typeof createStateStore>;

function event(
  type: string,
  to: TransitionEvent["to"],
  payload: unknown = { fixture: true },
): TransitionEvent {
  return { type, to, payload };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function withStore(
  run: (context: {
    root: string;
    stateRoot: string;
    store: Store;
    setNow(value: string): void;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-state-store-"));
  const stateRoot = join(root, ".change-state");
  let now = startedAt;
  const store = createStateStore({
    stateRoot,
    now: () => new Date(now),
    hostname: () => "fixture-host",
    isPidAlive: () => false,
  });

  try {
    await run({
      root,
      stateRoot,
      store,
      setNow(value) {
        now = value;
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function writeJournal(
  path: string,
  events: JournalEvent[],
): Promise<void> {
  await writeFile(
    path,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

test("creates the first received record and only permits adjacent transitions", async () => {
  await withStore(async ({ store }) => {
    const created = await store.transition(
      changeId,
      event("request-received", "received"),
    );

    assert.deepEqual(created, {
      schemaVersion: 1,
      changeId,
      state: "received",
      revision: 1,
      attemptNumber: 1,
      currentAttemptId: "attempt-000001",
      resumeState: "received",
      createdAt: startedAt,
      updatedAt: startedAt,
    } satisfies ChangeRecord);
    assert.deepEqual(await store.readChange(changeId), created);

    await assert.rejects(
      store.transition(changeId, event("skip", "planned")),
      /transici[oó]n|estado/i,
    );
    await assert.rejects(
      store.transition(changeId, event("lock-recovered", "received")),
      /transici[oó]n|estado/i,
    );

    const normalized = await store.transition(
      changeId,
      event("normalized", "normalized"),
    );
    assert.equal(normalized.revision, 2);
    assert.equal(normalized.resumeState, "normalized");
  });
});

test("reserves retry transitions for retryChange without mutating durable state", async () => {
  await withStore(async ({ store, stateRoot }) => {
    await store.transition(changeId, event("request-received", "received"));
    const paths = await ingestPaths(changeId, { stateRoot });
    const stateBefore = new Uint8Array(await readFile(paths.state));
    const journalBefore = new Uint8Array(await readFile(paths.journal));

    await assert.rejects(
      store.transition(changeId, event("retry", "normalized")),
      /retry|reintento|reservad/i,
    );

    assert.deepEqual(new Uint8Array(await readFile(paths.state)), stateBefore);
    assert.deepEqual(
      new Uint8Array(await readFile(paths.journal)),
      journalBefore,
    );
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  });
});

test("rejects an invalid first transition instead of inventing state", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.transition(changeId, event("unsafe\nname", "received")),
      /tipo/i,
    );
    await assert.rejects(
      store.transition(changeId, event("skip", "normalized")),
      /received|inicial/i,
    );
    await assert.rejects(store.readChange(changeId), /no existe|estado/i);
  });
});

test("the store owns event timestamps and persists only a canonical payload hash", async () => {
  await withStore(async ({ store, stateRoot }) => {
    const payload = { marker: "synthetic-payload-marker" };
    await store.transition(changeId, {
      ...event("request-received", "received", payload),
      at: "1999-01-01T00:00:00.000Z",
    } as TransitionEvent);

    const paths = await ingestPaths(changeId, { stateRoot });
    const [journalEvent] = await store.verifyJournal(changeId);
    assert.equal(journalEvent.at, startedAt);
    assert.equal(journalEvent.payloadSha256, sha256Canonical(payload));
    assert.doesNotMatch(
      await readFile(paths.journal, "utf8"),
      /synthetic-payload-marker/i,
    );
  });
});

test("rolls back a journal write when the following state snapshot write fails", async () => {
  await withStore(async ({ stateRoot }) => {
    let failStateWrite = false;
    const store = createStateStore({
      stateRoot,
      now: () => new Date(startedAt),
      hostname: () => "fixture-host",
      isPidAlive: () => false,
      atomicWriter: async (path: string, bytes: Uint8Array) => {
        if (failStateWrite && path.endsWith("/state.json")) {
          throw new Error("synthetic state snapshot failure");
        }
        await writeAtomic(path, bytes);
      },
    });
    await store.transition(changeId, event("request-received", "received"));
    failStateWrite = true;

    await assert.rejects(
      store.transition(changeId, event("normalized", "normalized")),
      /synthetic state snapshot failure/i,
    );

    const paths = await ingestPaths(changeId, { stateRoot });
    const restored = await store.readChange(changeId);
    assert.equal(restored.state, "received");
    assert.equal(restored.revision, 1);
    assert.equal((await store.verifyJournal(changeId)).length, 1);
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(paths.changeDir)).filter((entry) =>
        entry.startsWith(".tmp-"),
      ),
      [],
    );
  });
});

test("fails closed on either crash boundary between journal and state snapshots", async () => {
  await withStore(async ({ stateRoot }) => {
    const journalFirst = "journal-first";
    const stateFirst = "state-first";
    const store = createStateStore({
      stateRoot,
      now: () => new Date(startedAt),
      hostname: () => "fixture-host",
      isPidAlive: () => false,
    });

    await store.transition(journalFirst, event("request-received", "received"));
    const journalFirstPaths = await ingestPaths(journalFirst, { stateRoot });
    const [firstEvent] = await store.verifyJournal(journalFirst);
    const afterJournal = createJournalEvent({
      sequence: 2,
      at: laterAt,
      type: "normalized",
      from: "received",
      to: "normalized",
      payloadSha256: sha256Canonical({ fixture: "crash-boundary" }),
      previousEventSha256: firstEvent.eventSha256,
    });
    await writeAtomic(
      journalFirstPaths.journal,
      serializeJournal([firstEvent, afterJournal]),
    );
    await assert.rejects(
      store.readChange(journalFirst),
      /truncad|revisi[oó]n|estado.*journal/i,
    );

    await store.transition(stateFirst, event("request-received", "received"));
    const stateFirstPaths = await ingestPaths(stateFirst, { stateRoot });
    const current = await store.readChange(stateFirst);
    await writeAtomic(
      stateFirstPaths.state,
      new TextEncoder().encode(
        JSON.stringify({
          ...current,
          state: "normalized",
          revision: 2,
          resumeState: "normalized",
          updatedAt: laterAt,
        }),
      ),
    );
    await assert.rejects(
      store.readChange(stateFirst),
      /truncad|revisi[oó]n|estado.*journal/i,
    );
  });
});

test("does not overwrite an orphaned journal after a crash before state.json", async () => {
  await withStore(async ({ store, stateRoot }) => {
    const paths = await ingestPaths(changeId, { stateRoot });
    const orphan = createJournalEvent({
      sequence: 1,
      at: startedAt,
      type: "request-received",
      from: null,
      to: "received",
      payloadSha256: sha256Canonical({ fixture: "orphaned-journal" }),
      previousEventSha256: null,
    });
    const before = serializeJournal([orphan]);
    await writeFile(paths.journal, before);

    await assert.rejects(
      store.transition(changeId, event("request-received", "received")),
      /journal.*estado|sobrescribirse/i,
    );

    assert.deepEqual(new Uint8Array(await readFile(paths.journal)), before);
    await assert.rejects(lstat(paths.state), { code: "ENOENT" });
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(paths.changeDir)).filter((entry) =>
        entry.startsWith(".tmp-"),
      ),
      [],
    );
  });
});

test("rejects reserved retry and recovery types as the first journal event", () => {
  for (const type of ["retry", "lock-recovered"]) {
    const initial = createJournalEvent({
      sequence: 1,
      at: startedAt,
      type,
      from: null,
      to: "received",
      payloadSha256: sha256Canonical({ fixture: type }),
      previousEventSha256: null,
    });
    assert.throws(
      () => verifyJournalEvents([initial]),
      /iniciar|reintento|recuperaci[oó]n/i,
    );
  }
});

test("serializes one local change lock and retains remote or live stale locks", async () => {
  await withStore(async ({ store, stateRoot, setNow }) => {
    await store.transition(changeId, event("request-received", "received"));

    await store.withChangeLock(changeId, async () => {
      await assert.rejects(
        store.withChangeLock(changeId, async () => undefined),
        /bloqueado por otro proceso/i,
      );
    });

    const paths = await ingestPaths(changeId, { stateRoot });
    const stale = JSON.stringify({
      pid: 101,
      hostname: "fixture-host",
      createdAt: startedAt,
    });
    await writeFile(paths.lock, stale, "utf8");
    setNow(laterAt);

    await store.withChangeLock(changeId, async () => undefined);
    assert.equal(
      (await store.verifyJournal(changeId)).at(-1)?.type,
      "lock-recovered",
    );

    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 101,
        hostname: "another-host",
        createdAt: startedAt,
      }),
      "utf8",
    );
    await assert.rejects(
      store.withChangeLock(changeId, async () => undefined),
      /bloqueado por otro proceso/i,
    );
    assert.equal((await lstat(paths.lock)).isFile(), true);
  });
});

test("a stale pre-initial lock is journaled after the valid received transition", async () => {
  await withStore(async ({ store, stateRoot, setNow }) => {
    const paths = await ingestPaths(changeId, { stateRoot });
    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
      }),
      "utf8",
    );
    setNow(laterAt);

    const record = await store.transition(
      changeId,
      event("request-received", "received"),
    );
    const events = await store.verifyJournal(changeId);
    assert.equal(record.revision, 2);
    assert.deepEqual(
      events.map((journalEvent) => journalEvent.type),
      ["request-received", "lock-recovered"],
    );
  });
});

test("serializes two stale recoverers before either callback can enter", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-recovery-race-"));
  const stateRoot = join(root, ".change-state");
  const staleVerified = deferred();
  const resumeFirstRecovery = deferred();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const callbacks: string[] = [];
  const sharedOptions = {
    stateRoot,
    now: () => new Date(laterAt),
    hostname: () => "fixture-host",
    isPidAlive: (pid: number) => pid === process.pid,
  };
  const firstStore = createStateStore({
    ...sharedOptions,
    testHooks: {
      afterStaleLockVerified: async () => {
        staleVerified.resolve();
        await resumeFirstRecovery.promise;
      },
    },
  });
  const secondStore = createStateStore(sharedOptions);
  const paths = await ingestPaths(changeId, { stateRoot });
  let recoveredFirst: Promise<void> | undefined;

  try {
    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
      }),
      "utf8",
    );
    recoveredFirst = firstStore.withChangeLock(changeId, async () => {
      callbacks.push("first");
      firstEntered.resolve();
      await releaseFirst.promise;
    });

    await within(
      staleVerified.promise,
      250,
      "the first recoverer did not reach the verified stale-lock boundary",
    );
    const second = secondStore.withChangeLock(changeId, async () => {
      callbacks.push("second");
    });

    await assert.rejects(second, /bloqueado por otro proceso/i);
    assert.deepEqual(callbacks, []);

    resumeFirstRecovery.resolve();
    await within(firstEntered.promise, 250, "the first callback did not enter");
    assert.deepEqual(callbacks, ["first"]);
    releaseFirst.resolve();
    await recoveredFirst;

    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
    await assert.rejects(lstat(paths.recoveryGuard), {
      code: "ENOENT",
    });
  } finally {
    resumeFirstRecovery.resolve();
    releaseFirst.resolve();
    await recoveredFirst?.catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

test("cleans the acquisition guard when stale recovery fails before replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-recovery-fail-"));
  const stateRoot = join(root, ".change-state");
  const paths = await ingestPaths(changeId, { stateRoot });
  const recoveryGuard = paths.recoveryGuard;
  let guardSeen = false;
  const store = createStateStore({
    stateRoot,
    now: () => new Date(laterAt),
    hostname: () => "fixture-host",
    isPidAlive: () => false,
    testHooks: {
      afterStaleLockVerified: async () => {
        guardSeen = (await lstat(recoveryGuard)).isFile();
        throw new Error("synthetic stale recovery failure");
      },
    },
  });

  try {
    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
      }),
      "utf8",
    );

    await assert.rejects(
      store.withChangeLock(changeId, async () => undefined),
      /synthetic stale recovery failure/i,
    );
    assert.equal(guardSeen, true);
    assert.equal((await lstat(paths.lock)).isFile(), true);
    await assert.rejects(lstat(recoveryGuard), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("keeps live and remote recovery guards fail closed without probing a remote PID", async () => {
  await withStore(async ({ stateRoot, setNow }) => {
    const paths = await ingestPaths(changeId, { stateRoot });
    setNow(laterAt);
    let localProbes = 0;
    const localStore = createStateStore({
      stateRoot,
      now: () => new Date(laterAt),
      hostname: () => "fixture-host",
      isPidAlive: () => {
        localProbes += 1;
        return true;
      },
    });
    await writeFile(
      paths.recoveryGuard,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
      }),
      "utf8",
    );

    await assert.rejects(
      localStore.withChangeLock(changeId, async () => undefined),
      /bloqueado por otro proceso/i,
    );
    assert.equal(localProbes, 1);
    assert.equal((await lstat(paths.recoveryGuard)).isFile(), true);

    await unlink(paths.recoveryGuard);
    const remoteStore = createStateStore({
      stateRoot,
      now: () => new Date(laterAt),
      hostname: () => "fixture-host",
      isPidAlive: () => {
        throw new Error("a remote recovery-guard PID must not be probed");
      },
    });
    await writeFile(
      paths.recoveryGuard,
      JSON.stringify({
        pid: 101,
        hostname: "remote-host",
        createdAt: startedAt,
      }),
      "utf8",
    );

    await assert.rejects(
      remoteStore.withChangeLock(changeId, async () => undefined),
      /bloqueado por otro proceso/i,
    );
    assert.equal((await lstat(paths.recoveryGuard)).isFile(), true);
  });
});

test("reclaims only a stale local recovery guard and leaves no lock residue", async () => {
  await withStore(async ({ stateRoot, setNow }) => {
    const paths = await ingestPaths(changeId, { stateRoot });
    setNow(laterAt);
    await writeFile(
      paths.recoveryGuard,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
      }),
      "utf8",
    );
    let entered = 0;
    const store = createStateStore({
      stateRoot,
      now: () => new Date(laterAt),
      hostname: () => "fixture-host",
      isPidAlive: () => false,
    });

    await store.withChangeLock(changeId, async () => {
      entered += 1;
    });

    assert.equal(entered, 1);
    await assert.rejects(lstat(paths.recoveryGuard), { code: "ENOENT" });
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  });
});

test("reclaims a recovery guard left by an abruptly exited local process", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-recovery-crash-"));
  const stateRoot = join(root, ".change-state");
  const marker = join(root, "guard-acquired");
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");

  try {
    await execFileAsync(
      tsx,
      [
        "tests/fixtures/ingestion/recovery-guard-crash.ts",
        stateRoot,
        marker,
        startedAt,
      ],
      { cwd: process.cwd(), timeout: 15_000 },
    );
    assert.equal((await lstat(marker)).isFile(), true);
    const paths = await ingestPaths(changeId, { stateRoot });
    assert.equal((await lstat(paths.recoveryGuard)).isFile(), true);

    let entered = 0;
    const store = createStateStore({
      stateRoot,
      now: () => new Date(laterAt),
    });
    await store.withChangeLock(changeId, async () => {
      entered += 1;
    });

    assert.equal(entered, 1);
    await assert.rejects(lstat(paths.recoveryGuard), { code: "ENOENT" });
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("restores a replaced recovery guard instead of deleting it by path", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-guard-replace-"));
  const stateRoot = join(root, ".change-state");
  const paths = await ingestPaths(changeId, { stateRoot });
  const firstVerified = deferred();
  const secondVerified = deferred();
  const resumeFirst = deferred();
  const resumeSecond = deferred();
  const firstGuardAcquired = deferred();
  const releaseFirstGuard = deferred();
  const common = {
    stateRoot,
    now: () => new Date(laterAt),
    hostname: () => "fixture-host",
    isPidAlive: () => false,
  };
  let firstGuardBytes: Uint8Array | undefined;
  const first = createStateStore({
    ...common,
    testHooks: {
      afterRecoveryGuardVerified: async () => {
        firstVerified.resolve();
        await resumeFirst.promise;
      },
      afterRecoveryGuardAcquired: async () => {
        firstGuardBytes = new Uint8Array(await readFile(paths.recoveryGuard));
        firstGuardAcquired.resolve();
        await releaseFirstGuard.promise;
      },
    },
  });
  const second = createStateStore({
    ...common,
    testHooks: {
      afterRecoveryGuardVerified: async () => {
        secondVerified.resolve();
        await resumeSecond.promise;
      },
    },
  });
  let firstRun: Promise<void> | undefined;
  let secondRun: Promise<void> | undefined;

  try {
    await writeFile(
      paths.recoveryGuard,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
      }),
      "utf8",
    );
    firstRun = first.withChangeLock(changeId, async () => undefined);
    await within(
      firstVerified.promise,
      250,
      "first recovery guard was not read",
    );

    secondRun = second.withChangeLock(changeId, async () => undefined);
    await within(
      secondVerified.promise,
      250,
      "second recovery guard was not read",
    );

    resumeFirst.resolve();
    await within(
      firstGuardAcquired.promise,
      250,
      "first replacement guard was not acquired",
    );
    resumeSecond.resolve();
    await assert.rejects(secondRun, /bloqueado por otro proceso/i);
    assert.deepEqual(
      new Uint8Array(await readFile(paths.recoveryGuard)),
      firstGuardBytes,
    );

    releaseFirstGuard.resolve();
    await firstRun;
    await assert.rejects(lstat(paths.recoveryGuard), { code: "ENOENT" });
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  } finally {
    resumeFirst.resolve();
    resumeSecond.resolve();
    releaseFirstGuard.resolve();
    await firstRun?.catch(() => undefined);
    await secondRun?.catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

test("releases its lock and preserves even an undefined callback rejection", async () => {
  await withStore(async ({ store, stateRoot }) => {
    const outcome = await store
      .withChangeLock(changeId, async () => Promise.reject(undefined))
      .then(
        () => "resolved",
        () => "rejected",
      );
    assert.equal(outcome, "rejected");

    const paths = await ingestPaths(changeId, { stateRoot });
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  });
});

test("fails closed when its owned lock disappears before release", async () => {
  await withStore(async ({ store, stateRoot }) => {
    await assert.rejects(
      store.withChangeLock(changeId, async () => {
        const paths = await ingestPaths(changeId, { stateRoot });
        await unlink(paths.lock);
      }),
      /lock propio.*desapareci[oó]/i,
    );

    const paths = await ingestPaths(changeId, { stateRoot });
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  });
});

test("fails closed for malformed and locally-live stale lock owners", async () => {
  await withStore(async ({ store, stateRoot, setNow }) => {
    await store.transition(changeId, event("request-received", "received"));
    const paths = await ingestPaths(changeId, { stateRoot });
    setNow(laterAt);

    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
        unexpected: true,
      }),
      "utf8",
    );
    await assert.rejects(
      store.withChangeLock(changeId, async () => undefined),
      /propietario v[aá]lido|bloqueado/i,
    );
    assert.equal((await lstat(paths.lock)).isFile(), true);
    await unlink(paths.lock);

    const liveStore = createStateStore({
      stateRoot,
      now: () => new Date(laterAt),
      hostname: () => "fixture-host",
      isPidAlive: () => true,
    });
    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 101,
        hostname: "fixture-host",
        createdAt: startedAt,
      }),
      "utf8",
    );
    await assert.rejects(
      liveStore.withChangeLock(changeId, async () => undefined),
      /bloqueado por otro proceso/i,
    );
    assert.equal((await lstat(paths.lock)).isFile(), true);
  });
});

test("does not probe a remote host PID while deciding whether a lock is stale", async () => {
  await withStore(async ({ stateRoot, setNow }) => {
    const store = createStateStore({
      stateRoot,
      now: () => new Date(laterAt),
      hostname: () => "fixture-host",
      isPidAlive: () => {
        throw new Error("a remote PID must never be probed locally");
      },
    });
    await store.transition(changeId, event("request-received", "received"));
    const paths = await ingestPaths(changeId, { stateRoot });
    setNow(laterAt);
    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 101,
        hostname: "remote-host",
        createdAt: startedAt,
      }),
      "utf8",
    );

    await assert.rejects(
      store.withChangeLock(changeId, async () => undefined),
      /bloqueado por otro proceso/i,
    );
  });
});

test("retry creates a new attempt and returns only to the recorded checkpoint", async () => {
  await withStore(async ({ store }) => {
    await store.transition(changeId, event("request-received", "received"));
    await store.transition(changeId, event("normalized", "normalized"));
    const failed = await store.transition(
      changeId,
      event("planner-failed", "failed", { reason: "synthetic" }),
    );
    assert.equal(failed.resumeState, "normalized");

    const retried = await store.retryChange(changeId);
    assert.equal(retried.state, "normalized");
    assert.equal(retried.resumeState, "normalized");
    assert.equal(retried.attemptNumber, 2);
    assert.equal(retried.currentAttemptId, "attempt-000002");
    assert.equal(retried.revision, 4);
    assert.equal((await store.verifyJournal(changeId)).at(-1)?.type, "retry");

    await assert.rejects(
      store.retryChange(changeId),
      /failed|rejected|reintento/i,
    );
  });
});

test("retry preserves the latest permitted checkpoint rather than an arbitrary state", async () => {
  await withStore(async ({ store }) => {
    const checkpointChange = "checkpoint-solar";
    await store.transition(
      checkpointChange,
      event("request-received", "received"),
    );
    await store.transition(checkpointChange, event("normalized", "normalized"));
    await store.transition(checkpointChange, event("planned", "planned"));
    await store.transition(
      checkpointChange,
      event("gate1-approved", "gate1_approved"),
    );
    await store.transition(checkpointChange, event("generated", "generated"));
    await store.transition(
      checkpointChange,
      event("generation-failed", "failed"),
    );

    const retried = await store.retryChange(checkpointChange);
    assert.equal(retried.state, "gate1_approved");
    assert.equal(retried.resumeState, "gate1_approved");
    assert.equal(retried.currentAttemptId, "attempt-000002");
  });
});

test("retry also gives a rejected change a fresh attempt at its retained checkpoint", async () => {
  await withStore(async ({ store }) => {
    const rejectedChange = "rejected-solar";
    await store.transition(
      rejectedChange,
      event("request-received", "received"),
    );
    await store.transition(rejectedChange, event("rejected", "rejected"));

    const retried = await store.retryChange(rejectedChange);
    assert.equal(retried.state, "received");
    assert.equal(retried.attemptNumber, 2);
  });
});

test("detects tampering, truncation, and non-sequential journal entries before reads", async () => {
  await withStore(async ({ store, stateRoot }) => {
    await store.transition(changeId, event("request-received", "received"));
    await store.transition(changeId, event("normalized", "normalized"));
    const paths = await ingestPaths(changeId, { stateRoot });
    const events = await store.verifyJournal(changeId);

    const tampered = structuredClone(events);
    tampered[0].type = "modified";
    await writeJournal(paths.journal, tampered);
    await assert.rejects(store.verifyJournal(changeId), /cadena de hashes/i);
    await assert.rejects(store.readChange(changeId), /cadena de hashes/i);

    await writeJournal(paths.journal, events);
    await writeJournal(paths.journal, events.slice(0, 1));
    await assert.rejects(store.verifyJournal(changeId), /truncad|revisi[oó]n/i);

    await writeJournal(paths.journal, events);
    const wrongSequence = structuredClone(events);
    wrongSequence[1].sequence = 9;
    await writeJournal(paths.journal, wrongSequence);
    await assert.rejects(store.verifyJournal(changeId), /secuencia/i);

    await writeJournal(paths.journal, events);
    const record = JSON.parse(
      await readFile(paths.state, "utf8"),
    ) as ChangeRecord;
    record.resumeState = "received";
    await writeFile(paths.state, JSON.stringify(record), "utf8");
    await assert.rejects(
      store.readChange(changeId),
      /estado.*journal|journal.*estado/i,
    );
  });
});

test("rejects symlink escapes and leaves no temporary atomic files", async () => {
  await withStore(async ({ root, stateRoot, store }) => {
    await mkdir(stateRoot, { recursive: true });
    const outside = await mkdtemp(
      join(tmpdir(), "comunidadsolar-state-outside-"),
    );
    const escapedChange = "escaped-state";

    try {
      await symlink(outside, join(stateRoot, escapedChange));
      await assert.rejects(
        store.transition(escapedChange, event("request-received", "received")),
        /simb[oó]lic|escape|segur/i,
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }

    const output = join(root, "atomic", "state.json");
    await writeAtomic(output, new TextEncoder().encode("first"));
    await writeAtomic(output, new TextEncoder().encode("second"));
    assert.equal(await readFile(output, "utf8"), "second");
    assert.deepEqual(
      (await readdir(dirname(output))).filter((entry) =>
        entry.startsWith(".tmp-"),
      ),
      [],
    );
  });
});

test("writeAtomic rejects an intermediate symlink before it can create outside state", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-atomic-symlink-"));
  const outside = await mkdtemp(
    join(tmpdir(), "comunidadsolar-atomic-outside-"),
  );

  try {
    const linkedParent = join(root, "linked-parent");
    await symlink(outside, linkedParent);

    await assert.rejects(
      writeAtomic(
        join(linkedParent, "nested", "state.json"),
        new TextEncoder().encode("must-not-escape"),
      ),
      /simb[oó]lic|segur/i,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("writeAtomic removes its durable temporary file when the pre-rename phase fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-atomic-cleanup-"));
  const output = join(root, "state.json");

  try {
    await assert.rejects(
      writeAtomic(output, new TextEncoder().encode("incomplete"), {
        beforeRename() {
          throw new Error("synthetic pre-rename failure");
        },
      }),
      /synthetic pre-rename failure/i,
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.startsWith(".tmp-")),
      [],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("concurrent atomic writers create a shared missing parent without mkdir races", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-atomic-race-"));
  const parent = join(root, "missing-parent");

  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeAtomic(
          join(parent, `state-${index}.json`),
          new TextEncoder().encode(String(index)),
        ),
      ),
    );
    assert.equal(
      (await readdir(parent)).filter((entry) => entry.endsWith(".json")).length,
      8,
    );
    assert.deepEqual(
      (await readdir(parent)).filter((entry) => entry.startsWith(".tmp-")),
      [],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("state paths reject candidate worktrees and direct or nested symlink roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-state-paths-"));
  const outside = await mkdtemp(
    join(tmpdir(), "comunidadsolar-state-paths-outside-"),
  );
  const safeRoot = join(root, ".change-state");

  try {
    await assert.rejects(
      ingestPaths(changeId, {
        stateRoot: join(root, ".agent-worktrees", "candidate", ".change-state"),
      }),
      /worktree de candidato/i,
    );

    await mkdir(join(root, "linked"), { recursive: true });
    await mkdir(safeRoot, { recursive: true });
    await symlink(safeRoot, join(root, "linked", ".change-state"));
    await assert.rejects(
      ingestPaths(changeId, {
        stateRoot: join(root, "linked", ".change-state"),
      }),
      /simb[oó]lic/i,
    );

    const paths = await ingestPaths(changeId, { stateRoot: safeRoot });
    await rm(paths.attemptsDir, { force: true, recursive: true });
    await symlink(outside, paths.attemptsDir);
    await assert.rejects(
      ingestPaths(changeId, { stateRoot: safeRoot }),
      /simb[oó]lic|escape/i,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("concurrent path admission creates one safe root without mkdir races", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-path-race-"));
  const stateRoot = join(root, ".change-state");

  try {
    const paths = await Promise.all(
      Array.from({ length: 8 }, () => ingestPaths(changeId, { stateRoot })),
    );
    assert.equal(new Set(paths.map((path) => path.changeDir)).size, 1);
    assert.equal((await lstat(paths[0].attemptsDir)).isDirectory(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("writes a local PID, host, and timestamp into a default lock owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-default-lock-"));
  const stateRoot = join(root, ".change-state");
  const store = createStateStore({ stateRoot });

  try {
    await store.withChangeLock(changeId, async () => {
      const paths = await ingestPaths(changeId, { stateRoot });
      const owner = JSON.parse(await readFile(paths.lock, "utf8")) as {
        createdAt: string;
        hostname: string;
        pid: number;
      };
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.hostname, hostname());
      assert.equal(Number.isFinite(Date.parse(owner.createdAt)), true);
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("stress fixture grants exactly one multiprocess lock owner and removes all lock residues", async () => {
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  const { stdout, stderr } = await execFileAsync(
    tsx,
    ["tests/fixtures/ingestion/stress-locks.ts"],
    {
      cwd: process.cwd(),
      timeout: 15_000,
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /^STRESS_LOCKS_OK owners=1 blocked=7 residue=0\n$/u);
});
