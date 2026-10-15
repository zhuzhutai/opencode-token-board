// 诊断 Go 套餐用量链路（新版：/zen/go/v1/usage + API Key）
//
// API Key 解析顺序与插件一致：
//   ① ~/.local/share/opencode/auth.json 的 opencode-go / opencode
//   ② ~/.config/opencode/opencode.json[c] 的 provider.go.options.apiKey
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

function readAuthJsonKey() {
  try {
    const file = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"))
    return raw?.["opencode-go"]?.key || raw?.["opencode"]?.key || ""
  } catch {
    return ""
  }
}

function readConfigKey() {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try {
      const text = fs.readFileSync(path.join(os.homedir(), ".config", "opencode", name), "utf-8")
      try {
        const obj = JSON.parse(text)
        const k = obj?.provider?.go?.options?.apiKey
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

const key = readAuthJsonKey() || readConfigKey()
console.log("URL:", USAGE_URL)
console.log("API key:", key ? key.slice(0, 12) + "..." + key.slice(-4) : "(未找到)")

async function main() {
  if (!key) {
    console.log("未找到 Go API Key，检查 auth.json 或 opencode.json 的 provider.go.options.apiKey")
    process.exit(1)
  }
  const t0 = Date.now()
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    console.log(`status=${res.status} ms=${Date.now() - t0}`)
    console.log("body:", text)
    if (res.ok) {
      const json = JSON.parse(text)
      const u = json?.usage ?? json
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
