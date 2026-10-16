import type { TokenMessage } from "./types.js"

/**
 * mapper.ts — OpenCode v2 消息 → 内部 TokenMessage 的映射。
 *
 * v2 用 `context.data.session.message.list(sessionID)` 返回 `SessionMessageInfo[]`
 * 作为**唯一事实源**（每条 assistant 消息自带 model / tokens / cost / time），
 * 取代 v1 逐 `message.updated` 事件抠 token 的做法。
 *
 * 结构差异（vs v1）：
 *   - 模型：`msg.model.{id,providerID}`（嵌套）取代平铺 `modelID`/`providerID`
 *   - tokens：无 `total`，只有 input/output/reasoning/cache.{read,write}
 *   - 时间：`msg.time.{created,streamed,completed}` —— created=step 开始、
 *     streamed=流式输出结束、completed=工具执行完；延迟可直接算，
 *     TTFT/TPS 仍需实时首 token 计时（stream-timing.ts）
 *
 * 这里用防御式访问（必要处 as any），避免与体量巨大的生成类型强耦合；
 * 字段名以运行时为准（v1 曾出现 SDK 类型滞后）。
 */

/** assistant 消息的宽松视图（仅取所需字段）。 */
interface AssistantLike {
  id?: string
  type?: string
  model?: { id?: string; providerID?: string }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  time?: { created?: number; streamed?: number; completed?: number }
  /** 内容分片：只有 reasoning/tool 分片带 time.created（text 分片没有）。 */
  content?: Array<{ type?: string; time?: { created?: number } }>
}

/**
 * 取首个内容分片的创建时刻作为「首 token」依据。
 * 必须是**第一个**分片：若第一个分片是 text（无 time），其后 reasoning/tool 的时间
 * 已经晚于真正的首 token，用了会高估 TPS，宁可不用。
 */
function firstPartCreatedAt(m: AssistantLike): number | undefined {
  const first = Array.isArray(m.content) ? m.content[0] : undefined
  const t = first?.time?.created
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : undefined
}

/**
 * 把一条消息映射为 TokenMessage；非 assistant 或无有效 token 则返回 null。
 * 与 v1 一致：过滤 input+output+cache 全零的失败/未完成请求。
 */
export function toTokenMessage(msg: unknown, sessionID: string): TokenMessage | null {
  const m = msg as AssistantLike | null | undefined
  if (!m || m.type !== "assistant") return null
  const tokens = m.tokens
  if (!tokens) return null
  const inputTokens = tokens.input ?? 0
  const outputTokens = tokens.output ?? 0
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  if (inputTokens + outputTokens + cacheRead + cacheWrite === 0) return null

  return {
    id: m.id ?? "",
    sessionID: m.id ? sessionID : sessionID,
    providerID: m.model?.providerID ?? "unknown",
    modelID: m.model?.id ?? "unknown",
    inputTokens,
    outputTokens,
    reasoningTokens: tokens.reasoning ?? 0,
    cacheRead,
    cacheWrite,
    cost: m.cost ?? 0,
    created: m.time?.created,
    streamed: m.time?.streamed,
    completed: m.time?.completed,
    firstTokenAt: firstPartCreatedAt(m),
  }
}

/** 批量映射，过滤 null。 */
export function extractTokenMessages(messages: readonly unknown[], sessionID: string): TokenMessage[] {
  const out: TokenMessage[] = []
  for (const msg of messages) {
    const tm = toTokenMessage(msg, sessionID)
    if (tm) out.push(tm)
  }
  return out
}
