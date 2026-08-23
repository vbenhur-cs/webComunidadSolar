import { createHash } from "node:crypto";

function unsupported(type: string): never {
  throw new TypeError(`El JSON canónico no admite ${type}`);
}

function dataPropertyValue(
  descriptor: PropertyDescriptor | undefined,
): unknown {
  if (descriptor === undefined) {
    return unsupported("propiedades ausentes");
  }
  if (!Object.hasOwn(descriptor, "value")) {
    return unsupported("propiedades de acceso");
  }
  return descriptor.value;
}

function arrayIndex(key: string): number | null {
  const index = Number(key);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= 2 ** 32 - 1 ||
    String(index) !== key
  ) {
    return null;
  }
  return index;
}

function serializeArray(value: unknown[], ancestors: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value);
  let length: number | null = null;

  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      return unsupported("símbolos");
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const propertyValue = dataPropertyValue(descriptor);
    if (key === "length") {
      if (
        typeof propertyValue !== "number" ||
        !Number.isInteger(propertyValue) ||
        propertyValue < 0
      ) {
        return unsupported("longitudes de arrays");
      }
      length = propertyValue;
      continue;
    }

    const index = arrayIndex(key);
    if (index === null || (length !== null && index >= length)) {
      return unsupported("propiedades de arrays");
    }
    if (descriptor?.enumerable !== true) {
      return unsupported("propiedades no enumerables");
    }
  }

  if (length === null) {
    return unsupported("longitudes de arrays");
  }

  const items: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const item = dataPropertyValue(descriptor);
    if (descriptor?.enumerable !== true) {
      return unsupported("propiedades no enumerables");
    }
    items.push(serializeCanonical(item, ancestors));
  }
  return `[${items.join(",")}]`;
}

function serializeObject(value: object, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return unsupported("objetos no planos");
  }

  const properties = Reflect.ownKeys(value).map((key) => {
    if (typeof key === "symbol") {
      return unsupported("símbolos");
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const propertyValue = dataPropertyValue(descriptor);
    if (descriptor?.enumerable !== true) {
      return unsupported("propiedades no enumerables");
    }
    return [key, propertyValue] as const;
  });

  return `{${properties
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, propertyValue]) =>
        `${JSON.stringify(key)}:${serializeCanonical(propertyValue, ancestors)}`,
    )
    .join(",")}}`;
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        return unsupported("números no finitos");
      }
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return unsupported(typeof value);
    case "object":
      break;
    default:
      return unsupported(typeof value);
  }

  if (ancestors.has(value)) {
    return unsupported("ciclos");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return serializeArray(value, ancestors);
    }
    return serializeObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set());
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
