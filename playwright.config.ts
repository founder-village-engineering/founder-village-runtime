import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 45000,
  outputDir: ".state/playwright",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:43802", trace: "retain-on-failure" },
  webServer: {
    command: "node --env-file=.state/local.env dist/services/admin-api/main.js",
    url: "http://127.0.0.1:43802/health/live",
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
});
