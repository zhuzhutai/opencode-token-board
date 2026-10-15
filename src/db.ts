import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/**
 * db.ts — SQLite 访问层（v1 `opencode db` CLI 已在 v2 删除，改为进程内直连）。
 *
 * 引擎选择（插件运行在 OpenCode 的 bun 运行时，报告也可在 node 下测）：
 *   1. `bun:sqlite`  — bun 内置（OpenCode 主运行时）
 *   2. `node:sqlite` — node 22+ 内置（fallback / 本地测试）
 * 两者同构 `DatabaseSync` API：`new DatabaseSync(path, { readOnly })` + `.prepare(sql).all()`。
 *
 * 用 `new Function` 动态导入，绕过 TS/esbuild 的静态模块解析（bun:sqlite 在类型层不存在）。
 *
 * DB 路径解析：`OPENCODE_DB` env → 已知 XDG 路径 → `opencode debug paths db`（权威，带 channel）。
 * 连接只读，绝不写库。
 */

interface SqliteLike {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}
type OpenFn = (path: string) => SqliteLike

const dynImport = (spec: string): Promise<any> => new Function("s", "return import(s)")(spec)

let openFn: OpenFn | null = null
let engineLoaded = false

async function loadEngine(): Promise<OpenFn | null> {
  if (engineLoaded) return openFn
  engineLoaded = true
  // bun:sqlite（OpenCode bun 运行时）
  try {
    const mod = await dynImport("bun:sqlite")
    if (typeof mod?.DatabaseSync === "function") {
      openFn = (p: string) => new mod.DatabaseSync(p, { readOnly: true }) as SqliteLike
      return openFn
    }
  } catch { /* 非 bun 环境 */ }
  // node:sqlite（node 22+）
  try {
    const mod = await dynImport("node:sqlite")
    if (typeof mod?.DatabaseSync === "function") {
      openFn = (p: string) => new mod.DatabaseSync(p, { readOnly: true }) as SqliteLike
      return openFn
    }
  } catch { /* 过老 node */ }
  return null
}

function candidatePaths(): string[] {
  const out: string[] = []
  const envDb = process.env.OPENCODE_DB
  if (envDb && envDb !== ":memory:" && existsSync(envDb)) out.push(envDb)
  // XDG 数据目录（Windows 上 OpenCode 也用 ~/.local/share/opencode，实测如此）
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) out.push(join(xdg, "opencode", "opencode.db"))
  out.push(join(homedir(), ".local", "share", "opencode", "opencode.db"))
  // macOS 常见路径
  out.push(join(homedir(), "Library", "Application Support", "opencode", "opencode.db"))
  return out.filter((p) => existsSync(p))
}

/** 权威路径：`opencode debug paths db`（带 channel/OPENCODE_DB 处理）。失败返回 null。 */
async function resolveDbPathViaCli(): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync("opencode", ["debug", "paths", "db"], {
      timeout: 5000,
      windowsHide: true,
      env: process.env,
    })
    const p = stdout.trim().split("\n").pop()?.trim()
    if (p && existsSync(p)) return p
  } catch { /* opencode 不在 PATH 或不支持 */ }
  return null
}

let db: SqliteLike | null = null
let resolveTried = false

/** 确保 DB 已打开。成功返回 true，失败（无引擎 / 找不到库）返回 false。 */
export async function ensureDb(): Promise<boolean> {
  if (db) return true
  if (resolveTried && !db) return false
  resolveTried = true
  const open = await loadEngine()
  if (!open) return false
  // 优先权威 CLI 路径，其次已知位置
  let path = await resolveDbPathViaCli()
  if (!path) path = candidatePaths()[0]
  if (!path) return false
  try {
    db = open(path)
    return true
  } catch {
    db = null
    return false
  }
}

/** 同步执行 SELECT 并返回行数组。DB 未就绪或查询失败时返回空数组（报告优雅降级）。 */
export function queryAll<T = Record<string, unknown>>(sql: string): T[] {
  if (!db) return []
  try {
    return db.prepare(sql).all() as T[]
  } catch {
    return []
  }
}
