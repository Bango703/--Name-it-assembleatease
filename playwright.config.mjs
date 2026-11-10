import { defineConfig, devices } from '@playwright/test';

// Browser tests (owner, 2026-11-10). tests/e2e runs the real pages on a local
// static server with fixed test data, on every PR. tests/e2e-live reads the
// live dashboard and runs only when OWNER_PASSWORD is provided (nightly CI).
const port = Number(process.env.E2E_PORT || 4310);

export default defineConfig({
  testDir: 'tests',
  testMatch: process.env.E2E_LIVE ? 'e2e-live/**/*.spec.mjs' : 'e2e/**/*.spec.mjs',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI && !process.env.E2E_LIVE ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_LIVE ? (process.env.E2E_BASE_URL || 'https://www.assembleatease.com') : `http://127.0.0.1:${port}`,
    // The live run types the owner password and shows real customers: no trace.
    trace: process.env.E2E_LIVE ? 'off' : 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_LIVE ? undefined : {
    command: 'node scripts/e2e-static-server.mjs',
    url: `http://127.0.0.1:${port}/owner/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
