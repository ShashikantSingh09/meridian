import { defineConfig } from "@playwright/test";

// Runs the real interface against the browser stand-in for the Rust core.
export default defineConfig({
  testDir: "e2e",
  timeout: 15_000,
  use: {
    baseURL: "http://localhost:1421",
    viewport: { width: 860, height: 660 },
  },
  webServer: {
    command: "npx vite --port 1421 --strictPort",
    url: "http://localhost:1421",
    reuseExistingServer: true,
  },
});
