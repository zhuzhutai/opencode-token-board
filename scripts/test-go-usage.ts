// 端到端测试：新 go-usage fetcher（真实 token 解析 + 官方 API + 映射）
import { createGoUsageFetcher } from "../src/go-usage.js"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { homedir } from "node:os"

function resolveToken(): Promise<string | undefined> {
  const db = new DatabaseSync(join(homedir(), ".local/share/opencode/opencode.db"), { readOnly: true })
  const row = db.prepare("SELECT value FROM credential WHERE integration_id='opencode' AND active=1 LIMIT 1").get() as any
  db.close()
  if (!row) return Promise.resolve(undefined)
  const v = JSON.parse(row.value)
  return Promise.resolve(v.type === "oauth" ? v.access : undefined)
}

const fetcher = createGoUsageFetcher(resolveToken)
const data = await new Promise((resolve) => {
  const unsub = fetcher.subscribe(() => { unsub(); resolve(fetcher.data()) })
  // 兜底：若 5s 未通知则超时
  setTimeout(() => { unsub(); resolve(fetcher.data()) }, 6000)
})

console.log("data:", JSON.stringify(data, null, 1))
if (!data) { console.error("FAIL: no data"); process.exit(1) }
const ok = (c: boolean, m: string) => { console.log(c ? `ok: ${m}` : `FAIL: ${m}`); if (!c) process.exitCode = 1 }
ok(data.rolling.percent >= 0, `rolling percent >= 0 (${data.rolling.percent})`)
ok(data.weekly.percent >= 0, `weekly percent >= 0 (${data.weekly.percent})`)
ok(data.monthly.percent >= 0, `monthly percent >= 0 (${data.monthly.percent})`)
ok(!data.error, `no error (${data.error ?? "-"})`)
ok(data.rolling.resetInSec >= 0, `rolling resetInSec >= 0 (${data.rolling.resetInSec})`)
console.log(process.exitCode ? "=== FAILED ===" : "=== ALL PASSED ===")
