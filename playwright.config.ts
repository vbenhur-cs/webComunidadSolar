import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  use: {
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
