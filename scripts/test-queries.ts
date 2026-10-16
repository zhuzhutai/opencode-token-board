// 端到端测试：验证 queries.ts（v2 schema SQL）+ perf-tracker 纯聚合在真实 DB 上产出合理数据。
// 用 esbuild 打包本文件（import 源码），node 执行。node 环境下 db.ts 会用 node:sqlite。
import { getUsageReport, getModelBreakdown, getSummary } from "../src/queries.js"
import { computePerfStats, derivePerf } from "../src/perf-tracker.js"
import { clearStreamTiming, noteStreamToken, resetStreamTiming } from "../src/stream-timing.js"
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
clearStreamTiming()
const msgs = [
  { id: "m1", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheRead: 200, cacheWrite: 0, cost: 0.01, created: 1000, streamed: 1500, completed: 3500 },
  { id: "m2", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 100, outputTokens: 100, reasoningTokens: 0, cacheRead: 300, cacheWrite: 0, cost: 0.02, created: 4000, streamed: 4400, completed: 6400 },
]
// 无实时首 token 数据 → TTFT 置 null；TPS 恒按官方窗口（streamed − created）计算
const perf = computePerfStats(msgs as any)
const st = perf.models["p/m"]
assert(!!st, "perf has model p/m")
assert(st.requestCount === 2, `perf requestCount 2 (${st.requestCount})`)
assert(st.avgTTFT === null, `avgTTFT null without live timing (${st.avgTTFT})`)
assert(Math.abs(st.avgLatency! - 2450) < 1, `avgLatency 2450 (${st.avgLatency})`)
// 官方口径 TPS = (output+reasoning)/((streamed-created)/1000):
//   m1 50/(1500-1000)*1000=100, m2 100/(4400-4000)*1000=250 → avg 175
assert(Math.abs(st.avgTPS! - 175) < 0.1, `avgTPS 175 (${st.avgTPS})`)
// 命中率: cacheRead/(input+cacheRead) = (200+300)/((100+100)+(200+300)) = 500/700=71.4%
assert(Math.abs(st.cacheHitRate! - 71.42) < 0.1, `cacheHitRate ~71.4 (${st.cacheHitRate})`)
assert(derivePerf(msgs[0] as any).basis === "approx", "basis approx without live timing")

// 实时口径：注入 m1 的首 token 到达时刻 → 只影响 TTFT（TPS 恒为官方窗口，不随实时数据变）
noteStreamToken("m1", 1200)
noteStreamToken("m1", 1450)
const perfLive = computePerfStats(msgs as any)
const stLive = perfLive.models["p/m"]
// m1: ttft = 1200-1000 = 200；TPS 仍按官方窗口 = 50/(1500-1000)*1000 = 100
assert(Math.abs(stLive.avgTTFT! - 200) < 1, `live avgTTFT 200 (${stLive.avgTTFT})`)
assert(Math.abs(stLive.avgTPS! - 175) < 0.1, `live avgTPS unchanged by live timing (${stLive.avgTPS})`)
assert(derivePerf(msgs[0] as any).basis === "live", "basis live with stream timing")
resetStreamTiming("m1")
assert(derivePerf(msgs[0] as any).basis === "approx", "resetStreamTiming clears live data")

// 内容分片兜底：无实时数据时，用首个分片的 time.created 作 TTFT（TPS 仍为官方窗口）
const withContent = { ...msgs[1], firstTokenAt: 4100 } // m2: created4000 streamed4400 → ttft 100
const dc = derivePerf(withContent as any)
assert(dc.basis === "content", `content basis (${dc.basis})`)
assert(Math.abs(dc.ttft! - 100) < 1, `content ttft 100 (${dc.ttft})`)
assert(Math.abs(dc.tps! - 250) < 0.1, `content tps 250 (${dc.tps})`)

// 工具参数一次性到达（首 token 很晚，窗口看起来会「塌缩」）→ TPS 仍用官方窗口 streamed-created，
// 绝不再用 completed-streamed（工具耗时），因此不会算出上千的假值
const burst = { id: "mburst", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 10, outputTokens: 400, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, created: 1000, streamed: 3000, completed: 3200, firstTokenAt: 2995 }
const db2 = derivePerf(burst as any)
assert(db2.basis === "content", `burst uses content TTFT (${db2.basis})`)
assert(Math.abs(db2.ttft! - 1995) < 1 && Math.abs(db2.tps! - 200) < 0.1, `burst ttft 1995 & tps 200 (${db2.ttft}/${db2.tps})`)

// 窗口异常（例如只抓到流尾部）→ 实测与兜底窗口都超上限 → tps null（宁缺毋滥，不产生假值）
const bad = { id: "mbad", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 100, outputTokens: 5000, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, created: 1000, streamed: 1010, completed: 1020 }
noteStreamToken("mbad", 1005)
assert(derivePerf(bad as any).tps === null, "implausible window yields tps null")
clearStreamTiming()

// 分子必须含 reasoning（官方口径 (output+reasoning)/((streamed-created)/1000)）
const reasoned = { id: "mreason", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 10, outputTokens: 50, reasoningTokens: 50, cacheRead: 0, cacheWrite: 0, cost: 0, created: 1000, streamed: 2000, completed: 3500 }
assert(Math.abs(derivePerf(reasoned as any).tps! - 100) < 0.1, `tps counts reasoning (100) (${derivePerf(reasoned as any).tps})`)

// ── 截图回归见证 ──────────────────────────────────────────────
// 真实 bug：侧边栏曾把「工具执行耗时」completed − streamed（此处仅 67ms）当分母，
// 同一条消息算出 ~1970 的假值（用户截图里显示 1863.9）。官方窗口 streamed − created
//（此处 2000ms）应得 66。此用例锁死该窗口，防止回退。
const shot = { id: "mshot", sessionID: "s", providerID: "p", modelID: "m", inputTokens: 0, outputTokens: 127, reasoningTokens: 5, cacheRead: 0, cacheWrite: 0, cost: 0, created: 1000, streamed: 3000, completed: 3067 }
const dshot = derivePerf(shot as any)
assert(Math.abs(dshot.tps! - 66) < 0.1, `screenshot-case TPS uses official window = 66 (${dshot.tps})`)
const toolWindowTps = (shot.outputTokens + shot.reasoningTokens) / ((shot.completed - shot.streamed) / 1000)
assert(toolWindowTps > 1000, `regression witness: tool-window formula would give ${toolWindowTps.toFixed(1)} (>1000)`)

// mapper 测试
const mapped = extractTokenMessages([
  { type: "assistant", id: "a1", model: { id: "mm", providerID: "pp" }, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 3, write: 0 } }, cost: 0.1, time: { created: 1, streamed: 2, completed: 3 } },
  { type: "user", id: "u1", text: "hi" },
  { type: "assistant", id: "a0", model: { id: "mm", providerID: "pp" }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, // 全零，应过滤
], "sess")
assert(mapped.length === 1, `mapper filters non-assistant & zero-token (${mapped.length})`)
assert(mapped[0].providerID === "pp" && mapped[0].modelID === "mm", "mapper nested model extract")
assert(mapped[0].inputTokens === 10 && mapped[0].cacheRead === 3, "mapper tokens")
assert(mapped[0].firstTokenAt === undefined, "no content → no firstTokenAt")

// 首个分片带 time（reasoning/tool 开头）→ 提取为 firstTokenAt；text 开头（无 time）→ 不取后续分片
const mapped2 = extractTokenMessages([
  { type: "assistant", id: "a2", model: { id: "mm", providerID: "pp" }, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1000, streamed: 2000, completed: 2100 },
    content: [{ type: "reasoning", text: "x", time: { created: 1500, completed: 1900 } }, { type: "text", text: "y" }] },
  { type: "assistant", id: "a3", model: { id: "mm", providerID: "pp" }, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1000, streamed: 2000, completed: 2100 },
    content: [{ type: "text", text: "first" }, { type: "reasoning", text: "later", time: { created: 1500 } }] },
], "sess")
assert(mapped2.find(m => m.id === "a2")?.firstTokenAt === 1500, `reasoning-first firstTokenAt=1500 (${mapped2.find(m => m.id === "a2")?.firstTokenAt})`)
assert(mapped2.find(m => m.id === "a3")?.firstTokenAt === undefined, "text-first does not use later part time")

console.log(process.exitCode ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===")
