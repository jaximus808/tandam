import { defineConfig } from "tsup";

export default defineConfig({
  // index.ts → published stdio CLI; http.ts → hosted Streamable HTTP sidecar.
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  outDir: "dist",
  splitting: false,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
