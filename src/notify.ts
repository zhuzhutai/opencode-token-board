import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unlinkSync, writeFileSync } from "node:fs"

/**
 * Windows 桌面提示。
 *
 * 不使用 ToastNotificationManager：传统 Node/PowerShell 进程没有注册 AUMID 时，
 * WinRT 的 Show() 可能静默成功但用户看不到任何通知。这里使用 WinForms 创建
 * 一个真正位于屏幕右下角的顶层矩形小窗，权限按钮直接写入本地批准标记。
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

export function notifyWindows(title: string, message: string): void {
  if (process.platform !== "win32") return
  const now = Date.now()
  if (now - lastNotifyAt < 1000) return
  lastNotifyAt = now
  runPowerShell(popupScript(title, message, 6000))
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

export function notifyPermissionWindows(input: PermissionToastInput): void {
  if (process.platform !== "win32") return
  if (shownPermissionIds.has(input.requestID)) return
  shownPermissionIds.add(input.requestID)

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
}
