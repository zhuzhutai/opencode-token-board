import type { Context } from "@opencode/plugin/tui/context"
import type { Store } from "solid-js/store"
import type { SidebarConfig, CollapseState } from "./types.js"
import { DEFAULT_SIDEBAR_CONFIG, DEFAULT_COLLAPSE } from "./types.js"

/**
 * storage.ts — 持久化适配层（v1 api.kv → v2 context.storage）。
 *
 * v1 的 `api.kv.get/set` 是同步、非响应式，sidebar 靠 500ms 轮询 config-version
 * 感知配置变化。v2 的 `context.storage.store` 返回 SolidJS Store：**同步读 + 响应式**，
 * 配置变化自动触发依赖它的 memo 重算，轮询彻底删除。
 *
 * - `store`：持久化到磁盘，跨 TUI 实例同步，热重载保留（配置 / 折叠态用它）
 * - `memory`：内存，热重载共享，TUI 退出丢失（无需持久的大对象可用它）
 *
 * 插件 options（opencode.json 的 `plugins:[{options}]`）作为**全新安装的默认值**灌入
 * store 的 initial；一旦有持久化值，持久化优先。
 */
export interface BoardStorage {
  /** 侧边栏显示配置（响应式）。 */
  config: Store<SidebarConfig>
  updateConfig(mutate: (draft: SidebarConfig) => void): Promise<void>
  /** 折叠状态（响应式）。 */
  collapse: Store<CollapseState>
  updateCollapse(mutate: (draft: CollapseState) => void): Promise<void>
}

/** 把插件 options（可能是部分 SidebarConfig）与默认值深合并为完整初始配置。 */
function mergeOptionsWithDefaults(options: Readonly<Record<string, any>>): SidebarConfig {
  const opts = options as Partial<SidebarConfig> | undefined
  return {
    sidebar: { ...DEFAULT_SIDEBAR_CONFIG.sidebar, ...(opts?.sidebar ?? {}) },
    language: opts?.language ?? DEFAULT_SIDEBAR_CONFIG.language,
  }
}

export function createBoardStorage(context: Context): BoardStorage {
  const initialConfig = mergeOptionsWithDefaults(context.options ?? {})
  const [config, updateConfig] = context.storage.store<SidebarConfig>("config", { initial: initialConfig })
  const [collapse, updateCollapse] = context.storage.store<CollapseState>("collapse", { initial: DEFAULT_COLLAPSE })

  // 兜底：持久化值优先于 initial，历史版本可能缺少后加的字段（如 showGoUsage），
  // 读出来是 undefined 会被当作「关闭」而误隐藏。这里检测并回填默认值。
  const persisted = config as Partial<SidebarConfig>
  const sb = (persisted.sidebar ?? {}) as Partial<SidebarConfig["sidebar"]>
  const needsFill =
    sb.showPerformance === undefined ||
    sb.showTokenDistribution === undefined ||
    sb.showGoUsage === undefined ||
    persisted.language === undefined
  if (needsFill) {
    updateConfig((d) => {
      d.sidebar = { ...DEFAULT_SIDEBAR_CONFIG.sidebar, ...(d.sidebar ?? {}) }
      if (d.language === undefined) d.language = DEFAULT_SIDEBAR_CONFIG.language
    }).catch(() => { /* 回填失败不影响使用 */ })
  }

  return { config, updateConfig, collapse, updateCollapse }
}
