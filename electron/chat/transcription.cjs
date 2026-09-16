// Dedicated speech-to-text providers; Gemini remains responsible for voice output.
async function transcribe({ provider = 'openai', apiKey, localUrl, audioBuffer, mime = 'audio/webm' }) {
  try {
    const local = provider === 'whisper-local'
    if (!local && provider !== 'openai') throw new Error('Unbekannter Transkriptionsanbieter.')
    if (!local && !apiKey) throw new Error('OpenAI API-Key unter Voice → Transkription eintragen.')
    const url = new URL(local ? localUrl || 'http://127.0.0.1:8080/inference' : 'https://api.openai.com/v1/audio/transcriptions')
    if (local && (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol))) {
      throw new Error('Lokales Whisper benötigt eine localhost-Adresse.')
    }
    const body = new FormData()
    const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm'
    body.append('file', new Blob([audioBuffer], { type: mime }), `dictation.${ext}`)
    body.append('response_format', 'json')
    if (local) body.append('language', 'auto')
    else body.append('model', 'gpt-4o-mini-transcribe')
    const response = await fetch(url, {
      method: 'POST', body,
      headers: local ? {} : { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(local ? 180000 : 60000)
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result?.error?.message || result?.error || `Transkription fehlgeschlagen (${response.status}).`)
    if (typeof result.text !== 'string') throw new Error('Der Transkriptionsdienst hat keinen Text geliefert.')
    return { ok: true, text: result.text.trim() }
  } catch (error) {
    let message = error?.message || 'Transkription fehlgeschlagen.'
    if (message === 'fetch failed' && provider === 'whisper-local') message = 'Whisper ist nicht erreichbar. Lokalen whisper.cpp-Server starten und die Adresse unter Voice prüfen.'
    return { ok: false, text: '', error: message }
  }
}
module.exports = { transcribe }
