/** @jsxImportSource @opentui/solid */
import { Show, createSignal } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { derivePerf } from "./perf-tracker.js"
import { toTokenMessage } from "./mapper.js"

/**
 * footer-tps.tsx — 输入框底部状态栏的实时 TPS（prompt.footer.status 槽）。
 *
 * 位置：OpenCode V2 TUI 输入框底部那一行右侧的状态段，与内置的
 * 「64.4K (6%) · $0.01」同段，append 在内置内容之后（宿主自己的内置插件
 * opencode.btw 也用 `append:"prompt.footer.status"`，模式一致）。
 * 注意原生 `session.tps` 开关（cli.json）只在每条 assistant 消息底部显示
 * 「 · NN.N tok/s」，不在这一行 —— 本插件补的正是这个位置。
 *
 * ── 为什么是「step 结束时刷新」而不是逐 token 刷新 ──
 * OpenCode core（packages/core/src/session/message-updater.ts）实测语义：
 *   · `session.step.streamed` 每个 step 只发一次、流跑完后才 publish，只写 time.streamed；
 *   · `draft.tokens` 仅在 `session.step.ended` / `session.step.failed` 一次性写入，
 *     流式过程中不增量更新。
 * 即：一个 step 的生成过程中没有任何 token 计数，只有带时间戳的 delta 事件。
 * 因此「实时 TPS」的唯一诚实算法 = step 结束时用真实 token 数重算，
 * 多 step 消息每步结束刷新一次；会话 idle 后隐藏（不展示过期数字）。
 * 宁缺毋滥：不用字符数估算 token（会给出侧边栏/报告里对不上的数字）。
 *
 * ── 与官方 footer 的数字关系（重要）──
 * 官方每条 assistant 消息底部的 `· NNN.N tok/s` 是**本轮累计**（官方 ju：
 * Σtoken/Σ窗口，范围 = 本轮全部 step），本插件 footer 显示的是**单个 step**
 * 的 TPS（用户诉求：每一次思考一个 TPS）。两者对同一 step 的分母口径一致
 * （streamed − firstToken，不含预填充），数值差异只来自聚合范围：
 * 最终 step 的 footer 是整轮加权值，本插件是当前这一步的即时值。
 * 侧边栏（sidebar.tsx）另提供与官方完全一致的「本轮 TPS」。
 *
 * 口径：复用 derivePerf（TPS 分母 = streamed − (firstToken ?? created)，
 * 与官方 v2.3.2 一致），保证与侧边栏/报告同源。
 */

export function registerFooterTps(context: Context): () => void {
  const cleanups: (() => void)[] = []

  // 当前 TPS（null = 不显示）。仅 step 结束后更新，idle 后清空。
  const [tps, setTps] = createSignal<number | null>(null)
  // 正在生成的会话：只有被查看的会话才在自己的 footer 里显示（槽位 input 带 sessionID）
  let activeSessionID = ""

  const theme = context.theme
  const accent = () => theme.hue?.accent?.[500] ?? RGBA.fromInts(88, 166, 255, 255)
  const muted = () => theme.text?.muted ?? RGBA.fromInts(139, 148, 158, 255)

  // step 结束 → 同步消息缓存后用官方口径重算该消息 TPS（与侧边栏/报告同一函数）。
  // sync 是异步的：core 把 token 投影进本地缓存同样依赖事件后的同步，
  // 这里显式 sync + get，避免读到上一步的旧 token。
  cleanups.push(context.data.on("session.step.ended", async (e) => {
    const sessionID = e.data.sessionID
    activeSessionID = sessionID
    try {
      await context.data.session.message.sync(sessionID)
      const msg = context.data.session.message.get(sessionID, e.data.assistantMessageID)
      const tm = msg ? toTokenMessage(msg, sessionID) : null
      setTps(tm ? derivePerf(tm).tps : null)
    } catch { /* 读取失败保持原值，下一步结束会再刷新 */ }
  }))

  // step 失败 → 清掉可能是上一步的残留值（会话可能整体结束，也可能重试）
  cleanups.push(context.data.on("session.step.failed", () => setTps(null)))

  // 会话空闲 → 全部隐藏（不展示过期 TPS）
  cleanups.push(context.data.on("session.idle", (e) => {
    if (e.data.sessionID !== activeSessionID) return
    activeSessionID = ""
    setTps(null)
  }))

  // 槽位：追加进 prompt.footer.status（内置状态段之后，flexShrink:0 防止窄终端被压缩）
  cleanups.push(context.ui.slot({
    append: "prompt.footer.status",
    render: ({ sessionID }) => (
      <Show when={tps() != null && !!sessionID && sessionID === activeSessionID}>
        <box flexShrink={0}>
          <text>
            <span style={{ fg: muted() } as any}> · </span>
            <span style={{ fg: muted() } as any}>TPS </span>
            <span style={{ fg: accent() } as any}>{tps()!.toFixed(0)}</span>
          </text>
        </box>
      </Show>
    ),
  }))

  return () => {
    for (const c of cleanups) { try { c() } catch { /* 忽略 */ } }
  }
}
