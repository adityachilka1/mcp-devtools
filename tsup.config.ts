import { defineConfig } from "tsup";

// Two builds:
//   1. library entries (index, embed) — no shebang
//   2. CLI entry — with shebang
export default defineConfig([
  {
    entry: { index: "src/index.ts", embed: "src/embed.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: true,
    clean: true,
    dts: true,
    shims: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: true,
    clean: false,
    dts: false,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
