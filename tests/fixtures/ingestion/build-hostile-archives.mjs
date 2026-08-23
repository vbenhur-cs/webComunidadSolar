import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const archiveDirectory = fileURLToPath(new URL("./archives/", import.meta.url));
const dosDate = 0x0021;
const regularMode = 0o100600;
const symlinkMode = 0o120777;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, archiveComment = "") {
  const localFiles = [];
  const centralFiles = [];
  let offset = 0;

  for (const {
    name,
    value,
    mode = regularMode,
    flags: entryFlags = 0,
    uncompressedSize,
  } of entries) {
    const filename = Buffer.from(name, "utf8");
    const data = Buffer.from(value, "utf8");
    const flags =
      entryFlags |
      (Buffer.byteLength(name, "utf8") !== name.length ? 0x0800 : 0);
    const declaredSize = uncompressedSize ?? data.byteLength;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(filename.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localFiles.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(filename.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralFiles.push(central, filename);
    offset += local.byteLength + filename.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralFiles);
  const end = Buffer.alloc(22);
  const comment = Buffer.from(archiveComment, "utf8");
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.byteLength, 20);
  return Buffer.concat([...localFiles, centralDirectory, end, comment]);
}

const page = "<main><h1>Página aportada</h1></main>";
const validPage = "<main><h1>Página ZIP aportada</h1></main>";
const validCss = ".zip-page { color: #163b2f; }\n";
const validSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" /></svg>\n';
const archives = new Map([
  [
    "valid-page.zip",
    [
      { name: "page.html", value: validPage },
      { name: "styles.css", value: validCss },
      { name: "solar.svg", value: validSvg },
    ],
  ],
  ["zip-slip.zip", [{ name: "../escape.html", value: page }]],
  ["absolute-path.zip", [{ name: "/escape.html", value: page }]],
  ["nul-path.zip", [{ name: "safe\0.html", value: page }]],
  ["empty-path.zip", [{ name: "", value: page }]],
  [
    "case-collision.zip",
    [
      { name: "Page.html", value: page },
      { name: "page.html", value: page },
    ],
  ],
  [
    "nfc-collision.zip",
    [
      { name: "cafe\u0301.html", value: page },
      { name: "café.html", value: page },
    ],
  ],
  ["dotfile.zip", [{ name: ".hidden.html", value: page }]],
  ["node-modules.zip", [{ name: "node_modules/page.html", value: page }]],
  [
    "symlink.zip",
    [{ name: "linked-page.html", value: "../outside.html", mode: symlinkMode }],
  ],
  ["encrypted.zip", [{ name: "page.html", value: page, flags: 0x0001 }]],
  [
    "special-unix-entry.zip",
    [{ name: "page.html", value: page, mode: 0o020600 }],
  ],
  [
    "declared-size-mismatch.zip",
    [{ name: "page.html", value: page, uncompressedSize: 1 }],
  ],
  [
    "too-many-files.zip",
    Array.from({ length: 501 }, (_, index) => ({
      name: `entry-${String(index).padStart(3, "0")}.txt`,
      value: "x",
    })),
  ],
  [
    "too-many-directories.zip",
    Array.from({ length: 501 }, (_, index) => ({
      name: `directory-${String(index).padStart(3, "0")}/`,
      value: "",
    })),
  ],
  [
    "executable.zip",
    [
      { name: "page.html", value: page },
      { name: "install.sh", value: "#!/bin/sh\necho never-run\n" },
    ],
  ],
  ["mode-executable.zip", [{ name: "page.html", value: page, mode: 0o100755 }]],
  [
    "secret.zip",
    [
      {
        name: "page.html",
        value: `${page}\n<!-- fixture-only: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->`,
      },
    ],
  ],
  [
    "secret-assignment.zip",
    [
      {
        name: "page.html",
        value: `${page}\n<!-- API_KEY=fixture-only-value -->`,
      },
    ],
  ],
  [
    "archive-comment-secret.zip",
    {
      entries: [{ name: "page.html", value: page }],
      archiveComment: `fixture-only sk-${"z".repeat(24)}`,
    },
  ],
]);

await mkdir(archiveDirectory, { recursive: true });
for (const [name, archive] of archives) {
  const { entries, archiveComment = "" } = Array.isArray(archive)
    ? { entries: archive }
    : archive;
  await writeFile(
    new URL(name, `file://${archiveDirectory}`),
    zip(entries, archiveComment),
  );
}
