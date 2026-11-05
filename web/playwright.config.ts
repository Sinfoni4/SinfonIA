import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the dashboard (FE5) in a real browser, against the server of
 * scripts/e2e/server.ts (test database, port 3300), which Playwright starts and stops.
 * Usage: npm run e2e (from web/) or npm run web:e2e (from the repository).
 */
const PORT = Number(process.env.E2E_PORT ?? 3300);
// On Windows the installed Google Chrome (nothing to download); elsewhere Playwright's Chromium,
// or the browser named in E2E_BROWSER_CHANNEL.
const channel =
  process.env.E2E_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'chrome' : undefined);

export default defineConfig({
  testDir: './e2e',
  // One worker: the tests share the organization of the run and its data.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/app/`,
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'computer', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } },
    { name: 'telefono', use: { ...devices['Pixel 7'], ...(channel ? { channel } : {}) } },
  ],
  webServer: {
    command: 'node --import tsx scripts/e2e/server.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/readyz`,
    // Always a fresh server: it clears the login codes of the test accounts at start.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
