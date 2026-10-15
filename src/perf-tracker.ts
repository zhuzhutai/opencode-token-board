import type { LogEntry, ModelPerfStats, SessionPerfStats } from "./formatter.js"
import { computeTps } from "./formatter.js"
import type { TokenMessage } from "./types.js"
import { hasPerfTiming } from "./types.js"
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
}

export function derivePerf(m: TokenMessage): PerfSample {
  if (!hasPerfTiming(m)) return { ttft: null, latency: null, tps: null }
  const created = m.created!
  const completed = m.completed!
  const latency = completed - created
  const ttft = typeof m.streamed === "number" && m.streamed > 0 ? m.streamed - created : null
  // TPS：计入 reasoning token（推理与可见输出同处一个流式窗口，只算 output 会低估）。
  // 无可靠 streamed 则 genMs 为 null → tps null（宁缺毋滥）。
  const genMs = ttft !== null && completed > m.streamed! ? completed - m.streamed! : null
  const tps = computeTps(m.outputTokens, m.reasoningTokens, genMs)
  return { ttft, latency, tps }
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
  const { ttft, latency, tps } = derivePerf(m)
  return {
    ts: new Date().toISOString(),
    model: `${m.providerID}/${m.modelID}`,
    providerID: m.providerID,
    modelID: m.modelID,
    sessionID: m.sessionID,
    ttft_ms: ttft,
    tps,
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
