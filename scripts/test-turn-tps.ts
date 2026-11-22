/**
 * test-turn-tps.ts — 本轮 TPS 口径回归测试。
 *
 * 参考实现（refJu/refQu/refVl/refBu）是从用户实际运行的 OpenCode v2.3.2
 * 官方二进制（opencode.exe 内嵌 TUI bundle）反混淆后**逐行镜像**的官方算法。
 * 断言：插件 sliceTurn + computeTurnTps/computeTurnDuration 与官方在
 * 任意消息序列上完全一致。已知豁免（均为文档化偏差，见 mapper/perf-tracker 注释）：
 *   · 官方 TPS 超过插件合理性上限（2000）→ 插件置 null（宁缺毋滥）；
 *   · 轮内零 token 的失败 step：官方计入其窗口，插件过滤不占窗口。
 *
 * 运行：esbuild bundle 后直接 node 执行（package.json test:turn）。
 */

import { sliceTurn, toTokenMessage } from "../src/mapper.js"
import { computeTurnTps, computeTurnDuration, derivePerf } from "../src/perf-tracker.js"
import { MAX_PLAUSIBLE_TPS_OBSERVED } from "../src/formatter.js"

// ── 官方参考实现（v2.3.2 二进制逐行镜像）──────────────────────────

function refVl(r: any[], l: number, f: boolean): number {
  let g = -1
  for (let h = l - 1; h >= 0; h--) {
    const v = r[h]
    if (v.type === "idle") return g
    if (v.type !== "user" && v.type !== "synthetic") continue
    if (f) return h
    g = h
  }
  return g
}

function refQu(r: any[], idx: number, legacy: boolean) {
  const g = idx
  const h = g + 1
  const v = refVl(r, h, legacy)
  return r.slice(v + 1, h).filter((p: any) => p.type === "assistant")
}

function refJu(r: any[], idx: number, legacy: boolean): number | undefined {
  const g = refQu(r, idx, legacy)
  const h = g.flatMap((y: any) =>
    y.time.streamed === undefined ? [] : [Math.max(0, y.time.streamed - (y.time.firstToken ?? y.time.created))],
  )
  if (g.length === 0 || h.length !== g.length) return undefined
  const v = g.reduce((a: number, T: any) => a + (T.tokens?.output ?? 0) + (T.tokens?.reasoning ?? 0), 0)
  const p = h.reduce((a: number, b: number) => a + b, 0)
  if (v <= 0 || p <= 0) return undefined
  return v / (p / 1000)
}

function refBu(r: any[], idx: number, legacy: boolean): number {
  const cur = r[idx]
  if (cur.time.completed === undefined) return 0
  const h = r[refVl(r, idx, legacy)]
  return Math.max(0, cur.time.completed - (h?.time.created ?? cur.time.created))
}

// ── fixture 构造 ──────────────────────────────────────────────────

let seq = 0
function msg(partial: Partial<any> & { type: string }): any {
  seq++
  return { id: `m${seq}`, tokens: undefined, time: {}, ...partial }
}

function assistant(o: {
  created: number; firstToken?: number; streamed?: number; completed?: number
  output?: number; reasoning?: number
}) {
  return msg({
    type: "assistant",
    model: { id: "deepseek-v4.1-flash", providerID: "deepseek" },
    tokens: { input: 100, output: o.output ?? 0, reasoning: o.reasoning ?? 0, cache: { read: 1000, write: 0 } },
    time: { created: o.created, firstToken: o.firstToken, streamed: o.streamed, completed: o.completed },
  })
}

let failures = 0
function check(name: string, actual: unknown, expected: unknown, tol = 0, dump?: () => string) {
  const bothNum = typeof actual === "number" && typeof expected === "number"
  const ok = bothNum && tol > 0
    ? Math.abs(actual as number - (expected as number)) <= tol
    : Object.is(actual, expected) ||
      (actual === null && (expected === undefined || expected === null)) ||
      (actual === undefined && expected === undefined)
  if (ok) {
    console.log(`  PASS ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
    if (dump) console.error(dump())
  }
}

// ── 用例 1：非 legacy 会话（含 idle 边界），多 step 轮 ─────────────

function caseMultiStep() {
  console.log("case 1: non-legacy multi-step turns (idle boundary)")
  const raw = [
    msg({ type: "user", time: { created: 0 } }),
    assistant({ created: 1000, firstToken: 2000, streamed: 4000, completed: 4100, output: 100, reasoning: 200 }),
    msg({ type: "idle", time: { created: 4200 } }),
    msg({ type: "user", time: { created: 10000 } }),
    assistant({ created: 11000, firstToken: 12000, streamed: 15000, completed: 15100, output: 300, reasoning: 0 }),
    assistant({ created: 16000, firstToken: 16200, streamed: 20000, completed: 20100, output: 500, reasoning: 700 }),
    msg({ type: "idle", time: { created: 20200 } }),
  ]
  const legacy = false
  for (let idx = 0; idx < raw.length; idx++) {
    if (raw[idx].type !== "assistant") continue
    const anchor = raw[idx]
    const slice = sliceTurn(raw, "s1", anchor.id)
    check(`step@${idx} turn TPS == official`, slice ? computeTurnTps(slice.turn) : null, refJu(raw, idx, legacy), 1e-9)
    check(
      `step@${idx} turn duration == official`,
      slice ? computeTurnDuration(slice.turn[slice.turn.length - 1], slice.startedAt) : null,
      refBu(raw, idx, legacy),
    )
  }
  const slice = sliceTurn(raw, "s1", raw[5].id)
  check("boundary start = current turn user.created", slice?.startedAt, 10000)
  check("turn assistant count", slice?.turn.length, 2)
}

// ── 用例 2：legacy 会话（无 idle），边界 = 最近 user ──────────────

function caseLegacy() {
  console.log("case 2: legacy session (no idle messages)")
  const raw = [
    msg({ type: "user", time: { created: 0 } }),
    assistant({ created: 1000, firstToken: 1100, streamed: 2000, completed: 2100, output: 50 }),
    msg({ type: "user", time: { created: 5000 } }),
    assistant({ created: 6000, firstToken: 6100, streamed: 8000, completed: 8100, output: 120, reasoning: 30 }),
  ]
  const legacy = true
  const idx = 3
  const slice = sliceTurn(raw, "s1", raw[idx].id)
  check("turn TPS == official", slice ? computeTurnTps(slice.turn) : null, refJu(raw, idx, legacy), 1e-9)
  check("turn duration == official", slice ? computeTurnDuration(slice.turn[0], slice.startedAt) : null, refBu(raw, idx, legacy))
  check("boundary start", slice?.startedAt, 5000)
}

// ── 用例 3：锚点正在流式（缺 streamed）→ 官方隐藏，插件 null ──────

function caseStreaming() {
  console.log("case 3: streaming anchor -> official undefined / plugin null")
  const raw = [
    msg({ type: "user", time: { created: 0 } }),
    assistant({ created: 1000, firstToken: 1100, streamed: 2000, completed: 2100, output: 50 }),
    assistant({ created: 3000, firstToken: 3100, streamed: undefined, completed: undefined, output: 10 }),
  ]
  const legacy = true // 无 idle 消息 → 官方 Ni(r)=true
  const idx = 2
  const slice = sliceTurn(raw, "s1", raw[idx].id)
  check("official undefined <-> plugin null", slice ? computeTurnTps(slice.turn) : null, refJu(raw, idx, legacy))
  const fallback = sliceTurn(raw, "s1")
  check("default anchor = last streamed message", fallback?.turn.length, 1)
  check(
    "default anchor TPS = official cumulative at step@1",
    fallback ? computeTurnTps(fallback.turn) : null,
    refJu(raw, 1, legacy),
    1e-9,
  )
}

// ── 用例 4：synthetic 边界（legacy 会话）+ 无关消息穿插 ───────────

function caseSynthetic() {
  console.log("case 4: synthetic boundary (legacy session) with unrelated messages")
  const raw = [
    msg({ type: "user", time: { created: 0 } }),
    assistant({ created: 1000, firstToken: 1100, streamed: 2000, completed: 2100, output: 50 }),
    msg({ type: "synthetic", time: { created: 2500 } }),
    msg({ type: "shell", time: { created: 2600 } }),
    assistant({ created: 3000, firstToken: 3200, streamed: 5000, completed: 5100, output: 200, reasoning: 100 }),
  ]
  const legacy = true // 无 idle 消息 → 官方 Ni(r)=true → 最近一条 user/synthetic 即边界
  const idx = 4
  const slice = sliceTurn(raw, "s1", raw[idx].id)
  check("synthetic cuts the turn", slice?.turn.length, 1)
  check("turn TPS == official", slice ? computeTurnTps(slice.turn) : null, refJu(raw, idx, legacy), 1e-9)
  check("boundary start = synthetic created", slice?.startedAt, 2500)
}

// ── 用例 5：逐条消息（单 step）TPS 分母 = streamed − firstToken ──

function caseDerivePerf() {
  console.log("case 5: per-step derivePerf denominator excludes prefill")
  const m = toTokenMessage(
    assistant({ created: 1000, firstToken: 3260, streamed: 4574, completed: 4574, output: 100, reasoning: 0 }),
    "s1",
  )!
  const perf = derivePerf(m)
  check("TTFT = firstToken - created", perf.ttft, 2260)
  check("TPS = tokens / (streamed - firstToken)", perf.tps, (100 / (4574 - 3260)) * 1000, 1e-9)
  const noFirst = toTokenMessage(
    assistant({ created: 1000, streamed: 4574, completed: 4574, output: 100 }),
    "s1",
  )!
  check("no firstToken -> fallback to created", derivePerf(noFirst).tps, (100 / (4574 - 1000)) * 1000, 1e-9)
}

// ── 用例 6：随机化属性测试 —— 任意序列上插件 ≡ 官方 ────────────────

function caseRandom() {
  console.log("case 6: randomized property test (200 sessions x all assistant anchors)")
  let seed = 20261122
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  let compared = 0
  let exemptCap = 0
  let exemptZero = 0
  for (let iter = 0; iter < 200; iter++) {
    const raw: any[] = []
    let t = 1
    const turns = 1 + Math.floor(rnd() * 4)
    for (let turn = 0; turn < turns; turn++) {
      t += 500 + Math.floor(rnd() * 3000)
      raw.push(msg({ type: rnd() < 0.15 ? "synthetic" : "user", time: { created: t } }))
      const steps = 1 + Math.floor(rnd() * 4)
      for (let s = 0; s < steps; s++) {
        t += 500 + Math.floor(rnd() * 3000)
        const created = t
        const firstToken = created + Math.floor(rnd() * 4000)
        const streamed = firstToken + 1 + Math.floor(rnd() * 20000)
        const completed = streamed + Math.floor(rnd() * 500)
        const out = Math.floor(rnd() * 400)
        const rsn = Math.floor(rnd() * 600)
        const streaming = rnd() < 0.15 // 尾部未完成 step
        raw.push(
          assistant({
            created,
            firstToken,
            streamed: streaming ? undefined : streamed,
            completed: streaming ? undefined : completed,
            output: out,
            reasoning: rsn,
          }),
        )
        t = streaming ? t + 1000 : completed
        if (rnd() < 0.2) raw.push(msg({ type: rnd() < 0.5 ? "system" : "shell", time: { created: t } }))
      }
      if (rnd() < 0.8) raw.push(msg({ type: "idle", time: { created: t } }))
    }
    const legacy = !raw.some((m) => m.type === "idle")
    const dump = () => JSON.stringify(raw, null, 1)
    for (let idx = 0; idx < raw.length; idx++) {
      if (raw[idx].type !== "assistant") continue
      const official = refJu(raw, idx, legacy)
      const slice = sliceTurn(raw, "s1", raw[idx].id)
      const ours = slice ? computeTurnTps(slice.turn) : null
      const zeroTokenSteps = (slice?.turn ?? []).filter((m) => m.outputTokens + m.reasoningTokens === 0).length
      if (official === undefined) {
        // 官方隐藏：插件唯一允许的偏差是「官方会计入的零 token step」，其余必须同为 null
        if (ours !== null && zeroTokenSteps > 0) exemptZero++
        else check(`iter${iter} step@${idx} official hidden => plugin null`, ours, null, 0, dump)
      } else if ((official as number) > MAX_PLAUSIBLE_TPS_OBSERVED) {
        // 官方给出超上限值（fixture 窗口极小所致）→ 插件按宁缺毋滥置 null
        exemptCap++
        check(`iter${iter} step@${idx} official > cap => plugin null`, ours, null, 0, dump)
      } else {
        check(`iter${iter} step@${idx} TPS == official`, ours, official, 1e-9, dump)
        compared++
      }
      const durOurs = slice ? computeTurnDuration(slice.turn[slice.turn.length - 1], slice.startedAt) : null
      const durOfficial = refBu(raw, idx, legacy)
      if (raw[idx].time.completed !== undefined) {
        check(`iter${iter} step@${idx} duration == official`, durOurs, durOfficial, 0, dump)
      }
    }
  }
  console.log(`  (numeric comparisons: ${compared}; cap exemptions: ${exemptCap}; zero-token exemptions: ${exemptZero})`)
}

caseMultiStep()
caseLegacy()
caseStreaming()
caseSynthetic()
caseDerivePerf()
caseRandom()

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s)`)
  process.exit(1)
}
console.log("\nALL PASS: plugin TPS matches OpenCode v2.3.2 official implementation")
