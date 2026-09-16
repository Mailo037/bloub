const WebSocket = require('ws')

function connectVoice({ provider, apiKey, emit }) {
  const openai = provider === 'openai'
  if (!apiKey) throw new Error(`${openai ? 'OpenAI' : 'Gemini'} API key is required. Add it under Voice.`)
  const socket = new WebSocket(openai ? 'wss://api.openai.com/v1/live/sessions' :
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', {
    headers: openai ? { Authorization: `Bearer ${apiKey}` } : { 'x-goog-api-key': apiKey },
    handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024
  })
  let ready = false, closing = false, closeTimer
  const send = data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)) }
  const startupTimer = setTimeout(() => { emit({ type: 'error', error: 'Voice connection timed out.' }); socket.terminate() }, 20000)
  socket.on('open', () => {
    const instructions = 'You are Bloub, a friendly desktop companion. Reply briefly and naturally in the language of the user. Do not claim to perform actions on the computer.'
    send(openai ? { type: 'session.start', session: {
      model: 'gpt-live-1', instructions,
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
      delegation: { type: 'responses', responses: { model: 'gpt-5.6-luna' } }
    } } : { setup: {
      model: 'models/gemini-3.1-flash-live-preview',
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: instructions }] },
      inputAudioTranscription: {}, outputAudioTranscription: {}
    } })
  })
  socket.on('message', raw => {
    try {
      const event = JSON.parse(raw.toString())
      if (event.error || event.type === 'error') {
        emit({ type: 'error', error: event.error?.message || 'The voice service reported an error.' })
        socket.close(); return
      }
      if (event.setupComplete || event.type === 'session.started') {
        clearTimeout(startupTimer); ready = true; emit({ type: 'ready', sampleRate: openai ? 24000 : 16000 })
      }
      if (event.type === 'session.output_audio.delta') emit({ type: 'audio', data: event.delta, sampleRate: 24000 })
      if (event.type === 'session.closed') { clearTimeout(closeTimer); socket.close() }
      const content = event.serverContent
      if (content?.interrupted) emit({ type: 'interrupted' })
      for (const part of content?.modelTurn?.parts || []) {
        if (part.inlineData?.data) emit({ type: 'audio', data: part.inlineData.data, sampleRate: Number(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1]) || 24000 })
      }
    } catch { emit({ type: 'error', error: 'Invalid response from the voice service.' }); socket.close() }
  })
  socket.on('error', () => emit({ type: 'error', error: 'Voice connection failed. Check your API key, model access and network.' }))
  socket.on('close', () => { clearTimeout(startupTimer); clearTimeout(closeTimer); emit({ type: 'closed' }) })
  return {
    audio(data) {
      if (!ready || closing || typeof data !== 'string' || data.length > 64000) return
      if (socket.bufferedAmount > 256000) { emit({ type: 'error', error: 'Voice connection is too slow.' }); socket.terminate(); return }
      send(openai ? { type: 'session.input_audio.append', audio: data } : { realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } })
    },
    close() {
      if (closing) return
      closing = true; clearTimeout(startupTimer)
      if (openai && ready && socket.readyState === WebSocket.OPEN) {
        send({ type: 'session.close' }); closeTimer = setTimeout(() => socket.terminate(), 15000)
      } else socket.terminate()
    }
  }
}
module.exports = { connectVoice }
