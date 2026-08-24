import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const fail = (message) => {
  throw new TypeError(message);
};

const identity = (entry) => ({
  device: String(entry.dev),
  inode: String(entry.ino),
});

const state = (entry) => ({
  ...identity(entry),
  mode: String(entry.mode),
  size: String(entry.size),
  mtimeNs: String(entry.mtimeNs),
  ctimeNs: String(entry.ctimeNs),
  nlink: String(entry.nlink),
});

const same = (left, right) =>
  Object.keys(left).every((key) => left[key] === right[key]);

const validName = (name) =>
  typeof name === "string" &&
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\0");

const expectedIdentity = (value) =>
  value && typeof value.device === "string" && typeof value.inode === "string"
    ? value
    : fail("La identidad esperada del scanner no es válida");

const checkIdentity = (entry, expected, kind) => {
  if (!same(identity(entry), expected))
    fail(`La identidad ${kind} del scanner cambió`);
};

const directory = async (expected) => {
  const named = await lstat(".");
  if (!named.isDirectory() || named.isSymbolicLink())
    fail("El cwd del scanner no es un directorio seguro");
  checkIdentity(named, expected, "del directorio");
  const handle = await open(
    ".",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory())
      fail("El descriptor del scanner no es directorio");
    checkIdentity(before, expected, "del directorio");
    const names = (await readdir(".")).sort();
    const entries = [];
    for (const name of names) {
      if (!validName(name)) fail("El scanner recibió un nombre inseguro");
      const entry = await lstat(name, { bigint: true });
      entries.push({
        name,
        type: entry.isDirectory()
          ? "D"
          : entry.isFile()
            ? "F"
            : entry.isSymbolicLink()
              ? "S"
              : "X",
        ...state(entry),
      });
    }
    const observed = (await readdir(".")).sort();
    const after = await handle.stat({ bigint: true });
    const finalNamed = await lstat(".");
    if (
      !same(state(before), state(after)) ||
      !same(identity(finalNamed), expected)
    )
      fail("La identidad del directorio de servicio cambió");
    if (
      names.length !== observed.length ||
      names.some((name, index) => name !== observed[index])
    )
      fail("La enumeración del directorio de servicio cambió");
    return { kind: "directory", directory: state(before), entries };
  } finally {
    await handle.close();
  }
};

const leaf = async (name, expected, cwdExpected, pause, nextLine) => {
  if (!validName(name)) fail("El scanner recibió un nombre inseguro");
  const cwd = await lstat(".");
  if (!cwd.isDirectory() || cwd.isSymbolicLink())
    fail("El cwd del scanner no es un directorio seguro");
  checkIdentity(cwd, cwdExpected, "del directorio");
  const named = await lstat(name);
  if (!named.isFile() || named.isSymbolicLink())
    fail("La hoja del scanner no es un archivo regular seguro");
  checkIdentity(named, expected, "del archivo");
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail("El descriptor del scanner no es archivo");
    checkIdentity(before, expected, "del archivo");
    const content = await handle.readFile();
    if (pause) {
      process.stdout.write('{"event":"after-read"}\n');
      const continuation = await nextLine();
      if (continuation !== "continue")
        fail("El scanner no recibió continuación");
    }
    const after = await handle.stat({ bigint: true });
    const finalNamed = await lstat(name);
    if (
      !same(state(before), state(after)) ||
      !same(identity(finalNamed), expected)
    )
      fail("La identidad del archivo de servicio cambió");
    return {
      kind: "leaf",
      digest: createHash("sha256").update(content).digest("hex"),
      metadata: state(before),
    };
  } finally {
    await handle.close();
  }
};

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = readline[Symbol.asyncIterator]();
const nextLine = async () => {
  const next = await lines.next();
  if (next.done) fail("El scanner no recibió input");
  return next.value;
};

try {
  const input = JSON.parse(await nextLine());
  const expected = expectedIdentity(input.expected);
  const result =
    input.action === "directory"
      ? await directory(expected)
      : input.action === "leaf"
        ? await leaf(
            input.name,
            expected,
            expectedIdentity(input.cwdExpected),
            input.pause === true,
            nextLine,
          )
        : fail("La acción del scanner no es válida");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Error del scanner";
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
