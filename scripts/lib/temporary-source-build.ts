import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  EXPECTED_SOURCE_COMMIT,
  resolveSourceRoot,
} from "./source-reference.ts";

const execFileAsync = promisify(execFile);
const maximumLogBytes = 1_024 * 1_024;

export interface TemporarySourceOptions {
  sourceRoot?: string;
  commit?: string;
  install?: boolean;
  build?: boolean;
  logRoot?: string;
}

export interface TemporarySourceBuild {
  root: string;
  sourceRoot: string;
  commit: string;
  logRoot: string;
}

interface BoundedOutput {
  bytes: number;
  truncated: boolean;
  toBuffer(): Buffer;
  write(chunk: Buffer | string): void;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: BoundedOutput;
  stderr: BoundedOutput;
}

function createBoundedOutput(): BoundedOutput {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
    toBuffer() {
      return Buffer.concat(chunks);
    },
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = maximumLogBytes - bytes;
      if (available <= 0) {
        truncated = true;
        return;
      }
      if (buffer.byteLength > available) {
        chunks.push(buffer.subarray(0, available));
        bytes += available;
        truncated = true;
        return;
      }
      chunks.push(buffer);
      bytes += buffer.byteLength;
    },
  };
}

function outputText(output: BoundedOutput): string {
  const suffix = output.truncated
    ? `\n[output truncated after ${maximumLogBytes} bytes]\n`
    : "";
  return `${output.toBuffer().toString("utf8")}${suffix}`;
}

function safeLogLabel(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-");
}

async function writeProcessLog(
  logRoot: string,
  label: string,
  command: string,
  args: string[],
  cwd: string,
  result: ProcessResult,
): Promise<string> {
  await mkdir(logRoot, { recursive: true });
  const logPath = join(
    logRoot,
    `${process.pid}-${Date.now()}-${safeLogLabel(label)}.log`,
  );
  const metadata = {
    command,
    args,
    cwd,
    exitCode: result.code,
    signal: result.signal,
    stdoutBytes: result.stdout.bytes,
    stderrBytes: result.stderr.bytes,
    stdoutTruncated: result.stdout.truncated,
    stderrTruncated: result.stderr.truncated,
  };
  await writeFile(
    logPath,
    `${JSON.stringify(metadata)}\n--- stdout ---\n${outputText(result.stdout)}--- stderr ---\n${outputText(result.stderr)}`,
  );
  return logPath;
}

async function runProcess(
  label: string,
  command: string,
  args: string[],
  options: { cwd: string; logRoot: string; environment?: NodeJS.ProcessEnv },
): Promise<void> {
  const stdout = createBoundedOutput();
  const stderr = createBoundedOutput();
  const child = spawn(command, args, {
    cwd: options.cwd,
    ...(options.environment === undefined ? {} : { env: options.environment }),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));

  const result = await new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  }).catch(async (error: unknown) => {
    const result = {
      code: null,
      signal: null,
      stdout,
      stderr,
    } satisfies ProcessResult;
    const logPath = await writeProcessLog(
      options.logRoot,
      label,
      command,
      args,
      options.cwd,
      result,
    );
    throw new Error(
      `No se pudo iniciar ${command} ${args.join(" ")}; log: ${logPath}`,
      { cause: error },
    );
  });
  const logPath = await writeProcessLog(
    options.logRoot,
    label,
    command,
    args,
    options.cwd,
    result,
  );

  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} terminó con código ${result.code ?? "desconocido"}; log: ${logPath}`,
    );
  }
}

async function createPortableTimeout(supportRoot: string): Promise<string> {
  const toolRoot = join(supportRoot, "tools");
  const timeoutPath = join(toolRoot, "timeout");
  const timeoutProgram = `#!/usr/bin/env node
const { spawn } = require("node:child_process");

function durationMilliseconds(value) {
  const match = /^(\\d+(?:\\.\\d+)?)(ms|s|m|h|d)?$/.exec(value);
  if (!match) throw new Error(\`unsupported timeout duration: \${value}\`);
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * units[match[2] || "s"];
}

function optionValue(args, index, name) {
  const value = args[index + 1];
  if (!value) throw new Error(\`\${name} requires a value\`);
  return value;
}

function parseArguments(args) {
  let signal = "TERM";
  let killAfter = null;
  let index = 0;
  while (args[index]?.startsWith("--")) {
    const option = args[index];
    if (option.startsWith("--signal=")) {
      signal = option.slice("--signal=".length);
    } else if (option === "--signal") {
      signal = optionValue(args, index, option);
      index += 1;
    } else if (option.startsWith("--kill-after=")) {
      killAfter = durationMilliseconds(option.slice("--kill-after=".length));
    } else if (option === "--kill-after") {
      killAfter = durationMilliseconds(optionValue(args, index, option));
      index += 1;
    } else {
      throw new Error(\`unsupported timeout option: \${option}\`);
    }
    index += 1;
  }
  const duration = args[index];
  const command = args[index + 1];
  if (!duration || !command) throw new Error("timeout requires a duration and command");
  return { command, commandArgs: args.slice(index + 2), duration: durationMilliseconds(duration), killAfter, signal };
}

try {
  const parsed = parseArguments(process.argv.slice(2));
  const processGroup = process.platform !== "win32";
  const child = spawn(parsed.command, parsed.commandArgs, {
    detached: processGroup,
    shell: false,
    stdio: "inherit",
  });
  let killTimer;
  let deadlineExpired = false;
  let startFailed = false;
  const signalName = parsed.signal.startsWith("SIG") ? parsed.signal : \`SIG\${parsed.signal}\`;
  function signalTimedCommand(signal) {
    if (processGroup && typeof child.pid === "number") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ESRCH") return;
      }
    }
    child.kill(signal);
  }
  const timer = setTimeout(() => {
    deadlineExpired = true;
    signalTimedCommand(signalName);
    if (parsed.killAfter !== null) {
      killTimer = setTimeout(() => signalTimedCommand("SIGKILL"), parsed.killAfter);
    }
  }, parsed.duration);
  child.once("error", (error) => {
    startFailed = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    process.stderr.write(\`timeout failed to start command: \${error.message}\\n\`);
    process.exitCode = 127;
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    if (killTimer && !deadlineExpired) clearTimeout(killTimer);
    if (!startFailed) process.exitCode = deadlineExpired ? 124 : code ?? (signal ? 124 : 1);
  });
} catch (error) {
  process.stderr.write(\`timeout: \${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 125;
}
`;

  await mkdir(toolRoot, { recursive: true });
  await writeFile(join(toolRoot, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(timeoutPath, timeoutProgram, { mode: 0o755 });
  await chmod(timeoutPath, 0o755);
  return toolRoot;
}

async function createTemporaryGitEnvironment(
  root: string,
  sourceRoot: string,
  commit: string,
  supportRoot: string,
  logRoot: string,
): Promise<NodeJS.ProcessEnv> {
  const gitDirectory = join(supportRoot, "git");
  await runProcess(
    "temporary-git-clone",
    "git",
    ["clone", "--mirror", "--no-local", "--quiet", sourceRoot, gitDirectory],
    {
      cwd: supportRoot,
      logRoot,
    },
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: root,
  };
  await runProcess(
    "temporary-git-ref",
    "git",
    ["update-ref", "refs/heads/main", commit],
    {
      cwd: root,
      logRoot,
      environment,
    },
  );
  await runProcess(
    "temporary-git-head",
    "git",
    ["symbolic-ref", "HEAD", "refs/heads/main"],
    {
      cwd: root,
      logRoot,
      environment,
    },
  );
  await runProcess("temporary-git-index", "git", ["read-tree", commit], {
    cwd: root,
    logRoot,
    environment,
  });
  return environment;
}

async function archiveSource(
  sourceRoot: string,
  commit: string,
  archivePath: string,
  logRoot: string,
): Promise<void> {
  const stdout = createBoundedOutput();
  const stderr = createBoundedOutput();
  let archiveBytes = 0;
  const archive = createWriteStream(archivePath, { flags: "wx" });
  const child = spawn("git", ["archive", "--format=tar", commit], {
    cwd: sourceRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    archiveBytes += chunk.byteLength;
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
  child.stdout?.pipe(archive);

  const archiveFinished = new Promise<void>((resolveResult, reject) => {
    archive.once("error", reject);
    archive.once("finish", resolveResult);
  });
  const result = await new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", (error) => {
      archive.destroy(error);
      reject(error);
    });
    child.once("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  }).catch(async (error: unknown) => {
    const logPath = await writeProcessLog(
      logRoot,
      "git-archive",
      "git",
      ["archive", "--format=tar", commit],
      sourceRoot,
      { code: null, signal: null, stdout, stderr },
    );
    throw new Error(`No se pudo archivar la fuente; log: ${logPath}`, {
      cause: error,
    });
  });

  await archiveFinished;
  stdout.write(`binary tar streamed to archive (${archiveBytes} bytes)\n`);
  const logPath = await writeProcessLog(
    logRoot,
    "git-archive",
    "git",
    ["archive", "--format=tar", commit],
    sourceRoot,
    result,
  );

  if (result.code !== 0) {
    throw new Error(
      `git archive terminó con código ${result.code ?? "desconocido"}; log: ${logPath}`,
    );
  }
}

async function extractArchive(
  archivePath: string,
  root: string,
  logRoot: string,
): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "tar",
      ["-xf", archivePath, "-C", root],
      { encoding: "utf8", maxBuffer: maximumLogBytes },
    );
    const capturedStdout = createBoundedOutput();
    const capturedStderr = createBoundedOutput();
    capturedStdout.write(stdout);
    capturedStderr.write(stderr);
    await writeProcessLog(
      logRoot,
      "tar-extract",
      "tar",
      ["-xf", archivePath, "-C", root],
      root,
      { code: 0, signal: null, stdout: capturedStdout, stderr: capturedStderr },
    );
  } catch (error: unknown) {
    const commandError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const stdout = createBoundedOutput();
    const stderr = createBoundedOutput();
    if (commandError.stdout) stdout.write(commandError.stdout);
    if (commandError.stderr) stderr.write(commandError.stderr);
    const logPath = await writeProcessLog(
      logRoot,
      "tar-extract",
      "tar",
      ["-xf", archivePath, "-C", root],
      root,
      { code: null, signal: null, stdout, stderr },
    );
    throw new Error(`No se pudo extraer el archivo fuente; log: ${logPath}`, {
      cause: error,
    });
  }
}

export async function withTemporarySourceBuild<T>(
  run: (build: TemporarySourceBuild) => Promise<T>,
  options: TemporarySourceOptions = {},
): Promise<T> {
  const sourceRoot = await resolveSourceRoot(options.sourceRoot);
  const commit = options.commit ?? EXPECTED_SOURCE_COMMIT;
  const logRoot = resolve(
    options.logRoot ?? join(process.cwd(), ".artifacts", "source-build"),
  );
  const sessionRoot = await mkdtemp(
    join(tmpdir(), "comunidadsolar-source-build-"),
  );
  const root = join(sessionRoot, "source");
  const supportRoot = join(sessionRoot, "support");
  const archivePath = join(root, "source.tar");

  try {
    await mkdir(root, { recursive: true });
    await mkdir(supportRoot, { recursive: true });
    await archiveSource(sourceRoot, commit, archivePath, logRoot);
    try {
      await extractArchive(archivePath, root, logRoot);
    } finally {
      await rm(archivePath, { force: true });
    }

    const shouldBuild = options.build ?? options.install !== false;
    const environment =
      options.install !== false || shouldBuild
        ? await createTemporaryGitEnvironment(
            root,
            sourceRoot,
            commit,
            supportRoot,
            logRoot,
          )
        : undefined;

    if (options.install !== false) {
      await runProcess("npm-ci", "npm", ["ci"], {
        cwd: root,
        logRoot,
        environment,
      });
    }
    if (shouldBuild) {
      const timeoutRoot = await createPortableTimeout(supportRoot);
      await runProcess("npm-build", "npm", ["run", "build"], {
        cwd: root,
        logRoot,
        environment: {
          ...environment,
          PATH: [timeoutRoot, process.env.PATH].filter(Boolean).join(delimiter),
        },
      });
    }

    return await run({ root, sourceRoot, commit, logRoot });
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
}
