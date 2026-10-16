/**
 * types.ts — 跨模块共享类型（避免 sidebar / storage / perf-tracker / tui 循环依赖）。
 *
 * TokenMessage 是本插件内部统一的「一条 assistant 消息的用量样本」。
 * 相比 v1，新增 time 三元组（created / streamed / completed）。
 * 注意语义（勿按字段名望文生义）：created = step 开始、streamed = **流式输出结束**、
 * completed = 工具执行完的 step 收尾 → 延迟可直接算，而 TTFT/TPS 的生成窗口
 * 没有持久化字段，须由 stream-timing.ts 实时采集首/末 token（见 perf-tracker.derivePerf）。
 */

export interface TokenMessage {
  id: string
  sessionID: string
  providerID: string
  modelID: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** 消息时间戳（毫秒）。streamed / completed 可能缺失（未完成的流）。 */
  created?: number
  streamed?: number
  completed?: number
  /**
   * 首个内容分片自带的创建时刻（= 该分片首个 chunk 到达，通常即首个 token）。
   * 只有 reasoning / tool 开头的消息才有（text 分片不带 time），
   * 作为「没有实时数据」时 TTFT/TPS 的持久化依据；实测 99% 以上的消息可用。
   */
  firstTokenAt?: number
}

/** 侧边栏显示配置（持久化到 context.storage.store）。 */
export interface SidebarConfig {
  sidebar: {
    showPerformance: boolean
    showTokenDistribution: boolean
    showGoUsage: boolean
  }
  language: "zh" | "en" | "auto"
}

export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = {
  sidebar: { showPerformance: true, showTokenDistribution: true, showGoUsage: true },
  language: "auto",
}

/** 折叠状态（持久化）。global=折叠②以下；models/subBlocks=按 key 折叠。 */
export interface CollapseState {
  global: boolean
  models: Record<string, boolean>
  subBlocks: Record<string, boolean>
}

export const DEFAULT_COLLAPSE: CollapseState = { global: false, models: {}, subBlocks: {} }

/** 某消息的时间字段是否齐备到可算性能指标。 */
export function hasPerfTiming(m: TokenMessage): boolean {
  return typeof m.created === "number" && typeof m.completed === "number" && m.completed > 0
}
