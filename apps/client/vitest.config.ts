import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Component tests for the integration UI.
 *
 * Separate from the Vite app config so the test environment (jsdom, setup
 * file) is not carried into the production build. There was no frontend test
 * stack in this repository before Vertical Slice 01; this is the minimum
 * needed to prove the panel's state matrix and its permission behaviour.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
  },
});
