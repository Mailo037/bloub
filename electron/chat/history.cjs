// Verstecktes Konversations-Gedaechtnis: append-only JSONL, ein Record pro
// Nachricht. Absturz-sicher: append pro Zeile; eine zerrissene letzte
// Zeile wird beim Laden ignoriert.
const fs = require('node:fs')
const path = require('node:path')

function historyFile(userData) {
  return path.join(userData, 'chat-history.jsonl')
}

/** Haengt einen Record an und speichert sofort (Crash-sicher). */
function appendRecord(userData, record) {
  const line = JSON.stringify({ ...record, ts: Date.now() })
  try {
    fs.mkdirSync(userData, { recursive: true })
    fs.appendFileSync(historyFile(userData), line + '\n', 'utf8')
  } catch (err) {
    console.error('[history] failed to append record:', err)
  }
}

/**
 * Laedt die letzten `maxRecords` Records; eine unvollstaendige letzte Zeile
 * (kein abschliessender Newline / kein gueltiges JSON) wird verworfen.
 */
function loadRecords(userData, maxRecords) {
  let raw = ''
  try {
    raw = fs.readFileSync(historyFile(userData), 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  const out = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* einzelne kaputte Zeile ueberspringen */
    }
  }
  return maxRecords ? out.slice(-maxRecords) : out
}

/** Archiviert die Datei und startet neu — nichts wird still zerstoert. */
function archiveAndClear(userData) {
  const file = historyFile(userData)
  try {
    if (fs.existsSync(file)) {
      const target = path.join(userData, `chat-history.archived-${Date.now()}.jsonl`)
      fs.renameSync(file, target)
      return target
    }
  } catch {
    return null
  }
  return null
}

function close() {}

module.exports = { appendRecord, loadRecords, archiveAndClear, close, historyFile }
