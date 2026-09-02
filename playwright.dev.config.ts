import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "4322");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["local-dev.spec.ts", "local-public-site.spec.ts"],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: `node ./node_modules/astro/bin/astro.mjs dev --ignore-lock --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      ASTRO_DEV_BACKGROUND: "0",
      CLOUDFLARE_CONFIG_PATH: "./wrangler.dev.jsonc",
    },
  },
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "es-ES",
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
    serviceWorkers: "block",
    video: "off",
    trace: "off",
    screenshot: "off",
  },
});
