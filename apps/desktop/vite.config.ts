import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // The island, and the outlines Fill this form draws over a form, in a window of their own.
  build: { target: "es2022", sourcemap: false, rolldownOptions: { input: { main: "index.html", outlines: "outlines.html" } } },
  test: { include: ["src/**/*.test.ts"] },
});
