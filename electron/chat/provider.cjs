// Provider-Layer: Adapter-Registry + SSE-Plumbing. Der Agent-Loop (agent.cjs)
// sieht nur die normalisierte Form — Protokoll-Details bleiben in den Adaptern
// unter chat/protocols/.
const path = require('node:path')

const ADAPTERS = {
  'openai-completions': () => require('./protocols/openai-completions.cjs'),
  'openai-responses': () => require('./protocols/openai-responses.cjs'),
  'anthropic-messages': () => require('./protocols/anthropic-messages.cjs')
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

/** Hilfsfunktion fuer abbrechbare Verzoegerung bei Retries. */
function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error('aborted'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort)
  })
}

const MAX_RETRIES = 5

/**
 * Führt einen Streaming-Chat-Turn aus und ruft `onEvent` mit normalisierten
 * Events auf: { type:'token', text } | { type:'tool_call', id, name, argsJson }
 * | { type:'done', usage? }.
 *
 * Wiederholt bei Fehlern bis zu 5 Mal mit exponentiellem Backoff (1s, 2s, 4s, 8s, 16s).
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

  let attempt = 0
  let lastError = ''

  while (attempt <= MAX_RETRIES) {
    if (signal?.aborted) return

    let res
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
        signal
      })
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) return
      lastError = err?.message || String(err)
      attempt++
      if (attempt <= MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000) + Math.floor(Math.random() * 300)
        onEvent({
          type: 'status',
          text: `Connection failed (${lastError}). Retrying (${attempt}/${MAX_RETRIES}) in ${(delay / 1000).toFixed(1)}s …`
        })
        try {
          await sleepWithSignal(delay, signal)
        } catch {
          return
        }
        continue
      }
      onEvent({ type: 'error', message: `Request failed after ${MAX_RETRIES} retries: ${lastError}` })
      return
    }

    if (!res.ok || !res.body) {
      lastError = await readError(res)
      attempt++
      if (attempt <= MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000) + Math.floor(Math.random() * 300)
        onEvent({
          type: 'status',
          text: `Provider error (${lastError}). Retrying (${attempt}/${MAX_RETRIES}) in ${(delay / 1000).toFixed(1)}s …`
        })
        try {
          await sleepWithSignal(delay, signal)
        } catch {
          return
        }
        continue
      }
      onEvent({ type: 'error', message: lastError })
      return
    }

    let receivedTokens = false
    try {
      for await (const ev of adapter.parseStream(sseData(res.body))) {
        if (ev.type === 'token' || ev.type === 'tool_call') {
          receivedTokens = true
        }
        onEvent(ev)
        if (ev.type === 'done' || ev.type === 'error') break
      }
      return
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) return
      lastError = `stream failed: ${err?.message || err}`
      if (!receivedTokens) {
        attempt++
        if (attempt <= MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000) + Math.floor(Math.random() * 300)
          onEvent({
            type: 'status',
            text: `Stream interrupted. Retrying (${attempt}/${MAX_RETRIES}) in ${(delay / 1000).toFixed(1)}s …`
          })
          try {
            await sleepWithSignal(delay, signal)
          } catch {
            return
          }
          continue
        }
      }
      onEvent({ type: 'error', message: lastError })
      return
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
