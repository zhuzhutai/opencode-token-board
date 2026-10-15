/**
 * stats-store.ts — 持久化聚合统计存储
 *
 * 设计目标：将性能指标的"聚合统计"与"原始 JSONL 日志"彻底解耦。
 * - 每次请求完成时，通过 updatePersistedStats() 增量写入 JSON 统计文件
 * - 统计文件永久累积，不受 JSONL 日志轮转/窗口限制影响
 * - 百分位数采用 Reservoir Sampling 保持有界内存占用
 * - 首次启动时自动从现有 JSONL 日志迁移，不丢失历史数据
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { LogEntry, ModelPerfStats } from "./formatter.js"
import { computeTps } from "./formatter.js"

const STATS_PATH = join(homedir(), ".opencode", "tokenwatch-stats.json")
const LOG_PATH = join(homedir(), ".opencode", "tokenwatch.jsonl")
const RESERVOIR_SIZE = 500   // 每个指标最多保留的原始样本数
// v2: TPS 分子纳入 reasoning token（旧版仅用 output，系统性低估生成速度）
const CURRENT_VERSION = 2

/** 持久化存储的单模型统计（含原始样本用于分位数计算） */
interface PersistedModelStats {
  model: string
  providerID: string
  requestCount: number
  ttftCount: number
  tpsCount: number
  latencyCount: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCost: number
  avgTTFT: number | null
  maxTTFT: number | null
  minTTFT: number | null
  avgTPS: number | null
  maxTPS: number | null
  minTPS: number | null
  avgLatency: number | null
  maxLatency: number | null
  minLatency: number | null
  /** TTFT 原始样本（Reservoir Sampling，最多 RESERVOIR_SIZE 条） */
  ttftReservoir: number[]
  /** 端到端延迟原始样本 */
  latencyReservoir: number[]
}

interface StatsFile {
  version: number
  updatedAt: string
  /** 是否已完成从 JSONL 日志的一次性迁移 */
  migratedFromLogs: boolean
  models: Record<string, PersistedModelStats>
}

// ─────────────────────────────────────────────
// 内部 I/O 工具
// ─────────────────────────────────────────────

// 进程内缓存 + 防抖落盘：
// 旧实现每次请求都「读整个统计文件 → 改 → 写回」，文件越大每次响应越慢。
// 现在统计文件只在进程内维护一份，写入合并为最多每 800ms 一次。
let cachedFile: StatsFile | null = null
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function loadStatsFile(): StatsFile {
  if (cachedFile) return cachedFile
  try {
    if (existsSync(STATS_PATH)) {
      const content = readFileSync(STATS_PATH, "utf-8")
      const parsed = JSON.parse(content) as StatsFile
      if (parsed?.version === CURRENT_VERSION && parsed.models) {
        cachedFile = parsed
        return cachedFile
      }
    }
  } catch { /* 文件损坏时返回空白统计 */ }
  cachedFile = { version: CURRENT_VERSION, updatedAt: "", migratedFromLogs: false, models: {} }
  return cachedFile
}

/** 立即落盘（仅在 dirty 时）。 */
function flushStatsFile(): void {
  if (!cachedFile || !dirty) return
  dirty = false
  try {
    cachedFile.updatedAt = new Date().toISOString()
    writeFileSync(STATS_PATH, JSON.stringify(cachedFile), "utf-8")
  } catch { /* 写入失败不影响主流程 */ }
}

/** 标记脏并安排一次防抖落盘。 */
function scheduleFlush(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushStatsFile()
  }, 800)
  ;(flushTimer as any).unref?.()
}

/** 仅供测试/诊断：丢弃进程内缓存（下次读取重新从磁盘加载）。 */
export function resetStatsCache(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  flushStatsFile()
  cachedFile = null
  dirty = false
}

// ─────────────────────────────────────────────
// Reservoir Sampling（有界样本更新）
// ─────────────────────────────────────────────

/**
 * Reservoir Sampling 算法：保证内存有界的同时，给每个观测值相同的入选概率，
 * 使分位数估算在统计意义上无偏。
 *
 * @param reservoir 当前样本数组（会被原地返回新引用）
 * @param value 新观测值
 * @param totalCount 加入此值后的总观测数
 */
function reservoirAdd(reservoir: number[], value: number, totalCount: number): number[] {
  if (reservoir.length < RESERVOIR_SIZE) {
    return [...reservoir, value]
  }
  // 以 RESERVOIR_SIZE/totalCount 的概率替换随机位置
  const j = Math.floor(Math.random() * totalCount)
  if (j < RESERVOIR_SIZE) {
    const next = [...reservoir]
    next[j] = value
    return next
  }
  return reservoir
}

// ─────────────────────────────────────────────
// 核心增量更新逻辑（可复用于单条 & 批量迁移）
// ─────────────────────────────────────────────

/**
 * 从日志条目还原"修正后"的 TPS。
 *
 * 迁移历史日志时，旧条目的 `tps` 字段是用 output/genMs 算出的（漏掉了 reasoning），
 * 不能直接信任。这里用同一条目的 latency_ms 与 ttft_ms 反推生成窗口
 * （latency - ttft == completed - firstPart == genMs），再按新口径重算，
 * 从而让全量历史统计与新版一致。
 */
function effectiveTps(entry: LogEntry): number | null {
  const genMs = entry.latency_ms != null && entry.ttft_ms != null
    ? entry.latency_ms - entry.ttft_ms
    : null
  return computeTps(entry.outputTokens, entry.reasoningTokens, genMs) ?? entry.tps
}

function applyEntryToModels(models: Record<string, PersistedModelStats>, entry: LogEntry): void {
  const key = entry.model
  let s = models[key]
  if (!s) {
    s = {
      model: entry.model,
      providerID: entry.providerID,
      requestCount: 0,
      ttftCount: 0,
      tpsCount: 0,
      latencyCount: 0,
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalCost: 0,
      avgTTFT: null, maxTTFT: null, minTTFT: null,
      avgTPS: null, maxTPS: null, minTPS: null,
      avgLatency: null, maxLatency: null, minLatency: null,
      ttftReservoir: [],
      latencyReservoir: [],
    }
    models[key] = s
  }

  s.requestCount++
  s.totalInput += entry.inputTokens
  s.totalOutput += entry.outputTokens
  s.totalCacheRead += entry.cacheReadTokens
  s.totalCacheWrite += entry.cacheWriteTokens
  s.totalCost += entry.cost

  if (entry.ttft_ms != null) {
    s.ttftCount++
    const c = s.ttftCount
    s.avgTTFT = s.avgTTFT != null ? s.avgTTFT + (entry.ttft_ms - s.avgTTFT) / c : entry.ttft_ms
    s.maxTTFT = s.maxTTFT != null ? Math.max(s.maxTTFT, entry.ttft_ms) : entry.ttft_ms
    s.minTTFT = s.minTTFT != null ? Math.min(s.minTTFT, entry.ttft_ms) : entry.ttft_ms
    s.ttftReservoir = reservoirAdd(s.ttftReservoir, entry.ttft_ms, s.ttftCount)
  }

  // 新日志（带 reasoningStreamed 标记）直接信任 tracker 写入的 tps；
  // 旧日志（无该字段）用修正口径重算，保证迁移后历史数据不低估。
  const tps = entry.reasoningStreamed === undefined ? effectiveTps(entry) : entry.tps
  if (tps != null) {
    s.tpsCount++
    const c = s.tpsCount
    s.avgTPS = s.avgTPS != null ? s.avgTPS + (tps - s.avgTPS) / c : tps
    s.maxTPS = s.maxTPS != null ? Math.max(s.maxTPS, tps) : tps
    s.minTPS = s.minTPS != null ? Math.min(s.minTPS, tps) : tps
  }

  if (entry.latency_ms != null) {
    s.latencyCount++
    const c = s.latencyCount
    s.avgLatency = s.avgLatency != null ? s.avgLatency + (entry.latency_ms - s.avgLatency) / c : entry.latency_ms
    s.maxLatency = s.maxLatency != null ? Math.max(s.maxLatency, entry.latency_ms) : entry.latency_ms
    s.minLatency = s.minLatency != null ? Math.min(s.minLatency, entry.latency_ms) : entry.latency_ms
    s.latencyReservoir = reservoirAdd(s.latencyReservoir, entry.latency_ms, s.latencyCount)
  }
}

// ─────────────────────────────────────────────
// 一次性迁移：从 JSONL 日志重建初始统计
// ─────────────────────────────────────────────

/**
 * 如果统计文件尚未完成迁移，则读取全量 JSONL 日志并批量写入统计文件。
 * 只在首次调用 readPersistedStats() 时执行一次，之后通过 migratedFromLogs 标志跳过。
 */
function migrateFromLogsIfNeeded(file: StatsFile): boolean {
  if (file.migratedFromLogs) return false
  if (!existsSync(LOG_PATH)) {
    file.migratedFromLogs = true
    return true
  }
  try {
    const content = readFileSync(LOG_PATH, "utf-8").trim()
    if (!content) {
      file.migratedFromLogs = true
      return true
    }
    let migrated = 0
    for (const line of content.split("\n")) {
      if (!line) continue
      try {
        const entry = JSON.parse(line) as LogEntry
        if (entry.model && entry.ts) {
          applyEntryToModels(file.models, entry)
          migrated++
        }
      } catch { /* 跳过格式损坏的行 */ }
    }
    file.migratedFromLogs = true
    if (migrated > 0) {
      // 标记本次迁移来源，便于调试
      ;(file as any)._migratedFrom = `${LOG_PATH} (${migrated} entries)`
    }
    return true
  } catch {
    // 迁移失败时仍标记为已完成，避免每次都重试（下次重建会通过 updatePersistedStats 增量补充）
    file.migratedFromLogs = true
    return true
  }
}

// ─────────────────────────────────────────────
// 分位数计算
// ─────────────────────────────────────────────

function percentile(arr: number[], p: number): number | null {
  if (arr.length === 0) return null
  if (arr.length === 1) return arr[0]
  const idx = (p / 100) * (arr.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return arr[lo]
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo)
}

// ─────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────

/**
 * 将一条新的日志条目增量更新到持久化统计文件。
 * 在 perf-tracker.ts 的 appendLog() 之后调用。
 *
 * 设计原则：本函数只做增量更新，迁移逻辑由 readPersistedStats() 负责。
 * 这样可以避免迁移与增量更新之间的竞态问题。
 */
export function updatePersistedStats(entry: LogEntry): void {
  try {
    const file = loadStatsFile()
    applyEntryToModels(file.models, entry)
    // 只改内存 + 标记脏，实际写盘由防抖合并（避免每次请求都同步读写整个文件）
    scheduleFlush()
  } catch { /* 统计写入失败不影响主流程 */ }
}

/**
 * 读取所有持久化统计，返回 ModelPerfStats 数组（含分位数）。
 * 用于 HTML 报告生成，替代 aggregatePerfStats(readLogs(N)) 的有限窗口方案。
 */
export function readPersistedStats(): ModelPerfStats[] {
  try {
    const file = loadStatsFile()
    // 如果尚未迁移（例如首次生成报告前没有任何请求），执行迁移
    // 迁移时先清空 models，以 JSONL 全量数据为唯一权威来源，
    // 避免与 updatePersistedStats 先写入的零散增量数据叠加导致重复计数。
    if (!file.migratedFromLogs) {
      file.models = {}  // 清空，让迁移从零开始重建
      migrateFromLogsIfNeeded(file)
      dirty = true
      flushStatsFile()
    }

    return Object.values(file.models).map(s => {
      const ttftArr = [...s.ttftReservoir].sort((a, b) => a - b)
      const latArr = [...s.latencyReservoir].sort((a, b) => a - b)
      const denom = s.totalInput + s.totalCacheRead
      return {
        model: s.model,
        providerID: s.providerID,
        requestCount: s.requestCount,
        ttftCount: s.ttftCount,
        tpsCount: s.tpsCount,
        latencyCount: s.latencyCount,
        totalInput: s.totalInput,
        totalOutput: s.totalOutput,
        totalCacheRead: s.totalCacheRead,
        totalCacheWrite: s.totalCacheWrite,
        totalCost: s.totalCost,
        avgTTFT: s.avgTTFT,
        maxTTFT: s.maxTTFT,
        minTTFT: s.minTTFT,
        p50TTFT: percentile(ttftArr, 50),
        p95TTFT: percentile(ttftArr, 95),
        p99TTFT: percentile(ttftArr, 99),
        avgTPS: s.avgTPS,
        maxTPS: s.maxTPS,
        minTPS: s.minTPS,
        recentTPS: null,
        avgLatency: s.avgLatency,
        maxLatency: s.maxLatency,
        minLatency: s.minLatency,
        p50Latency: percentile(latArr, 50),
        p95Latency: percentile(latArr, 95),
        p99Latency: percentile(latArr, 99),
        cacheHitRate: denom > 0 ? (s.totalCacheRead / denom) * 100 : null,
      }
    })
  } catch {
    return []
  }
}
