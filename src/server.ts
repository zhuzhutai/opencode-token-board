import { Plugin } from "@opencode/plugin"

/**
 * opencode-token-board server-side plugin entry (OpenCode V2).
 *
 * This plugin's logic lives almost entirely in the CLI/TUI plugin (src/tui.tsx):
 * token collection rides on the event stream surfaced to the TUI, and reports read
 * from the SQLite database directly. The server entry is kept as a stable, minimal
 * placeholder so the package exposes a valid V2 server plugin (`.` and `./server`).
 */
export default Plugin.define({
  id: "opencode-token-board",
  setup() {
    // Intentionally empty; see module doc.
  },
})
