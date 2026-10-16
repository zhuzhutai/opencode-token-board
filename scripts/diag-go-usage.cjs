// 诊断 Go 套餐用量链路（与插件现行实现保持一致：官方 usage 端点 + credential 解析）
//
// 端点：GET https://opencode.ai/inference/go/v1/usage
//   （https://opencode.ai/zen/go/v1/usage 是同数据的旧路径，实测也可用）
//
// token 解析顺序与 src/go-usage.ts 的 pickGoToken 一致：
//   ① credential 表：opencode-go/key  →  ② opencode/oauth  →  ③ opencode/key
//   ④ 兜底 auth.json：opencode-go.key / opencode.key
//   ⑤ 兜底 ~/.config/opencode/opencode.json[c] 的 provider.go.options.apiKey
//
// 只打印状态码与用量百分比，不打印密钥本身。
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const USAGE_URL = "https://opencode.ai/inference/go/v1/usage"

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

function readAuthJson() {
  try {
    const file = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
    return JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {
    return {}
  }
}

function readConfigKey() {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try {
      const text = fs.readFileSync(path.join(os.homedir(), ".config", "opencode", name), "utf-8")
      try {
        const k = JSON.parse(text)?.provider?.go?.options?.apiKey
        if (typeof k === "string" && k) return k
      } catch {
        const block = text.match(/"go"\s*:\s*\{[\s\S]*?"options"\s*:\s*\{[\s\S]*?"apiKey"\s*:\s*"([^"]+)"/)
        if (block?.[1]) return block[1]
      }
    } catch {
      // 下一个
    }
  }
  return ""
}

function tokenFromValue(v) {
  if (!v) return ""
  if (v.type === "key" && v.key) return v.key
  if (v.type === "oauth" && v.access) return v.access
  return ""
}

/** 与 pickGoToken 相同的优先级；返回 { token, source }。 */
function resolveToken() {
  const rows = readCredentialRows()
  const parsed = rows.map((r) => ({ id: r.integration_id, active: r.active, value: safeParse(r.value) }))
  const rankOf = (c) => {
    const isKey = c.value && c.value.type === "key" && !!c.value.key
    const isOauth = c.value && c.value.type === "oauth" && !!c.value.access
    if (c.id === "opencode-go" && isKey) return 0
    if (c.id === "opencode" && isOauth) return 1
    if (c.id === "opencode" && isKey) return 2
    return Infinity
  }
  let best = null
  for (const c of parsed) {
    const r = rankOf(c)
    if (!Number.isFinite(r)) continue
    if (!best || r < best.rank) best = { rank: r, c }
  }
  if (best) {
    const t = tokenFromValue(best.c.value)
    if (t) return { token: t, source: `credential:${best.c.id}/${best.c.value.type}` }
  }

  const auth = readAuthJson()
  for (const id of ["opencode-go", "opencode"]) {
    const t = auth?.[id]?.key
    if (typeof t === "string" && t) return { token: t, source: `auth.json:${id}` }
  }

  const cfg = readConfigKey()
  if (cfg) return { token: cfg, source: "config:provider.go.options.apiKey" }
  return { token: "", source: "(未找到凭证)" }
}

function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

async function main() {
  const rows = readCredentialRows()
  console.log("credential 表条目：")
  if (!rows.length) console.log("  (空 / 无 node:sqlite，跳过)")
  for (const r of rows) {
    const v = safeParse(r.value) || {}
    console.log(`  - ${r.integration_id} active=${r.active} type=${v.type} hasKey=${!!v.key} hasToken=${!!v.access}`)
  }

  const { token, source } = resolveToken()
  console.log("URL:", USAGE_URL)
  console.log("token 来源:", source, token ? `(${token.slice(0, 8)}...${token.slice(-4)})` : "")
  if (!token) {
    console.log("未找到 Go 凭证。登录方式：TUI 里 /connect 选 opencode（OpenCode Console account）或 opencode-go（API Key）。")
    process.exit(1)
  }

  const t0 = Date.now()
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    console.log(`status=${res.status} ms=${Date.now() - t0}`)
    if (!res.ok) console.log("body:", text.slice(0, 300))
    if (res.ok) {
      const u = (JSON.parse(text) || {}).usage || JSON.parse(text)
      for (const k of ["rolling", "weekly", "monthly"]) {
        const b = u?.[k]
        console.log(`  ${k}: percent=${b?.percent} resetsAt=${b?.resetsAt}`)
      }
    }
  } catch (e) {
    console.log(`THROW ms=${Date.now() - t0}: ${e.name}: ${e.message} ${e.cause?.message ?? ""}`)
  }
}

main()
