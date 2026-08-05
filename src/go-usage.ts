/**
 * go-usage.ts — OpenCode Go 订阅用量获取
 *
 * 目标：在侧边栏展示与 https://opencode.ai/workspace/{id}/go 网页一致的用量：
 * 滚动窗口 / 本周 / 本月 各自的已用百分比与重置倒计时。
 *
 * 数据获取（无公开 REST API，按序降级）：
 *  ① POST 页面 RPC（SolidStart server function 调用格式）
 *  ② POST 页面 RPC（JSON body 备选格式）
 *  ③ GET 页面 HTML，从 SSR 渲染结果中解析
 *
 * 请求策略（纯事件驱动，无定时器）：
 *  - 首次挂载懒加载；message.updated（assistant 完成）与 session.idle 时刷新
 *  - 10s 节流（合并连续轮次）+ 30s 结果缓存（命中不发网络）
 *  - 失败保留上次成功数据，下一轮自动重试
 */

import type { GoBucket, GoUsageData } from "./formatter.js"

const BASE = "https://opencode.ai"
const MIN_INTERVAL_MS = 10_000
const CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 10_000

function pageUrl(workspaceID: string): string {
  return `${BASE}/workspace/${encodeURIComponent(workspaceID)}/go`
}

function withCookie(cookie: string): string {
  if (!cookie) return ""
  // 用户可能只粘贴了 session 值（Fe26.2**...），为其补上 opencode.ai 实际使用的 cookie 名
  // （与 opencode-go-usage 插件保持一致：Cookie: auth=...）
  return /[;=]/.test(cookie) ? cookie : `auth=${cookie}`
}

async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────
// RPC 尝试 ①/②：POST SolidStart server function
// ─────────────────────────────────────────────

async function tryRpc(workspaceID: string, cookie: string): Promise<GoUsageData | null> {
  const url = pageUrl(workspaceID)
  const args = JSON.stringify([workspaceID])
  const attempts: Array<{ name: string; init: RequestInit }> = [
    {
      name: "rpc-form",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: withCookie(cookie),
        },
        body: `_data=${encodeURIComponent(JSON.stringify({ key: "lite.subscription.get", args: [workspaceID] }))}`,
      },
    },
    {
      name: "rpc-json",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: withCookie(cookie),
        },
        body: JSON.stringify([args, "lite.subscription.get"]),
      },
    },
  ]

  for (const attempt of attempts) {
    try {
      const res = await httpFetch(url, attempt.init)
      if (!res.ok) continue
      const text = await res.text()
      if (!text) continue
      // 页面可能是完整 HTML（说明 RPC 未命中），跳过
      if (text.trimStart().startsWith("<")) continue
      let data: any
      try { data = JSON.parse(text) } catch { continue }
      const parsed = normalizePayload(data)
      if (parsed) return parsed
    } catch {
      // 尝试下一个
    }
  }
  return null
}

function normalizePayload(data: any): GoUsageData | null {
  const rolling = bucketFrom(data?.rollingUsage)
  const weekly = bucketFrom(data?.weeklyUsage)
  const monthly = bucketFrom(data?.monthlyUsage)
  if (!rolling && !weekly && !monthly) return null
  return {
    rolling: rolling ?? { percent: 0, resetInSec: 0 },
    weekly: weekly ?? { percent: 0, resetInSec: 0 },
    monthly: monthly ?? { percent: 0, resetInSec: 0 },
    fetchedAt: Date.now(),
  }
}

function bucketFrom(u: any): GoBucket | null {
  if (!u || typeof u !== "object") return null
  const percent = Number(u.usagePercent)
  const reset = Number(u.resetInSec)
  if (!Number.isFinite(percent)) return null
  return { percent, resetInSec: Number.isFinite(reset) ? reset : 0 }
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
// RPC 尝试 ③：GET 页面 HTML + 解析 SSR 数据
// ─────────────────────────────────────────────

function parseHtml(html: string): GoUsageData | null {
  if (!html) return null

  // 首选：SolidStart 序列化格式（opencode.ai 实际使用的格式）
  // 形如  rollingUsage:$R[0]={status:"ok",resetInSec:10586,usagePercent:8}
  const bucketFromSSR = (key: string): GoBucket | null => {
    const m = html.match(new RegExp(`${key}:\\$R\\[\\d+\\]=(\\{[^}]+\\})`))
    if (!m) return null
    try {
      // 键未加引号，手动补齐后解析
      const jsonStr = m[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3')
      const obj = JSON.parse(jsonStr)
      const percent = Number(obj.usagePercent)
      const reset = Number(obj.resetInSec)
      if (!Number.isFinite(percent)) return null
      return { percent, resetInSec: Number.isFinite(reset) ? reset : 0 }
    } catch {
      return null
    }
  }

  const rolling = bucketFromSSR("rollingUsage")
  const weekly = bucketFromSSR("weeklyUsage")
  const monthly = bucketFromSSR("monthlyUsage")
  if (rolling && weekly && monthly) {
    return { rolling, weekly, monthly, fetchedAt: Date.now() }
  }

  // 优先：从序列化 JSON 中提取 usagePercent/resetInSec 成对值（任意顺序）
  const pairs: Array<{ percent: number; reset: number }> = []
  const pairRe = /"usagePercent"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"resetInSec"\s*:\s*(\d+)/g
  const pairRe2 = /"resetInSec"\s*:\s*(\d+)\s*,\s*"usagePercent"\s*:\s*(\d+(?:\.\d+)?)/g
  for (const m of html.matchAll(pairRe)) pairs.push({ percent: Number(m[1]), reset: Number(m[2]) })
  for (const m of html.matchAll(pairRe2)) pairs.push({ percent: Number(m[2]), reset: Number(m[1]) })
  if (pairs.length >= 3) {
    const pick = (i: number) => ({
      percent: pairs[i]?.percent ?? 0,
      resetInSec: pairs[i]?.reset ?? 0,
    })
    return {
      rolling: pick(0),
      weekly: pick(1),
      monthly: pick(2),
      fetchedAt: Date.now(),
    }
  }

  // 兜底：从渲染的 slot 提取百分比与重置文案
  const percents: number[] = []
  for (const m of html.matchAll(/data-slot="usage-value">\s*(\d+(?:\.\d+)?)%/g)) {
    percents.push(Number(m[1]))
  }
  if (percents.length < 3) return null
  const resets: string[] = []
  for (const m of html.matchAll(/data-slot="reset-time">([^<]*)</g)) {
    resets.push(m[1])
  }
  const pickPct = (i: number) => percents[i] ?? 0
  return {
    rolling: { percent: pickPct(0), resetInSec: parseHumanDuration(resets[0]) },
    weekly: { percent: pickPct(1), resetInSec: parseHumanDuration(resets[1]) },
    monthly: { percent: pickPct(2), resetInSec: parseHumanDuration(resets[2]) },
    fetchedAt: Date.now(),
  }
}

/** 解析 "12 minutes" / "3 hours" / "5 days" 之类的文案为秒 */
function parseHumanDuration(text: string | undefined): number {
  if (!text) return 0
  const m = text.match(/(\d+(?:\.\d+)?)\s*(second|minute|hour|day|秒|分钟|小时|天)s?/i)
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  if (unit.startsWith("second") || unit === "秒") return Math.round(n)
  if (unit.startsWith("minute") || unit === "分钟") return Math.round(n * 60)
  if (unit.startsWith("hour") || unit === "小时") return Math.round(n * 3600)
  return Math.round(n * 86400)
}

// ─────────────────────────────────────────────
// 公开工厂
// ─────────────────────────────────────────────

export interface GoUsageFetcher {
  data: () => GoUsageData | null
  refresh: (force?: boolean) => void
  setConfig: (workspaceID: string, cookie: string) => void
  subscribe: (fn: () => void) => () => void
}

export function createGoUsageFetcher(): GoUsageFetcher {
  let workspaceID = ""
  let cookie = ""
  let cache: GoUsageData | null = null
  let lastFetchAt = 0
  let inFlight: Promise<void> | null = null
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const fn of listeners) fn()
  }

  async function doFetch(): Promise<{ data: GoUsageData | null; error?: string }> {
    if (!workspaceID || !cookie) return { data: null, error: "fetch-failed" }
    let data = await tryRpc(workspaceID, cookie)
    if (!data) {
      try {
        const res = await httpFetch(pageUrl(workspaceID), {
          method: "GET",
          headers: { Cookie: withCookie(cookie) },
        })
        if (res.status === 401 || res.status === 403) {
          return { data: null, error: "auth-failed" }
        }
        if (res.ok) data = parseHtml(await res.text())
      } catch {
        return { data: null, error: "fetch-failed" }
      }
    }
    return { data, error: data ? undefined : "fetch-failed" }
  }

  function refresh(force = false): void {
    const now = Date.now()
    if (!force && now - lastFetchAt < MIN_INTERVAL_MS) return
    if (!force && cache && now - cache.fetchedAt < CACHE_TTL_MS) return
    if (inFlight) return
    lastFetchAt = now

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
    setConfig: (ws, ck) => {
      workspaceID = ws
      cookie = ck
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
