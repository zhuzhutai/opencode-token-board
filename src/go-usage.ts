/**
 * go-usage.ts — OpenCode Go 套餐用量获取（V2：官方 API + 已存凭证）
 *
 * 目标：在侧边栏展示与 Go 套餐一致的用量：滚动(5h) / 本周 / 本月 已用百分比 + 重置倒计时。
 *
 * 数据源（V2 重写）：
 *   GET https://opencode.ai/inference/go/v1/usage
 *   Authorization: Bearer <OpenCode 的 OAuth access token>
 *   → { usage: { rolling:{status,percent,resetsAt}, weekly:{...}, monthly:{...} } }
 *
 * 凭证：不再手填 Workspace/Cookie。token 由注入的 `resolveToken` 提供 —— 插件用
 * `context.client.credential.list()` 取 opencode 集成的 active OAuth 凭证 `.value.access`
 * （opencode 自己管理、自动刷新）。请求失败(401/403)时清 token 下次重取。
 *
 * 请求策略（纯事件驱动，无常量轮询）：
 *  - 创建后首次立即刷新；assistant 完成 / session.idle / 点击标题时刷新
 *  - 10s 节流 + 30s 结果缓存
 *  - 失败保留上次成功数据并标记 error，下一轮自动重试
 *
 * V1 的三种抓取法（RPC / SSR HTML 解析）在 V2 已失效（页面不再 SSR、RPC 鉴权变更），全部移除。
 */

import type { GoUsageData, GoBucket } from "./formatter.js"

const USAGE_URL = "https://opencode.ai/inference/go/v1/usage"
const MIN_INTERVAL_MS = 10_000
const CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 10_000

/** 注入的 token 解析器：返回 OpenCode OAuth access token（未登录/无凭证返回 undefined）。 */
export type TokenResolver = () => Promise<string | undefined>

/** resetsAt(ISO) → 距重置秒数（已过期为 0）。 */
function resetsInSec(iso: unknown): number {
  if (typeof iso !== "string" || !iso) return 0
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.round((t - Date.now()) / 1000))
}

function mapBucket(b: unknown): GoBucket {
  const o = b as { percent?: number; resetsAt?: string } | null | undefined
  if (!o) return { percent: -1, resetInSec: 0 }
  const pct = typeof o.percent === "number" ? o.percent : -1
  return { percent: pct, resetInSec: resetsInSec(o.resetsAt) }
}

function mapResponse(json: unknown): GoUsageData | null {
  const usage = (json as { usage?: Record<string, unknown> })?.usage
  if (!usage) return null
  return {
    rolling: mapBucket(usage.rolling),
    weekly: mapBucket(usage.weekly),
    monthly: mapBucket(usage.monthly),
    fetchedAt: Date.now(),
  }
}

function errorPayload(prev: GoUsageData | null, err: string): GoUsageData {
  // 保留上次成功数据，只标记错误；无历史则用占位桶
  const placeholder: GoBucket = { percent: -1, resetInSec: 0 }
  const base = prev ?? { rolling: placeholder, weekly: placeholder, monthly: placeholder, fetchedAt: Date.now() }
  return { ...base, error: err, fetchedAt: Date.now() }
}

export interface GoUsageFetcher {
  data: () => GoUsageData | null
  refresh: (force?: boolean) => void
  subscribe: (fn: () => void) => () => void
}

export function createGoUsageFetcher(resolveToken: TokenResolver): GoUsageFetcher {
  let cache: GoUsageData | null = null
  let lastFetchAt = 0
  let inFlight: Promise<void> | null = null
  let token: string | undefined
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const fn of listeners) fn()
  }

  async function doFetch(): Promise<void> {
    // 首次或上次 401 后重新解析 token
    if (!token) {
      try { token = await resolveToken() } catch { token = undefined }
    }
    if (!token) {
      // 无凭证：不写 cache（侧边栏据此隐藏 Go 区块）
      return
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(USAGE_URL, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (res.status === 401 || res.status === 403) {
        token = undefined // token 过期 → 下轮重取
        cache = errorPayload(cache, "auth-failed")
        return
      }
      if (!res.ok) {
        cache = errorPayload(cache, "fetch-failed")
        return
      }
      const mapped = mapResponse(await res.json())
      if (mapped) cache = mapped
      else cache = errorPayload(cache, "fetch-failed")
    } catch {
      cache = errorPayload(cache, "fetch-failed")
    }
  }

  function refresh(force = false): void {
    const now = Date.now()
    if (!force && now - lastFetchAt < MIN_INTERVAL_MS) return
    if (!force && cache && !cache.error && now - cache.fetchedAt < CACHE_TTL_MS) return
    if (inFlight) return
    lastFetchAt = now
    inFlight = doFetch().finally(() => {
      inFlight = null
      notify()
    })
  }

  // 创建即拉一次，尽早拿到凭证与数据
  refresh(true)

  return {
    data: () => cache,
    refresh,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
