/**
 * types.ts — 跨模块共享类型（避免 sidebar / storage / perf-tracker / tui 循环依赖）。
 *
 * TokenMessage 是本插件内部统一的「一条 assistant 消息的用量样本」。
 * 相比 v1，新增 time 四元组（created / firstToken / streamed / completed）。
 * 注意语义（勿按字段名望文生义）：created = step 开始、firstToken = 首个 token 到达、
 * streamed = **流式输出结束**、completed = 工具执行完的 step 收尾 → 延迟可直接算，
 * TPS 分母 = streamed − (firstToken ?? created)（官方口径，不含预填充）；
 * TTFT = 首 token − created（见 perf-tracker.derivePerf）。
 */

/**
 * 打包标识（MMDD）：每次重新打包时更新，显示在侧边栏标题括号里，
 * 用于直观确认 OpenCode 实际加载的是哪一版产物（OpenCode 从自己的
 * npm 缓存目录加载插件，版本不可见，故用此标记自证）。
 */
export const BUILD_TAG = "1122"

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
   * 首 token 到达时刻。来源优先级：core v2.3.x 的 `time.firstToken`
   * （session.step.first-token，官方 footer TPS 分母起点）→ 首个内容分片的
   * time.created（reasoning/tool 开头的消息才有；text 分片不带 time）。
   * TPS 分母 = streamed − (firstTokenAt ?? created)，与官方一致不含预填充。
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
