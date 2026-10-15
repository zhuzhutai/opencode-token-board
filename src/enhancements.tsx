/** @jsxImportSource @opentui/solid */
import { Show, For, createMemo, createSignal, onMount } from "solid-js"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { formatTokens, formatCost, formatDuration, formatModelBreakdown, formatDailyBreakdown, formatSessionSummary } from "./formatter.js"
import { computePerfStats } from "./perf-tracker.js"
import { extractTokenMessages } from "./mapper.js"
import { getUsageReport } from "./queries.js"
import type { BoardStorage } from "./storage.js"
import type { TokenMessage } from "./types.js"

/**
 * enhancements.ts — V2 新形态增强（阶段 7）。
 *
 *  ① 状态条：`sidebar.footer` 槽，一行紧凑实时统计（总 token/请求/花费/命中）
 *  ② 全屏面板：`session.panel` 槽 + `ui.panel.open`，按模型详列 token/性能分位
 *  ③ 仪表盘：`ui.router` 独立路由页，展示全量历史报告（SQLite）
 *
 *  数据复用核心层：mapper（消息→TokenMessage）、perf-tracker（性能聚合）、
 *  formatter（格式化）、queries（历史报告）。命令注册见 commands.tsx。
 */

const PANEL_NAME = "tokenwatch.stats"
const DASHBOARD_ROUTE = "tokenwatch.dashboard"

// ── 共享：某会话的响应式 TokenMessage 列表 ──
function useSessionTokens(context: Context, sessionID: () => string, version: () => number): () => TokenMessage[] {
  return createMemo(() => {
    void version()
    const id = sessionID()
    if (!id) return []
    try {
      return extractTokenMessages(context.data.session.message.list(id) ?? [], id)
    } catch {
      return []
    }
  })
}

interface Totals {
  totalTokens: number
  requests: number
  cost: number
  hit: number | null
  input: number
  output: number
  reasoning: number
}

function sumTotals(msgs: readonly TokenMessage[]): Totals {
  let i = 0, o = 0, ir = 0, cr = 0, cw = 0, r = 0, c = 0
  for (const m of msgs) {
    i += m.inputTokens; o += m.outputTokens; ir += m.reasoningTokens
    cr += m.cacheRead; cw += m.cacheWrite; r++; c += m.cost
  }
  const hit = (i + cr) > 0 ? (cr / (i + cr)) * 100 : null
  return { totalTokens: i + o + ir + cr + cw, requests: r, cost: c, hit, input: i, output: o, reasoning: ir }
}

// ══════════════════════════════════════════════════════════════
//  ② 全屏面板（session.panel）：按模型详列 token + 性能分位
// ══════════════════════════════════════════════════════════════
interface ModelRow {
  key: string
  providerID: string
  modelID: string
  tokens: number
  requests: number
  cost: number
  hit: number | null
  ttft: number | null
  tps: number | null
  latency: number | null
  p95: number | null
}

export function StatsPanel(props: { context: Context; storage: BoardStorage; panel: PanelInput; version: () => number }) {
  const tokens = useSessionTokens(props.context, () => props.panel.sessionID, props.version)
  const totals = createMemo(() => sumTotals(tokens()))
  const perf = createMemo(() => computePerfStats(tokens()))

  const modelRows = createMemo<ModelRow[]>(() => {
    const msgs = tokens()
    const p = perf()
    const map = new Map<string, ModelRow>()
    for (const m of msgs) {
      if (m.inputTokens + m.outputTokens + m.cacheRead + m.cacheWrite === 0) continue
      const key = `${m.providerID}/${m.modelID}`
      let row = map.get(key)
      if (!row) {
        row = { key, providerID: m.providerID, modelID: m.modelID, tokens: 0, requests: 0, cost: 0, hit: null, ttft: null, tps: null, latency: null, p95: null }
        map.set(key, row)
      }
      row.tokens += m.inputTokens + m.outputTokens + m.reasoningTokens + m.cacheRead + m.cacheWrite
      row.requests++
      row.cost += m.cost
    }
    // 合并性能分位
    for (const row of map.values()) {
      const ps = p.models[row.key]
      if (ps) {
        row.hit = ps.cacheHitRate
        row.ttft = ps.avgTTFT
        row.tps = ps.avgTPS
        row.latency = ps.avgLatency
        row.p95 = ps.p95Latency
      }
    }
    return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens)
  })

  const theme = props.context.theme
  const accent = () => theme.hue?.accent?.[500] ?? RGBA.fromInts(88, 166, 255, 255)
  const primary = () => theme.hue?.interactive?.[400] ?? RGBA.fromInts(88, 166, 255, 255)
  const muted = () => theme.text?.muted ?? RGBA.fromInts(139, 148, 158, 255)
  const green = () => RGBA.fromInts(63, 185, 80, 255)
  const yellow = () => RGBA.fromInts(255, 193, 7, 255)

  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length))
  const padL = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s)

  return (
    <box flexDirection="column" padding={1}>
      {/* 标题 + 会话总计 */}
      <text fg={accent()}>TokenWatch · 会话统计</text>
      <text>
        <span style={{ fg: muted() } as any}>总计 </span>
        <span style={{ fg: primary() } as any}>{formatTokens(totals().totalTokens)}</span>
        <span style={{ fg: muted() } as any}>  ·  </span>
        <span style={{ fg: primary() } as any}>×{totals().requests}</span>
        <span style={{ fg: muted() } as any}> 请求  ·  </span>
        <span style={{ fg: green() } as any}>{formatCost(totals().cost)}</span>
        <span style={{ fg: muted() } as any}>  ·  命中 </span>
        <span style={{ fg: yellow() } as any}>{totals().hit != null ? `${totals().hit!.toFixed(1)}%` : "—"}</span>
      </text>

      <box marginTop={1}>
        <text fg={muted()}>
          {pad("模型", 30)} {padL("Tokens", 9)} {padL("×", 5)} {padL("成本", 9)} {padL("命中", 6)} {padL("TTFT", 8)} {padL("TPS", 7)} {padL("延迟", 8)} {padL("P95", 8)}
        </text>
      </box>

      <For each={modelRows()}>
        {(row) => (
          <text>
            <span style={{ fg: primary() } as any}>{pad(`${row.providerID}/${row.modelID}`, 30)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span>{padL(formatTokens(row.tokens), 9)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span>{padL(String(row.requests), 5)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span style={{ fg: green() } as any}>{padL(formatCost(row.cost), 9)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span style={{ fg: yellow() } as any}>{padL(row.hit != null ? `${row.hit.toFixed(0)}%` : "—", 6)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span>{padL(formatDuration(row.ttft), 8)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span>{padL(row.tps != null ? row.tps.toFixed(0) : "—", 7)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span>{padL(formatDuration(row.latency), 8)}</span>
            <span style={{ fg: muted() } as any}> </span>
            <span>{padL(formatDuration(row.p95), 8)}</span>
          </text>
        )}
      </For>

      <Show when={modelRows().length === 0}>
        <text fg={muted()} marginTop={1}>暂无数据 — 先进行一轮对话</text>
      </Show>
    </box>
  )
}

// ══════════════════════════════════════════════════════════════
//  ③ 仪表盘（ui.router 路由页）：全量历史报告（SQLite）
// ══════════════════════════════════════════════════════════════
export function Dashboard(props: { context: Context }) {
  const [summary, setSummary] = createSignal<Awaited<ReturnType<typeof getUsageReport>> | null>(null)
  const [loading, setLoading] = createSignal(true)
  const theme = props.context.theme
  const accent = () => theme.hue?.accent?.[500] ?? RGBA.fromInts(88, 166, 255, 255)
  const muted = () => theme.text?.muted ?? RGBA.fromInts(139, 148, 158, 255)

  onMount(async () => {
    try {
      setSummary(await getUsageReport({}))
    } finally {
      setLoading(false)
    }
  })

  return (
    <box flexDirection="column" padding={2}>
      <text fg={accent()}>TokenWatch 仪表盘 · 全量历史</text>
      <Show when={loading()}>
        <text fg={muted()} marginTop={1}>加载中…</text>
      </Show>
      <Show when={!loading() && summary()}>
        <box flexDirection="column" marginTop={1}>
          <MultiLine text={formatSessionSummary(summary()!.summary, "用量汇总")} />
          <box marginTop={1}>
            <MultiLine text={formatModelBreakdown(summary()!.models)} />
          </box>
          <box marginTop={1}>
            <MultiLine text={formatDailyBreakdown(summary()!.daily)} />
          </box>
          <Show when={summary()!.errors && summary()!.errors!.failedCount > 0}>
            <text fg={muted()} marginTop={1}>
              失败请求 {summary()!.errors!.failedCount}（{((summary()!.errors!.errorRate) * 100).toFixed(1)}%）
            </text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

/** 把含换行的格式化字符串按行渲染成一列 <text>（<text> 可能不按 \n 换行）。 */
function MultiLine(props: { text: string }) {
  const lines = createMemo(() => props.text.split("\n"))
  return (
    <box flexDirection="column">
      <For each={lines()}>{(line) => <text>{line || " "}</text>}</For>
    </box>
  )
}

// ══════════════════════════════════════════════════════════════
//  注册全部增强槽位 + 路由；返回清理函数
// ══════════════════════════════════════════════════════════════
export function registerEnhancements(context: Context, storage: BoardStorage, version: () => number): () => void {
  const cleanups: (() => void)[] = []

  // ② 全屏面板（session.panel）
  cleanups.push(context.ui.slot({
    append: "session.panel",
    render: (panel) => (
      <Show when={panel.name === PANEL_NAME}>
        <StatsPanel context={context} storage={storage} panel={panel} version={version} />
      </Show>
    ),
  }))

  // ③ 仪表盘路由页
  cleanups.push(context.ui.router.register({
    name: DASHBOARD_ROUTE,
    render: () => <Dashboard context={context} />,
  }))

  return () => {
    for (const c of cleanups) { try { c() } catch { /* 忽略 */ } }
  }
}

/** 供 commands.tsx 调用：打开全屏统计面板。 */
export function openStatsPanel(context: Context): void {
  context.ui.panel.open(PANEL_NAME, { presentation: "fullscreen" })
}

/** 供 commands.tsx 调用：跳转到仪表盘路由。 */
export function openDashboard(context: Context): void {
  context.ui.router.navigate({ type: "plugin", name: DASHBOARD_ROUTE })
}
