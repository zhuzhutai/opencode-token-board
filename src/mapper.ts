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
 *   - 时间：`msg.time.{created,streamed,completed,firstToken}` —— created=step 开始、
 *     firstToken=首个 token 到达（v2.3.x 新增，session.step.first-token）、
 *     streamed=流式输出结束、completed=工具执行完；延迟可直接算，
 *     TTFT/TPS 优先用 firstToken（旧版本 core 无此字段时再退回实时采集/内容分片）
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
  time?: { created?: number; firstToken?: number; streamed?: number; completed?: number }
  /** 内容分片：只有 reasoning/tool 分片带 time.created（text 分片没有）。 */
  content?: Array<{ type?: string; time?: { created?: number } }>
}

/**
 * 取首个内容分片的创建时刻作为「首 token」兜底依据。
 * 必须是**第一个**分片：若第一个分片是 text（无 time），其后 reasoning/tool 的时间
 * 已经晚于真正的首 token，用了会高估 TPS，宁可不用。
 */
function firstPartCreatedAt(m: AssistantLike): number | undefined {
  const first = Array.isArray(m.content) ? m.content[0] : undefined
  const t = first?.time?.created
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : undefined
}

/** 取「首 token 时刻」：core 的 time.firstToken（v2.3.x 官方写入）优先，内容分片兜底。 */
function firstTokenAtOf(m: AssistantLike): number | undefined {
  const t = m.time?.firstToken
  if (typeof t === "number" && Number.isFinite(t) && t > 0) return t
  return firstPartCreatedAt(m)
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
    firstTokenAt: firstTokenAtOf(m),
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

// ── 官方 turn（一轮回复）切分 ──
// 对齐 OpenCode v2.3.2 TUI 的 qu()/vl()（从官方二进制反混淆核实）：
//   · 一条 user 指令触发的整轮 agent loop 会产生多条 assistant 消息（一个 step 一条）；
//   · 本轮 = 「本轮边界消息」之后、锚点 assistant 消息（含）之前的全部 assistant 消息；
//   · 边界查找 vl()：从锚点向前扫，非 legacy 会话（列表含 idle 消息）遇到 idle 即停，
//     取扫过的最后一条 user/synthetic；legacy 会话（无 idle）取最近一条 user/synthetic。

/** 官方 turn 切分结果。 */
export interface TurnSlice {
  /** 本轮的 assistant 消息（含锚点），按时间线顺序。 */
  turn: TokenMessage[]
  /** 本轮边界消息（user/synthetic）的 time.created，即官方 Bu 的起点；无边界为 undefined。 */
  startedAt?: number
}

/** message.list 中任意消息的宽松视图（仅 turn 切分所需字段）。 */
interface RawLike {
  type?: string
  id?: string
  time?: { created?: number }
}

/**
 * 按官方口径切出包含锚点消息的「本轮」。
 *
 * 锚点缺省 = 最后一条已 streamed 的 assistant 消息：官方 footer 对正在流式的消息
 * 不显示 TPS（time.streamed 在流跑完后才写入），缺省锚点等价于
 * 「最近一个可见 footer 的口径」，即侧边栏数字与用户看到的官方 footer 一致。
 * 传 anchorID 可显式指定锚点（如按模型取该模型最后一条已完成的 step）。
 *
 * 已知微小偏差：官方对轮内「零 token 的 assistant 消息」（失败 step）也会把其
 * 流式窗口计入分母；这里沿用 toTokenMessage 的零样本过滤（失败 step 不占窗口）。
 * 常规数据下两者一致；官方遇此场景是整体隐藏而非计入。
 */
export function sliceTurn(rawMessages: readonly unknown[], sessionID: string, anchorID?: string): TurnSlice | null {
  const list = rawMessages as readonly (RawLike | null | undefined)[]
  if (!Array.isArray(list) || list.length === 0) return null

  // 锚点下标 g（官方 qu：f.index ?? findIndex(id===l.id)）
  let g = -1
  if (anchorID) {
    g = list.findIndex((m) => m?.type === "assistant" && m.id === anchorID)
  } else {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m?.type === "assistant" && typeof (m as AssistantLike).time?.streamed === "number") { g = i; break }
    }
  }
  if (g === -1) return null

  // 边界查找（官方 vl）：h = g+1，从 h-1 向前扫
  const h = g + 1
  const legacy = !list.some((m) => m?.type === "idle")
  let boundary = -1
  for (let i = h - 1; i >= 0; i--) {
    const type = list[i]?.type
    if (type === "idle") break
    if (type !== "user" && type !== "synthetic") continue
    if (legacy) { boundary = i; break }
    boundary = i
  }

  const turn: TokenMessage[] = []
  for (let i = boundary + 1; i < h; i++) {
    const m = list[i]
    if (m?.type !== "assistant") continue
    const tm = toTokenMessage(m, sessionID)
    if (tm) turn.push(tm)
  }
  const startedAt = boundary >= 0 ? list[boundary]?.time?.created : undefined
  return { turn, startedAt: typeof startedAt === "number" ? startedAt : undefined }
}
