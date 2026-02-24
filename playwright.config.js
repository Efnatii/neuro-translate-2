// @ts-check
const { defineConfig } = require('@playwright/test');
const WEB_SERVER_COMMAND = String(process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || '').trim();

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  retries: 2,
  expect: {
    timeout: 15_000
  },
  outputDir: 'test-results',
  ...(WEB_SERVER_COMMAND
    ? {
      webServer: {
        command: WEB_SERVER_COMMAND,
        url: 'http://127.0.0.1:51962',
        reuseExistingServer: true,
        timeout: 120_000
      }
    }
    : {}),
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium'
      }
    }
  ]
});
