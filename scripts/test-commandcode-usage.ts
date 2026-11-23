// 离线单测：CommandCode 用量解析（不依赖网络 / 凭据）
import {
  getCommandCodePlan,
  normalizeCommandCodeUsage,
  pickCommandCodeToken,
} from "../src/commandcode-usage.js"

const ok = (cond: boolean, msg: string) => {
  console.log(cond ? `ok: ${msg}` : `FAIL: ${msg}`)
  if (!cond) process.exitCode = 1
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps

// ── 1. 套餐识别 ──
ok(getCommandCodePlan("individual-goat")?.name === "GOAT", "individual-goat → GOAT")
ok(getCommandCodePlan("individual-goat")?.monthlyCredits === 70, "GOAT 月额度 = 70")
ok(getCommandCodePlan("individual-pro-v1")?.name === "Pro", "individual-pro-v1 → Pro（长键优先）")
ok(getCommandCodePlan("individual-pro-v1")?.monthlyCredits === 80, "Pro v1 月额度 = 80")
ok(getCommandCodePlan("INDIVIDUAL_GOAT")?.name === "GOAT", "大小写 / 下划线兼容")
ok(getCommandCodePlan("some-new-plan") === null, "未知套餐 → null")

// ── 2. 真实响应归一化（2026-11-23 实测样本）──
const now = Date.parse("2026-11-23T00:00:00Z")
const payload = {
  whoami: { user: { userName: "tester" }, org: null },
  credits: {
    credits: { monthlyCredits: 17.3038456311, purchasedCredits: 0, freeCredits: 2 },
    windowLimits: {
      fiveHour: { used: 0.0259108752, cap: 14, resetAt: Date.parse("2026-11-23T04:00:00Z") },
      weekly: { used: 13.7182472161, cap: 35, resetAt: Date.parse("2026-11-24T00:00:00Z") },
    },
  },
  subscription: {
    success: true,
    data: {
      status: "active",
      planId: "individual-goat",
      currentPeriodStart: "2026-11-02T08:08:50.000Z",
      currentPeriodEnd: "2026-12-02T08:08:50.000Z",
    },
  },
  summary: { totalCost: 52.94986633389998, totalCount: 30655 },
}

const data = normalizeCommandCodeUsage(payload, now)
ok(!!data, "归一化成功")
if (data) {
  ok(data.planName === "GOAT", `套餐名自动识别 = GOAT（实际 ${data.planName}）`)
  ok(data.planMonthlyCredits === 70, "月额度 = 70")
  ok(near(data.totalRemaining, 19.3038), `余额 = 17.30 + 2.00 = 19.30（实际 ${data.totalRemaining.toFixed(4)}）`)
  ok(near(data.usagePercent, ((70 + 2 - 19.3038) / 72) * 100, 0.05), `月已用 ≈ 73.2%（含 $2 赠送额度，实际 ${data.usagePercent.toFixed(2)}%）`)
  ok(data.fiveHour.cap === 14, "5h 上限取接口值 14")
  ok(near(data.fiveHour.percent, 0.185, 0.01), `5h 已用 ≈ 0.19%（实际 ${data.fiveHour.percent.toFixed(3)}%）`)
  ok(data.weekly.cap === 35, "周上限取接口值 35")
  ok(near(data.weekly.percent, 39.195, 0.01), `周已用 ≈ 39.2%（实际 ${data.weekly.percent.toFixed(2)}%）`)
  ok(data.periodEndInSec > 8 * 86400 && data.periodEndInSec < 10 * 86400, `续费倒计时 ≈ 9 天（实际 ${(data.periodEndInSec / 86400).toFixed(1)} 天）`)
  ok(data.status === "active", "订阅状态 active")
  ok(!data.error, "无错误标记")
}

// ── 3. 未知套餐：退化为 used/(used+remaining) ──
const fallback = normalizeCommandCodeUsage({
  credits: { credits: { monthlyCredits: 30 }, windowLimits: {} },
  subscription: { data: { planId: "mystery", status: "active" } },
  summary: { totalCost: 10 },
}, now)
ok(fallback?.planName === "mystery", "未知套餐名原样展示")
ok(fallback?.planMonthlyCredits === null, "未知套餐无月额度")
ok(near(fallback?.usagePercent ?? -1, 25), `未知套餐用量 = 10/(10+30) = 25%（实际 ${fallback?.usagePercent}%）`)

// ── 4. 空响应 ──
ok(normalizeCommandCodeUsage({}, now) === null, "无 credits / subscription → null")

// ── 5. 凭证挑选 ──
const creds = [
  { integrationID: "opencode", active: true, value: { type: "key", key: "sk-other" } },
  { integrationID: "commandcode", active: false, value: { type: "key", key: "user_old" } },
  { integrationID: "commandcode", active: true, value: { type: "key", key: "user_active" } },
  { integrationID: "command-code", active: false, value: { type: "key", key: "user_alt" } },
]
ok(pickCommandCodeToken(creds) === "user_active", "多个 CommandCode 凭证取 active 的")
ok(pickCommandCodeToken([{ integrationID: "commandcode", value: { type: "oauth", key: "" } }]) === undefined, "非 key 类型忽略")
ok(pickCommandCodeToken([]) === undefined, "空列表 → undefined")

console.log(process.exitCode ? "=== FAILED ===" : "=== ALL PASSED ===")
