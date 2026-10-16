import type { LogEntry, ModelPerfStats, SessionPerfStats, TpsBasis } from "./formatter.js"
import { computeTps, MAX_PLAUSIBLE_TPS_OBSERVED } from "./formatter.js"
import type { TokenMessage } from "./types.js"
import { hasPerfTiming } from "./types.js"
import { getStreamTiming } from "./stream-timing.js"
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { updatePersistedStats } from "./stats-store.js"

const LOG_PATH = join(homedir(), ".opencode", "tokenwatch.jsonl")

/** 线性插值百分位数，输入须为有序数组 */
function percentile(sortedArr: number[], p: number): number | null {
  if (sortedArr.length === 0) return null
  if (sortedArr.length === 1) return sortedArr[0]
  const idx = (p / 100) * (sortedArr.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedArr[lo]
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo)
}

function emptyStats(model: string, providerID: string): ModelPerfStats {
  return {
    model,
    providerID,
    requestCount: 0,
    ttftCount: 0,
    tpsCount: 0,
    latencyCount: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    avgTTFT: null, maxTTFT: null, minTTFT: null, p50TTFT: null, p95TTFT: null, p99TTFT: null,
    avgTPS: null, maxTPS: null, minTPS: null, recentTPS: null,
    avgLatency: null, maxLatency: null, minLatency: null, p50Latency: null, p95Latency: null, p99Latency: null,
    cacheHitRate: null,
  }
}

/** 从单条样本推导性能三元组（毫秒）。缺时间字段则对应项为 null。 */
export interface PerfSample {
  ttft: number | null
  latency: number | null
  tps: number | null
  /**
   * TTFT 的取数口径（TPS 自 v4 起恒为官方口径，与本字段无关）：
   *   live    = 实时抓到首个 token delta
   *   content = 消息首个内容分片的 time.created
   *   approx  = 无首 token 依据（TTFT 为 null）
   *   null    = 完全无性能数据
   */
  basis: TpsBasis | null
}

/**
 * 推导 TTFT / 延迟 / TPS。
 *
 * 时间字段真实语义（与 OpenCode core 对齐，勿按字段名望文生义）：
 *   created   = step 开始（发请求）
 *   streamed  = 流式输出结束（session.step.streamed，在流跑完后 publish）
 *   completed = step 收尾（工具执行完）
 *
 * ── TPS：严格对齐 OpenCode 官方口径 ──
 * 官方源码（v2.0.29 TUI footer）：
 *   TPS = Σ(output + reasoning) / (Σ(streamed − created) / 1000)
 * 即「step 开始 → 流式结束」为生成窗口（含预填充）。逐条消息等价于
 *   (output + reasoning) / ((streamed − created) / 1000)
 * 历史 bug：旧代码误用 `completed − streamed`（工具执行耗时，常 <100ms）当分母，
 * 于是 TPS 动辄上千（实测 avg 1150、max 26000），而官方只有几十~两百。
 *
 * ── TTFT：首 token − step 开始（官方不展示）──
 * 首 token 时间来源（按优先级）：
 *   ① stream-timing.ts 实时采集的首个 delta
 *   ② 消息首个内容分片的 time.created（reasoning/tool 开头的消息可用）
 *   ③ 都没有 → TTFT 置 null（宁缺毋滥）
 */
export function derivePerf(m: TokenMessage): PerfSample {
  if (!hasPerfTiming(m)) return { ttft: null, latency: null, tps: null, basis: null }
  const created = m.created!
  const completed = m.completed!
  const latency = completed - created

  // TPS —— 官方口径：生成窗口 = streamed − created（含预填充）
  const streamEnd = typeof m.streamed === "number" && m.streamed > 0 ? m.streamed : null
  let tps: number | null = null
  if (streamEnd !== null && streamEnd > created) {
    const t = computeTps(m.outputTokens, m.reasoningTokens, streamEnd - created)
    if (t !== null && t <= MAX_PLAUSIBLE_TPS_OBSERVED) tps = t
  }

  // TTFT —— 首 token − step 开始（实时采集优先，其次首个内容分片）
  const live = getStreamTiming(m.id)
  let first: number | null = null
  if (live && live.first >= created) first = live.first
  else if (typeof m.firstTokenAt === "number" && m.firstTokenAt >= created) first = m.firstTokenAt
  const ttft = first !== null ? first - created : null

  let basis: TpsBasis | null = null
  if (tps !== null || ttft !== null) {
    basis = first === null ? "approx" : live && first === live.first ? "live" : "content"
  }
  return { ttft, latency, tps, basis }
}

/**
 * 纯聚合：把一批 TokenMessage（当前会话）聚合成每模型 + 汇总的性能统计。
 * 无副作用，可每次渲染安全重算。分位数基于当前样本集。
 */
export function computePerfStats(messages: readonly TokenMessage[]): SessionPerfStats {
  const map = new Map<string, ModelPerfStats>()
  const ttftBuckets = new Map<string, number[]>()
  const latBuckets = new Map<string, number[]>()

  for (const m of messages) {
    // 过滤全零无效样本（失败/未完成请求）
    if (m.inputTokens + m.outputTokens + m.cacheRead + m.cacheWrite === 0) continue
    const model = `${m.providerID}/${m.modelID}`
    let s = map.get(model)
    if (!s) { s = emptyStats(model, m.providerID); map.set(model, s) }

    s.requestCount++
    s.totalInput += m.inputTokens
    s.totalOutput += m.outputTokens
    s.totalCacheRead += m.cacheRead
    s.totalCacheWrite += m.cacheWrite
    s.totalCost += m.cost

    const { ttft, latency, tps } = derivePerf(m)
    if (ttft !== null) {
      s.ttftCount++
      s.avgTTFT = s.avgTTFT != null ? s.avgTTFT + (ttft - s.avgTTFT) / s.ttftCount : ttft
      s.maxTTFT = s.maxTTFT != null ? Math.max(s.maxTTFT, ttft) : ttft
      s.minTTFT = s.minTTFT != null ? Math.min(s.minTTFT, ttft) : ttft
      const arr = ttftBuckets.get(model) ?? []; arr.push(ttft); ttftBuckets.set(model, arr)
    }
    if (tps !== null) {
      s.tpsCount++
      s.avgTPS = s.avgTPS != null ? s.avgTPS + (tps - s.avgTPS) / s.tpsCount : tps
      s.maxTPS = s.maxTPS != null ? Math.max(s.maxTPS, tps) : tps
      s.minTPS = s.minTPS != null ? Math.min(s.minTPS, tps) : tps
    }
    if (latency !== null) {
      s.latencyCount++
      s.avgLatency = s.avgLatency != null ? s.avgLatency + (latency - s.avgLatency) / s.latencyCount : latency
      s.maxLatency = s.maxLatency != null ? Math.max(s.maxLatency, latency) : latency
      s.minLatency = s.minLatency != null ? Math.min(s.minLatency, latency) : latency
      const arr = latBuckets.get(model) ?? []; arr.push(latency); latBuckets.set(model, arr)
    }
  }

  const result = Array.from(map.values())
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalRequests = 0, totalCost = 0
  let weightedHitSum = 0, totalReqForHit = 0

  for (const s of result) {
    const ttftArr = (ttftBuckets.get(s.model) ?? []).sort((a, b) => a - b)
    s.p50TTFT = percentile(ttftArr, 50); s.p95TTFT = percentile(ttftArr, 95); s.p99TTFT = percentile(ttftArr, 99)
    const latArr = (latBuckets.get(s.model) ?? []).sort((a, b) => a - b)
    s.p50Latency = percentile(latArr, 50); s.p95Latency = percentile(latArr, 95); s.p99Latency = percentile(latArr, 99)
    const denom = s.totalInput + s.totalCacheRead
    s.cacheHitRate = denom > 0 ? (s.totalCacheRead / denom) * 100 : null

    totalInput += s.totalInput; totalOutput += s.totalOutput
    totalCacheRead += s.totalCacheRead; totalCacheWrite += s.totalCacheWrite
    totalRequests += s.requestCount; totalCost += s.totalCost
    if (s.cacheHitRate != null) { weightedHitSum += s.cacheHitRate * s.requestCount; totalReqForHit += s.requestCount }
  }

  const weightedCacheHitRate = totalReqForHit > 0 ? weightedHitSum / totalReqForHit : null
  return {
    models: Object.fromEntries(map),
    totals: { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalRequests, totalCost, weightedCacheHitRate },
  }
}

/** 由 TokenMessage 生成一条 JSONL 日志样本。 */
export function toLogEntry(m: TokenMessage): LogEntry {
  const { ttft, latency, tps, basis } = derivePerf(m)
  return {
    ts: new Date().toISOString(),
    model: `${m.providerID}/${m.modelID}`,
    providerID: m.providerID,
    modelID: m.modelID,
    sessionID: m.sessionID,
    ttft_ms: ttft,
    tps,
    // basis 存在 = 本条日志按 v3 口径产出（迁移时据此区分新旧日志）；null → 不写，按旧日志处理
    basis: basis ?? undefined,
    latency_ms: latency,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    reasoningTokens: m.reasoningTokens,
    cacheReadTokens: m.cacheRead,
    cacheWriteTokens: m.cacheWrite,
    cost: m.cost,
  }
}

/**
 * 记录器：把「新完成的 assistant 消息」落盘到 JSONL + 持久化聚合统计，供报告用。
 * 用 seen ID 去重，避免同一消息重复落盘。跨会话共享（单例），随 TUI 生命周期存在。
 */
export class PerfRecorder {
  private seen = new Set<string>()

  /** 输入应为已知的完成消息集合（通常是当前会话消息列表 + 事件触发的增量）。 */
  record(messages: readonly TokenMessage[]): void {
    for (const m of messages) {
      if (this.seen.has(m.id)) continue
      if (!hasPerfTiming(m)) continue
      if (m.inputTokens + m.outputTokens + m.cacheRead + m.cacheWrite === 0) continue
      this.seen.add(m.id)
      const entry = toLogEntry(m)
      this.appendLog(entry)
      updatePersistedStats(entry)
    }
  }

  private appendLog(entry: LogEntry): void {
    try {
      // JSONL 轮转保护：>5MB 截断保留最新 2000 行
      const MAX_SIZE = 5 * 1024 * 1024
      const KEEP_LINES = 2000
      if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_SIZE) {
        const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n")
        writeFileSync(LOG_PATH, lines.slice(-KEEP_LINES).join("\n") + "\n")
      }
      appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n")
    } catch { /* 日志非关键 */ }
  }
}

/** 读取 JSONL 最后 n 条（报告的 perfLogs 参考）。 */
export function readLogs(last: number = 50): LogEntry[] {
  try {
    if (!existsSync(LOG_PATH)) return []
    const content = readFileSync(LOG_PATH, "utf-8").trim()
    if (!content) return []
    const lines = content.split("\n")
    const entries: LogEntry[] = []
    for (let i = Math.max(0, lines.length - last); i < lines.length; i++) {
      try { entries.push(JSON.parse(lines[i]) as LogEntry) } catch { /* skip */ }
    }
    return entries
  } catch { return [] }
}
