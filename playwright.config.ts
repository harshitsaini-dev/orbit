import { defineConfig, devices } from '@playwright/test';
import { E2E_DB_URL } from './e2e/paths.js';

// Dedicated ports so the suite never collides with - or silently reuses - a
// hand-started dev server that lacks the env this config sets below.
const WEB_PORT = 5174;
const API_PORT = 8788;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // The dev server transforms the module graph (three.js included) on the first
  // request, so a cold parallel start is well over Playwright's 5s default.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : [['list']],

  use: {
    baseURL: WEB_URL,
    // Headed by default so a local run can be watched; CI is the only place
    // this goes headless.
    headless: !!process.env.CI,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Slow enough locally to follow along; `npm run test:e2e` raises it further
    // for a single-browser walkthrough, and CI leaves it at zero.
    launchOptions: { slowMo: Number(process.env.ORBIT_SLOWMO ?? (process.env.CI ? 0 : 250)) },
  },

  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    // Tablet/mobile run on Chromium too, so CI only ever installs one browser.
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 }, isMobile: false, hasTouch: true },
    },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],

  webServer: [
    {
      // The database is rebuilt here, not in globalSetup: Playwright starts the
      // web servers first, so a globalSetup rebuild deleted the file out from
      // under the server's open connection.
      command: 'node scripts/prepare-e2e-db.mjs && npm run dev:server',
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        APP_URL: WEB_URL,
        API_URL,
        // The suite exercises the real OTP flow, so it needs hosted mode plus the
        // dev outbox endpoint standing in for a mailbox. Both are opt-in and
        // refused under NODE_ENV=production.
        AUTH_MODE: 'hosted',
        ENABLE_DEV_AUTH_ENDPOINTS: 'true',
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        SESSION_SECRET: 'e2e-session-secret',
        DATABASE_URL: E2E_DB_URL,
        // Many sign-ins from one IP; the limiter has its own unit test.
        AUTH_RATE_LIMIT: '10000',
        API_RATE_LIMIT: '10000',
        GOOGLE_CLIENT_ID: 'e2e-client-id',
        GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
      },
    },
    {
      command: 'npm run dev:web',
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ORBIT_API_PORT: String(API_PORT), ORBIT_WEB_PORT: String(WEB_PORT) },
    },
  ],
});
