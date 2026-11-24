import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "workspace.spec.ts",
  outputDir: "../../.state/team-browser",
  workers: 1,
  reporter: "list",
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "desktop", use: devices["Desktop Chrome"] },
    { name: "mobile", use: devices["Pixel 7"] },
  ],
});
