// Activity Recall — Clipboard-Tap (Phase 8, opt-in, default AUS).
// Lauscht auf Text-Aenderungen in der Zwischenablage und haelt einen
// Ring-Puffer der letzten 200 Eintraege (je max 10 KB) plus Write-Through in
// den Event-Store (source 'clipboard'). Skip, wenn ein Passwort-Manager-
// Fenster im Vordergrund ist.
//
// Technik wie beim Focus-Poller: EIN langlebiger PowerShell-Kindprozess
// polllt Get-ClipboardText alle 2 s und schreibt NUR bei Aenderung eine
// JSON-Zeile auf stdout (keine npm-Deps, kein Win32-FFI).

const { spawn } = require('node:child_process')
const readline = require('node:readline')
const store = require('./store.cjs')

const RING_MAX = 200
const ENTRY_MAX = 10 * 1024

// Passwort-Manager & Co.: gar nichts mitlesen, solange deren Fenster vorn ist.
const SECRET_WINDOW_RE = /1password|bitwarden|keepass|lastpass|dashlane|proton ?pass|password|passwort/i

const PS_CLIP_LOOP = `
Add-Type -AssemblyName PresentationCore
$last = $null
while ($true) {
  try {
    $text = [Windows.Clipboard]::GetText()
    if (-not [string]::IsNullOrEmpty($text)) {
      # Fokus-Titel pruefen: Passwort-Manager-Fenster -> diesen Tick ueberspringen
      $skip = $false
      try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BloubClipFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder t, int c);
}
"@
        $h = [BloubClipFocus]::GetForegroundWindow()
        if ($h -ne [IntPtr]::Zero) {
          $sb = New-Object System.Text.StringBuilder 512
          [void][BloubClipFocus]::GetWindowTextW($h, $sb, $sb.Capacity)
          if ($sb.ToString() -match '1Password|Bitwarden|KeePass|LastPass|Dashlane|ProtonPass|[Pp]asswo') { $skip = $true }
        }
      } catch {}
      if (-not $skip -and $text -ne $last) {
        $last = $text
        $obj = @{ text = $text; ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
        [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 2))
        [Console]::Out.Flush()
      }
    }
  } catch {}
  Start-Sleep -Milliseconds 2000
}
`.trim()

/**
 * Startet den Clipboard-Tap. Rueckgabe { stop(), ring() }.
 * ring(): die letzten Eintraege [{ts, preview}] fuer Statusanzeigen.
 */
function startClipboardTap({ userData } = {}) {
  let child = null
  let rl = null
  let stopped = false
  let restartTimer = null
  const ring = [] // { ts, length, preview }

  function spawnLoop() {
    if (stopped) return
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_CLIP_LOOP],
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
      const text = String(obj.text ?? '')
      if (!text.trim()) return
      // 10-KB-Cap pro Eintrag; nur Preview im Ring, Volltext in den Store
      const capped = text.length > ENTRY_MAX ? text.slice(0, ENTRY_MAX) : text
      const entry = {
        ts: Number(obj.ts) || Date.now(),
        length: text.length,
        preview: capped.slice(0, 80)
      }
      ring.push(entry)
      if (ring.length > RING_MAX) ring.shift() // Ring: letzte 200 Eintraege
      store.appendEvent(userData, {
        ts: entry.ts,
        source: 'clipboard',
        app: '',
        title: '',
        kind: 'action',
        text: capped,
        detail: { originalLength: text.length }
      })
    })
    child.on('exit', () => {
      child = null
      rl = null
      if (!stopped) restartTimer = setTimeout(spawnLoop, 5000)
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
    isRunning: () => !!child && !stopped,
    ring: () => [...ring]
  }
}

module.exports = { startClipboardTap, RING_MAX, ENTRY_MAX }
