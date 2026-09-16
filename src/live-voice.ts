import { getBridge } from './shared'

export function initLiveVoice(root: HTMLElement, button: HTMLButtonElement, onActive: (active: boolean) => void) {
  const bridge = getBridge()
  const panel = document.createElement('div')
  panel.className = 'live-voice-panel hidden'
  panel.innerHTML = '<div class="voice-orb-space"><span class="voice-orb"></span></div><div class="live-voice-status" role="status">Connecting…</div><div class="live-voice-controls"><button class="voice-mute" aria-label="Mute microphone">Mute</button><button class="voice-end" aria-label="End voice chat">End</button></div>'
  root.append(panel)
  const dot = panel.querySelector<HTMLElement>('.voice-orb')!
  const status = panel.querySelector<HTMLElement>('.live-voice-status')!
  const mute = panel.querySelector<HTMLButtonElement>('.voice-mute')!
  let id = '', stream: MediaStream | null = null, context: AudioContext | null = null
  let processor: ScriptProcessorNode | null = null, frame = 0, muted = false, ready = false
  let nextAudio = 0, inputLevel = 0, smoothLevel = 0
  const playing = new Set<AudioBufferSourceNode>()
  function clearPlayback() { for (const node of playing) { node.onended = null; node.stop(); node.disconnect() }; playing.clear(); nextAudio = 0 }
  function stop(error = '') {
    if (id) bridge.stopLiveVoice?.(id)
    id = ''; ready = false
    stream?.getTracks().forEach(t => t.stop()); stream = null
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null }
    clearPlayback(); void context?.close(); context = null
    cancelAnimationFrame(frame); frame = 0
    root.classList.toggle('voice-active', !!error); button.classList.remove('holding'); button.setAttribute('aria-pressed', 'false')
    onActive(false)
    panel.classList.toggle('hidden', !error)
    panel.dataset.state = error ? 'error' : 'idle'
    dot.style.setProperty('--voice-level', '0')
    status.textContent = error
    mute.disabled = !!error
  }
  const unsubscribe = bridge.onLiveVoice?.(event => {
    if (!id || event.requestId !== id) return
    if (event.type === 'error') { stop(event.error || 'Voice connection failed.'); return }
    if (event.type === 'closed') { stop(); return }
    if (event.type === 'ready') { ready = true; panel.dataset.state = 'listening'; status.textContent = 'Listening'; return }
    if (event.type === 'interrupted') { clearPlayback(); return }
    if (event.type === 'audio' && event.data && context) {
      const bytes = Uint8Array.from(atob(event.data), c => c.charCodeAt(0))
      if (bytes.length < 2 || bytes.length % 2) return
      const data = new DataView(bytes.buffer)
      const buffer = context.createBuffer(1, bytes.length / 2, event.sampleRate || 24000)
      const samples = buffer.getChannelData(0)
      for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(i * 2, true) / 32768
      if (nextAudio - context.currentTime > 15) { stop('Audio playback is falling behind. Please reconnect.'); return }
      const source = context.createBufferSource(); source.buffer = buffer
      source.connect(outputAnalyser!); playing.add(source)
      source.onended = () => { playing.delete(source); source.disconnect() }
      nextAudio = Math.max(nextAudio, context.currentTime + .025)
      source.start(nextAudio); nextAudio += buffer.duration
    }
  })
  let outputAnalyser: AnalyserNode | null = null
  async function start() {
    if (id) { stop(); return }
    id = crypto.randomUUID(); const requestId = id
    panel.classList.remove('hidden'); panel.dataset.state = 'connecting'; status.textContent = 'Connecting…'
    root.classList.add('voice-active'); root.classList.remove('pet-compact')
    root.querySelector<HTMLElement>('.pet-dock-content')!.inert = false
    button.classList.add('holding'); button.setAttribute('aria-pressed', 'true')
    muted = false; mute.disabled = false; mute.textContent = 'Mute'; mute.setAttribute('aria-pressed', 'false')
    try {
      const cfg = await bridge.getConfig()
      if (id !== requestId) return
      const rate = cfg.audio?.liveProvider === 'openai' ? 24000 : 16000
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      if (id !== requestId) { acquired.getTracks().forEach(t => t.stop()); return }
      stream = acquired; context = new AudioContext({ sampleRate: rate }); await context.resume()
      if (id !== requestId || !context) return
      outputAnalyser = context.createAnalyser(); outputAnalyser.fftSize = 256; outputAnalyser.connect(context.destination)
      // Process raw PCM at the provider's rate. The silent output keeps the capture graph running.
      processor = context.createScriptProcessor(2048, 1, 1)
      context.createMediaStreamSource(stream).connect(processor); processor.connect(context.destination)
      processor.onaudioprocess = event => {
        if (!id || !ready || !context) return
        const samples = event.inputBuffer.getChannelData(0)
        inputLevel = muted ? 0 : Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length)
        const count = Math.floor(samples.length * rate / context.sampleRate)
        const bytes = new Uint8Array(count * 2), view = new DataView(bytes.buffer)
        for (let i = 0; i < count; i++) { const v = muted ? 0 : Math.max(-1, Math.min(1, samples[Math.floor(i * context.sampleRate / rate)] ?? 0)); view.setInt16(i * 2, v * 32767, true) }
        bridge.sendLiveAudio?.(id, btoa(String.fromCharCode(...bytes)))
      }
      onActive(true)
      const result = await bridge.startLiveVoice?.(id)
      if (id !== requestId) return
      if (!result?.ok) throw new Error(result?.error || 'Voice mode unavailable.')
      const values = new Float32Array(outputAnalyser.fftSize)
      function draw() {
        if (!id || !outputAnalyser) return
        outputAnalyser.getFloatTimeDomainData(values)
        const output = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length)
        smoothLevel += (Math.min(1, Math.max(inputLevel, output) * 7) - smoothLevel) * .22
        dot.style.setProperty('--voice-level', String(smoothLevel))
        if (ready) { panel.dataset.state = playing.size ? 'speaking' : 'listening'; status.textContent = playing.size ? 'Bloub is speaking' : muted ? 'Microphone muted' : 'Listening' }
        frame = requestAnimationFrame(draw)
      }
      draw()
    } catch (error) { if (id === requestId) stop(error instanceof Error ? error.message : 'Microphone unavailable.') }
  }
  button.addEventListener('click', () => void start())
  button.title = 'Start voice chat'; button.setAttribute('aria-label', 'Start voice chat')
  button.innerHTML = '<span class="voice-launch-dot"></span>'
  mute.onclick = () => { muted = !muted; mute.textContent = muted ? 'Unmute' : 'Mute'; mute.setAttribute('aria-pressed', String(muted)); stream?.getAudioTracks().forEach(t => { t.enabled = !muted }) }
  panel.querySelector<HTMLButtonElement>('.voice-end')!.onclick = () => stop()
  window.addEventListener('beforeunload', () => { stop(); unsubscribe?.() })
  return { stop, get active() { return !!id } }
}
