/**
 * update-check.ts — 版本检查与更新提示
 *
 * opencode 不会自动更新 npm 插件：加载时把纯包名解析成 <name>@latest，但
 * `Npm.add` 只要发现缓存目录里已有 node_modules/<name> 就直接复用、不再查 registry。
 * 因此本插件需要主动检查最新版本并提示用户升级。
 *
 * 机制：
 *  · 检查：GET https://registry.npmjs.org/<pkg>/latest（轻量 JSON，8s 超时）
 *  · 缓存：api.kv "tokenwatch-update-check" { checkedAt, latest }，TTL 6h
 *  · 忽略：api.kv "tokenwatch-update-dismissed" = 被忽略的版本号
 *  · 升级：api.plugins.install("<pkg>@<latest>")（装到新版本目录并改写配置）
 *
 * 说明：npm 插件的缓存目录名含版本号（<name>@<ver>），所以用「精确新版本」
 * 安装必然触发新目录下载，绕过“已存在即复用”的短路逻辑。
 */

import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"

const PKG = "opencode-token-board"
const REGISTRY_LATEST = `https://registry.npmjs.org/${PKG}/latest`
const CHECK_TTL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000
const KV_CHECK = "tokenwatch-update-check"
const KV_DISMISS = "tokenwatch-update-dismissed"

export interface UpdateInfo {
  current: string
  latest: string
  source: "npm" | "file" | "internal"
  /** 能否用 api.plugins.install 一键升级（仅 npm 源支持） */
  canInstall: boolean
}

interface CheckCache {
  checkedAt: number
  latest: string
}

function parseVersion(v: string): number[] {
  const core = String(v ?? "").trim().replace(/^v/i, "").split("-")[0]
  return core.split(".").map((n) => parseInt(n, 10) || 0)
}

/** 简单 semver 比较：latest 是否比 current 新（忽略预发布标识） */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

export interface UpdateChecker {
  current: () => string
  info: () => UpdateInfo | null
  checking: () => boolean
  check: (force?: boolean) => void
  dismiss: () => void
  install: () => Promise<{ ok: boolean; message: string }>
  subscribe: (fn: () => void) => () => void
}

export function createUpdateChecker(api: TuiPluginApi, meta?: TuiPluginMeta): UpdateChecker {
  const current =
    (typeof __PLUGIN_VERSION__ === "string" && __PLUGIN_VERSION__) ||
    (meta?.version ?? "0.0.0")
  const source = (meta?.source ?? "npm") as UpdateInfo["source"]
  const canInstall = source === "npm" && typeof api.plugins?.install === "function"

  let info: UpdateInfo | null = null
  let isChecking = false
  let inFlight = false
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const fn of listeners) fn()
  }

  function dismissedVersion(): string {
    try { return (api.kv?.get?.<string>(KV_DISMISS) as string) || "" } catch { return "" }
  }

  function applyLatest(latest: string): void {
    if (!latest) return
    if (latest === dismissedVersion()) {
      info = null
    } else if (isNewer(latest, current)) {
      info = { current, latest, source, canInstall }
    } else {
      info = null
    }
  }

  function runFetch(): void {
    if (inFlight) return
    inFlight = true
    isChecking = true
    notify()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    fetch(REGISTRY_LATEST, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: any) => {
        const latest = typeof json?.version === "string" ? json.version : ""
        if (latest) {
          try { api.kv?.set?.(KV_CHECK, { checkedAt: Date.now(), latest } satisfies CheckCache) } catch { /* ignore */ }
          applyLatest(latest)
        }
      })
      .catch(() => { /* 网络失败静默，下一轮再试 */ })
      .finally(() => {
        clearTimeout(timer)
        inFlight = false
        isChecking = false
        notify()
      })
  }

  function check(force = false): void {
    if (isChecking) return
    if (!force) {
      try {
        const saved = api.kv?.get?.<CheckCache>(KV_CHECK)
        if (saved && typeof saved.checkedAt === "number" && Date.now() - saved.checkedAt < CHECK_TTL_MS) {
          applyLatest(saved.latest)
          notify()
          return
        }
      } catch { /* ignore */ }
    }
    runFetch()
  }

  function dismiss(): void {
    const v = info?.latest
    if (!v) return
    try { api.kv?.set?.(KV_DISMISS, v) } catch { /* ignore */ }
    info = null
    notify()
  }

  async function install(): Promise<{ ok: boolean; message: string }> {
    const cur = info
    if (!cur) return { ok: false, message: "already-latest" }
    if (!cur.canInstall) return { ok: false, message: "local-source" }
    try {
      const res = await api.plugins.install(`${PKG}@${cur.latest}`)
      if (res.ok) return { ok: true, message: cur.latest }
      return { ok: false, message: res.message || "install-failed" }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    current: () => current,
    info: () => info,
    checking: () => isChecking,
    check,
    dismiss,
    install,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
