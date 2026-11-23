/**
 * commandcode-usage.ts — CommandCode（GOAT / Pro / Max…）套餐用量与余额获取
 *
 * 目标：在侧边栏展示「自动识别到的套餐名 + 5 小时/本周窗口用量 + 月余额 + 续费倒计时」。
 *
 * 数据源（Command Code CLI 同源接口，实测可用）：
 *   GET https://api.commandcode.ai/alpha/whoami?limits=1
 *   GET https://api.commandcode.ai/alpha/billing/subscriptions?orgId=
 *   GET https://api.commandcode.ai/alpha/billing/credits?orgId=
 *   GET https://api.commandcode.ai/alpha/usage/summary?orgId=&since=<本期开始>
 *   Authorization: Bearer <CommandCode API Key>
 *
 * 套餐识别：subscription.planId（如 individual-goat）→ 展示名与月额度表（与 CLI 一致）。
 * 余额口径：monthlyCredits + purchasedCredits + freeCredits；月用量百分比优先按套餐总额度算，
 * 识别不到套餐时退化为 used / (used + remaining)。
 *
 * 凭证解析优先级（任一命中即可，零配置优先）：
 *   ① 设置里手填的 commandcode.apiKey
 *   ② opencode 凭证库中 integrationID 含 commandcode 的 key（context.client.credential.list）
 *   ③ 环境变量 commandcode_key / COMMANDCODE_API_KEY / COMMANDCODE_KEY
 *   ④ ~/.local/share/opencode/auth.json 的 commandcode
 *   ⑤ ~/.config/opencode/opencode.json[c] 的 provider.commandcode.options.apiKey（支持 {env:VAR}）
 *
 * 请求策略（事件驱动，无常量轮询）：
 *  - 创建后首次立即刷新；会话成功 / 空闲 / 点击标题时刷新
 *  - 60s 节流 + 5min 结果缓存（账单接口比用量接口重）
 *  - 失败保留上次成功数据并标记 error；关键失败打 console.warn 便于远程排障
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { CommandCodeBucket, CommandCodeUsageData } from "./formatter.js"

/** 日志前缀：便于在 opencode 日志里检索。 */
const LOG_PREFIX = "[opencode-token-board] CommandCode usage"

function warn(msg: string, detail?: unknown): void {
  try {
    if (detail === undefined) console.warn(`${LOG_PREFIX}: ${msg}`)
    else console.warn(`${LOG_PREFIX}: ${msg}`, detail)
  } catch { /* 日志不可用不影响主流程 */ }
}

const API_BASE = "https://api.commandcode.ai"
const MIN_INTERVAL_MS = 60_000
const CACHE_TTL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 10_000

/** 套餐月额度（美元），与 Command Code CLI 的 plan 表一致。 */
const PLAN_CREDITS: Record<string, number> = {
  "individual-go": 10,
  "individual-go-v1": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
}

const PLAN_NAMES: Record<string, string> = {
  "individual-go": "Go",
  "individual-go-v1": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
}

/** 长键优先，避免 individual-pro-v1 被 individual-pro 抢先匹配。 */
const PLAN_KEYS = Object.keys(PLAN_CREDITS).sort((a, b) => b.length - a.length)

export interface CommandCodePlanInfo {
  name: string
  monthlyCredits: number
}

/** planId → 展示名与月额度；无法识别返回 null。 */
export function getCommandCodePlan(planId: string | null | undefined): CommandCodePlanInfo | null {
  if (!planId) return null
  const normalized = planId.toLowerCase().replace(/_/g, "-")
  const hit = PLAN_KEYS.find((key) => normalized.startsWith(key))
  if (!hit) return null
  return { name: PLAN_NAMES[hit] ?? hit, monthlyCredits: PLAN_CREDITS[hit] }
}

// ─────────────────────────────────────────────
// 凭证解析
// ─────────────────────────────────────────────

export type CommandCodeTokenResolver = () => Promise<string | undefined>

/** 凭证条目的结构化最小视图（避免对 @opencode/client 的编译期依赖，便于单测）。 */
export interface CommandCodeCredentialLike {
  integrationID?: string
  active?: boolean | null
  value?: { type?: string; key?: string } | null
}

/** 从 opencode 凭证列表里挑出 CommandCode 的 API Key（同优先取 active）。 */
export function pickCommandCodeToken(
  creds: readonly CommandCodeCredentialLike[] | undefined | null,
): string | undefined {
  const list = Array.isArray(creds) ? creds : []
  let best: string | undefined
  let bestActive = false
  for (const c of list) {
    if (!/command-?code/i.test(c.integrationID ?? "")) continue
    const v = c.value
    const key = v?.type === "key" && typeof v.key === "string" && v.key ? v.key : undefined
    if (!key) continue
    const active = c.active === true
    if (!best || (active && !bestActive)) {
      best = key
      bestActive = active
    }
  }
  return best
}

/** `{env:VAR}` → 环境变量值；非该形式原样返回。 */
function expandEnvValue(value: string, env: NodeJS.ProcessEnv): string {
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim())
  if (!m) return value.trim()
  return (env[m[1]] ?? "").trim()
}

/** 去掉 JSONC 的注释与尾逗号（字符串内的 //、/* 不误删）。 */
function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  let quote = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === "\\") { out += next ?? ""; i++ }
      else if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    out += ch
  }
  // 去掉对象/数组尾逗号
  return out.replace(/,\s*([}\]])/g, "$1")
}

function readJsoncFile(path: string): unknown {
  const raw = readFileSync(path, "utf-8")
  return JSON.parse(stripJsonc(raw))
}

/** 读 opencode 凭证库：auth.json 的 commandcode 集成。 */
function readAuthJsonKey(env: NodeJS.ProcessEnv): string {
  const dataDir = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode")
  try {
    const raw = readJsoncFile(join(dataDir, "auth.json")) as Record<string, any>
    const entry = raw?.["commandcode"] ?? raw?.["command-code"]
    const key = entry?.key ?? entry?.value?.key
    return typeof key === "string" ? key.trim() : ""
  } catch {
    return ""
  }
}

/** 读 opencode.json[c] 中 provider.commandcode.options.apiKey。 */
function readConfigKey(env: NodeJS.ProcessEnv): string {
  const configDirs = [
    env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : join(homedir(), ".config", "opencode"),
    join(homedir(), ".opencode"),
  ]
  for (const dir of configDirs) {
    for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
      try {
        const obj = readJsoncFile(join(dir, name)) as any
        const raw = obj?.provider?.commandcode?.options?.apiKey
        if (typeof raw === "string" && raw.trim()) return expandEnvValue(raw, env)
      } catch {
        // 文件不存在 / 解析失败 → 下一个
      }
    }
  }
  return ""
}

/** 无显式配置时的自动发现（环境变量 → auth.json → opencode 配置）。 */
export function discoverCommandCodeKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.commandcode_key || env.COMMANDCODE_API_KEY || env.COMMANDCODE_KEY || env.CMD_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readAuthJsonKey(env) || readConfigKey(env)
}

// ─────────────────────────────────────────────
// 响应解析
// ─────────────────────────────────────────────

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : 0
}

function secondsUntil(value: unknown, now: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // 兼容毫秒时间戳与秒时间戳
    const ms = value > 1e12 ? value : value * 1000
    return Math.max(0, Math.round((ms - now) / 1000))
  }
  if (typeof value === "string" && value) {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return Math.max(0, Math.round((t - now) / 1000))
  }
  return 0
}

function mapWindow(w: any, now: number): CommandCodeBucket {
  const used = num(w?.used)
  const cap = num(w?.cap)
  const percent = cap > 0 ? Math.min(100, (used / cap) * 100) : -1
  return { used, cap, percent, resetInSec: secondsUntil(w?.resetAt, now) }
}

export interface CommandCodeRawPayload {
  whoami?: any
  credits?: any
  subscription?: any
  summary?: any
}

/** 把四个接口的原始响应归一化为侧边栏数据（纯函数，便于单测）。 */
export function normalizeCommandCodeUsage(
  payload: CommandCodeRawPayload,
  now = Date.now(),
): CommandCodeUsageData | null {
  const creditsRoot = payload.credits ?? null
  const credits = creditsRoot?.credits ?? creditsRoot ?? {}
  const windowLimits = creditsRoot?.windowLimits ?? {}
  const sub = payload.subscription?.data ?? payload.subscription ?? null
  const summary = payload.summary ?? null

  // 既没有余额也没有订阅信息 → 视为无效响应
  if (!creditsRoot && !sub) return null

  const planId = typeof sub?.planId === "string" ? sub.planId : ""
  const plan = getCommandCodePlan(planId)

  const monthlyRemaining = Math.max(0, num(credits?.monthlyCredits))
  const purchasedRemaining = Math.max(0, num(credits?.purchasedCredits))
  const freeRemaining = Math.max(0, num(credits?.freeCredits))
  const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining

  const summarySpent = Math.max(0, num(summary?.totalCost))
  const planTotal = plan?.monthlyCredits ?? null
  const pool = planTotal !== null ? planTotal + purchasedRemaining + freeRemaining : summarySpent + totalRemaining
  const used = Math.max(0, pool - totalRemaining)
  const totalSpent = summarySpent > 0 ? summarySpent : used
  const usagePercent = pool > 0 ? Math.min(100, (used / pool) * 100) : 0

  return {
    planId,
    planName: plan?.name ?? (planId || "CommandCode"),
    planMonthlyCredits: planTotal,
    status: typeof sub?.status === "string" ? sub.status : "",
    periodEndInSec: secondsUntil(sub?.currentPeriodEnd, now),
    monthlyRemaining,
    purchasedRemaining,
    freeRemaining,
    totalRemaining,
    totalSpent,
    usagePercent,
    fiveHour: mapWindow(windowLimits?.fiveHour, now),
    weekly: mapWindow(windowLimits?.weekly, now),
    fetchedAt: Date.now(),
  }
}

function errorPayload(prev: CommandCodeUsageData | null, err: string): CommandCodeUsageData {
  const placeholder: CommandCodeBucket = { used: 0, cap: 0, percent: -1, resetInSec: 0 }
  const base: CommandCodeUsageData = prev ?? {
    planId: "",
    planName: "CommandCode",
    planMonthlyCredits: null,
    status: "",
    periodEndInSec: 0,
    monthlyRemaining: 0,
    purchasedRemaining: 0,
    freeRemaining: 0,
    totalRemaining: 0,
    totalSpent: 0,
    usagePercent: 0,
    fiveHour: placeholder,
    weekly: placeholder,
    fetchedAt: Date.now(),
  }
  return { ...base, error: err, fetchedAt: Date.now() }
}

// ─────────────────────────────────────────────
// 公开工厂
// ─────────────────────────────────────────────

export interface CommandCodeUsageFetcher {
  data: () => CommandCodeUsageData | null
  refresh: (force?: boolean) => void
  /** 显式配置的 API Key（空字符串 = 自动发现）。 */
  setConfig: (apiKey: string) => void
  /** 是否已解析到可用 Key（侧边栏据此决定是否渲染区块）。 */
  configured: () => boolean
  subscribe: (fn: () => void) => () => void
}

class CommandCodeApiError extends Error {
  constructor(readonly code: "auth-failed" | "no-plan" | "fetch-failed") {
    super(code)
  }
}

export function createCommandCodeUsageFetcher(
  resolveToken: CommandCodeTokenResolver,
  initialKey = "",
): CommandCodeUsageFetcher {
  let explicitKey = initialKey.trim()
  let discoveredKey: string | undefined
  let discoveryDone = false
  /** 是否曾经解析到过 Key：用于「有 Key 但认证失败」时仍显示错误提示。 */
  let everResolved = false
  let cache: CommandCodeUsageData | null = null
  let lastFetchAt = 0
  let inFlight: Promise<void> | null = null
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const fn of listeners) fn()
  }

  async function resolveKey(refresh: boolean): Promise<string> {
    if (explicitKey) return explicitKey
    if (refresh) {
      discoveredKey = undefined
      discoveryDone = false
    }
    if (!discoveryDone) {
      try { discoveredKey = await resolveToken() } catch { discoveredKey = undefined }
      if (discoveredKey) everResolved = true
      discoveryDone = true
      notify()
    }
    return discoveredKey ?? ""
  }

  async function getJson(path: string, key: string): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: controller.signal,
      })
      if (res.status === 401) throw new CommandCodeApiError("auth-failed")
      if (res.status === 403) {
        const body = await res.text().catch(() => "")
        if (/upgrade_required|upgrade required/i.test(body)) throw new CommandCodeApiError("no-plan")
        throw new CommandCodeApiError("auth-failed")
      }
      if (!res.ok) throw new CommandCodeApiError("fetch-failed")
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async function doFetch(refreshCreds: boolean): Promise<void> {
    const key = await resolveKey(refreshCreds)
    if (!key) {
      // 无凭证：不写 cache（侧边栏整块不显示）；解析器已打过 warn
      return
    }
    try {
      const whoami = await getJson("/alpha/whoami?limits=1", key)
      const orgId = typeof whoami?.org?.id === "string" ? whoami.org.id : ""
      const orgQuery = orgId ? `orgId=${encodeURIComponent(orgId)}` : ""
      const billingQuery = orgQuery ? `?${orgQuery}` : ""

      const [credits, subscription] = await Promise.all([
        getJson(`/alpha/billing/credits${billingQuery}`, key),
        getJson(`/alpha/billing/subscriptions${billingQuery}`, key),
      ])

      const periodStart = subscription?.data?.currentPeriodStart
      let summary: any = null
      if (typeof periodStart === "string" && periodStart) {
        const params = [orgQuery, `since=${encodeURIComponent(periodStart)}`].filter(Boolean).join("&")
        summary = await getJson(`/alpha/usage/summary?${params}`, key).catch(() => null)
      }

      const mapped = normalizeCommandCodeUsage({ whoami, credits, subscription, summary })
      if (mapped) cache = mapped
      else {
        warn("响应格式无法解析（缺少 credits / subscription）")
        cache = errorPayload(cache, "fetch-failed")
      }
    } catch (e) {
      if (e instanceof CommandCodeApiError) {
        if (e.code === "auth-failed") {
          warn("认证失败（凭证可能失效）")
          // 保留当前 Key 以便继续显示错误提示；强制刷新时会重新解析凭据
          discoveryDone = true
        } else if (e.code === "no-plan") {
          warn("当前套餐不支持 API 查询（需要 GOAT 及以上）")
        } else {
          warn("请求失败（接口不可达或返回异常）")
        }
        cache = errorPayload(cache, e.code)
        return
      }
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
    inFlight = doFetch(force)
      .finally(() => {
        inFlight = null
        notify()
      })
  }

  // 创建即拉一次，尽早拿到凭证与数据
  refresh(true)

  return {
    data: () => cache,
    refresh,
    setConfig: (apiKey) => {
      const next = (apiKey ?? "").trim()
      if (next === explicitKey) return
      explicitKey = next
      discoveredKey = undefined
      discoveryDone = false
      lastFetchAt = 0
      // 保留旧数据直到新数据返回，避免刷新瞬间闪成空白
      refresh(true)
    },
    configured: () => !!explicitKey || everResolved,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
