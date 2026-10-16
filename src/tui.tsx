/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { registerCommands } from "./commands.js"
import { PerfRecorder } from "./perf-tracker.js"
import { noteStreamToken, resetStreamTiming } from "./stream-timing.js"
import { extractTokenMessages } from "./mapper.js"
import { createGoUsageFetcher, pickGoToken } from "./go-usage.js"
import type { TokenResolver } from "./go-usage.js"
import { createBoardStorage } from "./storage.js"
import { setLanguage, t } from "./i18n.js"
import { TokenWatchPanel } from "./sidebar.js"
import { registerEnhancements } from "./enhancements.js"

/**
 * ══════════════════════════════════════════════════════════════════
 *  tui.tsx — OpenCode V2 CLI 插件入口
 *
 *  职责：装配数据流（事件 → 消息同步 → 性能记录 → 侧边栏刷新）、注册槽位与命令、
 *  处理会话完成通知。具体渲染在 sidebar.tsx，菜单在 commands.tsx。
 *
 *  ── v1 → v2 关键变化 ───────────────────────────────────────────
 *  · 入口：`{ id, tui(api) }` → `Plugin.define({ id, setup(ctx) })`，清理函数由 setup 返回
 *  · 事件：`api.event.on(type, cb)` + `event.properties` → `ctx.data.on(type, cb)` + `event.data`
 *  · 数据源：v1 逐 `message.updated` 抠 token → v2 以 `ctx.data.session.message.list()`
 *    为**唯一事实源**，事件仅作「触发同步 + 重算」信号（更稳、自愈，会话切换免轮询）
 *  · 性能指标：延迟取自消息 `time.{created,completed}`；TPS 用官方口径（`streamed - created`，
 *    见 perf-tracker.derivePerf）；TTFT 的首 token 时刻靠订阅 text/reasoning/tool-input
 *    delta 事件**实时**记录（`time.streamed` 实为流结束，不含首 token 信息）
 *  · 持久化：`api.kv`（同步、非响应、需轮询版本号）→ `ctx.storage.store`（同步读 + 响应式）
 *  · 通知：自建 Windows 弹窗 → `ctx.attention.notify`（原生系统通知 + 音效）
 *  · 权限弹窗：**整条链路删除**（退回 v2 TUI 原生权限提示），见需求边界
 *  ──────────────────────────────────────────────────────────────────
 */

/** 事件触发的同步/记录去抖间隔（毫秒）。合并同一帧内的密集事件。 */
const SYNC_DEBOUNCE_MS = 60

/**
 * 取 Go 用量 API 的 Bearer token（供 Go 用量 API 使用）。
 *
 * 兼容两类用户（实测两种 token 都能调通官方 usage 端点）：
 *   · API Key 接入：opencode-go / opencode 集成的 value.key（多数用户是这种）
 *   · Console OAuth 接入：opencode 集成的 value.access
 * 选择逻辑见 go-usage 的 pickGoToken（不强制 active，key 类型凭证 active 可能为 null）。
 */
function makeGoTokenResolver(context: Context): TokenResolver {
  return async () => {
    try {
      const creds = await context.client.credential.list()
      const token = pickGoToken(creds)
      if (!token) {
        const ids = (creds ?? []).map((c) => `${c.integrationID}:${c.value?.type ?? "?"}`).join(", ")
        console.warn(`[opencode-token-board] Go usage: 未找到可用凭证（credential.list 返回 ${creds?.length ?? 0} 条${ids ? `: ${ids}` : ""}）`)
      }
      return token
    } catch (e) {
      console.warn(`[opencode-token-board] Go usage: 读取凭证失败 ${(e as Error)?.message ?? e}`)
      return undefined
    }
  }
}

export default Plugin.define({
  id: "opencode-token-board",
  async setup(context) {
    const perfRecorder = new PerfRecorder()
    const goUsageFetcher = createGoUsageFetcher(makeGoTokenResolver(context))
    const storage = createBoardStorage(context)
    const cleanups: (() => void)[] = []

    // 同步语言（侧边栏首帧即用正确语言）
    setLanguage(storage.config.language)

    // 「当前侧边栏显示的会话」（普通变量：事件处理器仅用于判断是否刷新侧边栏，无需响应式）
    let currentSessionID = ""
    // 版本信号：每次同步完成后 +1，驱动侧边栏 memo 重读消息列表
    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)

    // ── 同步 + 记录（去抖）：把指定会话的消息拉到本地缓存，落盘性能样本，必要时刷新侧边栏 ──
    const dirty = new Set<string>()
    let syncTimer: ReturnType<typeof setTimeout> | null = null
    function scheduleRecord(sessionID: string): void {
      if (!sessionID) return
      dirty.add(sessionID)
      if (syncTimer) return
      syncTimer = setTimeout(async () => {
        syncTimer = null
        const ids = [...dirty]
        dirty.clear()
        for (const sid of ids) {
          try { await context.data.session.message.sync(sid) } catch { /* 同步失败忽略 */ }
          try {
            const msgs = context.data.session.message.list(sid) ?? []
            perfRecorder.record(extractTokenMessages(msgs, sid))
          } catch { /* 记录失败忽略 */ }
          if (sid === currentSessionID) bump()
        }
      }, SYNC_DEBOUNCE_MS)
    }

    // ── 事件订阅（payload 在 event.data.*）──
    // 实时记录每个 assistant 消息的首 token 时刻（TTFT 的唯一来源）：
    // 消息自带的 time.streamed 是「流结束」、time.completed 是「工具执行完」，
    // 都没有首 token 时间；TPS 用官方口径（streamed - created）无需实时数据，
    // 但 TTFT 必须靠这里实时采集（见 stream-timing.ts）。
    cleanups.push(context.data.on("session.step.started", (e) => resetStreamTiming(e.data.assistantMessageID)))
    cleanups.push(context.data.on("session.text.started", (e) => noteStreamToken(e.data.assistantMessageID, e.created)))
    cleanups.push(context.data.on("session.text.delta", (e) => noteStreamToken(e.data.assistantMessageID, e.created)))
    cleanups.push(context.data.on("session.reasoning.started", (e) => noteStreamToken(e.data.assistantMessageID, e.created)))
    cleanups.push(context.data.on("session.reasoning.delta", (e) => noteStreamToken(e.data.assistantMessageID, e.created)))
    // 工具参数也是 provider 侧的 output token，纳入生成窗口（分子分母口径一致）
    cleanups.push(context.data.on("session.tool.input.delta", (e) => noteStreamToken(e.data.assistantMessageID, e.created)))
    // 每个 assistant step 完成 → 同步该会话 + 记录（跨会话历史性能也由此捕获）
    cleanups.push(context.data.on("session.step.ended", (e) => scheduleRecord(e.data.sessionID)))
    // 流式增量 / 用量更新 / 执行成功 → 若是当前会话则刷新侧边栏（token 分布等实时更新）
    cleanups.push(context.data.on("session.step.streamed", (e) => { if (e.data.sessionID === currentSessionID) bump() }))
    cleanups.push(context.data.on("session.usage.updated", (e) => { if (e.data.sessionID === currentSessionID) bump() }))
    cleanups.push(context.data.on("session.execution.succeeded", (e) => {
      if (e.data.sessionID === currentSessionID) bump()
      goUsageFetcher.refresh()
    }))
    // 会话空闲 → 刷新 Go 用量 + 原生通知 + 音效
    cleanups.push(context.data.on("session.idle", async (e) => {
      if (e.data.sessionID === currentSessionID) bump()
      goUsageFetcher.refresh(true)
      try {
        await context.attention.notify({
          title: t("notifySessionIdleTitle"),
          message: t("notifySessionIdleBody"),
          notification: true,
          sound: { name: "done" },
        })
      } catch { /* 通知失败忽略 */ }
    }))

    // ── 命令（/usage 菜单）──
    cleanups.push(registerCommands(context, storage))

    // ── 增强（阶段 7）：状态条 / 全屏面板 / 仪表盘路由 ──
    cleanups.push(registerEnhancements(context, storage, version))

    // ── 侧边栏槽位 ──
    cleanups.push(context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        if (sessionID !== currentSessionID) {
          currentSessionID = sessionID
          scheduleRecord(sessionID) // 首次/切换时同步历史消息
        }
        return (
          <TokenWatchPanel
            context={context}
            storage={storage}
            sessionID={sessionID}
            version={version}
            goUsageFetcher={goUsageFetcher}
          />
        )
      },
    }))

    // ── 清理 ──
    return () => {
      for (const c of cleanups) { try { c() } catch { /* 忽略 */ } }
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
    }
  },
})
