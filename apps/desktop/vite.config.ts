import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // "@/" is src, as in tsconfig.json, so components added from the React Bits registry (components.json) resolve.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // The island, and the outlines Fill this form draws over a form, in a window of their own.
  build: { target: "es2022", sourcemap: false, rolldownOptions: { input: { main: "index.html", outlines: "outlines.html" } } },
  test: { include: ["src/**/*.test.ts"] },
});
