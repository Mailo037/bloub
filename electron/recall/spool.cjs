// Activity Recall — Spool-Tailer (Phase 2).
// Ueberwacht <userData>/recall-spool/*.jsonl alle ~2 s: vollstaendige Zeilen
// (mit \n abgeschlossen) werden geparst, normalisiert und in den Event-Store
// uebernommen, danach aus der Spool-Datei entfernt. Eine unvollstaendige
// letzte Zeile bleibt liegen, bis sie komplett ist.
// Producer sind die Shell-Hooks (pwsh via Profil-Prompt-Wrap, bash via
// PROMPT_COMMAND) — die Zeilenform ist der Spool-Kontrakt:
//   {"v":1,"host":"pwsh|bash","pid":N,"ts":ms,"cmd":"...","cwd":"...","exit":N|null,"durMs":N}

const fs = require('node:fs')
const path = require('node:path')
const store = require('./store.cjs')

function spoolDir(userData) {
  return path.join(userData, 'recall-spool')
}

/** Host-Feld des Kontrakts -> kanonischer App-Name im Event. */
function hostToApp(host) {
  const h = String(host || '').toLowerCase()
  if (h === 'pwsh' || h === 'powershell') return 'PowerShell'
  if (h === 'bash') return 'bash'
  if (h === 'zsh') return 'zsh'
  return h || 'shell'
}

/**
 * Wandelt eine geparste Spool-Zeile in ein normalisiertes Roh-Event um.
 * Kein Keylogger-Detail: nur die akzeptierte Kommandozeile plus Kontext.
 */
function spoolLineToEvent(rec, srcFile) {
  if (!rec || typeof rec !== 'object') return null
  const cmd = typeof rec.cmd === 'string' ? rec.cmd : ''
  if (!cmd.trim()) return null
  return {
    ts: Number(rec.ts) || Date.now(),
    source: 'shell',
    app: hostToApp(rec.host),
    // Titel: cwd als Kontext — das Fenster-Titel-Rauschen ist hier weniger
    // nuetzlich als der Ort, wo das Kommando lief.
    title: String(rec.cwd ?? ''),
    kind: 'command',
    text: cmd,
    detail: {
      exitCode: rec.exit === null || rec.exit === undefined ? null : Number(rec.exit),
      cwd: String(rec.cwd ?? ''),
      durMs: Number.isFinite(Number(rec.durMs)) ? Number(rec.durMs) : null,
      pid: Number(rec.pid) || null,
      spool: path.basename(srcFile)
    }
  }
}

/**
 * Ein Ticker-Durchlauf: liest alle Spool-Dateien, extrahiert komplette
 * Zeilen und stuetzt die Dateien auf den Rest (unvollstaendige Tail-Zeile)
 * zusammen. Gibt die Anzahl uebernommener Events zurueck.
 */
function drainOnce(userData) {
  const dir = spoolDir(userData)
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { consumed: 0 }
  }
  let consumed = 0
  for (const f of files) {
    const full = path.join(dir, f)
    let raw = ''
    try {
      raw = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const lastNewline = raw.lastIndexOf('\n')
    if (lastNewline === -1) continue // noch keine komplette Zeile
    const complete = raw.slice(0, lastNewline + 1)
    const rest = raw.slice(lastNewline + 1)
    const events = []
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = spoolLineToEvent(JSON.parse(line), f)
        if (ev) events.push(ev)
      } catch {
        /* kaputte Zeile verwerfen — Spool ist Wegwerf-Medium */
      }
    }
    try {
      if (events.length > 0) store.appendEvents(userData, events)
      // Konsumierte Bytes abschneiden; unvollstaendige Restzeile bleibt.
      fs.writeFileSync(full, rest, 'utf8')
      consumed += events.length
    } catch {
      /* naechster Tick versucht es erneut */
    }
  }
  return { consumed }
}

/** Startet den 2-s-Tail-Timer. stop() gibt den Timer frei. */
function startTailer(userData, intervalMs = 2000) {
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    try {
      drainOnce(userData)
    } finally {
      busy = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}

module.exports = { spoolDir, spoolLineToEvent, drainOnce, startTailer, hostToApp }
