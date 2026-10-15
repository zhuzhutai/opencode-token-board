import type {
  DailyBreakdownItem,
  ErrorStats,
  ModelBreakdownItem,
  ProviderBreakdownItem,
  SessionBreakdownItem,
  SessionTokenData,
  UsageFilters,
  UsageReport,
} from "./formatter.js"
import { ensureDb, queryAll } from "./db.js"

/**
 * queries.ts — 报告数据查询（SQLite 直连）。
 *
 * v1 通过 `opencode db <sql>` CLI 执行；v2 已**删除该命令**，改为进程内直连（见 db.ts）。
 * v2 schema 变化已全部反映：
 *   - 表：`message` → `session_message`（type 列即角色），`session` → `session_v2`
 *   - 模型：`$.modelID`/`$.providerID`（平铺）→ `$.model.id`/`$.model.providerID`（嵌套）
 *   - token 总量：v2 无 `$.tokens.total`，用 input+output+reasoning+cache.read+cache.write 计算
 *   - 数据源只查 v2 表：实测 `session_message` 已包含 v1 全部迁移数据（0 缺失），无需 UNION 旧表
 *
 * 所有函数 async（开头 `await ensureDb()`），但查询本身同步（DatabaseSync）。
 */

const TBL = "session_message" // v2 消息表（含迁移的 v1 历史）

function modelExpr(alias: string): string {
  return `coalesce(json_extract(${alias}.data,'$.model.id'),'unknown')`
}
function providerExpr(alias: string): string {
  return `coalesce(json_extract(${alias}.data,'$.model.providerID'),'unknown')`
}
/** 计算 token 总量（v2 无 total 字段）。 */
function totalExpr(alias: string): string {
  const d = `${alias}.data`
  return `(coalesce(json_extract(${d},'$.tokens.input'),0)+coalesce(json_extract(${d},'$.tokens.output'),0)+coalesce(json_extract(${d},'$.tokens.reasoning'),0)+coalesce(json_extract(${d},'$.tokens.cache.read'),0)+coalesce(json_extract(${d},'$.tokens.cache.write'),0))`
}
function tok(alias: string, field: string): string {
  return `coalesce(json_extract(${alias}.data,'$.tokens.${field}'),0)`
}
function costExpr(alias: string): string {
  return `coalesce(json_extract(${alias}.data,'$.cost'),0)`
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

/** 校验日期格式必须为 YYYY-MM-DD */
function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function messageWhere(filters: UsageFilters): string {
  const where = [
    `${TBL}.type = 'assistant'`,
    `${totalExpr(TBL)} > 0`,
  ]
  if (filters.sessionId) where.push(`${TBL}.session_id = '${escapeSql(filters.sessionId)}'`)
  if (filters.provider) where.push(`${providerExpr(TBL)} = '${escapeSql(filters.provider)}'`)
  if (filters.model) where.push(`${modelExpr(TBL)} = '${escapeSql(filters.model)}'`)
  if (filters.startDate && isValidDate(filters.startDate)) {
    where.push(`date(${TBL}.time_created / 1000, 'unixepoch', 'localtime') >= '${filters.startDate}'`)
  }
  if (filters.endDate && isValidDate(filters.endDate)) {
    where.push(`date(${TBL}.time_created / 1000, 'unixepoch', 'localtime') <= '${filters.endDate}'`)
  }
  return where.join(" AND ")
}

function parseList(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(",").map((item) => item.trim()).filter(Boolean)
}

function toSessionTokenData(row?: Record<string, unknown>): SessionTokenData {
  const r = row ?? {}
  const models = parseList(r.models_used as string)
  const providers = parseList(r.providers_used as string)
  return {
    model: models.length === 1 ? models[0] : "",
    provider: providers.length === 1 ? providers[0] : "",
    modelsUsed: models,
    totalTokens: (r.total_tokens as number) ?? 0,
    inputTokens: (r.input_tokens as number) ?? 0,
    outputTokens: (r.output_tokens as number) ?? 0,
    reasoningTokens: (r.reasoning_tokens as number) ?? 0,
    cacheRead: (r.cache_read as number) ?? 0,
    cacheWrite: (r.cache_write as number) ?? 0,
    totalCost: (r.total_cost as number) ?? 0,
    requestCount: (r.request_count as number) ?? 0,
  }
}

export function getPresetRange(preset: "all" | "7d" | "30d" | "month"): Pick<UsageFilters, "startDate" | "endDate"> {
  if (preset === "all") return {}
  const end = new Date()
  const start = new Date(end)
  if (preset === "7d") start.setDate(end.getDate() - 6)
  if (preset === "30d") start.setDate(end.getDate() - 29)
  if (preset === "month") start.setDate(1)
  const format = (date: Date) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
  }
  return { startDate: format(start), endDate: format(end) }
}

export async function getSummary(filters: UsageFilters = {}): Promise<SessionTokenData> {
  await ensureDb()
  const sql = `
SELECT
  group_concat(distinct ${modelExpr(TBL)}) as models_used,
  group_concat(distinct ${providerExpr(TBL)}) as providers_used,
  count(*) as request_count,
  sum(${totalExpr(TBL)}) as total_tokens,
  sum(${tok(TBL, "input")}) as input_tokens,
  sum(${tok(TBL, "output")}) as output_tokens,
  sum(${tok(TBL, "reasoning")}) as reasoning_tokens,
  sum(${tok(TBL, "cache.read")}) as cache_read,
  sum(${tok(TBL, "cache.write")}) as cache_write,
  sum(${costExpr(TBL)}) as total_cost
FROM ${TBL}
WHERE ${messageWhere(filters)}
  `.trim()
  return toSessionTokenData(queryAll(sql)[0])
}

export async function getModelBreakdown(filters: UsageFilters = {}): Promise<ModelBreakdownItem[]> {
  await ensureDb()
  const sql = `
SELECT
  ${providerExpr(TBL)} as provider,
  ${modelExpr(TBL)} as model,
  count(*) as requests,
  count(distinct ${TBL}.session_id) as sessions,
  sum(${totalExpr(TBL)}) as total_tokens,
  sum(${tok(TBL, "input")}) as input_tokens,
  sum(${tok(TBL, "output")}) as output_tokens,
  sum(${tok(TBL, "reasoning")}) as reasoning_tokens,
  sum(${tok(TBL, "cache.read")}) as cache_read,
  sum(${costExpr(TBL)}) as total_cost
FROM ${TBL}
WHERE ${messageWhere(filters)}
GROUP BY provider, model
ORDER BY total_tokens DESC
  `.trim()
  return queryAll(sql).map((row: any) => ({
    provider: row.provider ?? "unknown",
    model: row.model ?? "unknown",
    requests: row.requests ?? 0,
    sessions: row.sessions ?? 0,
    totalTokens: row.total_tokens ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    cacheRead: row.cache_read ?? 0,
    totalCost: row.total_cost ?? 0,
  }))
}

export async function getProviderBreakdown(filters: UsageFilters = {}): Promise<ProviderBreakdownItem[]> {
  await ensureDb()
  const sql = `
SELECT
  ${providerExpr(TBL)} as provider,
  count(*) as requests,
  count(distinct ${TBL}.session_id) as sessions,
  sum(${totalExpr(TBL)}) as total_tokens,
  sum(${tok(TBL, "input")}) as input_tokens,
  sum(${tok(TBL, "output")}) as output_tokens,
  sum(${tok(TBL, "reasoning")}) as reasoning_tokens,
  sum(${tok(TBL, "cache.read")}) as cache_read,
  sum(${costExpr(TBL)}) as total_cost
FROM ${TBL}
WHERE ${messageWhere(filters)}
GROUP BY provider
ORDER BY total_tokens DESC
  `.trim()
  return queryAll(sql).map((row: any) => ({
    provider: row.provider ?? "unknown",
    requests: row.requests ?? 0,
    sessions: row.sessions ?? 0,
    totalTokens: row.total_tokens ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    cacheRead: row.cache_read ?? 0,
    totalCost: row.total_cost ?? 0,
  }))
}

export async function getDailyBreakdown(filters: UsageFilters = {}): Promise<DailyBreakdownItem[]> {
  await ensureDb()
  const limit = filters.limit ?? 30
  const sql = `
SELECT
  date(${TBL}.time_created / 1000, 'unixepoch', 'localtime') as day,
  count(*) as requests,
  count(distinct ${TBL}.session_id) as sessions,
  sum(${totalExpr(TBL)}) as total_tokens,
  sum(${tok(TBL, "input")}) as input_tokens,
  sum(${tok(TBL, "output")}) as output_tokens,
  sum(${tok(TBL, "reasoning")}) as reasoning_tokens,
  sum(${tok(TBL, "cache.read")}) as cache_read,
  sum(${costExpr(TBL)}) as total_cost
FROM ${TBL}
WHERE ${messageWhere(filters)}
GROUP BY day
ORDER BY day DESC
LIMIT ${Math.max(1, limit)}
  `.trim()
  return queryAll(sql).map((row: any) => ({
    day: row.day ?? "",
    requests: row.requests ?? 0,
    sessions: row.sessions ?? 0,
    totalTokens: row.total_tokens ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    cacheRead: row.cache_read ?? 0,
    totalCost: row.total_cost ?? 0,
  }))
}

export async function getSessionBreakdown(filters: UsageFilters = {}): Promise<SessionBreakdownItem[]> {
  await ensureDb()
  const limit = filters.limit ?? 15
  const sql = `
SELECT
  ${TBL}.session_id as session_id,
  s.title as title,
  ${providerExpr(TBL)} as provider,
  ${modelExpr(TBL)} as model,
  count(*) as requests,
  sum(${totalExpr(TBL)}) as total_tokens,
  sum(${tok(TBL, "input")}) as input_tokens,
  sum(${tok(TBL, "output")}) as output_tokens,
  sum(${tok(TBL, "reasoning")}) as reasoning_tokens,
  sum(${tok(TBL, "cache.read")}) as cache_read,
  sum(${costExpr(TBL)}) as total_cost,
  date(max(${TBL}.time_created) / 1000, 'unixepoch', 'localtime') as day
FROM ${TBL}
JOIN session_v2 s ON s.id = ${TBL}.session_id
WHERE ${messageWhere(filters)}
GROUP BY ${TBL}.session_id, s.title, provider, model
ORDER BY max(${TBL}.time_created) DESC
LIMIT ${Math.max(1, limit)}
  `.trim()
  return queryAll(sql).map((row: any) => ({
    sessionId: row.session_id ?? "",
    title: row.title ?? "(untitled)",
    provider: row.provider ?? "unknown",
    model: row.model ?? "unknown",
    requests: row.requests ?? 0,
    totalTokens: row.total_tokens ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    cacheRead: row.cache_read ?? 0,
    totalCost: row.total_cost ?? 0,
    day: row.day ?? "",
  }))
}

export async function getAvailableModels(): Promise<string[]> {
  await ensureDb()
  const sql = `SELECT distinct ${modelExpr(TBL)} as value FROM ${TBL} WHERE ${messageWhere({})} ORDER BY value ASC`
  return queryAll<{ value: string }>(sql).map((r) => r.value ?? "unknown")
}

export async function getAvailableProviders(): Promise<string[]> {
  await ensureDb()
  const sql = `SELECT distinct ${providerExpr(TBL)} as value FROM ${TBL} WHERE ${messageWhere({})} ORDER BY value ASC`
  return queryAll<{ value: string }>(sql).map((r) => r.value ?? "unknown")
}

/** 失败请求计数（total 计算值为 0 视为失败）。 */
export async function getErrorStats(filters: UsageFilters = {}): Promise<ErrorStats> {
  await ensureDb()
  const baseConds: string[] = [`${TBL}.type = 'assistant'`]
  if (filters.sessionId) baseConds.push(`${TBL}.session_id = '${escapeSql(filters.sessionId)}'`)
  if (filters.provider) baseConds.push(`${providerExpr(TBL)} = '${escapeSql(filters.provider)}'`)
  if (filters.model) baseConds.push(`${modelExpr(TBL)} = '${escapeSql(filters.model)}'`)
  if (filters.startDate && isValidDate(filters.startDate)) {
    baseConds.push(`date(${TBL}.time_created / 1000, 'unixepoch', 'localtime') >= '${filters.startDate}'`)
  }
  if (filters.endDate && isValidDate(filters.endDate)) {
    baseConds.push(`date(${TBL}.time_created / 1000, 'unixepoch', 'localtime') <= '${filters.endDate}'`)
  }
  const baseWhere = baseConds.join(" AND ")

  const sql = `
SELECT
  ${providerExpr(TBL)} as provider,
  ${modelExpr(TBL)} as model,
  count(*) as total,
  sum(CASE WHEN ${totalExpr(TBL)} = 0 THEN 1 ELSE 0 END) as failed
FROM ${TBL}
WHERE ${baseWhere}
GROUP BY provider, model
ORDER BY failed DESC
  `.trim()

  try {
    const rows = queryAll(sql) as any[]
    let successCount = 0, failedCount = 0
    const byModel = rows.map((r) => {
      const total = r.total ?? 0
      const failed = r.failed ?? 0
      const success = total - failed
      successCount += success
      failedCount += failed
      return { provider: r.provider ?? "unknown", model: r.model ?? "unknown", failed, total }
    })
    const errorRate = (successCount + failedCount) > 0 ? failedCount / (successCount + failedCount) : 0
    return { successCount, failedCount, errorRate, byModel }
  } catch {
    return { successCount: 0, failedCount: 0, errorRate: 0, byModel: [] }
  }
}

export async function getUsageReport(filters: UsageFilters = {}): Promise<UsageReport> {
  await ensureDb()
  const [summary, models, providers, daily, sessions, errors] = await Promise.all([
    getSummary(filters),
    getModelBreakdown(filters),
    getProviderBreakdown(filters),
    getDailyBreakdown(filters),
    getSessionBreakdown(filters),
    getErrorStats(filters),
  ])
  return { filters, summary, models, providers, daily, sessions, errors }
}

function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text
}

export function exportReportAsCsv(report: UsageReport, section: "models" | "providers" | "daily" | "sessions"): string {
  if (section === "models") {
    const header = ["provider", "model", "requests", "sessions", "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheRead", "totalCost"]
    const rows = report.models.map((item) => [item.provider, item.model, item.requests, item.sessions, item.totalTokens, item.inputTokens, item.outputTokens, item.reasoningTokens, item.cacheRead, item.totalCost])
    return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")
  }
  if (section === "providers") {
    const header = ["provider", "requests", "sessions", "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheRead", "totalCost"]
    const rows = report.providers.map((item) => [item.provider, item.requests, item.sessions, item.totalTokens, item.inputTokens, item.outputTokens, item.reasoningTokens, item.cacheRead, item.totalCost])
    return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")
  }
  if (section === "daily") {
    const header = ["day", "requests", "sessions", "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheRead", "totalCost"]
    const rows = report.daily.map((item) => [item.day, item.requests, item.sessions, item.totalTokens, item.inputTokens, item.outputTokens, item.reasoningTokens, item.cacheRead, item.totalCost])
    return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")
  }
  const header = ["day", "sessionId", "title", "provider", "model", "requests", "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheRead", "totalCost"]
  const rows = report.sessions.map((item) => [item.day, item.sessionId, item.title, item.provider, item.model, item.requests, item.totalTokens, item.inputTokens, item.outputTokens, item.reasoningTokens, item.cacheRead, item.totalCost])
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")
}
