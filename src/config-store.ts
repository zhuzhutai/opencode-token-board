/**
 * config-store.ts — 进程内配置单一数据源
 *
 * 背景：旧实现里 sidebar 每 500ms 轮询 `api.kv` 的 `tokenwatch-config-version`
 * 来感知设置变更。但设置只可能由本插件进程内的 /usage 菜单修改，直接用一个
 * 进程内发布/订阅即可被动触发，轮询完全没必要。
 *
 * 职责：
 *  · 懒加载并缓存合并后的配置（tui.json pluginConfig + api.kv 持久化覆盖）
 *  · saveConfig 时同步更新缓存、落盘 kv，并通知所有订阅者
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export interface SidebarConfig {
  sidebar: {
    showPerformance: boolean
    showTokenDistribution: boolean
    showGoUsage: boolean
  }
  language: "zh" | "en" | "auto"
  go?: { apiKey?: string }
}

export const DEFAULT_CONFIG: SidebarConfig = {
  sidebar: { showPerformance: true, showTokenDistribution: true, showGoUsage: true },
  language: "auto",
}

const KV_CONFIG = "tokenwatch-config"

let cached: SidebarConfig | null = null
const listeners = new Set<() => void>()

/** 读取并合并配置（首次调用时构建，之后走缓存）。 */
export function loadConfig(api: TuiPluginApi): SidebarConfig {
  if (cached) return cached
  const base: SidebarConfig = {
    sidebar: { ...DEFAULT_CONFIG.sidebar },
    language: DEFAULT_CONFIG.language,
    go: {},
  }
  try {
    const pluginCfg = (api as any).config?.pluginConfig?.["opencode-token-board"]
    if (pluginCfg?.sidebar) Object.assign(base.sidebar, pluginCfg.sidebar)
    if (pluginCfg?.language) base.language = pluginCfg.language
    if (pluginCfg?.go) base.go = pluginCfg.go
    const overrides = api.kv?.get?.(KV_CONFIG) as Partial<SidebarConfig> | undefined
    if (overrides?.sidebar) Object.assign(base.sidebar, overrides.sidebar)
    if (overrides?.language) base.language = overrides.language
    if (overrides?.go) base.go = overrides.go
  } catch { /* defaults */ }
  cached = base
  return base
}

/** 当前配置（懒加载 + 缓存）。 */
export function getConfig(api: TuiPluginApi): SidebarConfig {
  return loadConfig(api)
}

/** 持久化配置，并通知所有订阅者（替代轮询）。 */
export function saveConfig(api: TuiPluginApi, cfg: SidebarConfig): void {
  cached = cfg
  try { api.kv?.set?.(KV_CONFIG, cfg) } catch { /* non-critical */ }
  notifyConfigChanged()
}

/** 订阅配置变更，返回取消订阅函数。 */
export function subscribeConfig(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 广播配置变更（一般无需直接调用，saveConfig 已包含）。 */
export function notifyConfigChanged(): void {
  for (const fn of listeners) {
    try { fn() } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/** 仅供测试/诊断：清空进程内缓存。 */
export function resetConfigCache(): void {
  cached = null
}
