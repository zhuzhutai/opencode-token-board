/**
 * go-usage.ts — OpenCode Go 套餐用量获取（V2：官方 API + 已存凭证）
 *
 * 目标：在侧边栏展示与 Go 套餐一致的用量：滚动(5h) / 本周 / 本月 已用百分比 + 重置倒计时。
 *
 * 数据源（V2 重写）：
 *   GET https://opencode.ai/inference/go/v1/usage
 *   Authorization: Bearer <API Key 或 Console OAuth token>
 *   → { usage: { rolling:{status,percent,resetsAt}, weekly:{...}, monthly:{...} } }
 *
 * 凭证：不再手填 Workspace/Cookie。token 由注入的 `resolveToken` 提供 —— 插件用
 * `context.client.credential.list()` 取值，兼容两种接入方式（实测两种 token 都能调通该端点）：
 *   · API Key：`opencode-go`（首选）/ `opencode` 集成的 `.value.key` —— 绝大多数用户是这种
 *   · Console OAuth：`opencode` 集成的 `.value.access`
 * 解析优先级见 `pickGoToken`。无凭证时侧边栏显示占位提示而非静默隐藏。
 *
 * 请求策略（纯事件驱动，无常量轮询）：
 *  - 创建后首次立即刷新；assistant 完成 / session.idle / 点击标题时刷新
 *  - 10s 节流 + 30s 结果缓存
 *  - 失败保留上次成功数据并标记 error，下一轮自动重试
 *  - 关键失败路径打 `console.warn`（进 opencode 日志），便于远程排障
 *
 * V1 的三种抓取法（RPC / SSR HTML 解析）在 V2 已失效（页面不再 SSR、RPC 鉴权变更），全部移除。
 */

import type { GoUsageData, GoBucket } from "./formatter.js"

/** 日志前缀：便于在 ~/.local/share/opencode/log/opencode.log 里检索。 */
const LOG_PREFIX = "[opencode-token-board] Go usage"

function warn(msg: string, detail?: unknown): void {
  try {
    if (detail === undefined) console.warn(`${LOG_PREFIX}: ${msg}`)
    else console.warn(`${LOG_PREFIX}: ${msg}`, detail)
  } catch { /* 日志不可用不影响主流程 */ }
}

const USAGE_URL = "https://opencode.ai/inference/go/v1/usage"
const MIN_INTERVAL_MS = 10_000
const CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 10_000

/** 注入的 token 解析器：返回 OpenCode 凭证 token（未登录/无凭证返回 undefined）。 */
export type TokenResolver = () => Promise<string | undefined>

/**
 * 凭证条目的结构化最小视图（避免对 @opencode/client 的编译期依赖，便于单测）。
 * 对应 CredentialEntry 的运行时形状。
 */
export interface CredentialLike {
  integrationID?: string
  active?: boolean | null
  value?: { type?: string; key?: string; access?: string } | null
}

/** 从一条凭证里取出可用的 Bearer token（key 用 `.key`，oauth 用 `.access`）。 */
function tokenOf(c: CredentialLike): string | undefined {
  const v = c.value
  if (!v) return undefined
  if (v.type === "key" && typeof v.key === "string" && v.key) return v.key
  if (v.type === "oauth" && typeof v.access === "string" && v.access) return v.access
  return undefined
}

/** 候选优先级：数值越小越优先。 */
function rankOf(c: CredentialLike): number {
  const v = c.value
  const isKey = v?.type === "key" && !!v.key
  const isOauth = v?.type === "oauth" && !!v.access
  if (c.integrationID === "opencode-go" && isKey) return 0
  if (c.integrationID === "opencode" && isOauth) return 1
  if (c.integrationID === "opencode" && isKey) return 2
  return Number.POSITIVE_INFINITY
}

/**
 * 从凭证列表里挑出 Go 用量 API 可用的 token。
 *
 * 兼容「API Key 接入」与「Console OAuth 接入」两类用户，且**不强制 `active`**
 * （实测 key 类型凭证的 active 可能为 null）。同优先级下 active 优先。
 */
export function pickGoToken(creds: readonly CredentialLike[] | undefined | null): string | undefined {
  const list = Array.isArray(creds) ? creds : []
  let best: CredentialLike | undefined
  let bestRank = Number.POSITIVE_INFINITY
  let bestActive = false
  for (const c of list) {
    const r = rankOf(c)
    if (!Number.isFinite(r)) continue
    const active = c.active === true
    if (r < bestRank || (r === bestRank && active && !bestActive)) {
      best = c
      bestRank = r
      bestActive = active
    }
  }
  return best ? tokenOf(best) : undefined
}

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
      // 无凭证：不写 cache（侧边栏显示「无凭证」占位）；解析器已打过 warn
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
      if (res.status === 401) {
        warn("认证失败 HTTP 401（凭证可能过期）")
        token = undefined // token 过期 → 下轮重取
        cache = errorPayload(cache, "auth-failed")
        return
      }
      if (res.status === 403) {
        // 403 多为「账号没有 Go 套餐」(EntitlementError)；仅当确为权限/认证问题时才清 token 重取
        const body = await res.text().catch(() => "")
        if (/entitle/i.test(body)) {
          warn("账号无 Go 套餐 (HTTP 403 EntitlementError)")
          cache = errorPayload(cache, "no-plan")
        } else {
          warn("请求被拒 HTTP 403", body.slice(0, 160))
          token = undefined
          cache = errorPayload(cache, "auth-failed")
        }
        return
      }
      if (!res.ok) {
        warn(`请求失败 HTTP ${res.status}`)
        cache = errorPayload(cache, "fetch-failed")
        return
      }
      const mapped = mapResponse(await res.json())
      if (mapped) cache = mapped
      else {
        warn("响应格式无法解析（缺少 usage 字段）")
        cache = errorPayload(cache, "fetch-failed")
      }
    } catch (e) {
      warn(`请求异常 ${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? e}`)
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
