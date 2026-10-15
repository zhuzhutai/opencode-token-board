/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { formatTokens, formatCost, formatDuration } from "./formatter.js"
import { t as baseT, setLanguage } from "./i18n.js"
import { computePerfStats } from "./perf-tracker.js"
import { extractTokenMessages } from "./mapper.js"
import type { GoUsageFetcher } from "./go-usage.js"
import type { BoardStorage } from "./storage.js"
import type { TokenMessage, SidebarConfig, CollapseState } from "./types.js"

/**
 * ══════════════════════════════════════════════════════════════════
 *  sidebar.tsx — 侧边栏 UI（终端里 TokenWatch 面板的全部展示逻辑）
 *
 *  本文件唯一职责：把 token 数据渲染成右侧边栏的字符界面。
 *  想调 UI 外观（行内容 / 配色 / 宽度 / 显示与否）都在这里改。
 *  数据从哪里来、怎么算的，不在这里（见 tui.tsx / mapper.ts / perf-tracker.ts）。
 *
 *  ── v1 → v2 变化 ───────────────────────────────────────────────
 *  · 数据源：props.allTokenMessages（事件驱动信号）→ 由 version + message.list 派生的 memo
 *  · 性能：perfTracker.getSessionStats() → computePerfStats(tokenMessages)（纯聚合，无状态）
 *  · 配置/折叠：api.kv（轮询版本号）→ storage.config / storage.collapse（响应式 Store）
 *  · 主题：theme.current.{accent,primary,textMuted} → context.theme 语义 token 适配
 *  · token 分布：api.state.part(id) → 消息内嵌 content 数组；api.state.config → agent.system
 *  ──────────────────────────────────────────────────────────────────
 *
 *  ── 渲染出的终端效果（当前布局）────────────────────────────────
 *  ╭────────────────────────────────────────╮
 *  │ ▾      OpenCode-Token-Board            │  ← ① 面板标题行（accent 强调色，居中；点击折叠 ②以下）
 *  │    12.3K   ×45    $0.04  89.1%         │  ← ① 四项总计居中：总计|请求|花费|命中（4色）
 *  │     总计  请求    花费   命中           │  ← ① 四项标签居中（暗色）
 *  │           9.2K  3.1K                   │  ← ② 输入(蓝) / 输出(紫) 居中（折叠时隐藏）
 *  │           输入  输出                    │
 *  │ ▾ opencode    deepseek-v4-flash       │  ← ③ 模型头行1：▾(折叠三角) 供应商 模型名
 *  │    1.2M  ×45  $0.04  89.1%             │  ← ③ 模型头行2：四统计均分居中（配色同①）
 *  │   ╭────────────────────────╮           │
 *  │   │   1.2s  45.3   12S     │           │  ← ④ 性能网格：TTFT / TPS / 延迟
 *  │   │   TTFT  TPS   延迟     │           │
 *  │   ╰────────────────────────╯           │
 *  │ ▾ Token分布                            │  ← ⑤ Token 分布
 *  │   █ 系统提示  1.2K                     │
 *  │ ▾ Go 套餐   8%|3h  8%|5d  11%|26d     │  ← ⑥ Go 套餐
 *  │   🕔  8% ████░░░░░░░░░░░░░            │
 *  ╰────────────────────────────────────────╯
 *  配色语义：标题=accent，主数值/模型名=primary，请求数/输出=purple，输入=blue，
 *          花费=green，命中=hitColor(黄)，标签/次要=muted。
 *  防抖动：面板宽度常量 PANEL_WIDTH=38（含边框），INNER_WIDTH=36，不做动态测量。
 *  ──────────────────────────────────────────────────────────────────
 */

// 计算字符串在终端里的可视宽度（中文/日韩=2 宽，其余=1）
function getVisualWidth(str: string): number {
  let w = 0
  for (const c of str) {
    const code = c.codePointAt(0) ?? 0
    if (code === 0xFE0F) continue
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3040 && code <= 0x30FF) ||
      (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0x1100 && code <= 0x11FF) ||
      (code >= 0x2E80 && code <= 0x2EFF) || (code >= 0x2600 && code <= 0x27BF) ||
      (code >= 0x1F000 && code <= 0x1FAFF)) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

function truncateTail(str: string, maxW: number): string {
  if (getVisualWidth(str) <= maxW) return str
  let w = 0, res = ""
  for (const c of str) {
    const cw = getVisualWidth(c)
    if (w + cw + 1 > maxW) return res + "…"
    w += cw
    res += c
  }
  return res + "…"
}

function centerAlign(text: string, width: number): string {
  const visualW = getVisualWidth(text)
  if (visualW >= width) return truncateTail(text, width)
  const left = Math.floor((width - visualW) / 2)
  const right = width - visualW - left
  return " ".repeat(left) + text + " ".repeat(right)
}

/** 数值固定宽度居中：占位宽恒定，数字位数变化时文本位置不动，杜绝抖动。 */
function fixedCenter(val: string, reservedW: number, colW: number): string {
  const vw = getVisualWidth(val)
  if (vw >= colW) return truncateTail(val, colW)
  const block = vw >= reservedW ? val : " ".repeat(reservedW - vw) + val
  return centerAlign(block, colW)
}

/** 数值固定宽度右对齐：右侧不动。 */
function fixedRightPad(val: string, width: number): string {
  const vw = getVisualWidth(val)
  if (vw >= width) return truncateTail(val, width)
  return " ".repeat(width - vw) + val
}

// 命中率固定用展示色
function hitColor(): RGBA {
  return RGBA.fromInts(255, 50, 150, 255)
}

/** 各 Token 分布角色的颜色 */
function distRoleColor(role: string): RGBA {
  const map: Record<string, RGBA> = {
    system: RGBA.fromInts(130, 80, 255, 255),
    user: RGBA.fromInts(88, 166, 255, 255),
    toolCall: RGBA.fromInts(210, 153, 34, 255),
    toolResult: RGBA.fromInts(219, 109, 40, 255),
    output: RGBA.fromInts(63, 185, 80, 255),
    other: RGBA.fromInts(72, 79, 88, 255),
  }
  return map[role] ?? RGBA.fromInts(72, 79, 88, 255)
}

function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  let ascii = 0, cjk = 0
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3040 && code <= 0x30FF) ||
      (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0x1100 && code <= 0x11FF)) cjk++
    else ascii++
  }
  const trimmed = text.trimStart()
  const jsonLike = (trimmed.startsWith("{") || trimmed.startsWith("[")) && /"[^"]+"\s*:/.test(text)
  const codeLike = !jsonLike && /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(text)
  const asciiPerToken = jsonLike ? 2 : codeLike ? 2.5 : 4
  return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.5))
}

/** Go 用量百分比配色：<50 绿，50-80 黄，>80 红 */
function goPercentColor(percent: number): RGBA {
  if (percent >= 80) return RGBA.fromInts(244, 67, 54, 255)
  if (percent >= 50) return RGBA.fromInts(255, 193, 7, 255)
  return RGBA.fromInts(63, 185, 80, 255)
}

/** 重置倒计时短格式 */
function formatResetShort(sec: number): string {
  if (!sec || sec <= 0) return ""
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.ceil(sec / 60)}m`
  if (sec < 86400) return `${Math.ceil(sec / 3600)}h`
  return `${Math.ceil(sec / 86400)}d`
}

/** 百分比统一宽度（右对齐到 4 列） */
function padPercent(percent: number): string {
  return String(Math.round(percent)).padStart(3, " ") + "%"
}

// ── Go 套餐列表列宽常量 ──
const GO_PCT_W = 4
const GO_PCT_EMPTY = "   —"

function padTail(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - getVisualWidth(text)))
}

interface ModelAgg {
  providerID: string
  modelID: string
  totalInput: number
  totalOutput: number
  totalReasoning: number
  cacheRead: number
  cacheWrite: number
  totalCost: number
  requestCount: number
  lastMessageIndex: number
}

interface TokenWatchPanelProps {
  context: Context
  storage: BoardStorage
  sessionID: string
  /** 版本信号访问器：每次消息同步 +1，驱动 memo 重读 message.list */
  version: () => number
  goUsageFetcher?: GoUsageFetcher
}

export function TokenWatchPanel(props: TokenWatchPanelProps) {
  const { context, storage } = props
  const theme = context.theme

  // ── 响应式配置 / 折叠（v2 storage Store，替代 api.kv + 轮询）──
  const config = (): SidebarConfig => storage.config
  const collapse = (): CollapseState => storage.collapse

  // 同步语言（首帧即用正确语言）
  setLanguage(config().language)

  // ── 数据源：version + message.list 派生（取代事件信号 allTokenMessages）──
  // 防御：message.list 可能抛错（如 sessionID 无效 / 未同步），捕获后返回空数组，
  // 避免下游 memo 因依赖抛错而返回 undefined 导致渲染崩溃。
  const rawMessages = createMemo(() => {
    void props.version()
    try {
      return context.data.session.message.list(props.sessionID) ?? []
    } catch {
      return []
    }
  })
  const tokenMessages = createMemo<TokenMessage[]>(() => extractTokenMessages(rawMessages(), props.sessionID))

  const t = (key: string) => {
    void config().language // 建立语言响应依赖
    return baseT(key)
  }
  const isEnglish = (str: string) => /^[a-zA-Z\s\.\/]+$/.test(str)

  // Go 配置变更时同步到 fetcher（触发立即刷新）
  let lastGoWs = ""
  let lastGoCookie = ""
  const syncGoConfig = () => {
    const g = config().go
    const ws = g?.workspaceID ?? ""
    const ck = g?.cookie ?? ""
    if (ws && ck && (ws !== lastGoWs || ck !== lastGoCookie)) {
      lastGoWs = ws
      lastGoCookie = ck
      props.goUsageFetcher?.setConfig(ws, ck)
    }
  }
  syncGoConfig()

  // 配置（含 Go）变化 → 同步 fetcher + 语言（响应式，无轮询）
  createEffect(() => {
    const lang = config().language
    setLanguage(lang)
    syncGoConfig()
  })

  // ── 面板宽度常量（写死 opencode 侧边栏，不做动态测量）──
  const PANEL_WIDTH = 38
  const INNER_WIDTH = PANEL_WIDTH - 2   // 36，边框内可用列数
  const HALF_INNER_W = Math.max(4, Math.floor((INNER_WIDTH - 2) / 2))

  const innerWidth = () => INNER_WIDTH
  const halfInnerW = () => HALF_INNER_W

  // ── Go 套餐用量 ──
  const [goUsageVersion, setGoUsageVersion] = createSignal(0)
  onMount(() => {
    const unsub = props.goUsageFetcher?.subscribe(() => setGoUsageVersion(v => v + 1))
    onCleanup(() => { try { unsub?.() } catch { } })
  })
  const goUsage = createMemo(() => {
    void goUsageVersion()
    return props.goUsageFetcher?.data() ?? null
  })
  const goConfigured = () => !!config().go?.workspaceID && !!config().go?.cookie

  const goRows = createMemo(() => {
    const iconW = 2
    const rows = [
      { icon: "🕔", bucket: goUsage()?.rolling ?? null },
      { icon: "📅", bucket: goUsage()?.weekly ?? null },
      { icon: "🌙", bucket: goUsage()?.monthly ?? null },
    ]
    return { rows, iconW }
  })

  const goSummary = createMemo(() => {
    const usage = goUsage()
    if (!usage || usage.error) return ""
    return [usage.rolling, usage.weekly, usage.monthly]
      .map((b) => {
        if (!b || b.percent < 0) return "—|—"
        const reset = formatResetShort(b.resetInSec)
        return `${b.percent}%|${reset || "0m"}`
      })
      .join("  ")
  })
  const goSummaryDisplay = createMemo(() => {
    const s = goSummary()
    if (!s) return ""
    const titleW = getVisualWidth(`${collapse().subBlocks["go-plan"] ? "▶" : "▾"} ${t("goPlan")}`)
    const maxW = Math.max(4, innerWidth() - 2 - titleW - 1)
    return truncateTail(s, maxW)
  })

  // ── 颜色 helpers（v1 扁平键 → v2 ResolvedTheme 语义 token，带硬编码兜底）──
  const accentColor = (): RGBA => theme.hue?.accent?.[500] ?? RGBA.fromInts(88, 166, 255, 255)
  const primaryColor = (): RGBA => theme.hue?.interactive?.[400] ?? RGBA.fromInts(88, 166, 255, 255)
  const mutedColor = (): RGBA => theme.text?.muted ?? RGBA.fromInts(139, 148, 158, 255)
  const dimColor = (): RGBA => RGBA.fromInts(72, 79, 88, 255)
  const greenColor = (): RGBA => RGBA.fromInts(63, 185, 80, 255)
  const blueColor = (): RGBA => RGBA.fromInts(88, 166, 255, 255)
  const purpleColor = (): RGBA => RGBA.fromInts(180, 69, 255, 255)
  const borderColor = (): RGBA => theme.border?.base ?? RGBA.fromInts(55, 65, 80, 255)

  const costVisible = () => sessionTotals().totalCost > 0

  // ── 数据聚合（基于 tokenMessages memo）──
  const modelStats = createMemo(() => {
    const map = new Map<string, ModelAgg>()
    const msgs = tokenMessages()
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const key = `${msg.providerID}/${msg.modelID}`
      let e = map.get(key)
      if (!e) {
        e = { providerID: msg.providerID, modelID: msg.modelID, totalInput: 0, totalOutput: 0, totalReasoning: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0, requestCount: 0, lastMessageIndex: -1 }
        map.set(key, e)
      }
      e.totalInput += msg.inputTokens
      e.totalOutput += msg.outputTokens
      e.totalReasoning += msg.reasoningTokens
      e.cacheRead += msg.cacheRead
      e.cacheWrite += msg.cacheWrite
      e.totalCost += msg.cost
      e.requestCount++
      e.lastMessageIndex = i
    }
    return Array.from(map.entries())
      .filter(([, s]) => s.totalInput + s.totalOutput + s.totalReasoning + s.cacheRead + s.cacheWrite > 0)
      .sort((a, b) => b[1].lastMessageIndex - a[1].lastMessageIndex)
  })

  const sessionTotals = createMemo(() => {
    let i = 0, o = 0, ir = 0, cr = 0, cw = 0, r = 0, c = 0
    for (const [, s] of modelStats()) {
      i += s.totalInput; o += s.totalOutput; ir += s.totalReasoning
      cr += s.cacheRead; cw += s.cacheWrite; r += s.requestCount; c += s.totalCost
    }
    return { totalInput: i, totalOutput: o, totalReasoning: ir, totalCacheRead: cr, totalCacheWrite: cw, totalRequests: r, totalCost: c, totalTokens: i + o + ir + cr + cw }
  })

  const globalHitRate = createMemo(() => {
    const denom = sessionTotals().totalInput + sessionTotals().totalCacheRead
    return denom > 0 ? (sessionTotals().totalCacheRead / denom) * 100 : -1
  })

  const perfStats = createMemo(() => computePerfStats(tokenMessages()))

  const tokenDistribution = createMemo(() => {
    const dist: Record<string, number> = {}
    try {
      void tokenMessages()
      void rawMessages()

      // 系统提示估算：取首个带 system 的 agent（v1 取首个 agent 的 prompt）
      try {
        const agents = context.data.location.agent.list()
        const first = agents?.find((a) => typeof a.system === "string" && a.system)
        if (first?.system) dist.system = estimateTokens(first.system)
      } catch { }

      for (const msg of rawMessages()) {
        const m = msg as any
        if (m.type === "user") {
          if (typeof m.text === "string" && m.text) dist.user = (dist.user ?? 0) + estimateTokens(m.text)
          if (Array.isArray(m.files)) {
            for (const f of m.files) {
              const txt = f?.text ?? f?.source?.text?.value
              if (typeof txt === "string" && txt) dist.user = (dist.user ?? 0) + estimateTokens(txt)
            }
          }
        } else if (m.type === "assistant") {
          let msgEstimatedOutput = 0
          const content: readonly any[] = Array.isArray(m.content) ? m.content : []
          for (const p of content) {
            if (p.type === "tool") {
              let rawInput = ""
              try { rawInput = p.state?.raw ?? JSON.stringify(p.state?.input) } catch { try { rawInput = JSON.stringify(p.state) } catch { } }
              if (rawInput) dist.toolCall = (dist.toolCall ?? 0) + estimateTokens(rawInput)
              if (p.state?.status === "completed" && p.state?.output) {
                dist.toolResult = (dist.toolResult ?? 0) + estimateTokens(p.state.output)
              } else if (p.state?.status === "error" && p.state?.error) {
                dist.toolResult = (dist.toolResult ?? 0) + estimateTokens(p.state.error)
              }
            } else if (p.type === "text" && p.text) {
              msgEstimatedOutput += estimateTokens(p.text)
            } else if (p.type === "reasoning") {
              msgEstimatedOutput += estimateTokens(p.text ?? "")
            }
          }
          const tokens = m.tokens
          if (tokens?.output !== undefined || tokens?.reasoning !== undefined) {
            dist.output = (dist.output ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
          } else {
            dist.output = (dist.output ?? 0) + msgEstimatedOutput
          }
        }
      }

      let realInput = 0
      try { realInput = sessionTotals().totalInput } catch { realInput = 0 }
      if (realInput > 0) {
        const estimated = (dist.system ?? 0) + (dist.user ?? 0)
          + (dist.toolCall ?? 0) + (dist.toolResult ?? 0)
        const other = realInput - estimated
        if (other > 50) dist.other = other
      }
    } catch {
      // 任何异常都不让 token 分布拖垮整个面板
    }
    return dist
  })

  // ── 折叠状态 toggle（响应式 Store）──
  const toggle = {
    global: () => storage.updateCollapse((d) => { d.global = !d.global }),
    model: (k: string) => storage.updateCollapse((d) => { d.models = { ...d.models, [k]: !d.models[k] } }),
    sub: (k: string) => storage.updateCollapse((d) => { d.subBlocks = { ...d.subBlocks, [k]: !d.subBlocks[k] } }),
  }

  return (
    <box
      flexDirection="column"
      border={true}
      borderStyle="rounded"
      borderColor={borderColor()}
    >

      {/* ① 面板标题行（永远显示） */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        marginBottom={1}
        onMouseDown={toggle.global}
      >
        <text fg={mutedColor()}>{collapse().global ? "▶" : "▾"}</text>
        <text fg={accentColor()}>{t("panelTitle")}</text>
        <text fg={mutedColor()}>{" "}</text>
      </box>

      {/* ① 四项总计（永远显示） */}
      <box flexDirection="row" paddingX={1}>
        <For each={[
          { val: formatTokens(sessionTotals().totalTokens), lbl: t("total"), color: primaryColor, rw: 6 },
          { val: "×" + sessionTotals().totalRequests, lbl: t("requests"), color: purpleColor, rw: 6 },
          { val: costVisible() ? formatCost(sessionTotals().totalCost) : "—", lbl: t("cost"), color: greenColor, rw: 7 },
          { val: globalHitRate() >= 0 ? globalHitRate().toFixed(1) + "%" : "—", lbl: t("hit"), color: hitColor, rw: 6 },
        ]}>
          {(item, idx) => {
            const colW = () => {
              const totalW = innerWidth() - 2
              const base = Math.floor(totalW / 4)
              return idx() === 3 ? totalW - base * 3 : base
            }
            return (
              <box width={colW()} flexDirection="column">
                <text fg={item.color()}>{fixedCenter(item.val, item.rw, colW())}</text>
                <text fg={dimColor()}>
                  {fixedCenter(isEnglish(item.lbl) ? item.lbl.toUpperCase() : item.lbl, item.rw, colW())}
                </text>
              </box>
            )
          }}
        </For>
      </box>

      <Show when={!collapse().global}>

        {/* ② 输入 / 输出（折叠时隐藏） */}
        <box flexDirection="row" paddingX={1}>
          <box width={halfInnerW()} flexDirection="column">
            <text fg={blueColor()}>{fixedCenter(formatTokens(sessionTotals().totalInput), 6, halfInnerW())}</text>
            <text fg={dimColor()}>
              {fixedCenter(isEnglish(t("input")) ? t("input").toUpperCase() : t("input"), 6, halfInnerW())}
            </text>
          </box>
          <box width={halfInnerW()} flexDirection="column">
            <text fg={purpleColor()}>{fixedCenter(formatTokens(sessionTotals().totalOutput), 6, halfInnerW())}</text>
            <text fg={dimColor()}>
              {fixedCenter(isEnglish(t("output")) ? t("output").toUpperCase() : t("output"), 6, halfInnerW())}
            </text>
          </box>
        </box>

        {/* ③④ 各模型块 */}
        <For each={modelStats()}>
          {([key, stat]) => {
            const isExpanded = () => collapse().models[key] !== true

            const hitDenom = stat.totalInput + stat.cacheRead
            const hitRate = hitDenom > 0 ? (stat.cacheRead / hitDenom) * 100 : 0
            const modelTotalTokens = stat.totalInput + stat.totalOutput + stat.totalReasoning + stat.cacheRead + stat.cacheWrite
            const showModelCost = () => stat.totalCost > 0

            const avail = innerWidth() - 2
            const providerMaxW = Math.max(4, avail - 1 - getVisualWidth(stat.modelID))
            const providerDisplay = truncateTail(stat.providerID, providerMaxW)
            const providerDispW = getVisualWidth(`${isExpanded() ? "▾" : "▶"} ${providerDisplay}`)
            const modelDispW = Math.max(4, avail - 1 - providerDispW)
            const modelNameDisplay = truncateTail(stat.modelID, modelDispW)

            return (
              <box flexDirection="column" marginTop={1}>

                <box flexDirection="column" onMouseDown={() => toggle.model(key)} paddingX={1}>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={mutedColor()}>
                      <span>{isExpanded() ? "▾" : "▶"} </span>
                      <span style={{ fg: mutedColor() } as any}>{providerDisplay}</span>
                    </text>
                    <text fg={mutedColor()}>
                      <span style={{ fg: primaryColor() } as any}>{modelNameDisplay}</span>
                    </text>
                  </box>

                  <box flexDirection="row" marginTop={1}>
                    <For each={[
                      { text: formatTokens(modelTotalTokens), fg: primaryColor, rw: 6 },
                      { text: `×${stat.requestCount}`, fg: purpleColor, rw: 6 },
                      ...(showModelCost() ? [{ text: formatCost(stat.totalCost), fg: greenColor, rw: 7 }] : []),
                      { text: `${hitRate.toFixed(1)}%`, fg: hitColor, rw: 6 },
                    ]}>
                      {(item, idx) => {
                        const colCount = showModelCost() ? 4 : 3
                        const colW = () => {
                          const totalW = innerWidth() - 2
                          const base = Math.floor(totalW / colCount)
                          return idx() === colCount - 1 ? totalW - base * (colCount - 1) : base
                        }
                        return (
                          <box width={colW()} flexDirection="column">
                            <text fg={item.fg()}>{fixedCenter(item.text, item.rw, colW())}</text>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                </box>

                <Show when={isExpanded()}>
                  <box flexDirection="column" paddingX={2} marginTop={1}>
                    <Show when={config().sidebar.showPerformance && !!perfStats().models[key]}>
                      <box
                        flexDirection="column"
                        border={true}
                        borderStyle="rounded"
                        borderColor={borderColor()}
                      >
                        <box flexDirection="row">
                          <For each={[
                            { val: formatDuration(perfStats().models[key]?.avgTTFT ?? null), lbl: t("ttft"), rw: 6 },
                            { val: perfStats().models[key]?.avgTPS?.toFixed(1) ?? "—", lbl: t("tps"), rw: 6 },
                            { val: formatDuration(perfStats().models[key]?.avgLatency ?? null), lbl: t("latency"), rw: 6 },
                          ]}>
                            {(item, idx) => {
                              const colW = () => {
                                const totalW = PANEL_WIDTH - 2 - 2 - 4 - 2
                                const base = Math.floor(totalW / 3)
                                return idx() === 2 ? totalW - base * 2 : base
                              }
                              return (
                                <box width={colW()} flexDirection="column">
                                  <text fg={primaryColor()}>{fixedCenter(item.val, item.rw, colW())}</text>
                                  <text fg={dimColor()}>
                                    {fixedCenter(isEnglish(item.lbl) ? item.lbl.toUpperCase() : item.lbl, item.rw, colW())}
                                  </text>
                                </box>
                              )
                            }}
                          </For>
                        </box>
                      </box>
                    </Show>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>

        {/* ⑤ Token 分布区块 */}
        <Show when={config().sidebar.showTokenDistribution}>
          <box flexDirection="column" marginTop={1}>
            <box
              flexDirection="row"
              onMouseDown={() => toggle.sub("token-dist")}
              paddingX={1}
            >
              <text fg={greenColor()}>
                {!collapse().subBlocks["token-dist"] ? "▾" : "▶"} {t("tokenDistribution")}
              </text>
            </box>

            <Show when={!collapse().subBlocks["token-dist"]}>
              <box flexDirection="column" paddingX={1} marginTop={1}>
                <For each={Object.entries(tokenDistribution() ?? {}).filter(([_, val]) => val > 0)}>
                  {([role, val]) => (
                    <box flexDirection="row" justifyContent="space-between">
                      <box flexDirection="row">
                        <text fg={distRoleColor(role)}>█ </text>
                        <text fg={mutedColor()}>{t(role)}</text>
                      </box>
                      <text fg={mutedColor()}>{fixedRightPad(formatTokens(val), 7)}</text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>

        {/* ⑥ Go 套餐用量区块 */}
        <Show when={config().sidebar.showGoUsage && goConfigured()}>
          <box flexDirection="column" marginTop={1}>
            <box
              flexDirection="row"
              justifyContent="space-between"
              onMouseDown={() => {
                toggle.sub("go-plan")
                props.goUsageFetcher?.refresh(true)
              }}
              paddingX={1}
            >
              <text fg={greenColor()}>
                {!collapse().subBlocks["go-plan"] ? "▾" : "▶"} {t("goPlan")}
              </text>
              <text fg={mutedColor()}>
                {goSummaryDisplay()}
              </text>
            </box>

            <Show when={!collapse().subBlocks["go-plan"]}>
              <box flexDirection="column" paddingX={1} marginTop={1}>
                <For each={goRows().rows}>
                  {(row, idx) => {
                    const bucket = row.bucket
                    const pctVal = bucket && bucket.percent >= 0 ? bucket.percent : -1
                    const pct = pctVal >= 0 ? padPercent(pctVal) : GO_PCT_EMPTY
                    const icon = padTail(row.icon, goRows().iconW)
                    const avail = innerWidth() - 2
                    const barW = Math.max(8, avail - goRows().iconW - GO_PCT_W - 3)
                    const clampPct = pctVal >= 0 ? Math.max(0, Math.min(100, pctVal)) : 0
                    const color = pctVal >= 0 ? goPercentColor(pctVal) : dimColor()
                    const filled = Math.round((Math.round(clampPct) / 100) * barW)
                    return (
                      <text marginTop={idx() > 0 ? 1 : 0}>
                        <span style={{ fg: mutedColor() } as any}>{icon}</span>
                        <span style={{ fg: color } as any}>{pct}</span>
                        <span style={{ fg: mutedColor() } as any}>{" "}</span>
                        <span style={{ fg: color } as any}>{"█".repeat(filled)}</span>
                        <span style={{ fg: dimColor() } as any}>{"░".repeat(Math.max(0, barW - filled))}</span>
                      </text>
                    )
                  }}
                </For>
                <Show when={!!goUsage()?.error}>
                  <text fg={dimColor()} marginTop={1}>
                    {goUsage()?.error === "auth-failed" ? `🔒 ${t("goAuthFailed")}` : `⚠ ${t("goFetchFailed")}`}
                  </text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>

      </Show>
    </box>
  )
}
