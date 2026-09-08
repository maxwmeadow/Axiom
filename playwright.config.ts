import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  // Locally a flake should be visible immediately. On CI a single timing-
  // sensitive frame should not fail the run - Playwright still reports a
  // retried test as flaky rather than passing it off as clean.
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    actionTimeout: 8_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // {platform} is load-bearing: text rasterization differs across operating
  // systems, so a baseline captured on one will not match another within any
  // sane pixel tolerance. Each platform keeps its own.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{platform}/{arg}{ext}',
})
