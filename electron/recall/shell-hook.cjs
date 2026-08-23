// Activity Recall — Shell-Tap Installation (Phase 2).
// PowerShell: installiert einen Hook in die User-PowerShell-Profile, der nach
// JEDEM ausgefuehrten Kommando eine JSONL-Zeile in den Spool schreibt.
// Ansatz-Bewusstsein (ehrliche Limits, siehe auch unten):
//   Wir wrappen die `prompt`-Funktion. Nach jedem Rueckkehr zum Prompt lesen
//   wir den letzten Get-History-Eintrag (Id-Dedupe) und schreiben
//   Kommandozeile + cwd + Exitcode + Dauer. Das ist KEIN Keylogger: nur
//   akzeptierte/ausgefuehrte Zeilen landen im Spool, niemals Tastenanschlaege
//   waehrend der Eingabe.
//   Limits: $LASTEXITCODE existiert nur fuer native EXEs (Cmdlet-Fehler -> null,
//   wir schreiben dann exit=null); Ctrl+C kann einen Eintrag erst beim naechsten
//   Prompt erfassen; verschachtelte Prompts (Debug) werden nicht erfasst; nur
//   interaktive Sessions mit geladenem Profil.

const fs = require('node:fs')
const path = require('node:path')

const MARK_BEGIN = '# >>> bloub recall hook >>>'
const MARK_END = '# <<< bloub recall hook <<<'

/** Profilpfade (CurrentUserAllHosts) fuer Windows PowerShell 5.1 UND PowerShell 7+. */
function psProfileFiles() {
  const docs = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : null
  if (!docs) return []
  return [
    path.join(docs, 'WindowsPowerShell', 'profile.ps1'),
    path.join(docs, 'PowerShell', 'profile.ps1')
  ]
}

/**
 * Erzeugt den Hook-Block. spoolDir wird LITERAL eingebettet (absoluter Pfad
 * des App-userData), $env:BLOUB_SPOOL darf ihn zur Laufzeit ueberschreiben.
 */
function psHookBlock(spoolDir) {
  const esc = String(spoolDir).replace(/'/g, "''")
  return [
    MARK_BEGIN,
    'if (-not $env:BLOUB_RECALL_OFF) {',
    `  $global:BloubRecallSpool = if ($env:BLOUB_SPOOL) { $env:BLOUB_SPOOL } else { '${esc}' }`,
    '  $global:BloubRecallLastHid = 0',
    '  $global:BloubRecallStart = [DateTimeOffset]::Now.ToUnixTimeSeconds()',
    '  $global:BloubRecallPrevPrompt = $function:prompt',
    '  function global:prompt {',
    '    try {',
    '      $h = Get-History -Count 1',
    // Id-Vergleich verhindert Doppel-Erfassung bei neu gezeichnetem Prompt
    '      if ($h -and $h.Id -gt $global:BloubRecallLastHid) {',
    '        $exit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { $null }',
    '        $durMs = 0',
    '        try { $durMs = [int](New-TimeSpan $h.StartExecutionTime $h.EndExecutionTime).TotalMilliseconds } catch {}',
    // Mehrzeilige Befehle -> U+2424, damit die JSONL-Zeile intakt bleibt
    '        $cmdLine = ($h.CommandLine -replace "(\\r?\\n)", [string][char]0x2424)',
    '        $spoolFile = Join-Path $global:BloubRecallSpool ("pwsh-{0}-{1}.jsonl" -f $PID, $global:BloubRecallStart)',
    '        $rec = @{',
    "          v = 1; host = 'pwsh'; pid = $PID",
    '          ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()',
    '          cmd = $cmdLine; cwd = (Get-Location).Path',
    '          exit = $exit; durMs = $durMs',
    '        } | ConvertTo-Json -Compress',
    '        New-Item -ItemType Directory -Force -Path $global:BloubRecallSpool | Out-Null',
    '        Add-Content -LiteralPath $spoolFile -Value $rec -Encoding UTF8 -ErrorAction Stop',
    '        $global:BloubRecallLastHid = $h.Id',
    '      }',
    '    } catch {',
    // Ein kaputter Hook darf NIEMALS die Shell brechen
    '    }',
    '    if ($global:BloubRecallPrevPrompt) { return (& $global:BloubRecallPrevPrompt) }',
    '    "PS $($executionContext.SessionState.Path.CurrentLocation)> "',
    '  }',
    '}',
    MARK_END,
    ''
  ].join('\n')
}

function readProfile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function hasMarker(text) {
  return text.includes(MARK_BEGIN)
}

/** Installiert den Hook idempotent in beide Profile. */
function psInstall(spoolDir) {
  const results = []
  const block = psHookBlock(spoolDir)
  for (const file of psProfileFiles()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      let content = readProfile(file)
      if (hasMarker(content)) {
        // Bestehenden Block durch aktuellen ersetzen (Updates des Hooks)
        const begin = content.indexOf(MARK_BEGIN)
        const end = content.indexOf(MARK_END)
        if (begin !== -1 && end !== -1) {
          content = content.slice(0, begin) + block + content.slice(end + MARK_END.length + 1)
        }
        fs.writeFileSync(file, content, 'utf8')
        results.push({ file, changed: true, replaced: true })
      } else {
        fs.appendFileSync(file, (content && !content.endsWith('\n') ? '\n' : '') + block, 'utf8')
        results.push({ file, changed: true, replaced: false })
      }
    } catch (err) {
      results.push({ file, changed: false, error: String(err?.message ?? err) })
    }
  }
  return results
}

/** Entfernt den Hook aus beiden Profilen (idempotent). */
function psRemove() {
  const results = []
  for (const file of psProfileFiles()) {
    const content = readProfile(file)
    if (!hasMarker(content)) {
      results.push({ file, changed: false })
      continue
    }
    const begin = content.indexOf(MARK_BEGIN)
    const end = content.indexOf(MARK_END)
    if (begin === -1 || end === -1) {
      results.push({ file, changed: false, error: 'marker truncated' })
      continue
    }
    const next = content.slice(0, begin) + content.slice(end + MARK_END.length)
    try {
      fs.writeFileSync(file, next.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n'), 'utf8')
      results.push({ file, changed: true })
    } catch (err) {
      results.push({ file, changed: false, error: String(err?.message ?? err) })
    }
  }
  return results
}

/** Status: in wievielen Profilen ist der Hook aktiv? */
function psStatus() {
  return psProfileFiles().map((file) => ({
    file,
    installed: hasMarker(readProfile(file))
  }))
}

module.exports = { MARK_BEGIN, MARK_END, psHookBlock, psInstall, psRemove, psStatus, psProfileFiles }
