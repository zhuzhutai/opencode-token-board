/**
 * check-perf-real.ts — 用本机真实 OpenCode 数据库校验性能指标新口径。
 *
 * 背景：旧口径 `TPS = tokens / (completed - streamed)` 中的 `completed - streamed`
 * 实际是**工具执行耗时**（无工具时常 <100ms），会算出上千 TPS 的假值。
 * 现口径与 OpenCode 官方一致：`TPS = (output + reasoning) / ((streamed - created) / 1000)`。
 * 本脚本把历史消息按新算法重算一遍，并与旧口径对照，输出分布用于回归校验。
 *
 * 运行（真实 DB，只读）：
 *   npx esbuild scripts/check-perf-real.ts --bundle --platform=node --format=esm --outfile=%TEMP%/opencode/check-perf-real.mjs
 *   node %TEMP%/opencode/check-perf-real.mjs
 */
import { ensureDb, queryAll } from "../src/db.js"
import { toTokenMessage } from "../src/mapper.js"
import { derivePerf, computePerfStats } from "../src/perf-tracker.js"
import { clearStreamTiming } from "../src/stream-timing.js"
import type { TokenMessage } from "../src/types.js"
import type { TpsBasis } from "../src/formatter.js"

clearStreamTiming()

if (!(await ensureDb())) {
  console.error("FAIL: 无法打开 OpenCode 数据库")
  process.exit(1)
}

interface Row { data: string; session_id: string }
// 注意：session_message 表把 type 放在列里，JSON data 内没有 type 字段（API 返回时才补上）
const rows = queryAll<Row>("select data, session_id from session_message where type='assistant' order by seq")
const msgs: TokenMessage[] = []
for (const r of rows) {
  try {
    const tm = toTokenMessage({ ...JSON.parse(r.data), type: "assistant" }, r.session_id)
    if (tm) msgs.push(tm)
  } catch { /* skip */ }
}

const samples: Array<{ msg: TokenMessage; basis: TpsBasis | null; tps: number | null; ttft: number | null }> = []
for (const m of msgs) {
  const { basis, tps, ttft } = derivePerf(m)
  samples.push({ msg: m, basis, tps, ttft })
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const byBasis: Record<string, number> = {}
for (const s of samples) byBasis[String(s.basis)] = (byBasis[String(s.basis)] ?? 0) + 1

const tpsAll = samples.map(s => s.tps).filter((v): v is number => v != null)
const ttftAll = samples.map(s => s.ttft).filter((v): v is number => v != null)
const overLimit = samples.filter(s => s.tps != null && s.tps > 1000)
const overOldBug = samples.filter(s => s.tps != null && s.tps > 2000)

// 官方口径恒等式：TPS 必须等于 (output+reasoning)/((streamed-created)/1000)，误差 <0.5%
let identityChecked = 0
let identityBad = 0
for (const m of msgs) {
  if (typeof m.streamed !== "number" || typeof m.created !== "number" || typeof m.completed !== "number") continue
  const { tps } = derivePerf(m)
  if (tps == null) continue
  const official = ((m.outputTokens + m.reasoningTokens) / ((m.streamed - m.created) / 1000))
  identityChecked++
  if (Math.abs(tps - official) / official > 0.005) identityBad++
}
console.log(`\n官方口径恒等式: 校验 ${identityChecked} 条, 偏差超限 ${identityBad} 条`)

// 旧口径对照（复刻 v2 的错误算法）
const legacy = msgs
  .map(m => {
    if (typeof m.created !== "number" || typeof m.completed !== "number" || typeof m.streamed !== "number") return null
    const gen = m.outputTokens + m.reasoningTokens
    const genMs = m.completed - m.streamed
    return genMs > 0 && gen > 0 ? (gen / genMs) * 1000 : null
  })
  .filter((v): v is number => v != null)

console.log("=== 样本 ===")
console.log("assistant 消息数:", msgs.length, " 可算 TPS:", tpsAll.length, " 可算 TTFT:", ttftAll.length)
console.log("口径分布:", JSON.stringify(byBasis))
console.log("\n=== TPS（新口径） ===")
console.log(`min=${Math.min(...tpsAll).toFixed(1)}  p50=${pct(tpsAll, 50).toFixed(1)}  p90=${pct(tpsAll, 90).toFixed(1)}  p99=${pct(tpsAll, 99).toFixed(1)}  max=${Math.max(...tpsAll).toFixed(1)}  avg=${(tpsAll.reduce((a, b) => a + b, 0) / tpsAll.length).toFixed(1)}`)
console.log(">1000 的样本:", overLimit.length, " >2000 的样本:", overOldBug.length)
console.log("\n=== TPS（旧口径，对照） ===")
console.log(`min=${Math.min(...legacy).toFixed(1)}  p50=${pct(legacy, 50).toFixed(1)}  p99=${pct(legacy, 99).toFixed(1)}  max=${Math.max(...legacy).toFixed(1)}`)
console.log(">1000 的样本:", legacy.filter(v => v > 1000).length, " >2000 的样本:", legacy.filter(v => v > 2000).length)
console.log("\n=== TTFT（新口径，秒） ===")
console.log(`p50=${(pct(ttftAll, 50) / 1000).toFixed(1)}  p90=${(pct(ttftAll, 90) / 1000).toFixed(1)}  max=${(Math.max(...ttftAll) / 1000).toFixed(1)}`)

console.log("\n=== 按模型 ===")
const perf = computePerfStats(msgs)
for (const s of Object.values(perf.models)) {
  console.log(`${s.model.padEnd(40)} req=${String(s.requestCount).padStart(5)}  TPS avg=${(s.avgTPS ?? 0).toFixed(1).padStart(7)} max=${(s.maxTPS ?? 0).toFixed(1).padStart(8)}  TTFT avg=${((s.avgTTFT ?? 0) / 1000).toFixed(1)}s (n=${s.ttftCount})`)
}

const ok = overOldBug.length === 0 && tpsAll.length > 0
const ok2 = identityBad === 0 && identityChecked > 0
console.log(ok ? "\n=== NEW METRICS SANITY PASSED ===" : "\n=== SANITY FAILED ===")
console.log(ok2 ? "=== OFFICIAL-FORMULA IDENTITY PASSED ===" : "=== OFFICIAL-FORMULA IDENTITY FAILED ===")
process.exitCode = (ok && ok2) ? 0 : 1
