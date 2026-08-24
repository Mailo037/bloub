// Gemini-Audio-Engine (separat vom Chat-Provider).
// Sprache->Text (STT) und Text->Sprache (TTS) ueber die Gemini-API.
// Diese Engine ist bewusst unabhaengig vom Chat-Provider, damit jeder
// seinen eigenen Chat-Provider nutzen kann und Gemini nur fuer Audio zustaendig ist.

/**
 * TTS-Modell: gemini-3.1-flash-tts-preview
 *   - generateContent mit AUDIO-Output + speechConfig.voiceConfig
 *   - Standard-Stimme: "Kore" (weiblich, englisch)
 *   - Alternative: "Puck" (maennlich)
 *
 * STT-Modell: gemini-3.6-flash (oder jedes Flash-Modell mit Audio-Input)
 *   - generateContent mit TEXT-Output, Audio als inlineData.
 *
 * Live-Modelle (gemini-*-live-preview) sind NICHT fuer generateContent
 * geeignet — sie brauchen die Live-API (WebSocket) und werden hier abgelehnt.
 */

const TTS_MODEL = 'gemini-3.1-flash-tts-preview'
const STT_MODEL = 'gemini-3.6-flash'
const LIVE_RE = /gemini-.*-live(-preview)?$/
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const REQUEST_TIMEOUT_MS = 45000

function isLiveModel(model) {
  return LIVE_RE.test(String(model || ''))
}

/** Nachricht fuer Live-Modell-Fehler bei generateContent. */
function liveModelError(model) {
  return (
    `"${model}" is a Live-API model (WebSocket) and does not support the ` +
    `generateContent endpoint used here. Use the TTS/STT models for speech-to-text ` +
    `and text-to-speech; the Live model is reserved for realtime sessions.`
  )
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Kurze Provider-Aussetzer einmal wiederholen; Preview-TTS liefert selten sporadische 500er. */
async function postJson(url, body, attempts = 2) {
  let lastError = ''
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      lastError = err?.name === 'TimeoutError' ? 'audio request timed out' : (err?.message || String(err))
      if (attempt + 1 < attempts) {
        await wait(350 * (attempt + 1))
        continue
      }
      return { ok: false, error: lastError }
    }
    if (res.ok) return { ok: true, response: res }

    let detail = ''
    try {
      const j = await res.json()
      detail = j?.error?.message || j?.message || ''
    } catch { /* ignore */ }
    lastError = detail || `${res.status} ${res.statusText}`
    if (!RETRYABLE_STATUS.has(res.status) || attempt + 1 >= attempts) {
      return { ok: false, error: lastError }
    }
    await wait(350 * (attempt + 1))
  }
  return { ok: false, error: lastError || 'audio request failed' }
}

/** Gemini-TTS liefert PCM/L16 ohne WAV-Header. Chromium kann erst den WAV-Container decodieren. */
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44)
  const blockAlign = channels * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function normaliseGeneratedAudio(audio, mime) {
  const rawMime = String(mime || '').toLowerCase()
  if (!rawMime.startsWith('audio/l16') && !rawMime.startsWith('audio/pcm')) {
    return { audio, mime: mime || 'audio/wav' }
  }
  const rate = Number(rawMime.match(/rate=(\d+)/)?.[1]) || 24000
  const channels = Number(rawMime.match(/channels=(\d+)/)?.[1]) || 1
  return { audio: pcmToWav(audio, rate, channels), mime: 'audio/wav' }
}

function buildSpeechPrompt(text) {
  return [
    'Synthesize speech from the transcript below. Speak only the transcript, never the headings or instructions.',
    '### DIRECTOR\'S NOTES',
    'Style: warm, friendly, natural desktop companion with a subtle vocal smile.',
    'Pacing: conversational and clear, with short natural pauses.',
    '### TRANSCRIPT',
    text
  ].join('\n')
}

/** Lange Antworten an Satzgrenzen teilen, damit Stimme und Tempo stabil bleiben. */
function splitSpeechText(text, maxLength = 420) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) || [clean]
  const chunks = []
  let current = ''

  const pushPiece = (piece) => {
    const candidate = current ? `${current} ${piece}` : piece
    if (candidate.length <= maxLength) {
      current = candidate
      return
    }
    if (current) chunks.push(current)
    current = ''
    if (piece.length <= maxLength) {
      current = piece
      return
    }
    const words = piece.split(/\s+/)
    for (const word of words) {
      const next = current ? `${current} ${word}` : word
      if (next.length > maxLength && current) {
        chunks.push(current)
        current = word
      } else {
        current = next
      }
    }
  }

  for (const sentence of sentences) pushPiece(sentence.trim())
  if (current) chunks.push(current)
  return chunks.filter(Boolean)
}

function speechRequestBody(text, voice) {
  return {
    contents: [{ parts: [{ text: buildSpeechPrompt(text) }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice }
        }
      }
    }
  }
}

function parseSseEvent(rawEvent) {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  return JSON.parse(data)
}

/** Einen TTS-Abschnitt als rohe PCM-Chunks streamen. */
async function streamSpeechChunk({ apiKey, baseUrl, text, voice, signal, onChunk }) {
  const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
  const url = `${root}/models/${TTS_MODEL}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
  let res
  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(speechRequestBody(text, voice)),
      signal: requestSignal
    })
  } catch (err) {
    if (signal?.aborted) return { ok: false, cancelled: true, error: 'cancelled' }
    return { ok: false, retryable: true, error: err?.name === 'TimeoutError' ? 'audio stream timed out' : (err?.message || String(err)) }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = j?.error?.message || j?.message || ''
    } catch { /* ignore */ }
    return { ok: false, retryable: RETRYABLE_STATUS.has(res.status), error: detail || `${res.status} ${res.statusText}` }
  }
  if (!res.body) return { ok: false, error: 'audio stream unavailable' }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let audioChunks = 0
  let finishReason = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value || new Uint8Array(), { stream: !done })
      const events = pending.split(/\r?\n\r?\n/)
      pending = done ? '' : (events.pop() || '')
      for (const eventText of events) {
        const event = parseSseEvent(eventText)
        if (!event) continue
        finishReason = event?.candidates?.[0]?.finishReason || finishReason
        for (const candidate of event?.candidates || []) {
          for (const part of candidate?.content?.parts || []) {
            if (!part?.inlineData?.data) continue
            audioChunks++
            onChunk({ data: part.inlineData.data, mime: part.inlineData.mimeType || 'audio/L16; rate=24000; channels=1' })
          }
        }
      }
      if (done) break
    }
  } catch (err) {
    if (signal?.aborted) return { ok: false, cancelled: true, error: 'cancelled' }
    return { ok: false, chunks: audioChunks, error: err?.message || String(err) }
  }
  if (!audioChunks) return { ok: false, retryable: true, chunks: 0, error: 'no audio in stream' }
  if (finishReason && finishReason !== 'STOP') return { ok: false, chunks: audioChunks, error: `audio stream ended early (${finishReason})` }
  return { ok: true, chunks: audioChunks }
}

async function streamTextToSpeech({ apiKey, baseUrl, text, voice = 'Achird', signal, onChunk }) {
  if (!apiKey) return { ok: false, error: 'Gemini API key not set (Audio tab)' }
  if (!text) return { ok: false, error: 'empty text' }
  const chunks = splitSpeechText(text)
  let totalChunks = 0
  for (const chunk of chunks) {
    if (signal?.aborted) return { ok: false, cancelled: true, error: 'cancelled' }
    let result
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await streamSpeechChunk({ apiKey, baseUrl, text: chunk, voice, signal, onChunk })
      if (result.ok || result.cancelled || result.chunks || !result.retryable || attempt === 1) break
      await wait(350)
    }
    if (!result.ok) return result
    totalChunks += result.chunks || 0
  }
  return { ok: true, chunks: totalChunks, sections: chunks.length }
}

/** TTS: Text -> Audio via generateContent + speechConfig (Prebuilt-Voice). */
async function textToSpeech({ apiKey, baseUrl, text, voice = 'Kore' }) {
  if (!apiKey) return { ok: false, error: 'Gemini API key not set (Audio tab)' }
  if (!text) return { ok: false, error: 'empty text' }
  const url = `${(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models/${TTS_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = speechRequestBody(text, voice)
  const request = await postJson(url, body)
  if (!request.ok) return request
  let j
  try {
    j = await request.response.json()
  } catch {
    return { ok: false, error: 'invalid response' }
  }
  const audioPart = j?.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.mimeType && p.inlineData.mimeType.startsWith('audio')
  )
  if (!audioPart?.inlineData?.data) return { ok: false, error: 'no audio in response' }
  try {
    const normalised = normaliseGeneratedAudio(
      Buffer.from(audioPart.inlineData.data, 'base64'),
      audioPart.inlineData.mimeType
    )
    return {
      ok: true,
      audio: normalised.audio,
      mime: normalised.mime
    }
  } catch {
    return { ok: false, error: 'bad audio data' }
  }
}

/** STT: Audio -> Text via generateContent mit einem multimodalen Flash-Modell. */
async function transcribe({ apiKey, baseUrl, audioBuffer, mime }) {
  if (!apiKey) return { ok: false, error: 'Gemini API key not set (Audio tab)' }
  const url = `${(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models/${STT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = {
    contents: [{
      parts: [
        {
          text: 'Transcribe only the spoken words exactly as heard. Keep the original language and natural punctuation. Return only the transcript, with no labels, notes, translation, or markdown.'
        },
        {
          inlineData: { mimeType: mime || 'audio/wav', data: audioBuffer.toString('base64') }
        }
      ]
    }],
    generationConfig: { responseModalities: ['TEXT'], temperature: 0 }
  }
  const request = await postJson(url, body)
  if (!request.ok) return request
  let j
  try {
    j = await request.response.json()
  } catch {
    return { ok: false, error: 'invalid response' }
  }
  const text = j?.candidates?.[0]?.content?.parts?.filter((p) => typeof p.text === 'string').map((p) => p.text).join(' ').trim()
  if (!text) return { ok: false, error: 'no transcription' }
  return { ok: true, text }
}

/** Ping: Verifiziert, dass die API erreichbar ist (nutzt das TTS-Modell). */
async function ping({ apiKey, baseUrl }) {
  return textToSpeech({ apiKey, baseUrl: baseUrl || 'https://generativelanguage.googleapis.com/v1beta', text: 'ok' })
    .then((r) => ({ ok: r.ok, error: r.error }))
}

module.exports = {
  textToSpeech,
  streamTextToSpeech,
  transcribe,
  ping,
  TTS_MODEL,
  STT_MODEL,
  pcmToWav,
  normaliseGeneratedAudio,
  splitSpeechText,
  parseSseEvent,
  handleLiveModel: (model) => isLiveModel(model) ? liveModelError(model) : null
}
