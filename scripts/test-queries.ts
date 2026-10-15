// 端到端测试：验证 queries.ts（v2 schema SQL）+ perf-tracker 纯聚合在真实 DB 上产出合理数据。
// 用 esbuild 打包本文件（import 源码），node 执行。node 环境下 db.ts 会用 node:sqlite。
import { getUsageReport, getModelBreakdown, getSummary } from "../src/queries.js"
import { computePerfStats, derivePerf } from "../src/perf-tracker.js"
import { extractTokenMessages } from "../src/mapper.js"

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1 }
  else console.log("ok:", msg)
}

const summary = await getSummary({})
console.log("summary:", JSON.stringify(summary, null, 1))
assert(summary.requestCount > 0, `summary has requests (${summary.requestCount})`)
assert(summary.totalTokens > 0, `summary totalTokens > 0 (${summary.totalTokens})`)
assert(summary.inputTokens > 0, `summary inputTokens > 0 (${summary.inputTokens})`)
// 校验 total = input+output+reasoning+cache.read+cache.write
const summed = summary.inputTokens + summary.outputTokens + summary.reasoningTokens + summary.cacheRead + summary.cacheWrite
assert(summed === summary.totalTokens, `totalTokens == components sum (${summary.totalTokens} vs ${summed})`)

const models = await getModelBreakdown({})
console.log("models top3:", JSON.stringify(models.slice(0, 3), null, 1))
assert(models.length > 0, `model breakdown non-empty (${models.length})`)

const report = await getUsageReport({})
assert(report.daily.length > 0, `daily breakdown non-empty (${report.daily.length})`)
assert(report.providers.length > 0, `providers non-empty (${report.providers.length})`)
assert(report.sessions.length > 0, `sessions non-empty (${report.sessions.length})`)
console.log("errors:", JSON.stringify(report.errors))

// perf-tracker 纯聚合测试（构造样本）
const msgs = [
  { id: "m1", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheRead: 200, cacheWrite: 0, cost: 0.01, created: 1000, streamed: 1500, completed: 3500 },
  { id: "m2", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 100, outputTokens: 100, reasoningTokens: 0, cacheRead: 300, cacheWrite: 0, cost: 0.02, created: 4000, streamed: 4400, completed: 6400 },
]
const perf = computePerfStats(msgs as any)
const st = perf.models["p/m"]
assert(!!st, "perf has model p/m")
assert(st.requestCount === 2, `perf requestCount 2 (${st.requestCount})`)
assert(Math.abs(st.avgTTFT! - 450) < 1, `avgTTFT 450 (${st.avgTTFT})`)
assert(Math.abs(st.avgLatency! - 2450) < 1, `avgLatency 2450 (${st.avgLatency})`)
// TPS: msg1 output50/(3500-1500)*1000=25, msg2 output100/(6400-4400)*1000=50 → avg 37.5
assert(Math.abs(st.avgTPS! - 37.5) < 0.1, `avgTPS 37.5 (${st.avgTPS})`)
// 命中率: cacheRead/(input+cacheRead) = (200+300)/((100+100)+(200+300)) = 500/700=71.4%
assert(Math.abs(st.cacheHitRate! - 71.42) < 0.1, `cacheHitRate ~71.4 (${st.cacheHitRate})`)

// mapper 测试
const mapped = extractTokenMessages([
  { type: "assistant", id: "a1", model: { id: "mm", providerID: "pp" }, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 3, write: 0 } }, cost: 0.1, time: { created: 1, streamed: 2, completed: 3 } },
  { type: "user", id: "u1", text: "hi" },
  { type: "assistant", id: "a0", model: { id: "mm", providerID: "pp" }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, // 全零，应过滤
], "sess")
assert(mapped.length === 1, `mapper filters non-assistant & zero-token (${mapped.length})`)
assert(mapped[0].providerID === "pp" && mapped[0].modelID === "mm", "mapper nested model extract")
assert(mapped[0].inputTokens === 10 && mapped[0].cacheRead === 3, "mapper tokens")

console.log(process.exitCode ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===")
