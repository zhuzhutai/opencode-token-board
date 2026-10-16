export interface UsageFilters {
  sessionId?: string
  model?: string
  provider?: string
  startDate?: string
  endDate?: string
  limit?: number
}

export interface SessionTokenData {
  model: string
  provider: string
  modelsUsed: string[]
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  totalCost: number
  requestCount: number
}

export interface ModelBreakdownItem {
  provider: string
  model: string
  requests: number
  sessions: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  totalCost: number
}

export interface ProviderBreakdownItem {
  provider: string
  requests: number
  sessions: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  totalCost: number
}

export interface DailyBreakdownItem {
  day: string
  requests: number
  sessions: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  totalCost: number
}

export interface SessionBreakdownItem {
  sessionId: string
  title: string
  provider: string
  model: string
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  totalCost: number
  day: string
}

/** 失败请求统计 */
export interface ErrorStats {
  /** 过滤内总请求数（tokens.total > 0 的 assistant） */
  successCount: number
  /** 失败请求数（tokens.total == 0 的 assistant） */
  failedCount: number
  /** 失败率：failedCount / (successCount + failedCount) */
  errorRate: number
  /** 按模型细化的失败数 */
  byModel: Array<{ provider: string; model: string; failed: number; total: number }>
}

export interface UsageReport {
  filters: UsageFilters
  summary: SessionTokenData
  models: ModelBreakdownItem[]
  providers: ProviderBreakdownItem[]
  daily: DailyBreakdownItem[]
  sessions: SessionBreakdownItem[]
  errors?: ErrorStats
}

interface Column {
  label: string
  align: "left" | "right"
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatCost(n: number): string {
  if (n === 0) return "$0.00"
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—"
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m ${s}s`
}

/**
 * 计算生成吞吐（TPS / tokens per second）。
 *
 * 关键点：opencode 的 `tokens.output` 不包含 `tokens.reasoning`（两者互斥，
 * 见 message.tokens.total = input + output + reasoning + cache.read + cache.write）。
 * 但推理 token 与可见输出是在同一个流式窗口内生成的，因此分母（genMs）已包含
 * 推理耗时。若分子只取 output，会系统性低估真实生成速度。
 *
 * @param outputTokens    可见输出 token 数
 * @param reasoningTokens 推理 token 数（与 output 同处一个流式窗口，应计入）
 * @param genMs           生成窗口时长（毫秒）。**必须与 OpenCode 官方口径一致**：
 *                        `streamed - created`（step 开始 → 流式输出结束，含预填充）。
 *                        这是历史上 TPS 冲上几千的根因所在——旧代码误用
 *                        `completed - streamed`（工具执行耗时，常 <100ms）当分母。
 */
export function computeTps(
  outputTokens: number,
  reasoningTokens: number,
  genMs: number | null,
): number | null {
  if (genMs === null || genMs <= 0) return null
  const generated = outputTokens + reasoningTokens
  if (generated <= 0) return null
  return (generated / genMs) * 1000
}

/**
 * TPS 合理性上限（tok/s）。仅作兜底防线：正常情况下官方口径（streamed − created）
 * 落在大约 10~300，极少超过 1000。超过上限说明时间戳异常（窗口塌缩/时钟漂移），
 * 此时置 null，而不是把假值写进统计。
 *
 * 保留两个常量以兼容 stats-store 的历史日志迁移：
 *   OBSERVED  = 当前口径（实时/持久化时间戳齐备）的宽松上限
 *   ESTIMATED = 由近似时间戳推算时的从严上限
 */
export const MAX_PLAUSIBLE_TPS_OBSERVED = 2000
export const MAX_PLAUSIBLE_TPS_ESTIMATED = 1000

export function formatFilters(filters: UsageFilters): string {
  const parts: string[] = []
  if (filters.sessionId) parts.push(`session=${filters.sessionId}`)
  if (filters.provider) parts.push(`provider=${filters.provider}`)
  if (filters.model) parts.push(`model=${filters.model}`)
  if (filters.startDate || filters.endDate) {
    parts.push(`date=${filters.startDate ?? "..."}..${filters.endDate ?? "..."}`)
  }
  return parts.length ? parts.join(" | ") : "scope=all local sessions"
}

function getVisualWidth(str: string): number {
  let width = 0
  for (let i = 0; i < str.length; i++) {
    width += str.charCodeAt(i) > 255 ? 2 : 1
  }
  return width
}

function truncateByWidth(str: string, maxWidth: number): string {
  if (getVisualWidth(str) <= maxWidth) return str
  let width = 0
  let res = ""
  for (let i = 0; i < str.length; i++) {
    const charWidth = str.charCodeAt(i) > 255 ? 2 : 1
    if (width + charWidth > maxWidth - 3) {
      return res + "..."
    }
    width += charWidth
    res += str[i]
  }
  return res
}

function table(columns: Column[], rows: string[][], totalRow?: string[]): string {
  const widths = columns.map((col, i) => {
    const rowWidths = rows.map((row) => getVisualWidth(row[i] ?? ""))
    const maxRow = rowWidths.length ? Math.max(...rowWidths) : 0
    const totalWidth = totalRow ? getVisualWidth(totalRow[i] ?? "") : 0
    return Math.max(getVisualWidth(col.label), maxRow, totalWidth)
  })

  const renderRow = (cells: string[]) =>
    "║" + cells.map((cell, i) => {
      const value = cell ?? ""
      const vWidth = getVisualWidth(value)
      const padding = " ".repeat(widths[i] - vWidth)
      const content = columns[i].align === "right"
        ? padding + value
        : value + padding
      return ` ${content} ║`
    }).join("")

  const sep = (left: string, mid: string, right: string, fill: string) =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right

  const lines = [
    sep("╔", "╦", "╗", "═"),
    renderRow(columns.map((col) => col.label)),
    sep("╠", "╬", "╣", "═"),
    ...rows.map(renderRow),
  ]

  if (totalRow) {
    lines.push(sep("╠", "╬", "╣", "═"))
    lines.push(renderRow(totalRow))
  }

  lines.push(sep("╚", "╩", "╝", "═"))
  return lines.join("\n")
}

export function formatSessionSummary(data: SessionTokenData, title = "Current Session"): string {
  const modelLabel = data.modelsUsed.length > 1
    ? `${data.modelsUsed.length} models`
    : data.model || "(unknown)"

  return [
    `═══ ${title} ═══`,
    `Models:        ${modelLabel}`,
    `Provider:      ${data.provider || "(mixed)"}`,
    `Req:           ${data.requestCount}`,
    `Total Tokens:  ${formatTokens(data.totalTokens)}`,
    `  Input:       ${formatTokens(data.inputTokens)}`,
    `  Output:      ${formatTokens(data.outputTokens)}`,
    `  Reasoning:   ${formatTokens(data.reasoningTokens)}`,
    `  C.Read:      ${formatTokens(data.cacheRead)}`,
    `  C.Write:     ${formatTokens(data.cacheWrite)}`,
    `  Cost:        ${formatCost(data.totalCost)}`,
  ].join("\n")
}

export function formatStatusBar(data: SessionTokenData): string {
  return `Tok:${formatTokens(data.totalTokens)} Req:${data.requestCount} Cost:${formatCost(data.totalCost)}`
}

export function formatModelBreakdown(items: ModelBreakdownItem[]): string {
  if (items.length === 0) return "═══ Model Breakdown ═══\n(no data)"

  const total = items.reduce((acc, item) => ({
    requests: acc.requests + item.requests,
    totalTokens: acc.totalTokens + item.totalTokens,
    inputTokens: acc.inputTokens + item.inputTokens,
    outputTokens: acc.outputTokens + item.outputTokens,
    cacheRead: acc.cacheRead + item.cacheRead,
  }), {
    requests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
  })

  const rows = items.map((item) => [
    item.provider || "-",
    truncateByWidth(item.model, 20),
    String(item.requests),
    formatTokens(item.totalTokens),
    formatTokens(item.inputTokens),
    formatTokens(item.outputTokens),
    formatTokens(item.cacheRead),
  ])

  return [
    "═══ Model Breakdown ═══",
    table([
      { label: "Provider", align: "left" },
      { label: "Model", align: "left" },
      { label: "Req", align: "right" },
      { label: "Total", align: "right" },
      { label: "In", align: "right" },
      { label: "Out", align: "right" },
      { label: "Cache", align: "right" },
    ], rows, [
      "TOTAL",
      "",
      String(total.requests),
      formatTokens(total.totalTokens),
      formatTokens(total.inputTokens),
      formatTokens(total.outputTokens),
      formatTokens(total.cacheRead),
    ]),
  ].join("\n")
}

export function formatProviderBreakdown(items: ProviderBreakdownItem[]): string {
  if (items.length === 0) return "═══ Provider Breakdown ═══\n(no data)"

  const total = items.reduce((acc, item) => ({
    requests: acc.requests + item.requests,
    totalTokens: acc.totalTokens + item.totalTokens,
    inputTokens: acc.inputTokens + item.inputTokens,
    outputTokens: acc.outputTokens + item.outputTokens,
    cacheRead: acc.cacheRead + item.cacheRead,
  }), {
    requests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
  })

  const rows = items.map((item) => [
    item.provider || "-",
    String(item.requests),
    formatTokens(item.totalTokens),
    formatTokens(item.inputTokens),
    formatTokens(item.outputTokens),
    formatTokens(item.cacheRead),
  ])

  return [
    "═══ Provider Breakdown ═══",
    table([
      { label: "Provider", align: "left" },
      { label: "Req", align: "right" },
      { label: "Total", align: "right" },
      { label: "In", align: "right" },
      { label: "Out", align: "right" },
      { label: "Cache", align: "right" },
    ], rows, [
      "TOTAL",
      String(total.requests),
      formatTokens(total.totalTokens),
      formatTokens(total.inputTokens),
      formatTokens(total.outputTokens),
      formatTokens(total.cacheRead),
    ]),
  ].join("\n")
}

export function formatDailyBreakdown(items: DailyBreakdownItem[]): string {
  if (items.length === 0) return "═══ Daily Breakdown ═══\n(no data)"

  const total = items.reduce((acc, item) => ({
    requests: acc.requests + item.requests,
    totalTokens: acc.totalTokens + item.totalTokens,
    inputTokens: acc.inputTokens + item.inputTokens,
    outputTokens: acc.outputTokens + item.outputTokens,
    cacheRead: acc.cacheRead + item.cacheRead,
  }), {
    requests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
  })

  const rows = items.map((item) => [
    item.day,
    String(item.requests),
    formatTokens(item.totalTokens),
    formatTokens(item.inputTokens),
    formatTokens(item.outputTokens),
    formatTokens(item.cacheRead),
  ])

  return [
    "═══ Daily Breakdown ═══",
    table([
      { label: "Day", align: "left" },
      { label: "Req", align: "right" },
      { label: "Total", align: "right" },
      { label: "In", align: "right" },
      { label: "Out", align: "right" },
      { label: "Cache", align: "right" },
    ], rows, [
      "TOTAL",
      String(total.requests),
      formatTokens(total.totalTokens),
      formatTokens(total.inputTokens),
      formatTokens(total.outputTokens),
      formatTokens(total.cacheRead),
    ]),
  ].join("\n")
}

export function formatSessionBreakdown(items: SessionBreakdownItem[]): string {
  if (items.length === 0) return "═══ Session Breakdown ═══\n(no data)"

  const rows = items.map((item) => {
    // Truncate title by visual width (40 columns)
    const title = truncateByWidth(item.title, 40)
    return [
      item.day,
      item.provider || "-",
      truncateByWidth(item.model, 20),
      String(item.requests),
      formatTokens(item.totalTokens),
      formatTokens(item.cacheRead),
      title,
    ]
  })

  return [
    "═══ Session Breakdown ═══",
    table([
      { label: "Day", align: "left" },
      { label: "Provider", align: "left" },
      { label: "Model", align: "left" },
      { label: "Req", align: "right" },
      { label: "Total", align: "right" },
      { label: "Cache", align: "right" },
      { label: "Title", align: "left" },
    ], rows),
  ].join("\n")
}

export function formatUsageReport(report: UsageReport): string {
  return [
    `Filters: ${formatFilters(report.filters)}`,
    "",
    formatSessionSummary(report.summary, "Usage Summary"),
    "",
    formatModelBreakdown(report.models),
    "",
    formatProviderBreakdown(report.providers),
    "",
    formatDailyBreakdown(report.daily),
    "",
    formatSessionBreakdown(report.sessions),
  ].join("\n")
}

// ── New types for v2 ──

export interface SessionPerfStats {
  models: Record<string, ModelPerfStats>
  totals: {
    totalInput: number
    totalOutput: number
    totalCacheRead: number
    totalCacheWrite: number
    totalRequests: number
    totalCost: number
    /** 全局加权缓存命中率（按请求数加权平均） */
    weightedCacheHitRate: number | null
  }
}

export interface ModelPerfStats {
  model: string
  providerID: string
  requestCount: number
  ttftCount: number    // 有效 TTFT 样本数（非 null）
  tpsCount: number     // 有效 TPS 样本数（非 null）
  latencyCount: number // 有效 latency 样本数
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCost: number
  avgTTFT: number | null
  maxTTFT: number | null
  minTTFT: number | null
  p50TTFT: number | null   // TTFT 中位数
  p95TTFT: number | null   // TTFT P95
  p99TTFT: number | null   // TTFT P99
  avgTPS: number | null
  maxTPS: number | null
  minTPS: number | null
  /**
   * 最近若干次请求的滚动平均 TPS（用于侧边栏"瞬时"展示，随每次思考变动）。
   * 仅内存态 tracker 会填充；持久化/报告口径为全量 avgTPS，此字段为 null。
   */
  recentTPS: number | null
  avgLatency: number | null
  maxLatency: number | null
  minLatency: number | null
  p50Latency: number | null  // 端到端延迟 P50
  p95Latency: number | null  // 端到端延迟 P95
  p99Latency: number | null  // 端到端延迟 P99
  /** 该模型加权缓存命中率：cacheRead / (cacheRead + input) */
  cacheHitRate: number | null
}

export interface TokenDistribution {
  system: number
  user: number
  agent: number
  toolCall: number
  toolResult: number
  output: number
  total: number
}

/**
 * TPS/TTFT 取数口径（见 LogEntry.basis）。
 *
 * TPS 口径已统一为 OpenCode 官方公式（`(output+reasoning)/((streamed-created)/1000)`），
 * 因此 basis 现在只描述 **TTFT 的来源**（TPS 恒为官方口径）：
 *   "live"    = 实时采集到首个 token delta
 *   "content" = 用消息首个内容分片 time.created 作首 token
 *   "approx"  = 无首 token 依据（TTFT 为 null），TPS 仍按官方窗口算
 */
export type TpsBasis = "live" | "content" | "approx"

export interface LogEntry {
  ts: string
  model: string
  providerID: string
  modelID: string
  sessionID: string
  ttft_ms: number | null
  tps: number | null
  latency_ms: number | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  /**
   * 本次请求的 reasoning token 是否以流式 part 产出。
   * 旧版日志无此字段（undefined）。已被 `basis` 取代，保留仅为兼容历史日志。
   */
  reasoningStreamed?: boolean
  /**
   * TPS/TTFT 的取数口径（v4 起写入）：
   *   "live"    = 实时采集到首个 token，TTFT 为实测值
   *   "content" = 用消息首个内容分片 time.created 作首 token
   *   "approx"  = 无首 token 依据（ttft_ms 为 null）
   *   TPS 自 v4 起恒为 OpenCode 官方口径（streamed − created），与本字段无关。
   *   缺失（undefined）= 旧版日志（v1~v3）：`ttft_ms` 当时的语义是「step 开始 → 流式结束」，
   *                     正好等于官方生成窗口 → 迁移时直接用它重算 TPS，TTFT 丢弃。
   */
  basis?: TpsBasis
}

// ── HTML report types ──

export interface HtmlReportMeta {
  generatedAt: string
  dateRange: { start: string; end: string }
}

export interface CombinedReportData {
  summary: SessionTokenData
  models: ModelBreakdownItem[]
  providers: ProviderBreakdownItem[]
  daily: DailyBreakdownItem[]
  sessions: SessionBreakdownItem[]
  perfLogs: LogEntry[]
  perfSummary: ModelPerfStats[]
  meta: HtmlReportMeta
}

// ── OpenCode Go 订阅用量 ──

export interface GoBucket {
  percent: number
  resetInSec: number
}

export interface GoUsageData {
  rolling: GoBucket
  weekly: GoBucket
  monthly: GoBucket
  fetchedAt: number
  error?: string
}
