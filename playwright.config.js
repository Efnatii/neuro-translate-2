// @ts-check
const { defineConfig } = require('@playwright/test');

const projects = [
  {
    name: 'chromium',
    use: {
      browserName: 'chromium',
      channel: 'chromium'
    }
  }
];

if (process.env.PW_RUN_EDGE === '1') {
  projects.push({
    name: 'msedge',
    use: {
      browserName: 'chromium',
      channel: 'msedge'
    }
  });
}

module.exports = defineConfig({
  testDir: './tests/e2e/specs',
  timeout: 90_000,
  expect: {
    timeout: 10_000
  },
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects
});
