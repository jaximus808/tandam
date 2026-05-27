import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  splitting: false,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
