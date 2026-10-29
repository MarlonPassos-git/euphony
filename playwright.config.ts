import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './__tests__',
  testMatch: '*.integration.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3033', browserName: 'chromium' },
  webServer: {
    command: 'pnpm preview --host 127.0.0.1 --port 3033',
    url: 'http://127.0.0.1:3033',
    reuseExistingServer: !process.env.CI
  }
});
