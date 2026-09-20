/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { homedir } from "node:os"
import { join } from "node:path"
import { readdirSync, unlinkSync, watch, mkdirSync } from "node:fs"
import type { FSWatcher } from "node:fs"
import { registerCommands } from "./commands.js"
import { createPerfTracker } from "./perf-tracker.js"
import { createGoUsageFetcher } from "./go-usage.js"
import type { GoUsageFetcher } from "./go-usage.js"
import { createUpdateChecker } from "./update-check.js"
import type { UpdateChecker } from "./update-check.js"
import { notify, notifyPermission } from "./notify.js"
import { TokenWatchPanel } from "./sidebar.js"
import { t } from "./i18n.js"

export interface TokenMessage {
  id: string
  sessionID: string
  providerID: string
  modelID: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

function kvKey(sessionID: string): string {
  return "tokenwatch-msgs-" + sessionID
}

const approvalDirectory = join(homedir(), ".opencode", "tokenwatch-approvals")

const tui: TuiPluginModule["tui"] = async (api, _options, meta) => {
  const perfTracker = createPerfTracker()
  const goUsageFetcher: GoUsageFetcher = createGoUsageFetcher()
  const updateChecker: UpdateChecker = createUpdateChecker(api, meta)
  const [sidebarRevision, setSidebarRevision] = createSignal(0)
  const [allTokenMessages, setAllTokenMessages] = createSignal<TokenMessage[]>([])
  let currentSlotSessionID = ""
  let sessionLoadPending = false
  let sessionRetryTimer: ReturnType<typeof setTimeout> | null = null
  const cleanups: (() => void)[] = []

  registerCommands(api, updateChecker)

  // 版本检查：发现新版本时弹一次 Toast（同一版本只提示一次）
  const notifiedVersions = new Set<string>()
  updateChecker.subscribe(() => {
    const info = updateChecker.info()
    if (info && !notifiedVersions.has(info.latest)) {
      notifiedVersions.add(info.latest)
      api.ui.toast?.({
        variant: "info",
        title: t("updateToastTitle"),
        message: t("updateToastBody").replace("{latest}", info.latest).replace("{current}", info.current),
        duration: 10000,
      })
    }
  })
  // 延迟到界面就绪后检查，避免阻塞启动
  setTimeout(() => { try { updateChecker.check() } catch { /* ignore */ } }, 1500)

  function loadGoConfig(): void {
    // 新版仅需 Go API Key：显式配置为空时由 fetcher 自动从 OpenCode 凭据中解析
    try {
      const cfg = api.kv?.get?.("tokenwatch-config") as { go?: { apiKey?: string } } | undefined
      goUsageFetcher.setConfig(cfg?.go?.apiKey ?? "")
    } catch {
      goUsageFetcher.setConfig("")
    }
  }
  loadGoConfig()

  function persistToKv(sessionID: string, msgs: TokenMessage[]): void {
    try {
      api.kv?.set?.(kvKey(sessionID), msgs)
    } catch { /* non-critical */ }
  }

  const unsubMsgUpdated = api.event.on("message.updated", (event: any) => {
    const info = event.properties?.info

    perfTracker.handleMessageUpdated(event)

    // 一轮会话结束（assistant 消息完成且有有效 token）→ 刷新 Go 用量
    if (info?.role === "assistant" && (info?.tokens?.total ?? 0) > 0 && info?.time?.completed) {
      goUsageFetcher.refresh()
    }

    if (info?.role === "assistant" && info?.tokens?.total > 0) {
      setAllTokenMessages(prev => {
        const msg: TokenMessage = {
          id: info.id,
          sessionID: info.sessionID ?? "",
          providerID: info.providerID ?? "unknown",
          modelID: info.modelID ?? "unknown",
          inputTokens: info.tokens?.input ?? 0,
          outputTokens: info.tokens?.output ?? 0,
          reasoningTokens: info.tokens?.reasoning ?? 0,
          cacheRead: info.tokens?.cache?.read ?? 0,
          cacheWrite: info.tokens?.cache?.write ?? 0,
          cost: info.cost ?? 0,
        }
        const idx = prev.findIndex(m => m.id === msg.id)
        let next: TokenMessage[]
        if (idx >= 0) {
          next = [...prev]
          next[idx] = msg
        } else {
          next = [...prev, msg]
        }
        // Bug fix: 优先使用事件自带的 sessionID，而非 currentSlotSessionID
        // currentSlotSessionID 在 slot 首次渲染时才更新，session 切换瞬间可能落后
        const targetSessionID = info.sessionID ?? currentSlotSessionID
        persistToKv(targetSessionID, next)
        return next
      })
    }


    setSidebarRevision((v) => v + 1)

    // 会话历史可能刚异步载入完成 → 若仍在等待首次载入，被动补一次
    if (sessionLoadPending && populateFromState(currentSlotSessionID)) {
      sessionLoadPending = false
      clearSessionRetry()
    }
  })
  cleanups.push(unsubMsgUpdated)

  const unsubPartUpdated = api.event.on("message.part.updated", (event: any) => {
    perfTracker.handlePartUpdated({
      message_id: event.properties?.part?.messageID,
      type: event.properties?.part?.type,
      text: event.properties?.part?.type === "text" ? event.properties?.part?.text : undefined,
      time: { start: event.properties?.part?.time?.start },
    })
  })
  cleanups.push(unsubPartUpdated)

  const unsubRemoved = api.event.on("message.removed", () => {
    setSidebarRevision((v) => v + 1)
  })
  cleanups.push(unsubRemoved)

  // 会话整段空闲 → 刷新 Go 用量 + 桌面提示
  const unsubSessionIdle = api.event.on("session.idle", () => {
    goUsageFetcher.refresh(true)
    if (populateFromState(currentSlotSessionID)) {
      sessionLoadPending = false
      clearSessionRetry()
    }
    notify(t("notifySessionIdleTitle"), t("notifySessionIdleBody"))
  })
  cleanups.push(unsubSessionIdle)

  // 已弹提示的待审批权限请求；标记文件命中后调用 permission.reply 放行
  const pendingRequests = new Map<string, { sessionID: string; permission: string; pattern: string }>()
  const repliedIds = new Set<string>()

  // ── 批准标记目录：事件驱动监听（取代旧的 300ms 轮询）──
  // 弹窗进程（PowerShell / osascript）写 <requestID>.<once|always|reject>，
  // 这里用 fs.watch 被动接收目录变更；仅在有待审批请求时开启，处理完即关闭。
  let approvalWatcher: FSWatcher | null = null

  function processApprovals(): void {
    if (pendingRequests.size === 0) return
    let entries: string[] = []
    try {
      entries = readdirSync(approvalDirectory)
    } catch { return }
    for (const entry of entries) {
      const dotIdx = entry.lastIndexOf(".")
      if (dotIdx <= 0) continue
      const requestID = entry.slice(0, dotIdx)
      const reply = entry.slice(dotIdx + 1)
      if (reply !== "once" && reply !== "always" && reply !== "reject") continue
      const pending = pendingRequests.get(requestID)
      if (!pending || repliedIds.has(requestID)) continue

      repliedIds.add(requestID)
      pendingRequests.delete(requestID)
      try { unlinkSync(join(approvalDirectory, entry)) } catch { }

      api.client.permission
        .reply({ requestID, reply })
        .then((res: any) => {
          const failed = res?.error != null
          if (failed) {
            api.ui.toast?.({ message: t("permReplyFailed"), variant: "error" })
          } else {
            api.ui.toast?.({
              message: reply === "reject" ? t("permRejected") : t("permAllowed"),
              variant: reply === "reject" ? "warning" : "success",
            })
          }
        })
        .catch(() => {
          api.ui.toast?.({ message: t("permReplyFailed"), variant: "error" })
        })
    }
    syncApprovalWatcher()
  }

  function stopApprovalWatcher(): void {
    if (!approvalWatcher) return
    try { approvalWatcher.close() } catch { /* ignore */ }
    approvalWatcher = null
  }

  function syncApprovalWatcher(): void {
    if (pendingRequests.size === 0) {
      stopApprovalWatcher()
      return
    }
    if (approvalWatcher) return
    try {
      mkdirSync(approvalDirectory, { recursive: true })
      approvalWatcher = watch(approvalDirectory, { persistent: false }, () => processApprovals())
      approvalWatcher.on("error", () => stopApprovalWatcher())
    } catch {
      stopApprovalWatcher()
    }
  }
  cleanups.push(stopApprovalWatcher)

  // 申请权限 → 右下角三按钮提示（允许一次 / 总是允许 / 拒绝）
  const unsubPermissionAsked = api.event.on("permission.asked", (event: any) => {
    const props = event.properties as { id?: string; sessionID?: string; permission?: string; patterns?: string[] } | undefined
    if (!props?.id) return
    const permission = props.permission ?? ""
    const pattern = (props.patterns ?? []).join(" ")
    pendingRequests.set(props.id, { sessionID: props.sessionID ?? "", permission, pattern })
    syncApprovalWatcher()
    processApprovals()   // 兜底：标记可能已先于 watcher 建立写入
    notifyPermission({
      requestID: props.id,
      title: t("notifyPermissionTitle"),
      message: pattern ? `${permission}: ${pattern}` : permission,
      allowOnceLabel: t("permAllowOnce"),
      alwaysLabel: t("permAlways"),
      rejectLabel: t("permReject"),
      pid: process.pid,
    })
  })
  cleanups.push(unsubPermissionAsked)

  // 权限在终端内已被回复 → 从待审批表移除
  const unsubPermissionReplied = api.event.on("permission.replied", (event: any) => {
    const props = event.properties as { requestID?: string } | undefined
    if (props?.requestID) {
      pendingRequests.delete(props.requestID)
      syncApprovalWatcher()
    }
  })
  cleanups.push(unsubPermissionReplied)

  // ── 会话历史消息加载：事件驱动 + 有界退避重试（取代旧的 200ms×50 轮询）──
  // opencode 的历史会话消息可能是异步载入的，且 api.state.session.messages 并非
  // Solid 响应式源。旧实现固定每 200ms 轮询 10 秒；现在改为：
  //   ① 打开会话时立即读一次；
  //   ② 若为空，按 250/500/1000/2000/3000ms 退避重试（合计 ~7s，覆盖冷载入）；
  //   ③ message.updated / session.idle 到达时被动再读一次并提前结束重试。
  function clearSessionRetry(): void {
    if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null }
  }

  function tokenMessagesFromState(sessionID: string): TokenMessage[] {
    const existing = api.state.session.messages(sessionID)
    if (!existing || existing.length === 0) return []
    const out: TokenMessage[] = []
    for (const msg of existing) {
      if ((msg as any).role !== "assistant") continue
      const tokens = (msg as any).tokens
      // 与 message.updated 处理器保持一致：过滤 total=0 的失败请求
      if (!tokens || (tokens.total ?? 0) === 0) continue
      out.push({
        id: (msg as any).id,
        sessionID,
        providerID: (msg as any).providerID ?? "unknown",
        modelID: (msg as any).modelID ?? "unknown",
        inputTokens: tokens?.input ?? 0,
        outputTokens: tokens?.output ?? 0,
        reasoningTokens: tokens?.reasoning ?? 0,
        cacheRead: tokens?.cache?.read ?? 0,
        cacheWrite: tokens?.cache?.write ?? 0,
        cost: (msg as any).cost ?? 0,
      })
    }
    return out
  }

  /** 将宿主已载入的消息合并进面板数据；返回是否已有数据。 */
  function populateFromState(sessionID: string): boolean {
    if (!sessionID) return true
    const incoming = tokenMessagesFromState(sessionID)
    if (incoming.length === 0) return false
    setAllTokenMessages((prev) => {
      let changed = false
      const next = [...prev]
      for (const tokenMsg of incoming) {
        const idx = next.findIndex(m => m.id === tokenMsg.id)
        if (idx >= 0) {
          const cur = next[idx]
          if (
            cur.inputTokens !== tokenMsg.inputTokens ||
            cur.outputTokens !== tokenMsg.outputTokens ||
            cur.reasoningTokens !== tokenMsg.reasoningTokens ||
            cur.cacheRead !== tokenMsg.cacheRead ||
            cur.cacheWrite !== tokenMsg.cacheWrite ||
            cur.cost !== tokenMsg.cost
          ) {
            next[idx] = tokenMsg
            changed = true
          }
        } else {
          next.push(tokenMsg)
          changed = true
        }
      }
      if (changed) {
        persistToKv(sessionID, next)
        return next
      }
      return prev
    })
    return true
  }

  function scheduleSessionRetries(sessionID: string): void {
    clearSessionRetry()
    sessionLoadPending = true
    const delays = [250, 500, 1000, 2000, 3000]
    let attempt = 0
    const tick = () => {
      if (currentSlotSessionID !== sessionID) return
      if (populateFromState(sessionID)) {
        sessionLoadPending = false
        return
      }
      if (attempt >= delays.length) { sessionLoadPending = false; return }
      const delay = delays[attempt++]
      sessionRetryTimer = setTimeout(tick, delay)
      ;(sessionRetryTimer as any).unref?.()
    }
    sessionRetryTimer = setTimeout(tick, delays[attempt++])
    ;(sessionRetryTimer as any).unref?.()
  }
  cleanups.push(clearSessionRetry)

  api.lifecycle?.onDispose?.(() => {
    for (const cleanup of cleanups) cleanup()
  })

  api.slots.register({
    order: 50,
    slots: {
      sidebar_content: (_ctx, { session_id }) => {
        sidebarRevision()

        if (session_id && session_id !== currentSlotSessionID) {
          currentSlotSessionID = session_id
          // 异步加载本会话历史性能统计，完成后触发一次重绘（避免同步读全量 JSONL 卡住 UI）
          void perfTracker.loadSessionAsync(session_id, () => setSidebarRevision(v => v + 1))

          let loaded: TokenMessage[] = []
          try {
            const saved = api.kv?.get?.(kvKey(session_id)) as TokenMessage[] | undefined
            if (saved && saved.length > 0) loaded = saved
          } catch {}
          setAllTokenMessages(loaded)

          // 立即合并宿主已载入的消息；为空则进入有界退避重试（事件到达会提前结束）
          if (populateFromState(session_id)) {
            sessionLoadPending = false
            clearSessionRetry()
          } else {
            scheduleSessionRetries(session_id)
          }
        }

        return <TokenWatchPanel api={api} theme={api.theme} perfTracker={perfTracker} messages={() => api.state.session.messages(session_id)} allTokenMessages={allTokenMessages} goUsageFetcher={goUsageFetcher} updateChecker={updateChecker} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-token-board",
  tui,
}

export default plugin
