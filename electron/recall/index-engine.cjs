// Activity Recall — Batch-Indexer + Inverted-Index-Query-Engine (Phase 4).
//
// Bewusste Entscheidung (Spec §3): KEIN SQLite/better-sqlite3 — native
// Abhaengigkeiten sind verboten. Stattdessen ein schlichter, ehrlicher Index:
//   - Stundenshards <index>/shards/<yyyymmddhh>.jsonl.gz (UTC-Stunde des ts).
//     Gzip-Anhang-Trick: zlib.gzipSync(chunk) erzeugt EIN gzip-Member;
//     aneinandergehaengte Member sind ein gueltiges Multi-Member-Gzip und
//     werden von zlib.gunzipSync vollstaendig zurueckgelesen.
//   - Beim ERSTEN Query pro Session wird der Index im RAM aufgebaut:
//     term -> [eventIdx], hartes Limit 200k Terme mit LRU-Verdrängung.
//   - Retention-Purge during indexing: alte Shardstunden werden als Datei
//     geloescht, events.jsonl entsprechend beschnitten.
// Personal-Scale (~100k Events/Monat) ist das locker; SQLite bleibt die
// dokumentierte Upgrade-Pfad-Option, falls der User eine native Dep freigibt.

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const store = require('./store.cjs')

const MAX_TERMS = 200_000
const STATE_VERSION = 1

function recallRoot(userData) {
  return path.join(userData, 'recall')
}
function indexRoot(userData) {
  return path.join(userData, 'recall', 'index')
}
function shardsRoot(userData) {
  return path.join(userData, 'recall', 'index', 'shards')
}

/** UTC-Stunden-Bucket "yyyymmddhh" fuer einen ms-Timestamp. */
function hourBucket(ts) {
  const d = new Date(ts)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`
}

/** Bucket-String zurueck nach ms (Stundenanfang, UTC). */
function bucketToTs(bucket) {
  const y = +bucket.slice(0, 4)
  const mo = +bucket.slice(4, 6) - 1
  const d = +bucket.slice(6, 8)
  const h = +bucket.slice(8, 10)
  return Date.UTC(y, mo, d, h)
}

/**
 * Tokenisierung fuer den Index: Kleinbuchstaben, alphanumerische Laeufe,
 * Laenge 2..40, dedupliziert. Läuft ueber text+title+app zusammen.
 */
function tokenize(...parts) {
  const out = new Set()
  for (const part of parts) {
    const s = String(part ?? '').toLowerCase()
    if (!s) continue
    for (const m of s.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}/gu)) {
      const t = m[0]
      if (t.length >= 2) out.add(t.replace(/[-_]+$/, ''))
    }
  }
  return [...out]
}

/* ------------------------------------------------------------- indexing */

function readState(userData) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(indexRoot(userData), 'state.json'), 'utf8'))
    if (st?.v === STATE_VERSION && Number.isFinite(st.offset)) return st
  } catch {
    /* neu anfangen */
  }
  return { v: STATE_VERSION, offset: 0 }
}

function writeState(userData, state) {
  fs.mkdirSync(indexRoot(userData), { recursive: true })
  fs.writeFileSync(path.join(indexRoot(userData), 'state.json'), JSON.stringify(state), 'utf8')
}

/**
 * Ein Indexier-Durchlauf: neue Events (ab committed Offset) in die
 * Stundenshards falten, Retention ausfuehren, Offset committen.
 */
function indexEvents({ userData, retentionDays = 14 }) {
  const eventsFile = store.eventsFile(userData)
  let raw = ''
  try {
    raw = fs.readFileSync(eventsFile, 'utf8')
  } catch {
    return { indexed: 0, purgedShards: 0, purgedBytes: 0, errors: [] }
  }
  const state = readState(userData)
  const errors = []

  // Nur komplette Zeilen verarbeiten (torn tail bleibt liegen).
  const lastNewline = raw.lastIndexOf('\n')
  const safeEnd = lastNewline === -1 ? 0 : lastNewline + 1
  const pending = raw.slice(state.offset, safeEnd)

  // Nach Zeilen gruppieren, dabei Offset fortschreiben
  const byBucket = new Map()
  let consumed = state.offset
  for (const line of pending.split('\n')) {
    consumed += Buffer.byteLength(line, 'utf8') + 1 // + \n
    if (!line.trim()) continue
    try {
      const ev = store.normalizeEvent(JSON.parse(line))
      if (!ev) continue
      const b = hourBucket(ev.ts)
      if (!byBucket.has(b)) byBucket.set(b, [])
      byBucket.get(b).push(JSON.stringify(ev))
    } catch {
      errors.push('invalid event line skipped')
    }
  }

  fs.mkdirSync(shardsRoot(userData), { recursive: true })
  for (const [bucket, lines] of byBucket) {
    try {
      const chunk = Buffer.from(lines.join('\n') + '\n', 'utf8')
      fs.appendFileSync(path.join(shardsRoot(userData), `${bucket}.jsonl.gz`), zlib.gzipSync(chunk))
    } catch (err) {
      errors.push(`shard ${bucket}: ${err?.message ?? err}`)
    }
  }

  // Offset NACH erfolgreichem Shard-Schreiben committen
  writeState(userData, { v: STATE_VERSION, offset: consumed })

  // ---- Retention ----
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
  let purgedShards = 0
  let purgedBytes = 0
  try {
    for (const f of fs.readdirSync(shardsRoot(userData))) {
      const m = f.match(/^(\d{10})\.jsonl\.gz$/)
      if (!m) continue
      if (bucketToTs(m[1]) < cutoff) {
        const full = path.join(shardsRoot(userData), f)
        purgedBytes += fs.statSync(full).size
        fs.rmSync(full, { force: true })
        purgedShards++
      }
    }
  } catch {
    /* best effort */
  }

  // events.jsonl selbst beschneiden, wenn alte Zeilen drin sind
  let trimmedFile = false
  try {
    const keep = []
    let anyOld = false
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const ts = JSON.parse(line).ts
        if (ts >= cutoff) keep.push(line)
        else anyOld = true
      } catch {
        /* unlesbare Zeile faellt beim Naechsten Purg raus */
      }
    }
    if (anyOld) {
      fs.writeFileSync(eventsFile, keep.length ? keep.join('\n') + '\n' : '', 'utf8')
      // Offset auf die neue Dateilaenge setzen (alles Alte ist weg)
      const fresh = fs.readFileSync(eventsFile, 'utf8')
      writeState(userData, { v: STATE_VERSION, offset: Buffer.byteLength(fresh, 'utf8') })
      trimmedFile = true
    }
  } catch {
    /* best effort */
  }

  return { indexed: [...byBucket.values()].reduce((n, l) => n + l.length, 0), purgedShards, purgedBytes, trimmedFile, errors }
}

/* -------------------------------------------------------------- querying */

/**
 * Query-Engine mit traegem, im RAM gehaltenem Index.
 * Ein Engine-Exemplar pro App-Session; nach jedem indexEvents()-Lauf
 * invalidate() rufen.
 */
function createQueryEngine(userData) {
  let events = null // aufsteigend nach ts
  let postings = null // Map<term, number[]> (Indizes in events)
  let lruKeys = null // Einfuege-Reihenfolge fuer LRU-Eviction

  function ensureBuilt({ from, to } = {}) {
    if (events) return
    events = []
    postings = new Map()
    lruKeys = new Set()

    let files = []
    try {
      files = fs.readdirSync(shardsRoot(userData)).filter((f) => f.endsWith('.jsonl.gz'))
    } catch {
      return
    }
    // Nur Shards lesen, die das Zeitfenster ueberlappen koennen
    if (from !== undefined || to !== undefined) {
      const lo = from !== undefined ? hourBucket(Math.max(0, from - 3600_000)) : null
      const hi = to !== undefined ? hourBucket(to + 3600_000) : null
      files = files.filter((f) => {
        const b = f.slice(0, 10)
        if (lo && b < lo) return false
        if (hi && b > hi) return false
        return true
      })
    }
    files.sort() // Bucket-Reihenfolge == Zeit-Reihenfolge

    for (const f of files) {
      let text = ''
      try {
        text = zlib.gunzipSync(fs.readFileSync(path.join(shardsRoot(userData), f))).toString('utf8')
      } catch {
        continue // korrupter Shard: skip, nicht abbrechen
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (events.length >= 500_000) break // harte Obergrenze fuer den RAM-Index
        const idx = events.length
        events.push(ev)
        for (const term of tokenize(ev.text, ev.title, ev.app)) {
          let list = postings.get(term)
          if (!list) {
            if (postings.size >= MAX_TERMS) {
              // LRU: aeltesten (insertion-order ersten) Term verdraengen
              const oldest = lruKeys.values().next().value
              if (oldest !== undefined) {
                postings.delete(oldest)
                lruKeys.delete(oldest)
              }
            }
            list = []
            postings.set(term, list)
            lruKeys.add(term)
          }
          if (list.length === 0 || list[list.length - 1] !== idx) list.push(idx)
        }
      }
    }
  }

  /** Term-Match mit Praefix-Toleranz: exakt ODER Token beginnt mit Term. */
  function eventMatchesTerm(ev, term) {
    for (const tok of tokenize(ev.text, ev.title, ev.app)) {
      if (tok === term || tok.startsWith(term)) return true
    }
    return false
  }

  /**
   * Suche. query darf leer sein (Zeitfenster-Browse). from/to inklusive,
   * source/kind optional als Filter. Newest-first. Rueckgabe:
   * { rows, truncated }.
   */
  function search({ query = '', from, to, source, kind, site, limit = 50 } = {}) {
    ensureBuilt({ from, to })
    if (!events || events.length === 0) return { rows: [], truncated: false }

    // Kandidaten: Zeitfenster via Binaersuche eingrenzen
    let lo = 0
    let hi = events.length
    if (from !== undefined) lo = lowerBound(from)
    if (to !== undefined) hi = upperBound(to)

    const terms = tokenize(query)

    /** Filter + Zeilen sammeln ueber einen Index-Bereich (rueckwaerts). */
    function collect(indexes) {
      const out = []
      let matched = 0
      for (const i of indexes) {
        const ev = events[i]
        if (source && ev.source !== source) continue
        if (kind && ev.kind !== kind) continue
        if (site) {
          const host = String(ev.detail?.url ? safeHost(ev.detail.url) : (ev.app ?? '')).toLowerCase()
          if (!host.includes(String(site).toLowerCase())) continue
        }
        matched++
        if (out.length < limit) out.push(ev)
      }
      return { rows: out, truncated: matched > out.length }
    }

    if (terms.length === 0) {
      // Zeitfenster-Browse ohne Query: alles im Bereich, newest-first.
      const idxs = []
      for (let i = hi - 1; i >= lo; i--) idxs.push(i)
      return collect(idxs)
    }

    // Fast path: Schnittmenge der exakten Posting-Listen (AND-Semantik).
    const lists = terms.map((t) => postings.get(t) ?? null)
    if (lists.every(Boolean) && lists.length > 0) {
      lists.sort((a, b) => a.length - b.length)
      const base = new Set(lists[0])
      for (let i = 1; i < lists.length && base.size > 0; i++) {
        const keep = new Set()
        for (const idx of lists[i]) if (base.has(idx)) keep.add(idx)
        base.clear()
        for (const idx of keep) base.add(idx)
      }
      if (base.size > 0) {
        const idxs = [...base].sort((a, b) => b - a)
        const res = collect(idxs)
        if (res.rows.length > 0 || res.truncated) return res
      }
    }

    // Fallback (nur wenn Fast Path nichts fand): Linear-Scan im Zeitfenster
    // mit Praefix-Matching ("git" trifft auch "github").
    const idxs = []
    for (let i = hi - 1; i >= lo; i--) {
      const ev = events[i]
      if (terms.every((t) => eventMatchesTerm(ev, t))) idxs.push(i)
    }
    return collect(idxs)
  }

  function lowerBound(ts) {
    let a = 0
    let b = events.length
    while (a < b) {
      const mid = (a + b) >> 1
      if (events[mid].ts < ts) a = mid + 1
      else b = mid
    }
    return a
  }
  function upperBound(ts) {
    let a = 0
    let b = events.length
    while (a < b) {
      const mid = (a + b) >> 1
      if (events[mid].ts <= ts) a = mid + 1
      else b = mid
    }
    return a
  }

  function safeHost(url) {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }

  /** RAM-Index verwerfen (nach neuem indexEvents-Laufen). */
  function invalidate() {
    events = null
    postings = null
    lruKeys = null
  }

  return { search, invalidate, isBuilt: () => !!events }
}

module.exports = { tokenize, indexEvents, createQueryEngine, hourBucket }
