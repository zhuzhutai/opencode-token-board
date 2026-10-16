/**
 * stream-timing.ts — 实时记录每个 assistant 消息「首/末 token」到达时刻。
 *
 * 为什么需要实时采集（TTFT 的唯一来源）：
 *   OpenCode core（packages/core/src/session/message-updater.ts）里：
 *     · `time.created`  ← session.step.started 的 `started`（发请求时刻）
 *     · `time.streamed` ← session.step.streamed，**每个 step 只发一次，且在流跑完之后才 publish**
 *                          → 它是「流式输出结束」，不是首 token
 *     · `time.completed` ← session.step.ended（工具执行完的 step 收尾）
 *   因此：
 *     · TPS 用官方口径 `streamed - created`（见 perf-tracker.derivePerf），无需实时数据；
 *     · 但**首 token 时刻**（TTFT = 首 token − created）没有任何持久化字段，
 *       `streamed - created` 是「预填充 + 整段生成」而非 TTFT。
 *
 * 真正的首 token 时刻只能靠订阅 `session.text.*` / `session.reasoning.*` /
 * `session.tool.input.delta` 事件实时记下来：每个事件都带服务端时间戳 `event.created`（毫秒），
 * 按 assistantMessageID 归集即可。
 */

/** 单条 assistant 消息的实测流式时间窗口。 */
export interface StreamTiming {
  /** 首个 token delta 到达时刻（毫秒，服务端 event.created） */
  first: number
  /** 最后一个 token delta 到达时刻（毫秒） */
  last: number
}

/** 最多同时保留的追踪条目数（超出后按最久未更新淘汰，防止长会话泄漏内存）。 */
const MAX_TRACKED = 2000

const timings = new Map<string, StreamTiming>()

/**
 * step 开始（含重试）→ 该消息的生成窗口重新计时。
 * OpenCode 在 step.started 时也会重置消息的 created/streamed/completed，两边保持一致。
 */
export function resetStreamTiming(messageID: string): void {
  if (!messageID) return
  timings.delete(messageID)
}

/** 记录一个 token delta 的到达时刻（首见即建，见到更早/更晚则扩展窗口）。 */
export function noteStreamToken(messageID: string, at: number): void {
  if (!messageID || !Number.isFinite(at) || at <= 0) return
  const cur = timings.get(messageID)
  if (cur) {
    if (at < cur.first) cur.first = at
    if (at > cur.last) cur.last = at
    // 重新插队到队尾，让淘汰顺序 = 最久未更新优先
    timings.delete(messageID)
    timings.set(messageID, cur)
  } else {
    timings.set(messageID, { first: at, last: at })
  }
  while (timings.size > MAX_TRACKED) {
    const oldest = timings.keys().next()
    if (oldest.done) break
    timings.delete(oldest.value)
  }
}

/** 取某条消息的实测流式窗口（无实时数据的历史消息返回 undefined）。 */
export function getStreamTiming(messageID: string): StreamTiming | undefined {
  return timings.get(messageID)
}

/** 仅供测试/诊断：清空全部追踪数据。 */
export function clearStreamTiming(): void {
  timings.clear()
}

/** 仅供测试/诊断：当前追踪条目数。 */
export function streamTimingSize(): number {
  return timings.size
}
