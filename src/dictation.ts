import { getBridge } from './shared'
export function initDictation(bridge: ReturnType<typeof getBridge>, input: HTMLTextAreaElement, mic: HTMLButtonElement | null, send: () => Promise<void>, chatId: () => string) {
  const composer = input.closest<HTMLElement>('.composer-pill')!
  const panel = document.createElement('div')
  panel.className = 'dictation-panel hidden'
  panel.innerHTML = `<button class="dictation-cancel" aria-label="Cancel dictation"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg></button><canvas class="dictation-wave"></canvas><span class="dictation-status" role="status"></span><button class="dictation-stop" aria-label="Stop recording"><svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" fill="currentColor" stroke="none"/></svg></button><button class="dictation-send" aria-label="Send dictation"><svg viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>`
  composer.append(panel)
  const canvas = panel.querySelector('canvas')!
  const status = panel.querySelector<HTMLElement>('.dictation-status')!
  const stopButton = panel.querySelector<HTMLButtonElement>('.dictation-stop')!
  const sendButton = panel.querySelector<HTMLButtonElement>('.dictation-send')!
  let state = 'idle', serial = 0, stream: MediaStream | null = null, recorder: MediaRecorder | null = null
  let audio: AudioContext | null = null, frame = 0, sendAfter = false
  function ui(next: string, message = '') {
    state = next
    composer.classList.toggle('dictating', next !== 'idle')
    panel.classList.toggle('hidden', next === 'idle')
    panel.dataset.state = next
    status.textContent = message
    canvas.hidden = next !== 'recording'
    stopButton.disabled = next !== 'recording'
    sendButton.disabled = next !== 'recording'
    input.readOnly = next !== 'idle'
    if (mic) { mic.disabled = next !== 'idle'; mic.title = next === 'starting' ? 'Starting dictation…' : 'Voice input' }
  }
  function release() {
    cancelAnimationFrame(frame)
    stream?.getTracks().forEach(t => t.stop()); stream = null
    void audio?.close().catch(() => {}); audio = null
  }
  function cancel() {
    serial++
    if (recorder?.state === 'recording') recorder.stop()
    release(); recorder = null; ui('idle'); input.focus()
  }
  async function start() {
    if (state !== 'idle') return
    const token = ++serial, target = chatId()
    sendAfter = false
    ui('starting', 'Starting dictation…')
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true } })
      if (token !== serial) { acquired.getTracks().forEach(t => t.stop()); return }
      stream = acquired
      const mime = ['audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m))
      const current = new MediaRecorder(acquired, mime ? { mimeType: mime } : undefined)
      recorder = current
      const chunks: Blob[] = []
      current.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      current.onstop = async () => {
        if (token !== serial) return
        release(); ui('transcribing', 'Transcribing…')
        try {
          const blob = new Blob(chunks, { type: current.mimeType })
          const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(blob) })
          if (token !== serial) return
          const result = await bridge.transcribeAudio?.({ data, mime: blob.type, source: 'dictation' })
          if (token !== serial) return
          if (!result?.ok || !result.text?.trim()) throw new Error(result?.error || 'No speech detected. Please try again.')
          ui('idle')
          if (chatId() !== target) return
          input.value = [input.value, result.text.trim()].filter(Boolean).join(' ')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.focus()
          if (sendAfter) await send()
        } catch (error) {
          if (token !== serial) return
          ui('error', error instanceof Error ? error.message : 'Transcription failed')
        }
      }
      current.start(200)
      ui('recording')
      audio = new AudioContext()
      const analyser = audio.createAnalyser(); analyser.fftSize = 256
      audio.createMediaStreamSource(acquired).connect(analyser)
      const samples = new Uint8Array(analyser.frequencyBinCount)
      // A fixed spatial cadence keeps the tape smooth at any display refresh rate.
      const spacing = 6, speed = 36
      const levels: number[] = []
      const startedAt = performance.now()
      let sampledStep = 0
      const draw = (now: number) => {
        if (state !== 'recording') return
        analyser.getByteTimeDomainData(samples)
        const volume = Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length)
        const distance = (now - startedAt) * speed / 1000
        const step = Math.floor(distance / spacing)
        const capacity = Math.ceil(canvas.clientWidth / spacing) + 2
        for (let n = Math.max(sampledStep, step - capacity); n < step; n++) levels.push(Math.min(1, volume * 5))
        sampledStep = step
        if (levels.length > capacity) levels.splice(0, levels.length - capacity)
        canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio); canvas.height = 30 * devicePixelRatio
        const ctx = canvas.getContext('2d')!
        ctx.scale(devicePixelRatio, devicePixelRatio); ctx.lineWidth = 3; ctx.lineCap = 'round'
        for (let i = 0; i < capacity; i++) {
          const x = canvas.clientWidth - distance % spacing - i * spacing
          const level = levels[levels.length - 1 - i]
          const h = Math.max(0.1, (level ?? 0) * 23)
          ctx.strokeStyle = level === undefined ? '#656565' : '#f5f5f5'
          ctx.beginPath(); ctx.moveTo(x, 15 - h / 2); ctx.lineTo(x, 15 + h / 2); ctx.stroke()
        }
        frame = requestAnimationFrame(draw)
      }
      draw(startedAt)
    } catch (error) {
      if (token !== serial) return
      release(); ui('error', error instanceof Error ? error.message : 'Microphone unavailable')
    }
  }
  function stop() { if (state === 'recording') recorder?.stop(); else if (state === 'starting') cancel() }
  panel.querySelector<HTMLButtonElement>('.dictation-cancel')!.onclick = cancel
  stopButton.onclick = stop
  sendButton.onclick = () => { sendAfter = true; stop() }
  mic?.addEventListener('click', () => void start())
  window.addEventListener('beforeunload', cancel)
  return { start, stop, get isRecording() { return state === 'recording' || state === 'starting' } }
}
