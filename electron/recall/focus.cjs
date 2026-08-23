// Activity Recall — App-Focus-Poller (Phase 3).
// Liefert den App-Nutzungs-Zeitstrahl: alle 2 s Vordergrundfenster pruefen und
// bei Aenderung ein `focus`-Event schreiben (Dedupe identischer Folgen).
//
// WARUM dieser Weg (dokumentierte Entscheidung):
//   - npm-FFI-Bindings sind verboten ("no new npm dependencies").
//   - Ein `powershell -Command`-Aufruf pro Tick kostet 200-500 ms Startup und
//     dauerhaft CPU — viel zu schwer fuer einen 2-s-Takt.
//   - Also: EIN langlebiger, versteckter PowerShell-Kindprozess laeuft eine
//     Polling-Schleife (Add-Type auf user32) und schreibt NUR bei Aenderung
//     eine JSON-Zeile auf stdout. Node liest zeilenweise. Kosten: ein
//     schlafender Prozess, praktisch keine CPU, keine Abhaengigkeiten.

const { spawn } = require('node:child_process')
const readline = require('node:readline')
const store = require('./store.cjs')

const PS_FOCUS_LOOP = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BloubWinFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$lastApp = $null
$lastTitle = $null
$sb = New-Object System.Text.StringBuilder 512
while ($true) {
  try {
    $h = [BloubWinFocus]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      [void][BloubWinFocus]::GetWindowTextW($h, $sb, $sb.Capacity)
      $title = $sb.ToString().Trim()
      $winPid = [uint32]0
      [void][BloubWinFocus]::GetWindowThreadProcessId($h, [ref]$winPid)
      $proc = Get-Process -Id $winPid -ErrorAction SilentlyContinue
      $app = if ($proc) { $proc.ProcessName } else { '' }
      if ($app -ne $lastApp -or $title -ne $lastTitle) {
        $lastApp = $app
        $lastTitle = $title
        $obj = @{ app = $app; title = $title; ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
        [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
      }
    }
  } catch {
    # Schleife niemals sterben lassen
  }
  Start-Sleep -Milliseconds 2000
}
`.trim()

/**
 * Startet den Poller. onFocus(app, title, ts) wird NUR bei Wechsel gerufen
 * (dedupliziert). Rueckgabe: { stop(), isRunning() }.
 */
function startFocusPoller({ userData, intervalMs = 2000, onFocus } = {}) {
  let child = null
  let rl = null
  let stopped = false
  let restartTimer = null
  let lastKey = null

  function spawnLoop() {
    if (stopped) return
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_FOCUS_LOOP],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) return
      let obj
      try {
        obj = JSON.parse(trimmed)
      } catch {
        return
      }
      const key = `${obj.app}\u0000${obj.title}`
      if (key === lastKey) return // Dedupe: identisches App/Title-Paar
      lastKey = key
      const event = {
        ts: Number(obj.ts) || Date.now(),
        source: 'app',
        app: String(obj.app ?? ''),
        title: String(obj.title ?? ''),
        kind: 'focus',
        text: '',
        detail: {}
      }
      store.appendEvent(userData, event)
      if (typeof onFocus === 'function') {
        try {
          onFocus(event.app, event.title, event.ts)
        } catch {
          /* Callback-Fehler duerfen den Poller nicht beenden */
        }
      }
    })
    // Kindprozess gestorben (Crash/System-Event)? Mit Backoff neu starten,
    // solange der Poller nicht bewusst gestoppt wurde.
    child.on('exit', () => {
      child = null
      rl = null
      if (!stopped) {
        restartTimer = setTimeout(spawnLoop, 5000)
      }
    })
    child.on('error', () => { /* exit-Handler uebernimmt */ })
  }

  spawnLoop()

  return {
    stop() {
      stopped = true
      clearTimeout(restartTimer)
      try { child?.kill() } catch { /* schon tot */ }
    },
    isRunning() {
      return !!child && !stopped
    },
    /** Fuer Auto-Pause-Checks: zuletzt gesehener Fenstertitel. */
    lastKey
  }
}

module.exports = { startFocusPoller }
