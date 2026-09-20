import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { popupScript, macNotifyScript, macPermissionScript, linuxNotifyArgs, linuxPermissionPlan, linuxReplyFromButton } from "../src/notify.js"

let failures = 0
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

console.log("== 权限弹窗（3 按钮）脚本生成 ==")
const perm = popupScript(
  "OpenCode 请求权限",
  "bash: rm -rf D:/tmp/demo",
  120000,
  [
    { label: "允许一次", reply: "once", color: "#2E7D32", hover: "#388E3C" },
    { label: "总是允许", reply: "always", color: "#1565C0", hover: "#1976D2" },
    { label: "拒绝", reply: "reject", color: "#C62828", hover: "#D32F2F" },
  ],
  "req-123",
  4567,
)
check("包含 Add-Type WinForms", perm.includes("Add-Type -AssemblyName System.Windows.Forms"))
check("包含 Add-Type Drawing", perm.includes("Add-Type -AssemblyName System.Drawing"))
check("不包含圆角路径函数", !perm.includes("New-RoundPath"))
check("不包含圆角区域函数", !perm.includes("New-RoundRegion"))
check("不包含 DrawPath 边框绘制", !perm.includes("DrawPath"))
check("不包含顶部蓝色条", !perm.includes("#0078D4"))
check("无系统标题栏", perm.includes("FormBorderStyle]::None"))
check("ShowInTaskbar 为 $true", perm.includes("ShowInTaskbar = $true"))
check("三个按钮", (perm.match(/New-Object System.Windows.Forms.Button/g) ?? []).length === 3)
check("按钮文案 允许一次", perm.includes("'允许一次'"))
check("按钮文案 总是允许", perm.includes("'总是允许'"))
check("按钮文案 拒绝", perm.includes("'拒绝'"))
check("允许一次→once", perm.includes("Complete 'once'"))
check("总是允许→always", perm.includes("Complete 'always'"))
check("拒绝→reject", perm.includes("Complete 'reject'"))
check("颜色 绿 #2E7D32", perm.includes("#2E7D32"))
check("颜色 蓝 #1565C0", perm.includes("#1565C0"))
check("颜色 红 #C62828", perm.includes("#C62828"))
check("标记写入 requestID 拼接", perm.includes("'req-123' + \".\" + $reply"))
check("窗口激活使用 pid 4567", perm.includes("$ws.AppActivate([int]4567)"))
check("右下角定位", perm.includes("$workArea.Right - $form.Width - 16"))
check("置顶 TopMost", perm.includes("TopMost = $true"))
check("ShowDialog", perm.includes("[void]$form.ShowDialog()"))
check("自动关闭 Timer", perm.includes("$timer.Interval = 120000"))

console.log("== 特殊字符注入安全 ==")
const evil = popupScript(
  "title'; $evil = 1; '",
  "msg'); Remove-Item C:\\ -Recurse; '",
  1000,
  [{ label: "a'; x='b", reply: "once", color: "#000000", hover: "#111111" }],
  "id'; rm 'x",
  0,
)
check("标题单引号转义", evil.includes("'title''; $evil = 1; '''") || evil.includes("title''"))
check("消息单引号转义", evil.includes("msg''); Remove-Item"))
check("requestID 单引号转义", evil.includes("'id''; rm ''x'"))
check("标签单引号转义", evil.includes("'a''; x=''b'"))

console.log("== 会话结束弹窗（无按钮） ==")
const idle = popupScript("OpenCode 会话完成", "本轮会话已结束", 6000)
check("无按钮", !idle.includes("New-Object System.Windows.Forms.Button"))
check("无标记写入函数", !idle.includes("function Complete"))
check("高度 158（无按钮）", idle.includes("$form.Height = 158"))
check("Timer 6s", idle.includes("$timer.Interval = 6000"))

console.log("== PowerShell 语法校验 ==")
const script = [perm, idle].join("\n")
writeFileSync("scripts/popup-script-check.ps1", script, "utf-8")
const psFile = "scripts/popup-script-check.ps1".replace(/'/g, "''")
const ps = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NoInteractive",
  "-ExecutionPolicy", "Bypass",
  "-Command",
  `$errs = $null; [System.Management.Automation.PSParser]::Tokenize((Get-Content '${psFile}' -Raw), [ref]$errs) | Out-Null; if ($errs.Count -eq 0) { 'SYNTAX_OK' } else { $errs | ForEach-Object { $_.Message }; exit 1 }`,
], { encoding: "utf8" })
check("PSParser 语法无错误", ps.stdout.includes("SYNTAX_OK"), ps.stdout + ps.stderr)

// ── 跨平台脚本生成（无法在 Windows 执行 osascript，但可校验生成结果）──
console.log("== macOS AppleScript 生成 ==")
const macNotify = macNotifyScript('标题"x', "消息\\y")
check("含 display notification", macNotify.includes("display notification"))
check("双引号转义", macNotify.includes('\\"'))
check("反斜杠转义", macNotify.includes("\\\\"))

const macPerm = macPermissionScript({
  requestID: "per_1",
  title: "t",
  message: "m",
  allowOnceLabel: "允许一次",
  alwaysLabel: "总是允许",
  rejectLabel: "拒绝",
  pid: 123,
})
check("含 display dialog", macPerm.includes("display dialog"))
check("三按钮顺序", macPerm.includes('buttons {"允许一次", "总是允许", "拒绝"}'))
check("默认按钮 1", macPerm.includes("default button 1"))
check("once 标记写入", macPerm.includes(".once'"))
check("always 标记写入", macPerm.includes(".always'"))
check("reject 标记写入", macPerm.includes(".reject'"))
check("写入 approvals 目录", macPerm.includes("tokenwatch-approvals"))
check("if/else-if 分支", macPerm.includes("else if theReply is"))
check("do shell script 落盘", macPerm.includes("do shell script"))

console.log("== Linux notify-send 参数 ==")
const lin = linuxNotifyArgs("标题", "消息")
check("两个参数", lin.length === 2 && lin[0] === "标题" && lin[1] === "消息")

console.log("== Linux zenity 三按钮 ==")
const linInput = {
  requestID: "per_9",
  title: "t",
  message: "m",
  allowOnceLabel: "允许一次",
  alwaysLabel: "总是允许",
  rejectLabel: "拒绝",
  pid: 1,
}
const zp = linuxPermissionPlan(linInput)
check("命令为 zenity", zp.command === "zenity")
check("--switch 抑制默认按钮", zp.args.includes("--switch"))
check("三个 --extra-button", (zp.args.filter((a) => a === "--extra-button")).length === 3)
const ai = zp.args.indexOf("允许一次")
const bi = zp.args.indexOf("总是允许")
const ci = zp.args.indexOf("拒绝")
check("按钮文案顺序", ai > 0 && ai < bi && bi < ci, `${ai},${bi},${ci}`)
check("--question 模式", zp.args.includes("--question"))
check("点击 允许一次 → once", linuxReplyFromButton("允许一次", linInput) === "once")
check("点击 总是允许 → always", linuxReplyFromButton("总是允许", linInput) === "always")
check("点击 拒绝 → reject", linuxReplyFromButton("拒绝", linInput) === "reject")
check("空输出（Esc/关窗）→ null", linuxReplyFromButton("\n", linInput) === null)
check("未知文案 → null", linuxReplyFromButton("whatever", linInput) === null)

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"}`)
process.exit(failures === 0 ? 0 : 1)
