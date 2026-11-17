import { defineConfig } from "tsup";

// One self-contained script for the Front sidebar iframe: no module loader, no externals.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["iife"],
  globalName: "OverturnFront",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  clean: true,
  minify: true,
  noExternal: ["@overturn-ai/shared"],
  // Front's SDK talks to the host; leave it as a global import via the CDN script in index.html,
  // or bundle it. Bundling keeps the zip self-contained.
  external: [],
  outDir: "dist",
});
