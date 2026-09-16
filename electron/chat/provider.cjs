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
  try {
    if (await require('./model-catalog.cjs').stream(cfg, normalizedRequest, signal, onEvent)) return
  } catch (error) { onEvent({ type: 'error', message: error.message }); return }
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
  if (!cfg?.baseUrl || !cfg.baseUrl.trim()) {
    return { ok: false, error: 'Base URL is required' }
  }
  if (!cfg?.model || !cfg.model.trim()) {
    return { ok: false, error: 'Model name is required' }
  }
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

/** Bereinigt Titel: maximal fünf Wörter, keine Anführungszeichen oder Satzzeichen am Ende. */
function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return null
  let t = raw.trim()
  t = t.replace(/^(Title|Titel)\s*:\s*/i, '')
  t = t.replace(/^["'`“«\s]+|["'`”»\s]+$/g, '')
  t = t.replace(/[#*_`]/g, '')
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const capped = words.slice(0, 5).join(' ')
  return capped.replace(/[.,:;!?]+$/, '').trim()
}

/** Lokaler Fallback-Titel aus der ersten User-Nachricht (maximal fünf Wörter). */
function localFallbackTitle(text) {
  if (!text || typeof text !== 'string') return 'New Chat'
  let cleaned = text.replace(/^[#*_`>\-\s"']+|[#*_`>\-\s"'.]+$/g, '').trim()
  cleaned = cleaned.replace(/[#*_`\r\n]/g, ' ')
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5)
  if (words.length === 0) return 'New Chat'
  const title = words.join(' ')
  return title.length > 40 ? title.slice(0, 37) + '…' : title
}

/**
 * Erzeugt einen kurzen Konversationstitel (maximal 5 Wörter) über den konfigurierten Provider.
 * Nutzt ein knappes Token-Budget (16) und fällt bei Fehlern auf null zurück.
 */
async function requestTitle(cfg, userText) {
  if (!cfg?.baseUrl || !userText || typeof userText !== 'string') return null
  const adapter = getAdapter(cfg.protocol)
  if (!adapter) return null

  const sample = userText.trim().slice(0, 400)
  const normalizedReq = {
    system: 'You generate a short conversation title of at most 5 words. Output ONLY the title words, no quotes, no explanation, no period at the end.',
    messages: [
      {
        role: 'user',
        content: `Generate a brief title (at most 5 words) for this request: "${sample}"`
      }
    ],
    tools: [],
    maxTokens: 16
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 7000)
  try {
    let accumulated = ''
    await streamChat(cfg, normalizedReq, ac.signal, (ev) => {
      if (ev.type === 'token' && typeof ev.text === 'string') {
        accumulated += ev.text
      }
    })
    clearTimeout(timer)
    return cleanTitle(accumulated)
  } catch {
    clearTimeout(timer)
    return null
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

module.exports = {
  getAdapter,
  streamChat,
  pingProvider,
  guessProtocol,
  requestTitle,
  cleanTitle,
  localFallbackTitle,
  protocolsPath: path.join(__dirname, 'protocols')
}
