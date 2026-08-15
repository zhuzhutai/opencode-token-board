import { build } from "esbuild"
await build({
  entryPoints: ["scripts/test-popup.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "scripts/test-popup-built.mjs",
})
await import("./test-popup-built.mjs")
