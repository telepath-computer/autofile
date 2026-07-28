import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src/ui",
  base: "/_ui/",
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true
  },
  test: {
    environment: "jsdom"
  }
});
