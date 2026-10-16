/**
 * test-stats-upgrade.ts — 隔离测试 stats 文件 v2 → v3 升级。
 *
 * v2 的 TPS/TTFT 是用错误窗口算出来的（completed-streamed = 工具耗时）。
 * 升级要求：用量/成本/延迟聚合原样保留，错误的 TPS/TTFT 聚合被作废，
 * 并用 JSONL 按新口径补回 TPS；TTFT 历史丢弃。
 *
 * 做法：把真实 stats/jsonl 复制到临时目录，切 USERPROFILE 后动态 import stats-store
 * （路径在模块加载时按 homedir() 决定，所以必须先设 env 再 import）。
 * 全程不写你的真实文件。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1 }
  else console.log("ok:", msg)
}

// ① 备份真实文件到临时目录（此时还用原 homedir）
//    模式：--v2 时改用合成的 v2 文件（验证"保留用量聚合"分支），否则复制你的真实文件
const mode = process.argv.includes("--v2") ? "v2" : "real"
const realHome = homedir()
const realStats = join(realHome, ".opencode", "tokenwatch-stats.json")
const realLog = join(realHome, ".opencode", "tokenwatch.jsonl")
const testHome = join(tmpdir(), "opencode", `stats-upgrade-test-${mode}`)
rmSync(testHome, { recursive: true, force: true })
mkdirSync(join(testHome, ".opencode"), { recursive: true })

let original: any
if (mode === "v2") {
  original = {
    version: 2, updatedAt: "2026-10-01T00:00:00.000Z", migratedFromLogs: true,
    models: {
      "opencode-go/deepseek-v4.1-flash": {
        model: "opencode-go/deepseek-v4.1-flash", providerID: "opencode-go",
        requestCount: 1234, ttftCount: 1234, tpsCount: 1234, latencyCount: 1234,
        totalInput: 987654, outputTokens: 0, totalOutput: 555, totalCacheRead: 777, totalCacheWrite: 0, totalCost: 3.21,
        avgTTFT: 33000, maxTTFT: 90000, minTTFT: 100,
        avgTPS: 1566, maxTPS: 44096, minTPS: 2,   // ← 旧口径的假值，必须被作废
        avgLatency: 45000, maxLatency: 99000, minLatency: 500,
        ttftReservoir: [100, 200], latencyReservoir: [1000, 2000],
      },
    },
  }
  writeFileSync(join(testHome, ".opencode", "tokenwatch-stats.json"), JSON.stringify(original), "utf-8")
} else {
  original = JSON.parse(readFileSync(realStats, "utf-8"))
  copyFileSync(realStats, join(testHome, ".opencode", "tokenwatch-stats.json"))
}
if (existsSync(realLog)) copyFileSync(realLog, join(testHome, ".opencode", "tokenwatch.jsonl"))
console.log(`[mode=${mode}] 原文件: version=${original.version} models=${Object.keys(original.models ?? {}).length} migrated=${original.migratedFromLogs}`)

// ② 切 HOME → 模块加载时会解析到临时目录
process.env.USERPROFILE = testHome
process.env.HOME = testHome

const store = await import("../src/stats-store.js")
const persisted = store.readPersistedStats()

// ③ 校验升级结果
const upgraded = JSON.parse(readFileSync(join(testHome, ".opencode", "tokenwatch-stats.json"), "utf-8"))
assert(upgraded.version === 4, `stats version → 4 (${upgraded.version})`)
assert(upgraded.migratedFromLogs === true, `migratedFromLogs 保持/置为 true (${upgraded.migratedFromLogs})`)
assert(persisted.length > 0, `模型数 ${persisted.length}`)

const keepUsage = original.version === 2   // v2 → 保留用量聚合；v1 及更早 → 与既有行为一致，按 JSONL 重建
console.log(`原 version=${original.version} → ${keepUsage ? "保留用量聚合" : "按 JSONL 重建"}`)

if (keepUsage) {
  let usagePreserved = true
  for (const [key, m] of Object.entries<any>(original.models)) {
    const now = persisted.find((p: any) => p.model === m.model)
    if (!now) continue
    if (now.requestCount !== m.requestCount || Math.abs(now.totalInput - m.totalInput) > 0.5) usagePreserved = false
    if (now.totalCost !== m.totalCost) usagePreserved = false
    if (now.latencyCount !== m.latencyCount) usagePreserved = false   // 延迟口径未变，保留
  }
  assert(usagePreserved, "用量/成本/延迟聚合原样保留（未重复计数）")
  const recomputed = persisted.filter((p: any) => p.tpsCount > 0 && Math.abs(p.avgTPS - (original.models[p.model]?.avgTPS ?? -1)) > 1)
  assert(recomputed.length > 0, "旧 TPS 假值已被作废并按新口径重算（avgTPS 与 v2 原值不同）")
} else {
  const totalReq = persisted.reduce((a: number, p: any) => a + p.requestCount, 0)
  assert(totalReq >= Object.values<any>(original.models).reduce((a: number, m: any) => a + m.requestCount, 0),
    `JSONL 重建后请求数不少于原聚合 (${totalReq})`)
}

let perfCleared = true
let tpsRestored = 0
let tpsSane = true
for (const p of persisted as any[]) {
  if (p.ttftCount !== 0 || p.avgTTFT !== null) perfCleared = false  // 旧 TTFT 是错的，按约定清空
  if (p.tpsCount > 0) { tpsRestored++; if (p.avgTPS > 2000 || p.maxTPS > 2000) tpsSane = false }
}
assert(perfCleared, "TTFT 历史按新约定清空（不再显示错误值）")
assert(tpsRestored > 0, `带 TPS 样本的模型数 ${tpsRestored}`)
assert(tpsSane, "补回的 TPS 全部 ≤ 2000（无离谱值）")

const totalTps = persisted.reduce((a: number, p: any) => a + (p.tpsCount ?? 0), 0)
console.log(`升级后: 模型 ${persisted.length}, TPS 样本 ${totalTps}, TTFT 样本 ${persisted.reduce((a: number, p: any) => a + p.ttftCount, 0)}`)
console.log(persisted.map((p: any) => `${p.model}: tps n=${p.tpsCount} avg=${(p.avgTPS ?? 0).toFixed(1)} max=${(p.maxTPS ?? 0).toFixed(1)}`).join("\n"))

// ④ 再读一次应命中进程内缓存且不重复迁移
const second = store.readPersistedStats()
assert(second.length === persisted.length, "二次读取模型数一致（未重复迁移）")

console.log(process.exitCode ? "\n=== UPGRADE TEST FAILED ===" : "\n=== UPGRADE TEST PASSED ===")
