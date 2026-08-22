// Provider-Layer: Adapter-Registry + SSE-Plumbing. Der Agent-Loop (agent.cjs)
// sieht nur die normalisierte Form — Protokoll-Details bleiben in den Adaptern
// unter chat/protocols/.
const path = require('node:path')

const ADAPTERS = {
  'openai-completions': () => require('./protocols/openai-completions'),
  'openai-responses': () => require('./protocols/openai-responses'),
  'anthropic-messages': () => require('./protocols/anthropic-messages')
}

function getAdapter(protocol) {
  const load = ADAPTERS[protocol]
  if (!load) return null
  try {
    return load()
  } catch {
    return null
  }
}

/**
 * Zerlegt einen Node-Read-Stream in SSE-Events. Liefert pro Event das
 * zusammengefasste `data`-Feld (mehrzeilige data:-Zeilen mit \n verbunden).
 * Kommentare (`:`-Präfix) und `event:`/`id:`-Zeilen werden ignoriert.
 */
async function* sseData(body) {
  let buf = ''
  const decoder = new TextDecoder()
  let dataLines = []
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line === '') {
        // Leerzeile = Event-Grenze
        if (dataLines.length > 0) yield dataLines.join('\n')
        dataLines = []
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
      // event:/id:/retry/ und Kommentarzeilen interessieren nicht
    }
  }
  if (dataLines.length > 0) yield dataLines.join('\n')
}

/** Einheitlicher Fehler-Text aus einem nicht-OK-Response. */
async function readError(res) {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(detail)
    if (j.error?.message) return j.error.message
    if (j.message) return j.message
    if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
  } catch {
    /* kein JSON */
  }
  return detail ? `${res.status} ${res.statusText}: ${detail.slice(0, 500)}` : `${res.status} ${res.statusText}`
}

/**
 * Führt einen Streaming-Chat-Turn aus und ruft `onEvent` mit normalisierten
 * Events auf: { type:'token', text } | { type:'tool_call', id, name, argsJson }
 * | { type:'done', usage? }. Wirft nie für Provider-Fehler — stattdessen kommt
 * { type:'error', message } als letztes Event.
 */
async function streamChat(cfg, normalizedRequest, signal, onEvent) {
  const adapter = getAdapter(cfg.protocol)
  if (!adapter) {
    onEvent({ type: 'error', message: `unknown protocol: ${cfg.protocol}` })
    return
  }
  let req
  try {
    req = adapter.buildRequest(normalizedRequest, cfg)
  } catch (err) {
    onEvent({ type: 'error', message: err?.message || String(err) })
    return
  }
  let res
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...req.headers },
      body: JSON.stringify(req.body),
      signal
    })
  } catch (err) {
    onEvent({ type: 'error', message: err?.name === 'AbortError' ? 'aborted' : `request failed: ${err?.message || err}` })
    return
  }
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', message: await readError(res) })
    return
  }
  try {
    for await (const ev of adapter.parseStream(sseData(res.body))) {
      onEvent(ev)
      if (ev.type === 'done' || ev.type === 'error') break
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      onEvent({ type: 'error', message: `stream failed: ${err?.message || err}` })
    }
  }
}

/** 1-Token-Ping für den Settings-Test-Button; liefert ok:true oder den Fehler wörtlich. */
async function pingProvider(cfg) {
  const adapter = getAdapter(cfg.protocol)
  if (!adapter) return { ok: false, error: `unknown protocol: ${cfg.protocol}` }
  const req = adapter.pingRequest(cfg)
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...req.headers },
      body: JSON.stringify(req.body)
    })
    if (!res.ok) return { ok: false, error: await readError(res) }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * Protokoll-Vermutung nach Host — nur Vorschlag, die Dropdown-Auswahl gewinnt.
 */
function guessProtocol(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'api.anthropic.com') return 'anthropic-messages'
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'openai-completions'
    if (host.endsWith('.localhost')) return 'openai-completions'
  } catch {
    /* keine gültige URL */
  }
  return null
}

module.exports = { getAdapter, streamChat, pingProvider, guessProtocol, protocolsPath: path.join(__dirname, 'protocols') }
