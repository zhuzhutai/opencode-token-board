import type { PluginModule } from "@opencode-ai/plugin"

const plugin: PluginModule & { id: string } = {
  id: "opencode-token-board",
  server: async () => {
    return {}
  },
}

export default plugin