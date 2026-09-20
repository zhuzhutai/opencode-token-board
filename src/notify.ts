import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { unlinkSync, writeFileSync, mkdirSync } from "node:fs"

/**
 * 桌面提示（跨平台）。
 *
 * Windows：不用 ToastNotificationManager（未注册 AUMID 的传统进程会静默失败），
 *          改用 WinForms 顶层小窗，权限按钮直接写入本地批准标记；通过 wscript
 *          以 ShellExecute 拉起独立 GUI 进程，避免继承无窗口标志。
 * macOS：  osascript + `display notification`（会话结束）/ `display dialog`（权限），
 *          权限对话框点按后由 AppleScript 直接写出同样的批准标记文件。
 * Linux：  notify-send 兜底通知（权限按钮无法可靠实现，请在 TUI 内回复）。
 *
 * 批准标记协议（跨平台一致，供 tui.tsx 监听目录）：
 *   ~/.opencode/tokenwatch-approvals/<requestID>.<once|always|reject>
 */

function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function runPowerShell(script: string): void {
  if (process.platform !== "win32") return
  const hideConsole = [
    "Add-Type -Namespace OpenCodeNotify -Name Native -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'",
    "$console = [OpenCodeNotify.Native]::GetConsoleWindow()",
    "if ($console -ne [IntPtr]::Zero) { [OpenCodeNotify.Native]::ShowWindow($console, 0) | Out-Null }",
  ].join("\n")
  const wrapped = [
    hideConsole,
    "try {",
    script,
    "} catch {",
    "  try { [IO.File]::AppendAllText((Join-Path $env:TEMP 'opencode-token-board-notify-error.log'), ((Get-Date).ToString('o') + ' ' + ($_ | Out-String))) } catch { }",
    "  exit 1",
    "}",
  ].join("\n")
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64")
  try {
    // wscript 的 WshShell.Run 使用 ShellExecute 创建独立 GUI 进程。
    // Node/Bun 直接 CreateProcess 或 cmd start 可能让 WinForms 继承无窗口标志。
    const vbsPath = join(tmpdir(), `opencode-token-board-${randomUUID()}.vbs`)
    const command = `powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
    const vbs = [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run "${command}", 0, False`,
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'On Error Resume Next',
      'fso.DeleteFile WScript.ScriptFullName, True',
    ].join("\r\n")
    writeFileSync(vbsPath, vbs, "ascii")
    const child = spawn("wscript.exe", [vbsPath], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    setTimeout(() => {
      try { unlinkSync(vbsPath) } catch { }
    }, 5000).unref()
  } catch {
    /* 桌面提示失败不影响插件主流程 */
  }
}

/** 分离式 spawn 一个外部命令（macOS / Linux 提示用），失败静默。 */
function spawnDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
  } catch {
    /* 提示失败不影响插件主流程 */
  }
}

// ─────────────────────────────────────────────
// macOS (AppleScript)
// ─────────────────────────────────────────────

/** AppleScript 字符串字面量转义（双引号 + 反斜杠）。 */
function asQuote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

/** POSIX shell 单引号转义。 */
function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** 会话结束通知（macOS）：非阻塞，osascript 执行完即退出。 */
export function macNotifyScript(title: string, message: string): string {
  return `display notification ${asQuote(message)} with title ${asQuote(title)}`
}

/**
 * 权限弹窗（macOS）：三按钮对话框，点按后写出与 Windows 完全一致的批准标记。
 * display dialog 会阻塞该 osascript 进程直到用户选择，进程以 detached 方式拉起。
 */
export function macPermissionScript(input: PermissionToastInput): string {
  const approvalDir = join(homedir(), ".opencode", "tokenwatch-approvals")
  const buttons: Array<{ label: string; reply: string }> = [
    { label: input.allowOnceLabel, reply: "once" },
    { label: input.alwaysLabel, reply: "always" },
    { label: input.rejectLabel, reply: "reject" },
  ]
  const buttonList = buttons.map((b) => asQuote(b.label)).join(", ")
  const branches = buttons
    .map((b, index) => {
      const marker = join(approvalDir, `${input.requestID}.${b.reply}`)
      const shell = `mkdir -p ${shQuote(approvalDir)} && : > ${shQuote(marker)}`
      const lead = index === 0 ? "if" : "else if"
      return `${lead} theReply is ${asQuote(b.label)} then\n  do shell script ${asQuote(shell)}`
    })
    .join("\n")
  return [
    `set theReply to button returned of (display dialog ${asQuote(input.message)} with title ${asQuote(input.title)} buttons {${buttonList}} default button 1 with icon caution)`,
    branches,
    "end if",
  ].join("\n")
}

// ─────────────────────────────────────────────
// Linux (zenity / notify-send)
// ─────────────────────────────────────────────

export function linuxNotifyArgs(title: string, message: string): string[] {
  return [title, message]
}

export interface ZenityPlan {
  command: string
  args: string[]
}

/**
 * Linux 权限弹窗（zenity 三按钮）。
 * 用 `--switch` 抑制默认的 OK/Cancel，改用三个 `--extra-button`；点击的按钮文案会
 * 打印到 stdout，据此判定动作——比依赖 exit code（extra button 在不同版本返回 0/1/2
 * 不一致）更可靠。
 */
export function linuxPermissionPlan(input: PermissionToastInput): ZenityPlan {
  return {
    command: "zenity",
    args: [
      "--question",
      "--title", input.title,
      "--text", input.message,
      "--switch",
      "--extra-button", input.allowOnceLabel,
      "--extra-button", input.alwaysLabel,
      "--extra-button", input.rejectLabel,
      "--width", "420",
    ],
  }
}

/** 将 zenity 返回的按钮文案映射为批准动作；空（Esc/关窗）或未知文案返回 null。 */
export function linuxReplyFromButton(label: string, input: PermissionToastInput): "once" | "always" | "reject" | null {
  const v = (label ?? "").trim()
  if (!v) return null
  if (v === input.allowOnceLabel) return "once"
  if (v === input.alwaysLabel) return "always"
  if (v === input.rejectLabel) return "reject"
  return null
}

/** 写入批准标记文件（与 Windows/macOS 协议一致）。 */
function writeApprovalMarker(requestID: string, reply: string): void {
  try {
    const dir = join(homedir(), ".opencode", "tokenwatch-approvals")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${requestID}.${reply}`), "")
  } catch { /* ignore */ }
}

/** 拉起 zenity 三按钮对话框；缺 zenity 时退化为 notify-send 通知。 */
function spawnLinuxPermission(input: PermissionToastInput): void {
  const plan = linuxPermissionPlan(input)
  try {
    const child = spawn(plan.command, plan.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    let out = ""
    let settled = false
    child.stdout?.on("data", (chunk) => { out += String(chunk) })
    child.on("error", () => {
      if (settled) return
      settled = true
      spawnDetached("notify-send", linuxNotifyArgs(input.title, input.message))
    })
    child.on("close", () => {
      if (settled) return
      settled = true
      const reply = linuxReplyFromButton(out, input)
      if (reply) writeApprovalMarker(input.requestID, reply)
    })
  } catch {
    spawnDetached("notify-send", linuxNotifyArgs(input.title, input.message))
  }
}

// ─────────────────────────────────────────────
// Windows popup 脚本（保持原样，供测试与 win32 使用）
// ─────────────────────────────────────────────

export function popupScript(title: string, message: string, timeoutMs: number, buttons?: Array<{ label: string; reply: string; color: string; hover: string }>, requestID?: string, processID?: number): string {
  const W = 520
  const buttonScript = buttons?.length
    ? buttons.map((button, index) => {
      const x = 18 + index * 168
      return [
        `$button${index} = New-Object System.Windows.Forms.Button`,
        `$button${index}.Text = ${psQuote(button.label)}`,
        `$button${index}.Left = ${x}`,
        `$button${index}.Top = 160`,
        `$button${index}.Width = 150`,
        `$button${index}.Height = 38`,
        "$button" + index + ".FlatStyle = [System.Windows.Forms.FlatStyle]::Flat",
        "$button" + index + ".FlatAppearance.BorderSize = 0",
        `$button${index}.BackColor = [System.Drawing.ColorTranslator]::FromHtml(${psQuote(button.color)})`,
        `$button${index}.FlatAppearance.MouseOverBackColor = [System.Drawing.ColorTranslator]::FromHtml(${psQuote(button.hover)})`,
        "$button" + index + ".ForeColor = [System.Drawing.Color]::White",
        `$button${index}.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)`,
        "$button" + index + ".Cursor = [System.Windows.Forms.Cursors]::Hand",
        `$button${index}.Add_Click({ Complete ${psQuote(button.reply)} })`,
        `$form.Controls.Add($button${index})`,
        `$button${index}.BringToFront()`,
      ].join("\n")
    }).join("\n")
    : ""

  const completion = buttons?.length
    ? `
function Complete([string]$reply) {
  try {
    $dir = Join-Path $HOME ".opencode\\tokenwatch-approvals"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $file = Join-Path $dir (${psQuote(requestID ?? "")} + "." + $reply)
    New-Item -ItemType File -Force -Path $file | Out-Null
  } catch { }
  if (${processID ?? 0} -gt 0) {
    try {
      $ws = New-Object -ComObject WScript.Shell
      $ws.AppActivate([int]${processID ?? 0}) | Out-Null
    } catch { }
  }
  $form.Close()
}
`
    : ""

  const height = buttons?.length ? 220 : 158
  const timer = timeoutMs > 0
    ? `
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = ${timeoutMs}
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()
`
    : ""

  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$form = New-Object System.Windows.Forms.Form",
    `$form.Text = ${psQuote(title)}`,
    `$form.Width = ${W}`,
    `$form.Height = ${height}`,
    // 无系统标题栏，避免出现 Windows XP 风格；ShowInTaskbar 保持 true，确保
    // PowerShell 分离进程中的窗体仍然拥有可见窗口句柄。
    "$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None",
    "$form.ShowInTaskbar = $true",
    "$form.TopMost = $true",
    "$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#F5F7FA')",
    "$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea",
    "$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
    "$form.Location = New-Object System.Drawing.Point(($workArea.Right - $form.Width - 16), ($workArea.Bottom - $form.Height - 16))",
    "$titleLabel = New-Object System.Windows.Forms.Label",
    `$titleLabel.Text = ${psQuote(title)}`,
    "$titleLabel.Left = 22",
    "$titleLabel.Top = 20",
    "$titleLabel.Width = 446",
    "$titleLabel.Height = 26",
    "$titleLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)",
    "$titleLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#1F2933')",
    "$titleLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft",
    "$form.Controls.Add($titleLabel)",
    "$closeLabel = New-Object System.Windows.Forms.Label",
    "$closeLabel.Text = '×'",
    `$closeLabel.Left = ${W - 44}`,
    "$closeLabel.Top = 12",
    "$closeLabel.Width = 30",
    "$closeLabel.Height = 30",
    "$closeLabel.Font = New-Object System.Drawing.Font('Segoe UI Symbol', 14)",
    "$closeLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#667085')",
    "$closeLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter",
    "$closeLabel.Cursor = [System.Windows.Forms.Cursors]::Hand",
    "$closeLabel.Add_Click({ $form.Close() })",
    "$form.Controls.Add($closeLabel)",
    `$label = New-Object System.Windows.Forms.Label`,
    `$label.Text = ${psQuote(message)}`,
    "$label.Left = 22",
    "$label.Top = 58",
    "$label.Width = 476",
    `$label.Height = ${buttons?.length ? 82 : 70}`,
    "$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)",
    "$label.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#3E4C59')",
    "$label.TextAlign = [System.Drawing.ContentAlignment]::TopLeft",
    "$label.AutoEllipsis = $true",
    "$form.Controls.Add($label)",
    completion,
    buttonScript,
    timer,
    "$form.Add_Shown({ $form.Activate() })",
    "[void]$form.ShowDialog()",
  ].join("\n")
}

let lastNotifyAt = 0

/** 会话结束提示（跨平台）。 */
export function notify(title: string, message: string): void {
  const now = Date.now()
  if (now - lastNotifyAt < 1000) return
  lastNotifyAt = now

  if (process.platform === "win32") {
    runPowerShell(popupScript(title, message, 6000))
  } else if (process.platform === "darwin") {
    spawnDetached("osascript", ["-e", macNotifyScript(title, message)])
  } else if (process.platform === "linux") {
    spawnDetached("notify-send", linuxNotifyArgs(title, message))
  }
}

const shownPermissionIds = new Set<string>()

export interface PermissionToastInput {
  requestID: string
  title: string
  message: string
  allowOnceLabel: string
  alwaysLabel: string
  rejectLabel: string
  pid: number
}

/** 权限请求提示（跨平台）。macOS 点按后同样写出批准标记文件。 */
export function notifyPermission(input: PermissionToastInput): void {
  if (shownPermissionIds.has(input.requestID)) return
  shownPermissionIds.add(input.requestID)

  if (process.platform === "win32") {
    runPowerShell(popupScript(
      input.title,
      input.message,
      120000,
      [
        { label: input.allowOnceLabel, reply: "once", color: "#2E7D32", hover: "#388E3C" },
        { label: input.alwaysLabel, reply: "always", color: "#1565C0", hover: "#1976D2" },
        { label: input.rejectLabel, reply: "reject", color: "#C62828", hover: "#D32F2F" },
      ],
      input.requestID,
      input.pid,
    ))
  } else if (process.platform === "darwin") {
    spawnDetached("osascript", ["-e", macPermissionScript(input)])
  } else if (process.platform === "linux") {
    spawnLinuxPermission(input)
  }
}
