import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

async function freePort(): Promise<number> {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo reservar un puerto loopback para Playwright");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function main(): Promise<void> {
  const port = await freePort();
  const child = spawn(
    "./node_modules/.bin/playwright",
    ["test", ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      env: { ...process.env, PLAYWRIGHT_PORT: String(port) },
      stdio: "inherit",
      shell: false,
    },
  );
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  process.exitCode = code;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
