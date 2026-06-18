import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        external: ["electron", /^node:/],
      },
      lib: {
        entry: resolve(__dirname, "src/main.ts"),
        formats: ["cjs"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        external: ["electron", /^node:/],
      },
      lib: {
        entry: resolve(__dirname, "src/preload.ts"),
        formats: ["cjs"],
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
