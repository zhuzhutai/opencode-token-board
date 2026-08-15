import { spawn } from "node:child_process"

/**
 * Windows 桌面提示。
 *
 * 不使用 ToastNotificationManager：传统 Node/PowerShell 进程没有注册 AUMID 时，
 * WinRT 的 Show() 可能静默成功但用户看不到任何通知。这里使用 WinForms 创建
 * 一个真正位于屏幕右下角的顶层小窗，权限按钮直接写入本地批准标记。
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
    // 通过 cmd start 脱离 OpenCode/Bun 的控制台创建标志；直接 spawn GUI 子进程时，
    // Windows 可能继承无窗口标志，导致 PowerShell 活着但 WinForms 没有可见句柄。
    const child = spawn("cmd.exe", [
      "/d",
      "/c",
      "start",
      "",
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ], {
      // 隐藏的是短暂的 cmd 启动器，不是它启动的 WinForms PowerShell。
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch {
    /* 桌面提示失败不影响插件主流程 */
  }
}

function popupScript(title: string, message: string, timeoutMs: number, buttons?: Array<{ label: string; reply: string }>, requestID?: string, processID?: number): string {
  const buttonScript = buttons?.length
    ? buttons.map((button, index) => {
      const x = 18 + index * 136
      return [
        `$button${index} = New-Object System.Windows.Forms.Button`,
        `$button${index}.Text = ${psQuote(button.label)}`,
        `$button${index}.Width = 122`,
        `$button${index}.Height = 30`,
        `$button${index}.Location = New-Object System.Drawing.Point(${x}, 105)`,
        `$button${index}.Add_Click({ Complete ${psQuote(button.reply)} })`,
        `$form.Controls.Add($button${index})`,
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

  const height = buttons?.length ? 180 : 125
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
    `$form = New-Object System.Windows.Forms.Form`,
    `$form.Text = ${psQuote(title)}`,
    `$form.Width = 460`,
    `$form.Height = ${height}`,
    "$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle",
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.TopMost = $true",
    "$form.ShowInTaskbar = $true",
    "$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea",
    "$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
    "$form.Location = New-Object System.Drawing.Point(($workArea.Right - $form.Width - 12), ($workArea.Bottom - $form.Height - 12))",
    "$label = New-Object System.Windows.Forms.Label",
    "$label.Text = " + psQuote(message),
    "$label.AutoSize = $false",
    "$label.Width = 424",
    "$label.Height = 64",
    "$label.Location = New-Object System.Drawing.Point(18, 18)",
    "$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)",
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
      { label: input.allowOnceLabel, reply: "once" },
      { label: input.alwaysLabel, reply: "always" },
      { label: input.rejectLabel, reply: "reject" },
    ],
    input.requestID,
    input.pid,
  ))
}
