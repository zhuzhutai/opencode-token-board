import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))

/**
 * esbuild build script for opencode-token-board TUI plugin.
 *
 * Bundles src/tui.tsx -> dist/tui.js with SolidJS JSX pre-compiled
 * (JSX -> createComponent calls via esbuild-plugin-solid).
 * Also builds src/server.ts -> dist/server.js (plain JS, no JSX).
 *
 * All runtime deps (solid-js, @opentui/*, @opencode-ai/*) are kept
 * as external imports - the OpenCode TUI host provides them at runtime.
 */

const external = [
  "solid-js",
  "solid-js/*",
  "solid-js/store",
  "@opentui/solid",
  "@opentui/solid/*",
  "@opentui/core",
  "@opentui/core/*",
  "@opencode/plugin",
  "@opencode/plugin/*",
  "@opencode/client",
  "@opencode/client/*",
  "@opencode/theme",
  "@opencode/theme/*",
]

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external,
  logLevel: "info",
}

await Promise.all([
  // TUI module - SolidJS JSX pre-compilation
  build({
    ...common,
    entryPoints: ["src/tui.tsx"],
    outfile: "dist/tui.js",
    define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
    plugins: [solidPlugin({
      solid: { moduleName: "@opentui/solid", generate: "universal" },
    })],
  }),
  // Server module - no JSX
  build({
    ...common,
    entryPoints: ["src/server.ts"],
    outfile: "dist/server.js",
  }),
])

console.log("✓ esbuild: dist/tui.js + dist/server.js")