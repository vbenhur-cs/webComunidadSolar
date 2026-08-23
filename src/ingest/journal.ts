import { canonicalJson, sha256Canonical } from "./canonical-json.ts";
import {
  allowedTransition,
  type ChangeState,
  type JournalEvent,
} from "./domain.ts";

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

const resumeStates = new Set<ChangeState>([
  "received",
  "normalized",
  "planned",
  "gate1_approved",
]);

const hashPattern = /^[a-f0-9]{64}$/;
const eventTypePattern = /^[a-z][a-z0-9-]{0,63}$/;
const journalKeys = [
  "at",
  "eventSha256",
  "from",
  "payloadSha256",
  "previousEventSha256",
  "sequence",
  "to",
  "type",
] as const;

export interface JournalEventDraft {
  sequence: number;
  at: string;
  type: string;
  from: ChangeState | null;
  to: ChangeState;
  payloadSha256: string;
  previousEventSha256: string | null;
}

function unsignedEvent(event: JournalEventDraft): JournalEventDraft {
  return {
    sequence: event.sequence,
    at: event.at,
    type: event.type,
    from: event.from,
    to: event.to,
    payloadSha256: event.payloadSha256,
    previousEventSha256: event.previousEventSha256,
  };
}

function eventHash(event: JournalEventDraft): string {
  return sha256Canonical(unsignedEvent(event));
}

function isChangeState(value: unknown): value is ChangeState {
  return typeof value === "string" && states.has(value as ChangeState);
}

function isJournalEvent(value: unknown): value is JournalEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== journalKeys.length ||
    keys.some((key, index) => key !== journalKeys[index])
  ) {
    return false;
  }
  const event = value as Partial<JournalEvent>;
  return (
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.at === "string" &&
    Number.isFinite(Date.parse(event.at)) &&
    typeof event.type === "string" &&
    eventTypePattern.test(event.type) &&
    (event.from === null || isChangeState(event.from)) &&
    isChangeState(event.to) &&
    typeof event.payloadSha256 === "string" &&
    hashPattern.test(event.payloadSha256) &&
    (event.previousEventSha256 === null ||
      (typeof event.previousEventSha256 === "string" &&
        hashPattern.test(event.previousEventSha256))) &&
    typeof event.eventSha256 === "string" &&
    hashPattern.test(event.eventSha256)
  );
}

function assertTransitionShape(
  event: JournalEvent,
  previous: JournalEvent | null,
): void {
  if (event.sequence !== (previous?.sequence ?? 0) + 1) {
    throw new TypeError("La secuencia del journal no es continua");
  }
  if (event.previousEventSha256 !== (previous?.eventSha256 ?? null)) {
    throw new TypeError("La cadena de hashes del journal está rota");
  }
  if (previous === null) {
    if (
      event.from !== null ||
      event.to !== "received" ||
      event.type === "retry" ||
      event.type === "lock-recovered"
    ) {
      throw new TypeError("El journal debe iniciar en received");
    }
    return;
  }
  if (event.from !== previous.to) {
    throw new TypeError("La cadena de estados del journal está rota");
  }
  if (event.type === "lock-recovered") {
    if (event.to !== event.from) {
      throw new TypeError("La recuperación de lock no puede cambiar el estado");
    }
    return;
  }
  if (event.type === "retry") {
    if (
      (event.from !== "failed" && event.from !== "rejected") ||
      !resumeStates.has(event.to)
    ) {
      throw new TypeError("El reintento del journal no es válido");
    }
    return;
  }
  if (!allowedTransition(event.from, event.to)) {
    throw new TypeError("La transición del journal no está permitida");
  }
}

export function createJournalEvent(draft: JournalEventDraft): JournalEvent {
  if (
    !Number.isSafeInteger(draft.sequence) ||
    draft.sequence < 1 ||
    !isChangeState(draft.to) ||
    (draft.from !== null && !isChangeState(draft.from)) ||
    !eventTypePattern.test(draft.type) ||
    !hashPattern.test(draft.payloadSha256) ||
    (draft.previousEventSha256 !== null &&
      !hashPattern.test(draft.previousEventSha256))
  ) {
    throw new TypeError("El evento de journal no es válido");
  }
  return { ...unsignedEvent(draft), eventSha256: eventHash(draft) };
}

export function verifyJournalEvents(
  events: readonly unknown[],
): JournalEvent[] {
  let previous: JournalEvent | null = null;
  const verified: JournalEvent[] = [];

  for (const value of events) {
    if (!isJournalEvent(value)) {
      throw new TypeError("El evento del journal no tiene el formato canónico");
    }
    const event = value;
    assertTransitionShape(event, previous);
    if (event.eventSha256 !== eventHash(unsignedEvent(event))) {
      throw new TypeError("La cadena de hashes del journal está rota");
    }
    verified.push(event);
    previous = event;
  }
  return verified;
}

export function serializeJournal(events: readonly JournalEvent[]): Uint8Array {
  return new TextEncoder().encode(
    events.map((event) => canonicalJson(event)).join("\n") +
      (events.length > 0 ? "\n" : ""),
  );
}

export function parseJournal(serialized: string): unknown[] {
  if (serialized.length === 0) {
    return [];
  }
  if (!serialized.endsWith("\n")) {
    throw new TypeError("El journal está truncado");
  }
  const lines = serialized.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new TypeError("El journal contiene líneas vacías");
  }
  try {
    return lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new TypeError("El journal no contiene JSON válido");
  }
}
