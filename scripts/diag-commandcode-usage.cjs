// 诊断 CommandCode 套餐用量与余额链路（与 src/commandcode-usage.ts 保持一致）
//
// 端点（base https://api.commandcode.ai，Authorization: Bearer <API Key>）：
//   GET /alpha/whoami?limits=1
//   GET /alpha/billing/subscriptions?orgId=
//   GET /alpha/billing/credits?orgId=
//   GET /alpha/usage/summary?orgId=&since=<本期开始>
//
// Key 解析顺序与插件一致：
//   ① credential 表：integration_id 含 commandcode
//   ② 环境变量 commandcode_key / COMMANDCODE_API_KEY / COMMANDCODE_KEY
//   ③ auth.json 的 commandcode
//   ④ ~/.config/opencode/opencode.json[c] 的 provider.commandcode.options.apiKey（支持 {env:VAR}）
//
// 只打印状态码与用量摘要，不打印密钥本身。
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const BASE = "https://api.commandcode.ai"

const PLAN_CREDITS = {
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
const PLAN_NAMES = {
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
const PLAN_KEYS = Object.keys(PLAN_CREDITS).sort((a, b) => b.length - a.length)

function getPlan(planId) {
  if (!planId) return null
  const n = String(planId).toLowerCase().replace(/_/g, "-")
  const hit = PLAN_KEYS.find((k) => n.startsWith(k))
  return hit ? { name: PLAN_NAMES[hit] ?? hit, monthlyCredits: PLAN_CREDITS[hit] } : null
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

function readCredentialRows() {
  try {
    const { DatabaseSync } = require("node:sqlite")
    const file = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
    const db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare("SELECT integration_id, active, value FROM credential").all()
    db.close()
    return rows
  } catch {
    return []
  }
}

/** 去 JSONC 注释与尾逗号（字符串内的 //、/* 不误删）。 */
function stripJsonc(text) {
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
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue }
    if (ch === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

function expandEnv(value) {
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(value).trim())
  return m ? (process.env[m[1]] ?? "").trim() : String(value).trim()
}

function resolveKey() {
  for (const r of readCredentialRows()) {
    if (!/command-?code/i.test(r.integration_id ?? "")) continue
    const v = safeParse(r.value) || {}
    if (v.type === "key" && v.key) return { key: v.key, source: `credential:${r.integration_id}` }
  }

  for (const name of ["commandcode_key", "COMMANDCODE_API_KEY", "COMMANDCODE_KEY", "CMD_API_KEY"]) {
    const v = (process.env[name] ?? "").trim()
    if (v) return { key: v, source: `env:${name}` }
  }

  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"), "utf-8"))
    const entry = auth?.commandcode ?? auth?.["command-code"]
    const k = entry?.key ?? entry?.value?.key
    if (k) return { key: k, source: "auth.json:commandcode" }
  } catch { /* 忽略 */ }

  for (const dir of [path.join(os.homedir(), ".config", "opencode"), path.join(os.homedir(), ".opencode")]) {
    for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
      try {
        const text = fs.readFileSync(path.join(dir, name), "utf-8")
        const obj = JSON.parse(stripJsonc(text))
        const raw = obj?.provider?.commandcode?.options?.apiKey
        if (typeof raw === "string" && raw.trim()) {
          return { key: expandEnv(raw), source: `config:${name}:provider.commandcode.options.apiKey` }
        }
      } catch { /* 下一个 */ }
    }
  }

  return { key: "", source: "(未找到凭证)" }
}

async function getJson(pathname, key) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, ms: Date.now() - t0, json, text }
}

async function main() {
  const { key, source } = resolveKey()
  console.log("base:", BASE)
  console.log("key 来源:", source, key ? `(${key.slice(0, 8)}...${key.slice(-4)})` : "")
  if (!key) {
    console.log("未找到 CommandCode Key。设置环境变量 commandcode_key，或在 /usage → 设置 → CommandCode API Key 手填。")
    process.exit(1)
  }

  const whoami = await getJson("/alpha/whoami?limits=1", key)
  console.log(`whoami: status=${whoami.status} ms=${whoami.ms} user=${whoami.json?.user?.userName ?? "?"} org=${whoami.json?.org?.id ?? "null"}`)
  if (whoami.status !== 200) {
    console.log("body:", whoami.text.slice(0, 300))
    process.exit(1)
  }

  const orgId = typeof whoami.json?.org?.id === "string" ? whoami.json.org.id : ""
  const q = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""

  const [credits, subscription] = await Promise.all([
    getJson(`/alpha/billing/credits${q}`, key),
    getJson(`/alpha/billing/subscriptions${q}`, key),
  ])
  console.log(`credits: status=${credits.status} ms=${credits.ms}`)
  console.log(`subscriptions: status=${subscription.status} ms=${subscription.ms}`)

  const sub = subscription.json?.data ?? subscription.json
  const planId = sub?.planId ?? ""
  const plan = getPlan(planId)
  console.log(`  planId=${planId || "?"} → ${plan ? `${plan.name} (月额度 $${plan.monthlyCredits})` : "未识别"}`)
  console.log(`  status=${sub?.status ?? "?"} currentPeriodEnd=${sub?.currentPeriodEnd ?? "?"}`)

  const c = credits.json?.credits ?? {}
  const remaining = (c.monthlyCredits ?? 0) + (c.purchasedCredits ?? 0) + (c.freeCredits ?? 0)
  console.log(`  余额: monthly=$${(c.monthlyCredits ?? 0).toFixed(2)} purchased=$${(c.purchasedCredits ?? 0).toFixed(2)} free=$${(c.freeCredits ?? 0).toFixed(2)} total=$${remaining.toFixed(2)}`)
  for (const k of ["fiveHour", "weekly"]) {
    const w = credits.json?.windowLimits?.[k]
    if (!w) continue
    const pct = w.cap > 0 ? (w.used / w.cap) * 100 : -1
    console.log(`  ${k}: used=$${Number(w.used ?? 0).toFixed(2)} cap=$${Number(w.cap ?? 0).toFixed(2)} (${pct.toFixed(1)}%) resetAt=${w.resetAt ?? "?"}`)
  }

  const since = sub?.currentPeriodStart
  if (since) {
    const summary = await getJson(`/alpha/usage/summary?${[q ? q.slice(1) : "", `since=${encodeURIComponent(since)}`].filter(Boolean).join("&")}`, key)
    console.log(`usage/summary: status=${summary.status} ms=${summary.ms} totalCost=$${Number(summary.json?.totalCost ?? 0).toFixed(2)} requests=${summary.json?.totalCount ?? "?"}`)
  }
}

main().catch((e) => {
  console.log(`THROW: ${e?.name}: ${e?.message}`)
  process.exit(1)
})
