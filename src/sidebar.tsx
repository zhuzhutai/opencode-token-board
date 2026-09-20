import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup } from "solid-js"
import type { TuiPluginApi, TuiTheme } from "@opencode-ai/plugin/tui"
import { RGBA } from "@opentui/core"
import { formatTokens, formatCost, formatDuration } from "./formatter.js"
import { t as baseT, setLanguage } from "./i18n.js"
import type { PerfTracker } from "./perf-tracker.js"
import type { TokenMessage } from "./tui.js"
import type { GoUsageData } from "./formatter.js"
import type { GoUsageFetcher } from "./go-usage.js"
import type { UpdateChecker } from "./update-check.js"

/**
 * ══════════════════════════════════════════════════════════════════
 *  sidebar.tsx — 侧边栏 UI（终端里 TokenWatch 面板的全部展示逻辑）
 *
 *  本文件唯一职责：把 token 数据渲染成右侧边栏的字符界面。
 *  想调 UI 外观（行内容 / 配色 / 宽度 / 显示与否）都在这里改。
 *  数据从哪里来、怎么算的，不在这里（见 perf-tracker.ts / tui.tsx）。
 *
 *  ── 渲染出的终端效果（当前布局）────────────────────────────────
 *  ╭────────────────────────────────────────╮
 *  │ ▾      OpenCode-Token-Board            │  ← ① 面板标题行（accent 强调色，居中；点击折叠 ②以下）
 *  │                                        │      （标题下留一行空隙，无分隔线）
 *  │    12.3K   ×45    $0.04  89.1%         │  ← ① 四项总计居中：总计|请求|花费|命中（4色）
 *  │     总计  请求    花费   命中           │  ← ① 四项标签居中（暗色）
 *  │           9.2K  3.1K                   │  ← ② 输入(蓝) / 输出(紫) 居中（折叠时隐藏）
 *  │           输入  输出                    │
 *  │                                        │
 *  │ ▾ opencode    deepseek-v4-flash       │  ← ③ 模型头行1：▾(左,折叠三角) 供应商  模型名(右,优先) 无右侧箭头
 *  │    1.2M  ×45  $0.04  89.1%             │  ← ③ 模型头行2：四统计均分宽度居中(配色同①) 点击折叠/展开 ④
 *  │   ╭────────────────────────╮           │
 *  │   │   1.2s  45.3   12S     │           │  ← ④ 性能网格（展开时）：TTFT / TPS / 延迟
 *  │   │   TTFT  TPS   延迟     │           │
 *  │   ╰────────────────────────╯           │
 *  │                                        │
 *  │ ▾ Token分布                            │  ← ⑤ Token 分布（点击折叠）
 *  │   █ 系统提示  1.2K                     │
 *  │                                        │
 *  │ ▾ Go 套餐   8%|3h  8%|5d  11%|26d     │  ← ⑥ Go 套餐（点击折叠+强制刷新），标题右：三桶 百分比|剩余时间
 *  │   🕔  8% ████░░░░░░░░░░░░░            │  ← 列表行：icon + 百分比 + 进度条（无文字/剩余时间列，条更宽更精细）
 *  │   📅 13% ██████░░░░░░░░░░░            │     固定列宽对齐，三行始终渲染（无数据时 — 占位）
 *  │   🌙 11% █████░░░░░░░░░░░░            │
 *  ╰────────────────────────────────────────╯
 *  注：无任何横线/竖线分隔符；① 标题 + ① 总计 永远显示，不随折叠隐藏；
 *      折叠仅影响 ②（输入/输出）、③④（模型）、⑤⑥。
 *  配色语义统一：标题=accent，主数值/模型名=primary，请求数/输出=purple，输入=blue，
 *              花费/成本=green，命中=黄色(hitColor)，标签/次要=暗色。
 *  防抖动：opencode 侧边栏固定 width={42}（padding 2+2 → slot 38 列），面板宽度是常量，
 *          PANEL_WIDTH=38（含边框），INNER_WIDTH=36（内容区），不做任何动态测量。
 *          从首帧起布局即完全确定，杜绝挂载校准/刷新时的一切抖动。
 *          所有数值列用 fixedCenter 固定占位宽再居中，标签用与数值相同的
 *          占位宽（label 与数值右端对齐），数字位数变化时文本位置不动，只向左增长。
 *          （Go 进度条条长也用整数百分比计算，与显示数字一致。）
 *
 *  ── 通用概念 ────────────────────────────────────────────────────
 *  · <box>    容器（flex 布局，类比安卓 LinearLayout / Column）
 *  · <text>   文本行，可内嵌多个 <span> 分段上色
 *  · <span>   单行内的一段文字（`style={{ fg: 颜色 }}`）
 *  · PANEL_WIDTH  面板宽度（含边框），写死为 opencode 侧边栏常量 38，不做动态测量
 *  · innerWidth()  = panelWidth - 2（去掉左右边框后的内容区）
 *  · 所有文案（中文/英文）在 src/i18n.ts 里改
 *  · 数据在 src/formatter.ts 定义类型；src/i18n.ts 定义文案
 *  ──────────────────────────────────────────────────────────────────
 */

export interface SidebarConfig {
  sidebar: {
    showPerformance: boolean
    showTokenDistribution: boolean
    showGoUsage: boolean
  }
  language: "zh" | "en" | "auto"
  go?: { apiKey?: string }
}

const DEFAULT_CONFIG: SidebarConfig = {
  sidebar: { showPerformance: true, showTokenDistribution: true, showGoUsage: true },
  language: "auto",
}

// 计算字符串在终端里的可视宽度（中文/日韩=2 宽，其余=1）。所有宽度换算都用它，避免中文撑破对齐
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

function centerAlign(text: string, width: number): string {
  const visualW = getVisualWidth(text)
  if (visualW >= width) return truncateTail(text, width)  // 超出则截断，绝不换行
  const left = Math.floor((width - visualW) / 2)
  const right = width - visualW - left
  return " ".repeat(left) + text + " ".repeat(right)
}

/** 数值固定宽度居中：先把数值右对齐填充到固定占位宽（reservedW），再整体居中到列宽 colW。
 *  占位宽恒定 ⇒ 数字位数变化（如 "—" → "1.2s"、9.2K → 10.0K）时文本位置不动，
 *  只在占位块内部向左增长，杜绝居中导致的左右抖动。值超过占位宽时退化为普通居中。 */
function fixedCenter(val: string, reservedW: number, colW: number): string {
  const vw = getVisualWidth(val)
  if (vw >= colW) return truncateTail(val, colW)
  const block = vw >= reservedW ? val : " ".repeat(reservedW - vw) + val
  return centerAlign(block, colW)
}

/** 数值固定宽度右对齐：填充到固定占位宽，右侧不动。用于 space-between 右侧数值列。 */
function fixedRightPad(val: string, width: number): string {
  const vw = getVisualWidth(val)
  if (vw >= width) return truncateTail(val, width)
  return " ".repeat(width - vw) + val
}

// 命中率固定用黄色展示（不再按阈值变绿/黄/红）
function hitColor(): RGBA {
//   return RGBA.fromInts(255, 193, 7, 255)
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
      (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0x1100 && code <= 0x11FF) ||
      (code >= 0x2E80 && code <= 0x2EFF)) cjk++
    else ascii++
  }
  const trimmed = text.trimStart()
  const jsonLike = (trimmed.startsWith("{") || trimmed.startsWith("[")) && /"[^"]+"\s*:/.test(text)
  const codeLike = !jsonLike && /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(text)
  const asciiPerToken = jsonLike ? 2 : codeLike ? 2.5 : 4
  return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.5))
}

/** Go 用量百分比配色：<50 绿，50-80 黄，>80 红（想调阈值改这里） */
function goPercentColor(percent: number): RGBA {
  if (percent >= 80) return RGBA.fromInts(244, 67, 54, 255)
  if (percent >= 50) return RGBA.fromInts(255, 193, 7, 255)
  return RGBA.fromInts(63, 185, 80, 255)
}

/** 重置倒计时短格式：<1h 分钟，<24h 小时，之后天 */
function formatResetShort(sec: number): string {
  if (!sec || sec <= 0) return ""
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.ceil(sec / 60)}m`
  if (sec < 86400) return `${Math.ceil(sec / 3600)}h`
  return `${Math.ceil(sec / 86400)}d`
}

/** 百分比统一宽度（右对齐到 4 列）：1% -> "  1%"、11% -> " 11%"、100% -> "100%" */
function padPercent(percent: number): string {
  return String(Math.round(percent)).padStart(3, " ") + "%"
}

// ── Go 套餐列表列宽常量（改动统一在这里，各行自动对齐）──
const GO_PCT_W = 4   // 百分比列固定宽（右对齐）：1% → "  1%"
const GO_PCT_EMPTY = "   —"  // 数据未返回时的百分比占位

/** 字符串左对齐补齐到指定可视宽度（不足补空格，超出不截断）。用于 icon/label 固定宽对齐 */
function padTail(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - getVisualWidth(text)))
}

/** 字符串截断到指定可视宽度，超出部分替换为 "…"。用于供应商名超长时压缩。 */
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

interface CollapseState { global: boolean; models: Record<string, boolean>; subBlocks: Record<string, boolean> }

function loadCollapseState(api: TuiPluginApi): CollapseState {
  try { return (api.kv?.get?.("tokenwatch-collapse") as CollapseState) ?? { global: false, models: {}, subBlocks: {} } }
  catch { return { global: false, models: {}, subBlocks: {} } }
}
function saveCollapseState(api: TuiPluginApi, state: CollapseState): void {
  try { api.kv?.set?.("tokenwatch-collapse", state) } catch { /* non-critical */ }
}

export function loadConfig(api: TuiPluginApi): SidebarConfig {
  const base = { sidebar: { ...DEFAULT_CONFIG.sidebar }, language: DEFAULT_CONFIG.language, go: {} as { apiKey?: string } }
  try {
    const pluginCfg = (api as any).config?.pluginConfig?.["opencode-token-board"]
    if (pluginCfg?.sidebar) Object.assign(base.sidebar, pluginCfg.sidebar)
    if (pluginCfg?.language) base.language = pluginCfg.language
    if (pluginCfg?.go) base.go = pluginCfg.go
    const overrides = api.kv?.get?.("tokenwatch-config") as Partial<SidebarConfig> | undefined
    if (overrides?.sidebar) Object.assign(base.sidebar, overrides.sidebar)
    if (overrides?.language) base.language = overrides.language
    if (overrides?.go) base.go = overrides.go
  } catch { /* defaults */ }
  return base
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
  /** allTokenMessages 数组中该模型最后一条消息的索引，用于「最近调用时间」排序 */
  lastMessageIndex: number
}

interface TokenWatchPanelProps {
  api: TuiPluginApi
  theme: TuiTheme
  perfTracker: PerfTracker
  messages: () => readonly any[]
  allTokenMessages: () => TokenMessage[]
  goUsageFetcher?: GoUsageFetcher
  updateChecker?: UpdateChecker
}

export function TokenWatchPanel(props: TokenWatchPanelProps) {
  const { api, theme, perfTracker } = props
  const getMessages = () => props.messages()
  const [config, setConfig] = createSignal<SidebarConfig>(loadConfig(api))
  // 同步初始化语言以防首帧渲染使用错误的 detectLanguage 默认值
  setLanguage(config().language)
  let knownCfgVer = api.kv?.get?.("tokenwatch-config-version") as number | undefined

  // ── 响应式翻译函数 ──
  const t = (key: string) => {
    // 显式订阅 config 的变化以建立 SolidJS 追踪依赖
    void config().language
    return baseT(key)
  }

  // 检测是否是纯英文标签，用于全大写转换
  const isEnglish = (str: string) => /^[a-zA-Z\s\.\/]+$/.test(str)

  // Go 配置（API Key）变更时同步到 fetcher（触发立即刷新）
  let lastGoKey = ""
  const syncGoConfig = () => {
    const key = config().go?.apiKey ?? ""
    if (key !== lastGoKey) {
      lastGoKey = key
      props.goUsageFetcher?.setConfig(key)
    }
  }
  syncGoConfig()

  createEffect(() => {
    const timer = setInterval(() => {
      const v = api.kv?.get?.("tokenwatch-config-version") as number | undefined
      if (v != null && v !== knownCfgVer) {
        knownCfgVer = v
        setConfig(loadConfig(api))
        syncGoConfig()
      }
    }, 500)
    onCleanup(() => clearInterval(timer))
  })

  const [collapse, setCollapse] = createSignal<CollapseState>(loadCollapseState(api))

  // ── 面板宽度（写死为 opencode 侧边栏常量，不做任何动态测量）──
  // opencode 源码 packages/tui/src/routes/session/sidebar.tsx：
  //   侧边栏 <box width={42} paddingLeft={2} paddingRight={2}>，
  //   ⇒ sidebar_content slot 固定 = 42 − 2 − 2 = 38 列。
  // 本面板带 1 列圆角边框 → 内容区恒为 36 列。
  // 直接用常量，从首帧起布局即完全确定，杜绝挂载校准/刷新时的一切抖动。
  // 注意：必须声明在所有用到 innerWidth() 的 memo 之前（createMemo 创建即求值，靠后声明会触发 TDZ）
  const PANEL_WIDTH = 38
  const INNER_WIDTH = PANEL_WIDTH - 2   // 36 — 边框内可用列数
  const HALF_INNER_W = Math.max(4, Math.floor((INNER_WIDTH - 2) / 2))  // ② 输入/输出各占一半

  // ── 宽度派生值（均为常量函数，供下游统一调用）──
  const innerWidth = () => INNER_WIDTH
  const halfInnerW = () => HALF_INNER_W

  // ── Go 套餐用量（订阅 fetcher 更新，驱动 SolidJS 重绘）──
  const [goUsageVersion, setGoUsageVersion] = createSignal(0)
  onMount(() => {
    const unsub = props.goUsageFetcher?.subscribe(() => setGoUsageVersion(v => v + 1))
    onCleanup(() => { try { unsub?.() } catch { } })
  })
  const goUsage = createMemo(() => {
    void goUsageVersion()
    return props.goUsageFetcher?.data() ?? null
  })
  // Go 是否可用（显式 API Key 或自动从 OpenCode 凭据解析到）→ 决定区块是否显示
  const goConfigured = () => props.goUsageFetcher?.configured() ?? false

  // ── 插件更新提示（有新版本时在面板底部显示一行，点击打开 /usage 菜单）──
  const [updateVersion, setUpdateVersion] = createSignal(0)
  onMount(() => {
    const unsub = props.updateChecker?.subscribe(() => setUpdateVersion(v => v + 1))
    onCleanup(() => { try { unsub?.() } catch { } })
  })
  const updateInfo = createMemo(() => {
    void updateVersion()
    return props.updateChecker?.info() ?? null
  })

  const goRows = createMemo(() => {
    const iconW = 2 // 🕔📅🌙 均为 2 宽 + 1 空格，固定 icon 列保证各行对齐
    const rows = [
      { icon: "🕔", bucket: goUsage()?.rolling ?? null },
      { icon: "📅", bucket: goUsage()?.weekly ?? null },
      { icon: "🌙", bucket: goUsage()?.monthly ?? null },
    ]
    return { rows, iconW }
  })

  // 标题最右侧的汇总：三个桶各自的 百分比|剩余时间，两两间用 2 空格分隔（与滚动原样式一致）
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
  // 汇总文本按头部剩余宽度截断（标题 "▾ Go 套餐" 固定占宽），避免换行闪烁
  const goSummaryDisplay = createMemo(() => {
    const s = goSummary()
    if (!s) return ""
    const titleW = getVisualWidth(`${collapse().subBlocks["go-plan"] ? "▶" : "▾"} ${t("goPlan")}`)
    const maxW = Math.max(4, innerWidth() - 2 - titleW - 1)
    return truncateTail(s, maxW)
  })

  createEffect(() => setLanguage(config().language))

  // ── 颜色 helpers ──
  // 统一配色语义（改一处全局生效）：
  //   标题 = accent(主题强调色)   主数值/模型名 = primary(主题主色)
  //   请求数/输出 = purple(紫)    输入 = blue(蓝)   花费/成本 = green(绿)
  //   命中率 = hitColor(固定黄)   标签/次要 = muted(弱化)   更暗 = dim
  const accentColor = (): RGBA => theme.current.accent            // 标题强调色
  const primaryColor = (): RGBA => theme.current.primary          // 主数值 / 模型名
  const mutedColor = (): RGBA => theme.current.textMuted          // 弱化文字（标签、次要信息）
  const dimColor = (): RGBA => RGBA.fromInts(72, 79, 88, 255)     // 更暗（错误提示等）
  const greenColor = (): RGBA => RGBA.fromInts(63, 185, 80, 255)  // 绿：成本/花费
  const blueColor = (): RGBA => RGBA.fromInts(88, 166, 255, 255)  // 蓝：输入
  const purpleColor = (): RGBA => RGBA.fromInts(180, 69, 255, 255)// 紫：请求数 / 输出
  const borderColor = (): RGBA => RGBA.fromInts(55, 65, 80, 255)  // 边框
  //RGBA.fromInts(255, 166, 87, 255)
//   const hitColor = (): RGBA => RGBA.fromInts(255, 166, 87, 255)

  // 成本是否展示：有非零花费时即显示（定价始终开启）
  const costVisible = () => sessionTotals().totalCost > 0

  // ── 数据聚合 ──
  const modelStats = createMemo(() => {
    const map = new Map<string, ModelAgg>()
    const msgs = props.allTokenMessages()
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
      e.lastMessageIndex = i  // 追踪该模型最后一条消息的索引（越大 = 越近调用）
    }
    return Array.from(map.entries())
      // 过滤掉全零无效模型（如会话失败导致 token 全为 0 的记录）
      .filter(([, s]) => s.totalInput + s.totalOutput + s.totalReasoning + s.cacheRead + s.cacheWrite > 0)
      // 按最近调用时间降序：最后一条消息在数组中索引越大越靠前
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

  const modelHitRate = createMemo(() => {
    return modelStats().map(([key, stat]) => {
      const denom = stat.totalInput + stat.cacheRead
      if (denom === 0) return { key, rate: 0, msgs: [] as TokenMessage[] }
      const msgs: TokenMessage[] = []
      for (const msg of props.allTokenMessages()) {
        const pk = `${msg.providerID}/${msg.modelID}`
        if (pk !== key) continue
        msgs.push(msg)
      }
      return { key, rate: (stat.cacheRead / denom) * 100, msgs }
    })
  })

  const modelTrend = createMemo(() => {
    return modelHitRate().map(({ key, msgs }) => {
      if (msgs.length < 6) return { key, trend: null as number | null }
      const sumSlice = (start: number, end: number) => {
        let sumCache = 0, sumTotal = 0
        for (let i = start; i < end && i < msgs.length; i++) {
          sumCache += msgs[i].cacheRead
          sumTotal += msgs[i].inputTokens + msgs[i].cacheRead
        }
        return { sumCache, sumTotal }
      }
      const n = msgs.length
      const recent = sumSlice(n - 3, n)
      const prev = sumSlice(n - 6, n - 3)
      const rateRecent = recent.sumTotal > 0 ? (recent.sumCache / recent.sumTotal) * 100 : 0
      const ratePrev = prev.sumTotal > 0 ? (prev.sumCache / prev.sumTotal) * 100 : 0
      return { key, trend: rateRecent - ratePrev }
    })
  })

  const [partVersion, setPartVersion] = createSignal(0)

  const perfStats = createMemo(() => {
    void props.allTokenMessages()
    void partVersion()
    return perfTracker.getSessionStats()
  })

  const tokenDistribution = createMemo(() => {
    void props.allTokenMessages()
    void partVersion()
    const dist: Record<string, number> = {}

    try {
      const cfg = api.state.config as Record<string, unknown>
      const agents = cfg?.agent as Record<string, unknown> | undefined
      if (agents) {
        for (const ac of Object.values(agents)) {
          const a = ac as Record<string, unknown>
          if (typeof a?.prompt === "string" && a.prompt) {
            dist.system = estimateTokens(a.prompt)
            break
          }
        }
      }
    } catch { }

    for (const msg of getMessages()) {
      const role = (msg as any).role
      if (role === "user") {
        if ((msg as any).system) dist.system = (dist.system ?? 0) + estimateTokens((msg as any).system)
        let parts: readonly any[] = []
        try { parts = api.state.part((msg as any).id) } catch { continue }
        for (const p of parts) {
          if (p.type === "text" && !p.synthetic && !p.ignored) {
            dist.user = (dist.user ?? 0) + estimateTokens(p.text ?? "")
          } else if (p.type === "file" && p.source?.text?.value) {
            dist.user = (dist.user ?? 0) + estimateTokens(p.source.text.value)
          }
        }
      } else if (role === "assistant") {
        let parts: readonly any[] = []
        try { parts = api.state.part((msg as any).id) } catch { continue }
        let msgEstimatedOutput = 0
        for (const p of parts) {
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
          } else if (p.type === "subtask") {
            msgEstimatedOutput += estimateTokens(p.prompt || p.description || "")
          }
        }
        const tokens = (msg as any).tokens
        if (tokens?.output !== undefined || tokens?.reasoning !== undefined) {
          dist.output = (dist.output ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
        } else {
          dist.output = (dist.output ?? 0) + msgEstimatedOutput
        }
      }
    }

    const realInput = sessionTotals().totalInput
    if (realInput > 0) {
      const estimated = (dist.system ?? 0) + (dist.user ?? 0)
        + (dist.toolCall ?? 0) + (dist.toolResult ?? 0)
      const other = realInput - estimated
      if (other > 50) dist.other = other
    }

    return dist
  })



  // ── 折叠状态 toggle ──
  const toggle = {
    global: () => setCollapse(p => { const n = { ...p, global: !p.global }; saveCollapseState(api, n); return n }),
    model: (k: string) => setCollapse(p => { const n = { ...p, models: { ...p.models, [k]: !p.models[k] } }; saveCollapseState(api, n); return n }),
    sub: (k: string) => setCollapse(p => { const n = { ...p, subBlocks: { ...p.subBlocks, [k]: !p.subBlocks[k] } }; saveCollapseState(api, n); return n }),
  }

  onMount(() => {
    const unsubPart = api.event?.on?.("message.part.updated", () => setPartVersion(v => v + 1))
    onCleanup(() => { try { unsubPart?.() } catch { } })
  })

  return (
    <box
      // ── 不设置固定 width，让外层容器决定宽度（opencode 侧边栏固定 42 列）──
      // 宽度已写死为常量 PANEL_WIDTH=38，无需 onSizeChange 测量，首帧布局即完全确定。
      flexDirection="column"
      border={true}
      borderStyle="rounded"
      borderColor={borderColor()}
    >

      {/* ① 面板标题行（永远显示）：▾ 固定左缘，标题独立居中（accent 强调色），右侧同宽占位保持居中。
          marginBottom 给标题下方留一行空隙，避免与四项统计贴太近。
          点击整行 = 折叠/展开 ③ 以下的所有内容。 */}
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

      {/* ① 四项总计（永远显示）：总计|请求|花费|命中，4 色，数值+标签居中。
           颜色顺序：总计(primary) 请求(purple) 花费(green) 命中(hitColor 黄)。想加/删项改这个 each。
           数值用 fixedCenter 固定占位宽，刷新时文本不抖动。 */}
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

        {/* ② 输入 / 输出（折叠时隐藏）：居中 2 列，输入(蓝) 输出(紫)。数值+标签同占位宽，对齐且不抖动。 */}
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

        {/* ③④ 各模型块：对每个模型循环渲染 ③头（两行+四统计，永不折叠）+ ④性能网格。
            每个模型一个 <box>，用 marginTop=1 隔开。缓存进度条已移除。 */}
        <For each={modelStats()}>
          {([key, stat]) => {
            const isExpanded = () => collapse().models[key] !== true

            const hitDenom = stat.totalInput + stat.cacheRead
            const hitRate = hitDenom > 0 ? (stat.cacheRead / hitDenom) * 100 : 0

            // 模型总 tokens
            const modelTotalTokens = stat.totalInput + stat.totalOutput + stat.totalReasoning + stat.cacheRead + stat.cacheWrite
            const showModelCost = () => stat.totalCost > 0

            // ③ 行1：供应商优先截断，模型名优先展示，整体不换行。
            // space-between 处理间距。用 truncateTail 保证左侧供应商 + 右侧模型名 恒 <= avail，
            // 最后一行避免 Math.max(8) 下限把两者挤超宽度导致换行。
            const avail = innerWidth() - 2
            const providerMaxW = Math.max(4, avail - 1 - getVisualWidth(stat.modelID))
            const providerDisplay = truncateTail(stat.providerID, providerMaxW)
            const providerDispW = getVisualWidth(`${isExpanded() ? "▾" : "▶"} ${providerDisplay}`)
            const modelDispW = Math.max(4, avail - 1 - providerDispW)
            const modelNameDisplay = truncateTail(stat.modelID, modelDispW)

            return (
              <box flexDirection="column" marginTop={1}>

                {/* ③ 模型头（两行，永不折叠；点击折叠/展开 ④）：
                    行1: ▾▶(左,折叠三角) 供应商  模型名(右,优先)
                    行2: 1.2M  ×45  $0.04  89.1%（四统计居中，无分隔线，配色同 ①） */}
                <box flexDirection="column" onMouseDown={() => toggle.model(key)} paddingX={1}>

                  {/* 行1：▼▶(左,折叠三角)  供应商  模型名(右) */}
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={mutedColor()}>
                      <span>{isExpanded() ? "▾" : "▶"} </span>
                      <span style={{ fg: mutedColor() } as any}>{providerDisplay}</span>
                    </text>
                    <text fg={mutedColor()}>
                      <span style={{ fg: primaryColor() } as any}>{modelNameDisplay}</span>
                    </text>
                  </box>

                  {/* 行2：四统计均分宽度居中，配色与 ① 一致：总计(primary) 请求(purple) 花费(green) 命中(hit)。
                      与顶部总计行同款均分列宽，数值固定占位宽，数字变化时不换行不抖动。 */}
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

                    {/* ④ 性能网格（带圆角边框）：TTFT / TPS / 延迟
                        值(主色)+标签(暗色) 三列均分。可关：设置→显示性能指标。 */}
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
                            { val: (perfStats().models[key]?.recentTPS ?? perfStats().models[key]?.avgTPS)?.toFixed(1) ?? "—", lbl: t("tps"), rw: 6 },
                            { val: formatDuration(perfStats().models[key]?.avgLatency ?? null), lbl: t("latency"), rw: 6 },
                          ]}>
                            {(item, idx) => {
                              const colW = () => {
                                // 面板边框2 + 模型块paddingX2 + ④父级paddingX4 + ④边框2
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

        {/* ⑤ Token 分布区块：▾ Token分布 + 每行 "█ 角色名  数值"
            颜色按角色（distRoleColor），数值 formatTokens()。
            可关：设置→显示Token分布。 */}
        <Show when={config().sidebar.showTokenDistribution}>
          <box flexDirection="column" marginTop={1}>

            {/* Header */}
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
                <For each={Object.entries(tokenDistribution()).filter(([_, val]) => val > 0)}>
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

        {/* ⑥ Go 套餐用量区块：▾ Go 套餐 8% + 三行进度条
            点击标题 = 折叠 + 强制刷新（goUsageFetcher.refresh(true)）。
            已配置即显示；三行列表始终渲染，数据未返回时 "—" 占位，结构一致不闪变。 */}
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
              {/* 三行列表始终渲染，数据未返回/出错时用 "—" 占位：
                  保证首次展示（加载中）与数据返回后的结构完全一致，不再闪成旧样式。
                  每行固定列宽：icon + 百分比 + 进度条（宽条），自动对齐。 */}
              <box flexDirection="column" paddingX={1} marginTop={1}>
                <For each={goRows().rows}>
                  {(row, idx) => {
                    const bucket = row.bucket
                    const pctVal = bucket && bucket.percent >= 0 ? bucket.percent : -1
                    // 百分比右对齐到 4 列，其自身的前导空格即 icon 与百分比的分隔
                    const pct = pctVal >= 0 ? padPercent(pctVal) : GO_PCT_EMPTY
                    const icon = padTail(row.icon, goRows().iconW)
                    const avail = innerWidth() - 2
                    // 固定列：icon + 百分比 + 空格 + 进度条。留3列余量（space+margin+安全），
                    // 避免进度条过长导致换行。
                    const barW = Math.max(8, avail - goRows().iconW - GO_PCT_W - 3)
                    const clampPct = pctVal >= 0 ? Math.max(0, Math.min(100, pctVal)) : 0
                    const color = pctVal >= 0 ? goPercentColor(pctVal) : dimColor()
                    // 实心进度条（无分数块字符，避免中间出现缺口/空白）。
                    // 条长用「整数百分比」计算，与右侧显示的 padPercent 一致：
                    // API 返回的小数位抖动（如 8.2%↔8.3%）不会让条长来回变化。
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

        {/* 插件更新提示：有新版时显示一行，点击打开 /usage 菜单 */}
        <Show when={updateInfo()}>
          <box marginTop={1} paddingX={1} onMouseDown={() => api.command?.trigger?.("tokenwatch-usage")}>
            <text fg={theme.current.warning}>
              {`⬆ ${t("updateAvailable")} v${updateInfo()!.latest} · /usage`}
            </text>
          </box>
        </Show>

      </Show>
    </box>
  )
}
