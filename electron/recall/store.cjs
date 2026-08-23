// Activity Recall — Event-Store (Phase 1).
// Append-only JSONL unter <userData>/recall/events.jsonl, eine Zeile pro
// Event. Gleiche Haltbarkeitsregeln wie der Chat-Verlauf: Flush pro Zeile,
// zerrissene letzte Zeile wird beim Laden ignoriert.
// Kein Producer schreibt hier direkt: alle Events laufen durch normalizeEvent,
// damit das Schema garantiert einheitlich bleibt (siehe docs/recall spec §1).

const fs = require('node:fs')
const path = require('node:path')

const SOURCES = new Set(['shell', 'app', 'browser', 'clipboard'])
const KINDS = new Set(['command', 'focus', 'action'])
const MAX_TEXT = 4000
const MAX_TITLE = 500
const MAX_DETAIL_JSON = 8000

function eventsFile(userData) {
  return path.join(userData, 'recall', 'events.jsonl')
}

/**
 * Normalisiert ein Roh-Event eines Producers auf das kanonische Schema:
 * { ts, source, app, title, kind, text, detail }. Gibt null zurueck bei
 * unbrauchbaren Events (fehlender ts/source/kind) — nie werfen.
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ts = Number(raw.ts)
  if (!Number.isFinite(ts) || ts <= 0) return null
  const source = String(raw.source ?? '')
  const kind = String(raw.kind ?? '')
  if (!SOURCES.has(source) || !KINDS.has(kind)) return null
  const detailSrc = raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail) ? raw.detail : {}
  // Detail klein halten: ein Event ist eine Zeile, keine Akte.
  let detail = detailSrc
  try {
    if (JSON.stringify(detail).length > MAX_DETAIL_JSON) {
      detail = { truncated: true }
    }
  } catch {
    detail = {}
  }
  return {
    ts: Math.round(ts),
    source,
    app: String(raw.app ?? '').slice(0, MAX_TITLE),
    title: String(raw.title ?? '').slice(0, MAX_TITLE),
    kind,
    text: String(raw.text ?? '').slice(0, MAX_TEXT),
    detail
  }
}

/** Haengt ein normalisiertes Event an (Crash-sicher, flush pro Zeile). */
function appendEvent(userData, raw) {
  const ev = normalizeEvent(raw)
  if (!ev) return null
  const file = eventsFile(userData)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8')
  return ev
}

/** Mehrere Events auf einmal (Spool-Tailer / Browser-Link). */
function appendEvents(userData, raws) {
  const out = []
  const file = eventsFile(userData)
  if (!raws?.length) return out
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let buf = ''
  for (const raw of raws) {
    const ev = normalizeEvent(raw)
    if (!ev) continue
    out.push(ev)
    buf += JSON.stringify(ev) + '\n'
  }
  if (buf) fs.appendFileSync(file, buf, 'utf8')
  return out
}

/**
 * Laedt Events im Zeitfenster [from, to] (ms, inklusive), newest-first,
 * max `limit`. Eine zerrissene/ungueltige Zeile wird uebersprungen.
 * Fuer persoenliche Datenmengen (~100k Zeilen/Monat) reicht sequentielles
 * Lesen; die Tools nutzen bevorzugt den Index, das hier ist der Fallback.
 */
function loadEvents(userData, { from = 0, to = Infinity, limit = 200 } = {}) {
  let raw = ''
  try {
    raw = fs.readFileSync(eventsFile(userData), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (let i = raw.length - 1; i >= 0; ) {
    if (out.length >= limit) break
    const end = raw.lastIndexOf('\n', i - 1)
    const lineStart = end + 1
    const line = raw.slice(lineStart, i)
    i = lineStart - 1
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev.ts >= from && ev.ts <= to) out.push(ev)
    } catch {
      /* kaputte Zeile ueberspringen */
    }
  }
  return out
}

/** Grobstatistik fuer die Settings-Anzeige. */
function storeStats(userData) {
  const file = eventsFile(userData)
  let bytes = 0
  let lines = 0
  let oldestTs = null
  let newestTs = null
  try {
    const st = fs.statSync(file)
    bytes = st.size
    const raw = fs.readFileSync(file, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      lines++
      try {
        const ts = JSON.parse(line).ts
        if (oldestTs === null || ts < oldestTs) oldestTs = ts
        if (newestTs === null || ts > newestTs) newestTs = ts
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* kein Store vorhanden */
  }
  return { bytes, lines, oldestTs, newestTs }
}

/** Loescht ALLES (Store + Spool + Index). Rueckgabe: freigegebene Bytes grob. */
function purgeEverything(userData) {
  const root = path.join(userData, 'recall')
  let freed = 0
  try {
    freed = dirSize(root)
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  return freed
}

function dirSize(dir) {
  let total = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += dirSize(p)
    else {
      try {
        total += fs.statSync(p).size
      } catch {
        /* ignore */
      }
    }
  }
  return total
}

module.exports = {
  eventsFile,
  normalizeEvent,
  appendEvent,
  appendEvents,
  loadEvents,
  storeStats,
  purgeEverything
}
