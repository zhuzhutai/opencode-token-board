/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import type { BoardStorage } from "./storage.js"
import { getUsageReport, getPresetRange } from "./queries.js"
import type { UsageFilters, CombinedReportData, HtmlReportMeta } from "./formatter.js"
import { formatUsageReport } from "./formatter.js"
import { generateUsageHtml } from "./generate-usage-html.js"
import { readLogs } from "./perf-tracker.js"
import { readPersistedStats } from "./stats-store.js"
import { setLanguage, t } from "./i18n.js"
import { openStatsPanel, openDashboard } from "./enhancements.js"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execSync } from "node:child_process"

/**
 * commands.ts — /usage 命令与多级菜单（v2：keymap.layer + Promise dialog）。
 *
 * v1 → v2 交互模型变化：
 *   - `api.command.register(() => [{ onSelect(dialog) }])` + `DialogSelect` 组件栈（dialog.replace 嵌套）
 *     → `ctx.keymap.layer(...)` 命令 + `ctx.ui.dialog.select/prompt`（**Promise 链式**，await 逐级下钻）
 *   - 菜单循环直到用户 Escape（select 返回 undefined）——比 v1 的 replace 栈更线性、易读
 *   - 配置读写：`api.kv` → `storage.updateConfig(draft => ...)`（响应式，侧边栏自动刷新）
 */

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 注册 /usage 命令。keymap layer 随插件卸载自动清理，无需手动 dispose。 */
export function registerCommands(context: Context, storage: BoardStorage): () => void {
  setLanguage(storage.config.language)
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "tokenwatch-usage",
        title: "TokenWatch",
        description: "Token usage reports, export, and settings",
        group: "Stats",
        palette: true,
        slash: { name: "usage" },
        run: () => { void showUsageMenu(context, storage) },
      },
    ],
  }))
  return () => { /* keymap layer 随插件卸载自动移除 */ }
}

function ensureReportDir(): string {
  const dir = join(homedir(), ".opencode", "reports")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function openInBrowser(filePath: string): void {
  try {
    const platform = process.platform
    if (platform === "win32") execSync(`start "" "${filePath}"`, { windowsHide: true, timeout: 5000 })
    else if (platform === "darwin") execSync(`open "${filePath}"`, { timeout: 5000 })
    else execSync(`xdg-open "${filePath}"`, { timeout: 5000 })
  } catch { /* 静默失败 */ }
}

function getRangeSlug(filters: UsageFilters, presetTag?: string): string {
  if (presetTag) return presetTag
  if (!filters.startDate && !filters.endDate) return "all"
  if (filters.startDate && filters.endDate) {
    if (filters.startDate === filters.endDate) {
      const today = new Date().toISOString().slice(0, 10)
      if (filters.startDate === today) return "today"
      return filters.startDate
    }
    return `${filters.startDate.replace(/-/g, "")}_${filters.endDate.replace(/-/g, "")}`
  }
  if (filters.startDate) return `from_${filters.startDate.replace(/-/g, "")}`
  if (filters.endDate) return `until_${filters.endDate.replace(/-/g, "")}`
  return "custom"
}

function generateUniqueReportPath(dir: string, rangeSlug: string): string {
  const dateStr = new Date().toISOString().slice(0, 10)
  const baseName = `tokenwatch-${rangeSlug}-${dateStr}`
  let targetPath = join(dir, `${baseName}.html`)
  if (!existsSync(targetPath)) return targetPath
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const timeSuffix = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  targetPath = join(dir, `${baseName}_${timeSuffix}.html`)
  let counter = 1
  while (existsSync(targetPath)) {
    targetPath = join(dir, `${baseName}_${timeSuffix}_${counter}.html`)
    counter++
  }
  return targetPath
}

async function buildCombinedData(filters: UsageFilters): Promise<CombinedReportData> {
  const report = await getUsageReport(filters)
  const logs = readLogs(200)
  const perfSummary = readPersistedStats()
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const meta: HtmlReportMeta = {
    generatedAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    dateRange: {
      start: report.daily.length > 0 ? report.daily[report.daily.length - 1].day : "—",
      end: report.daily.length > 0 ? report.daily[0].day : "—",
    },
  }
  return { ...report, perfLogs: logs, perfSummary, meta }
}

async function showHtmlReport(context: Context, filters: UsageFilters, presetTag?: string): Promise<void> {
  try {
    const data = await buildCombinedData(filters)
    const html = generateUsageHtml(data)
    const dir = ensureReportDir()
    const filePath = generateUniqueReportPath(dir, getRangeSlug(filters, presetTag))
    writeFileSync(filePath, html, "utf-8")
    context.ui.toast.show({ message: `Report: ${filePath}`, variant: "info" })
    openInBrowser(filePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    context.ui.toast.show({ message: `Error: ${msg}`, variant: "error" })
  }
}

async function showHtmlRangeMenu(context: Context): Promise<void> {
  const choice = await context.ui.dialog.select<string>({
    title: t("cmdTitleHtml"),
    placeholder: "Select date range...",
    options: [
      { title: t("menuToday"), value: "today" },
      { title: t("menu7d"), value: "7d" },
      { title: t("menu30d"), value: "30d" },
      { title: t("menuAll"), value: "all" },
    ],
  })
  if (!choice) return
  if (choice === "today") {
    const s = formatDate(new Date())
    await showHtmlReport(context, { startDate: s, endDate: s }, "today")
  } else if (choice === "7d") await showHtmlReport(context, getPresetRange("7d"), "7d")
  else if (choice === "30d") await showHtmlReport(context, getPresetRange("30d"), "30d")
  else await showHtmlReport(context, getPresetRange("all"), "all")
}

async function showJsonExport(context: Context): Promise<void> {
  try {
    const report = await getUsageReport({})
    const dir = ensureReportDir()
    const filePath = join(dir, `tokenwatch-${new Date().toISOString().slice(0, 10)}.json`)
    writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8")
    context.ui.toast.show({ message: `JSON: ${filePath}`, variant: "info" })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    context.ui.toast.show({ message: `Error: ${msg}`, variant: "error" })
  }
}

async function showTextReport(context: Context): Promise<void> {
  try {
    const report = await getUsageReport({})
    const formatted = formatUsageReport(report)
    const dir = ensureReportDir()
    const filePath = join(dir, `tokenwatch-${new Date().toISOString().slice(0, 10)}.md`)
    writeFileSync(filePath, formatted, "utf-8")
    context.ui.toast.show({ message: `Report saved to ${filePath}`, variant: "info" })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    context.ui.toast.show({ message: `Error: ${msg}`, variant: "error" })
  }
}

async function showLanguageMenu(context: Context, storage: BoardStorage): Promise<void> {
  for (;;) {
    const current = storage.config.language
    const choice = await context.ui.dialog.select<"auto" | "zh" | "en">({
      title: t("settingsLanguage"),
      options: [
        { title: `${current === "auto" ? "✓ " : "  "}${t("langAuto")}`, value: "auto", description: "自动检测 / Auto-detect" },
        { title: `${current === "zh" ? "✓ " : "  "}中文`, value: "zh", description: "简体中文" },
        { title: `${current === "en" ? "✓ " : "  "}English`, value: "en", description: "English" },
      ],
    })
    if (choice === "auto" || choice === "zh" || choice === "en") {
      await storage.updateConfig((d) => { d.language = choice })
      setLanguage(choice)
    } else return
  }
}

async function showSettingsMenu(context: Context, storage: BoardStorage): Promise<void> {
  for (;;) {
    const cfg = storage.config
    const choice = await context.ui.dialog.select<
      "showPerformance" | "showTokenDistribution" | "showGoUsage" | "language" | "done"
    >({
      title: t("settingsTitle"),
      placeholder: t("settingsPlaceholder"),
      options: [
        { title: `${cfg.sidebar.showPerformance ? "✓ " : "  "}${t("showPerformance")}`, value: "showPerformance", description: t("descShowPerformance") },
        { title: `${cfg.sidebar.showTokenDistribution ? "✓ " : "  "}${t("showTokenDistribution")}`, value: "showTokenDistribution", description: t("descShowTokenDistribution") },
        { title: `${cfg.sidebar.showGoUsage ? "✓ " : "  "}${t("showGoUsage")}`, value: "showGoUsage", description: t("descShowGoUsage") },
        { title: `${t("settingsLanguage")} ▸`, value: "language", description: t("descSettingsLanguage") },
        { title: t("done"), value: "done", description: t("closeSettings") },
      ],
    })
    if (choice === "showPerformance") await storage.updateConfig((d) => { d.sidebar.showPerformance = !d.sidebar.showPerformance })
    else if (choice === "showTokenDistribution") await storage.updateConfig((d) => { d.sidebar.showTokenDistribution = !d.sidebar.showTokenDistribution })
    else if (choice === "showGoUsage") await storage.updateConfig((d) => { d.sidebar.showGoUsage = !d.sidebar.showGoUsage })
    else if (choice === "language") await showLanguageMenu(context, storage)
    else return
  }
}

async function showUsageMenu(context: Context, storage: BoardStorage): Promise<void> {
  setLanguage(storage.config.language)
  for (;;) {
    const choice = await context.ui.dialog.select<"html" | "json" | "text" | "panel" | "dashboard" | "settings">({
      title: t("panelTitle"),
      placeholder: "Select an action...",
      options: [
        { title: `${t("cmdTitleHtml")} ▸`, value: "html", description: t("cmdDescHtml") },
        { title: t("cmdTitleJson"), value: "json", description: t("cmdDescJson") },
        { title: t("cmdTitleText"), value: "text", description: t("cmdDescText") },
        { title: `${t("cmdTitlePanel")} ▸`, value: "panel", description: t("cmdDescPanel") },
        { title: `${t("cmdTitleDashboard")} ▸`, value: "dashboard", description: t("cmdDescDashboard") },
        { title: `${t("cmdTitleSettings")} ▸`, value: "settings", description: t("cmdDescSettings") },
      ],
    })
    if (choice === "html") await showHtmlRangeMenu(context)
    else if (choice === "json") await showJsonExport(context)
    else if (choice === "text") await showTextReport(context)
    else if (choice === "panel") { context.ui.dialog.clear(); openStatsPanel(context); return }
    else if (choice === "dashboard") { context.ui.dialog.clear(); openDashboard(context); return }
    else if (choice === "settings") await showSettingsMenu(context, storage)
    else return
  }
}
