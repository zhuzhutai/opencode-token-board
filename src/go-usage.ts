/**
 * go-usage.ts — OpenCode Go 订阅用量获取（新版 API）
 *
 * 背景：opencode.ai 改版后，旧方案（/workspace/{id}/go 页面 + lite.subscription.get
 * RPC + SSR 解析 + 浏览器 Cookie）整体失效。新 console 为 SPA，页面数据走
 * /console/api/go/status 且依赖 OIDC 会话 Cookie，无法在插件里稳定复用。
 *
 * 现方案：直接调用推理 API 同源的用量接口（Go API Key 即可，无需 Cookie/Workspace）：
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <Go API Key>
 *   → {"usage":{"rolling":{"status","percent","resetsAt"},
 *               "weekly":{...},"monthly":{...}}}
 *
 * API Key 解析顺序：
 *   ① 插件配置显式传入（go.apiKey）
 *   ② ~/.local/share/opencode/auth.json 的 opencode-go / opencode
 *   ③ ~/.config/opencode/opencode.json[c] 的 provider.go.options.apiKey
 *
 * 刷新策略（与旧版一致）：事件驱动、无定时器；10s 节流 + 30s 结果缓存；
 * 失败保留上次成功数据，下一轮自动重试。
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { GoBucket, GoUsageData } from "./formatter.js"

const BASE = "https://opencode.ai"
const USAGE_URL = `${BASE}/zen/go/v1/usage`
const MIN_INTERVAL_MS = 10_000
const CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 10_000

// ─────────────────────────────────────────────
// API Key 解析
// ─────────────────────────────────────────────

/** 读取 OpenCode 凭据库：opencode-go 优先，其次 opencode */
function readAuthJsonKey(): string {
  try {
    const file = join(homedir(), ".local", "share", "opencode", "auth.json")
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, any>
    return raw?.["opencode-go"]?.key || raw?.["opencode"]?.key || ""
  } catch {
    return ""
  }
}

/** 读取 opencode.json[c] 中 provider.go.options.apiKey（JSONC 走正则兜底） */
function readConfigKey(): string {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try {
      const text = readFileSync(join(homedir(), ".config", "opencode", name), "utf-8")
      try {
        const obj = JSON.parse(text)
        const k = obj?.provider?.go?.options?.apiKey
        if (typeof k === "string" && k) return k
      } catch {
        // JSONC（含注释）→ 退化为定位 provider.go 块后的 apiKey
        const block = text.match(/"go"\s*:\s*\{[\s\S]*?"options"\s*:\s*\{[\s\S]*?"apiKey"\s*:\s*"([^"]+)"/)
        if (block?.[1]) return block[1]
      }
    } catch {
      // 文件不存在则尝试下一个
    }
  }
  return ""
}

function discoverApiKey(): string {
  return readAuthJsonKey() || readConfigKey()
}

// ─────────────────────────────────────────────
// 响应解析
// ─────────────────────────────────────────────

function resetSeconds(resetsAt: unknown): number {
  if (typeof resetsAt !== "string") return 0
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.round((t - Date.now()) / 1000))
}

function bucketFrom(u: any): GoBucket | null {
  if (!u || typeof u !== "object") return null
  const percent = Number(u.percent)
  if (!Number.isFinite(percent)) return null
  return { percent, resetInSec: resetSeconds(u.resetsAt) }
}

function normalizePayload(data: any): GoUsageData | null {
  const u = data?.usage ?? data
  const rolling = bucketFrom(u?.rolling)
  const weekly = bucketFrom(u?.weekly)
  const monthly = bucketFrom(u?.monthly)
  if (!rolling && !weekly && !monthly) return null
  return {
    rolling: rolling ?? { percent: 0, resetInSec: 0 },
    weekly: weekly ?? { percent: 0, resetInSec: 0 },
    monthly: monthly ?? { percent: 0, resetInSec: 0 },
    fetchedAt: Date.now(),
  }
}

function errorPayload(err: string): GoUsageData {
  return {
    rolling: { percent: -1, resetInSec: 0 },
    weekly: { percent: -1, resetInSec: 0 },
    monthly: { percent: -1, resetInSec: 0 },
    fetchedAt: Date.now(),
    error: err,
  }
}

// ─────────────────────────────────────────────
// 公开工厂
// ─────────────────────────────────────────────

export interface GoUsageFetcher {
  data: () => GoUsageData | null
  refresh: (force?: boolean) => void
  setConfig: (apiKey: string) => void
  configured: () => boolean
  subscribe: (fn: () => void) => () => void
}

export function createGoUsageFetcher(): GoUsageFetcher {
  let explicitKey = ""
  let discoveredKey = ""
  let discoveryDone = false
  let cache: GoUsageData | null = null
  let lastFetchAt = 0
  let inFlight: Promise<void> | null = null
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const fn of listeners) fn()
  }

  /** 显式配置优先；否则自动发现一次并缓存（下次强制刷新时重新发现） */
  function currentKey(): string {
    if (explicitKey) return explicitKey
    if (!discoveryDone) {
      discoveredKey = discoverApiKey()
      discoveryDone = true
    }
    return discoveredKey
  }

  async function doFetch(): Promise<{ data: GoUsageData | null; error?: string }> {
    const key = currentKey()
    if (!key) return { data: null, error: "no-key" }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(USAGE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: controller.signal,
      })
      if (res.status === 401 || res.status === 403) return { data: null, error: "auth-failed" }
      if (!res.ok) return { data: null, error: "fetch-failed" }
      const json = await res.json().catch(() => null)
      const data = normalizePayload(json)
      return { data, error: data ? undefined : "fetch-failed" }
    } catch {
      return { data: null, error: "fetch-failed" }
    } finally {
      clearTimeout(timer)
    }
  }

  function refresh(force = false): void {
    const now = Date.now()
    if (!force && now - lastFetchAt < MIN_INTERVAL_MS) return
    if (!force && cache && now - cache.fetchedAt < CACHE_TTL_MS) return
    if (inFlight) return
    lastFetchAt = now
    // 强制刷新时重新发现凭据，便于用户补上 auth.json / 配置后自动生效
    if (force && !explicitKey) discoveryDone = false

    inFlight = doFetch()
      .then(({ data, error }) => {
        if (data) {
          cache = data
        } else {
          const err = error ?? "fetch-failed"
          cache = cache && !cache.error ? { ...cache, error: err } : cache ? cache : errorPayload(err)
        }
      })
      .catch(() => {
        if (cache) cache = { ...cache, error: "fetch-failed" }
        else cache = errorPayload("fetch-failed")
      })
      .finally(() => {
        inFlight = null
        notify()
      })
  }

  return {
    data: () => cache,
    refresh,
    configured: () => !!currentKey(),
    setConfig: (apiKey) => {
      const next = (apiKey ?? "").trim()
      if (next !== explicitKey) explicitKey = next
      // 显式 key 变化时重新发现为空，避免沿用旧值
      if (!explicitKey) discoveredKey = ""
      lastFetchAt = 0
      // 保留旧数据直到新数据返回，避免刷新瞬间闪成空白
      refresh(true)
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
