import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { LogEntry, ModelPerfStats, SessionPerfStats } from "./formatter.js"
import { computeTps } from "./formatter.js"
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { updatePersistedStats } from "./stats-store.js"

const LOG_PATH = join(homedir(), ".opencode", "tokenwatch.jsonl")

/** 侧边栏"瞬时"TPS 使用的滚动窗口大小（最近 N 次请求） */
const TPS_ROLLING_WINDOW = 5

/** 分位数原始样本上限：有界内存 + 有界排序开销（报告口径，侧边栏不使用） */
const SAMPLE_CAP = 2000

interface PartEvent {
  message_id?: string
  type?: string
  text?: string
  time?: { start?: number }
}

interface MessageUpdateEvent {
  properties: {
    info: {
      id?: string
      sessionID?: string
      role?: string
      providerID?: string
      modelID?: string
      tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
      cost?: number
      time?: { created?: number; completed?: number }
    }
  }
}

interface MessageRemoveEvent {
  properties: {
    sessionID?: string
    messageID?: string
  }
}

/**
 * 解析日志条目的 TPS：
 * - 新日志（含 reasoningStreamed）直接使用 tracker 计算结果；
 * - 旧日志（无该字段，例如从 JSONL 载入的历史会话）按新口径重算，
 *   用 latency - ttft 反推生成窗口并纳入 reasoning token。
 */
function resolveTps(entry: LogEntry): number | null {
  if (entry.reasoningStreamed !== undefined) return entry.tps
  const genMs = entry.latency_ms != null && entry.ttft_ms != null
    ? entry.latency_ms - entry.ttft_ms
    : null
  return computeTps(entry.outputTokens, entry.reasoningTokens, genMs) ?? entry.tps
}

class PerfTracker {
  private firstPartTimes = new Map<string, number>()
  private statsMap = new Map<string, ModelPerfStats>()
  /** 原始样本串，用于分位数计算，不持久化 */
  private ttftSamples = new Map<string, number[]>()
  private latencySamples = new Map<string, number[]>()
  /** 出现过 reasoning part 的消息：只有真正流式生成的推理 token 才计入 TPS */
  private reasoningMessages = new Set<string>()
  /** 每个模型最近 N 次请求的 TPS 样本，用于计算滚动"瞬时"TPS */
  private tpsWindow = new Map<string, number[]>()
  /** JSONL 解析缓存：文件 mtime/size 未变时复用，避免反复读盘 + 解析 */
  private logCache: { mtimeMs: number; size: number; entries: LogEntry[] } | null = null

  /** 有界追加：超过上限时丢弃最旧样本，保证排序/内存开销有界 */
  private pushSample(arr: number[], value: number): void {
    arr.push(value)
    if (arr.length > SAMPLE_CAP) arr.splice(0, arr.length - SAMPLE_CAP)
  }

  private parseLogLines(content: string): LogEntry[] {
    const entries: LogEntry[] = []
    if (!content) return entries
    for (const line of content.split("\n")) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line) as LogEntry)
      } catch {
        // Skip malformed lines
      }
    }
    return entries
  }

  /** 同步读取并解析 JSONL（带 mtime/size 缓存）。 */
  private readLogEntriesSync(): LogEntry[] {
    try {
      if (!existsSync(LOG_PATH)) return []
      const st = statSync(LOG_PATH)
      if (this.logCache && this.logCache.mtimeMs === st.mtimeMs && this.logCache.size === st.size) {
        return this.logCache.entries
      }
      const entries = this.parseLogLines(readFileSync(LOG_PATH, "utf-8").trim())
      this.logCache = { mtimeMs: st.mtimeMs, size: st.size, entries }
      return entries
    } catch {
      return []
    }
  }

  /** 异步读取并解析 JSONL（带 mtime/size 缓存），用于会话切换，避免阻塞 UI 线程。 */
  private async readLogEntriesAsync(): Promise<LogEntry[]> {
    try {
      if (!existsSync(LOG_PATH)) return []
      const st = statSync(LOG_PATH)
      if (this.logCache && this.logCache.mtimeMs === st.mtimeMs && this.logCache.size === st.size) {
        return this.logCache.entries
      }
      const content = (await readFile(LOG_PATH, "utf-8")).trim()
      const entries = this.parseLogLines(content)
      this.logCache = { mtimeMs: st.mtimeMs, size: st.size, entries }
      return entries
    } catch {
      return []
    }
  }

  handlePartUpdated(event: PartEvent): void {
    if (!event.message_id) return
    // 记录该消息是否流式产出过推理内容（决定 reasoning token 能否计入 TPS 分子）
    if (event.type === "reasoning") {
      this.reasoningMessages.add(event.message_id)
    }
    if (!event.time?.start) return
    // Bug fix: 取最早 part 时间而非最后一个，避免 TTFT 被高估
    const cur = this.firstPartTimes.get(event.message_id) ?? Number.POSITIVE_INFINITY
    if (event.time.start < cur) {
      this.firstPartTimes.set(event.message_id, event.time.start)
    }
  }

  handleMessageUpdated(event: MessageUpdateEvent): void {
    const info = event.properties?.info
    if (!info || info.role !== "assistant") return
    if (!info.time?.completed) return

    const messageID = info.id ?? ""
    const created = info.time.created
    const completed = info.time.completed
    if (!created || !completed) {
      this.firstPartTimes.delete(messageID)
      this.reasoningMessages.delete(messageID)
      return
    }

    const sessionID = info.sessionID ?? ""
    const providerID = info.providerID ?? "unknown"
    const modelID = info.modelID ?? "unknown"
    const model = `${providerID}/${modelID}`
    const tokens = info.tokens

    const inputTokens = tokens?.input ?? 0
    const outputTokens = tokens?.output ?? 0
    const reasoningTokens = tokens?.reasoning ?? 0
    const cacheRead = tokens?.cache?.read ?? 0
    const cacheWrite = tokens?.cache?.write ?? 0
    const cost = info.cost ?? 0

    // 过滤全零 token 的失败请求，不写入日志和统计，防止污染数据
    if (inputTokens + outputTokens + reasoningTokens + cacheRead + cacheWrite === 0) {
      this.firstPartTimes.delete(messageID)
      this.reasoningMessages.delete(messageID)
      return
    }

    const firstPart = this.firstPartTimes.get(messageID) ?? null
    // 仅当推理内容确实以流式 part 产出时才把 reasoning token 计入分子，
    // 否则（部分 provider 只在最终 usage 中返回 reasoning）会高估生成速度。
    const reasoningStreamed = this.reasoningMessages.has(messageID)
    const streamedReasoning = reasoningStreamed ? reasoningTokens : 0

    const latencyMs = completed - created
    const ttftMs = firstPart !== null ? firstPart - created : null
    const genMs = firstPart !== null ? completed - firstPart : null
    // Bug fix: 分子包含 reasoning token（与分母的生成窗口一致），否则会系统性低估。
    // outputTokens 不含 reasoningTokens：total = input + output + reasoning + cache。
    const tps = computeTps(outputTokens, streamedReasoning, genMs)
    // Bug fix: 移除 TPS fallback。
    // 原 fallback 用 latencyMs（completed-created，含排队+TTFT）计算 TPS，
    // 会使结果严重低估（约 40%+）。null 表示"无可靠数据"比虚假数字更好。

    this.firstPartTimes.delete(messageID)
    this.reasoningMessages.delete(messageID)

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      model,
      providerID,
      modelID,
      sessionID,
      ttft_ms: ttftMs,
      tps: tps,          // 生成吞吐：(output + 流式 reasoning) / genMs，无可靠 genMs 时为 null
      latency_ms: latencyMs,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost,
      reasoningStreamed,
    }

    this.appendLog(entry)
    this.updateStats(model, entry)
  }

  private appendLog(entry: LogEntry): void {
    try {
      // Risk fix: JSONL 日志轮转保护，防止长期使用后文件无限增长
      // 超过 5MB 时截断，保留最新 2000 行
      // 注意：轮转前先调用 updatePersistedStats，确保被轮转行的数据已持久化
      const MAX_SIZE = 5 * 1024 * 1024  // 5 MB
      const KEEP_LINES = 2000
      if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_SIZE) {
        const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n")
        writeFileSync(LOG_PATH, lines.slice(-KEEP_LINES).join("\n") + "\n")
      }
      appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n")
    } catch {
      // Silently fail — logging is non-critical
    }
    // 无论 JSONL 写入是否成功，都尝试更新持久化聚合统计
    // 这样即使日志被轮转，历史统计数据也永不丢失
    updatePersistedStats(entry)
  }

  handleMessageRemoved(event: MessageRemoveEvent): void {
    const mid = event.properties?.messageID ?? ""
    if (mid) {
      this.firstPartTimes.delete(mid)
      this.reasoningMessages.delete(mid)
    }
  }

  private updateStats(model: string, entry: LogEntry): void {
    let stats = this.statsMap.get(model)
    if (!stats) {
      stats = {
        model,
        providerID: entry.providerID,
        requestCount: 0,
        ttftCount: 0,    // Bug fix: 独立维护有效样本计数
        tpsCount: 0,
        latencyCount: 0,
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalCost: 0,
        avgTTFT: null,
        maxTTFT: null,
        minTTFT: null,
        p50TTFT: null,
        p95TTFT: null,
        p99TTFT: null,
        avgTPS: null,
        maxTPS: null,
        minTPS: null,
        recentTPS: null,
        avgLatency: null,
        maxLatency: null,
        minLatency: null,
        p50Latency: null,
        p95Latency: null,
        p99Latency: null,
        cacheHitRate: null,
      }
      this.statsMap.set(model, stats)
    }

    stats.requestCount++
    stats.totalInput += entry.inputTokens
    stats.totalOutput += entry.outputTokens
    stats.totalCacheRead += entry.cacheReadTokens
    stats.totalCacheWrite += entry.cacheWriteTokens
    stats.totalCost += entry.cost

    if (entry.ttft_ms !== null) {
      // Bug fix: 分母使用 ttftCount（有效样本数），而非 requestCount（总请求数）
      stats.ttftCount++
      const c = stats.ttftCount
      const prev = stats.avgTTFT
      stats.avgTTFT = prev !== null ? prev + (entry.ttft_ms - prev) / c : entry.ttft_ms
      stats.maxTTFT = stats.maxTTFT !== null ? Math.max(stats.maxTTFT, entry.ttft_ms) : entry.ttft_ms
      stats.minTTFT = stats.minTTFT !== null ? Math.min(stats.minTTFT, entry.ttft_ms) : entry.ttft_ms
      // 收集原始样本用于分位数计算（有界）
      const ttftArr = this.ttftSamples.get(model) ?? []
      this.pushSample(ttftArr, entry.ttft_ms)
      this.ttftSamples.set(model, ttftArr)
    }

    // 新日志信任 tracker 的 tps；从 JSONL 载入的旧日志按新口径重算（含 reasoning）
    const tps = resolveTps(entry)
    if (tps !== null) {
      // Bug fix: 分母使用 tpsCount（有效样本数）
      stats.tpsCount++
      const c = stats.tpsCount
      const prev = stats.avgTPS
      stats.avgTPS = prev !== null ? prev + (tps - prev) / c : tps
      stats.maxTPS = stats.maxTPS !== null ? Math.max(stats.maxTPS, tps) : tps
      stats.minTPS = stats.minTPS !== null ? Math.min(stats.minTPS, tps) : tps
      // 维护滚动窗口（有界）：仅保留最近 N 次请求，供侧边栏"瞬时"TPS 使用
      const win = this.tpsWindow.get(model) ?? []
      win.push(tps)
      if (win.length > TPS_ROLLING_WINDOW) win.splice(0, win.length - TPS_ROLLING_WINDOW)
      this.tpsWindow.set(model, win)
    }

    if (entry.latency_ms !== null) {
      // latency 每条消息都有，但保持一致使用专用计数
      stats.latencyCount++
      const c = stats.latencyCount
      const prev = stats.avgLatency
      stats.avgLatency = prev !== null ? prev + (entry.latency_ms - prev) / c : entry.latency_ms
      stats.maxLatency = stats.maxLatency !== null ? Math.max(stats.maxLatency, entry.latency_ms) : entry.latency_ms
      stats.minLatency = stats.minLatency !== null ? Math.min(stats.minLatency, entry.latency_ms) : entry.latency_ms
      // 收集原始样本用于分位数计算（有界）
      const latArr = this.latencySamples.get(model) ?? []
      this.pushSample(latArr, entry.latency_ms)
      this.latencySamples.set(model, latArr)
    }
  }

  getSessionStats(): SessionPerfStats {
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
    let totalRequests = 0, totalCost = 0
    let weightedHitSum = 0, totalReqForHit = 0

    for (const [model, s] of this.statsMap) {
      totalInput += s.totalInput
      totalOutput += s.totalOutput
      totalCacheRead += s.totalCacheRead
      totalCacheWrite += s.totalCacheWrite
      totalRequests += s.requestCount
      totalCost += s.totalCost

      // 说明：这里刻意不再计算 p50/p95/p99 分位数。
      // 侧边栏只展示 avgTTFT / recentTPS / avgLatency；分位数仅用于 HTML 报告，
      // 由 stats-store.readPersistedStats() 负责。此前每次渲染都对全量样本排序，
      // 是流式期间的 CPU 热点，故移除（分位数字段在会话态保持 null）。

      // 滚动"瞬时"TPS：最近 N 次请求的平均，随每次思考变动
      const win = this.tpsWindow.get(model) ?? []
      s.recentTPS = win.length > 0 ? win.reduce((a, b) => a + b, 0) / win.length : s.avgTPS

      // 模型级缓存命中率
      const denom = s.totalInput + s.totalCacheRead
      s.cacheHitRate = denom > 0 ? (s.totalCacheRead / denom) * 100 : null

      // 累加加权命中率（按请求数加权）
      if (s.cacheHitRate !== null) {
        weightedHitSum += s.cacheHitRate * s.requestCount
        totalReqForHit += s.requestCount
      }
    }

    const weightedCacheHitRate = totalReqForHit > 0 ? weightedHitSum / totalReqForHit : null

    return {
      models: Object.fromEntries(this.statsMap),
      totals: { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalRequests, totalCost, weightedCacheHitRate },
    }
  }

  readLogs(last: number = 50): LogEntry[] {
    const entries = this.readLogEntriesSync()
    return entries.length > last ? entries.slice(entries.length - last) : entries
  }

  reset(): void {
    this.firstPartTimes.clear()
    this.statsMap.clear()
    this.ttftSamples.clear()
    this.latencySamples.clear()
    this.reasoningMessages.clear()
    this.tpsWindow.clear()
  }

  /**
   * 异步载入指定会话的历史性能统计。
   * 相比旧版同步 loadSession，改为 fs/promises 读取 + mtime 缓存，避免切换会话时
   * 同步读取整个 JSONL 阻塞 UI 线程；完成后通过 onDone 触发一次重绘。
   */
  async loadSessionAsync(sessionID: string, onDone?: () => void): Promise<void> {
    this.reset()
    if (!sessionID) {
      onDone?.()
      return
    }
    try {
      const entries = await this.readLogEntriesAsync()
      for (const entry of entries) {
        if (entry.sessionID === sessionID) {
          this.updateStats(entry.model, entry)
        }
      }
    } catch {
      // Non-critical loading failure
    }
    onDone?.()
  }
}

export function createPerfTracker(): PerfTracker {
  return new PerfTracker()
}
export type { PartEvent, PerfTracker }
export function readLogs(last: number = 50): LogEntry[] {
  const tracker = new PerfTracker()
  return tracker.readLogs(last)
}
