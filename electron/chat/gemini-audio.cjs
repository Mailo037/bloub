// Gemini-Audio-Engine (separat vom Chat-Provider).
// Sprache->Text (STT) und Text->Sprache (TTS) ueber die Gemini-API.
// Diese Engine ist bewusst unabhaengig vom Chat-Provider, damit jeder
// seinen eigenen Chat-Provider nutzen kann und Gemini nur fuer Audio zustaendig ist.

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

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

/** TTS: Text -> Audio via generateContent + speechConfig (Prebuilt-Voice). */
async function textToSpeech({ apiKey, baseUrl, text, voice = 'Kore' }) {
  if (!apiKey) return { ok: false, error: 'Gemini API key not set (Audio tab)' }
  if (!text) return { ok: false, error: 'empty text' }
  const url = `${(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models/${TTS_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice }
        }
      }
    }
  }
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = j?.error?.message || j?.message || ''
    } catch { /* ignore */ }
    return { ok: false, error: detail || `${res.status} ${res.statusText}` }
  }
  let j
  try {
    j = await res.json()
  } catch {
    return { ok: false, error: 'invalid response' }
  }
  const audioPart = j?.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.mimeType && p.inlineData.mimeType.startsWith('audio')
  )
  if (!audioPart?.inlineData?.data) return { ok: false, error: 'no audio in response' }
  try {
    return {
      ok: true,
      audio: Buffer.from(audioPart.inlineData.data, 'base64'),
      mime: audioPart.inlineData.mimeType || 'audio/wav'
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
      parts: [{
        inlineData: { mimeType: mime || 'audio/wav', data: audioBuffer.toString('base64') }
      }]
    }],
    generationConfig: { responseModalities: ['TEXT'] }
  }
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = j?.error?.message || j?.message || ''
    } catch { /* ignore */ }
    return { ok: false, error: detail || `${res.status} ${res.statusText}` }
  }
  let j
  try {
    j = await res.json()
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
  transcribe,
  ping,
  TTS_MODEL,
  STT_MODEL,
  handleLiveModel: (model) => isLiveModel(model) ? liveModelError(model) : null
}