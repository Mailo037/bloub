/**
 * Chat-Dock im Pet-Fenster: Eingabe-Pill plus Antwort unter dem Ball. Kein
 * eigenes Fenster mehr — der Bloub spricht direkt unter sich. Wird von
 * pet.ts gemountet; Sichtbarkeit steuert main.cjs ueber chat:visibility.
 */
import { getBridge, createSvgIcon, type ChatEvent, type AttachChip, type Grant } from './shared'
import { COLOR_BY_ID, DEFAULT_COLOR } from '../vendor/bot/skins'
import { renderMarkdownLite } from './markdown-lite'

export interface MountChatCallbacks {
  onThinkingStart?: () => void
  onStreamingStart?: () => void
  onTurnEnd?: (success: boolean) => void
  /** Gesichts-Reaktion aus dem Antwort-Text: "aha" (jetzt hab ichs) / "ohno" (Kopfschuetteln). */
  onReact?: (kind: 'aha' | 'ohno') => void
  /** Mikrofon-Aufnahme gestartet/beendet (PTT oder Klick) — fuer die Bloub-Animation. */
  onListeningChange?: (active: boolean) => void
}

export function mountChat(root: HTMLElement, callbacks?: MountChatCallbacks): void {
  const bridge = getBridge()

  root.innerHTML = `
    <div id="chip-row"></div>
    <div id="note-row"></div>
    <div id="reply" class="hidden">
      <button id="reply-audio" aria-label="Read answer aloud" title="Read answer aloud">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M15.5 8.5a5 5 0 0 1 0 7"></path>
          <path d="M18.5 5.5a9 9 0 0 1 0 13"></path>
        </svg>
      </button>
      <button id="reply-close" aria-label="Hide answer" title="Hide answer">✕</button>
      <div id="reply-scroll"><div id="reply-body"></div></div>
    </div>
    <div id="input-row">
      <textarea id="chat-input" rows="1" placeholder="ask the bloub…" spellcheck="false"></textarea>
      <button id="send" aria-label="Send">➤</button>
    </div>
    <div id="mic-row" class="hidden">
      <div id="mic-btn" title="Listening…">
        <div id="mic-level"></div>
        <svg id="mic-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"/>
          <path d="M5 10a7 7 0 0 0 14 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M12 17v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </div>
      <div id="mic-status">Listening…</div>
    </div>
  `

  const chipRow = root.querySelector('#chip-row') as HTMLElement
  const noteRow = root.querySelector('#note-row') as HTMLElement
  const reply = root.querySelector('#reply') as HTMLElement
  const replyAudio = root.querySelector('#reply-audio') as HTMLButtonElement
  const replyClose = root.querySelector('#reply-close') as HTMLButtonElement | null
  const replyScroll = root.querySelector('#reply-scroll') as HTMLElement
  const replyBody = root.querySelector('#reply-body') as HTMLElement
  const inputRow = root.querySelector('#input-row') as HTMLElement
  const input = root.querySelector('#chat-input') as HTMLTextAreaElement
  const sendBtn = root.querySelector('#send') as HTMLButtonElement
  const micRow = root.querySelector('#mic-row') as HTMLElement
  const micBtn = root.querySelector('#mic-btn') as HTMLElement
  const micStatus = root.querySelector('#mic-status') as HTMLElement
  replyAudio.disabled = true

  interface FileChip extends AttachChip {
    id: string
  }

  let fileChips: FileChip[] = []
  let grants: Grant[] = []
  let streaming = false
  let buffer = ''
  let rafPending = false
  let userScrolledUp = false
  let voiceEnabled = false

  /* Kein clampDock mehr: die Dock-Hoehe ist per CSS hart auf den Platz
   * UNTER dem Ball begrenzt (#chat-dock max-height). Ueberschüssige Antwort
   * laeuft stattdessen im Scroll-Frame (#reply-scroll) — der Dock wächst
   * nie wieder nach oben in den Bloub hinein. */

  /* --------------------------------------------- send-knopf in bloub-farbe */

  function applyBloubColor(colorId: string | undefined) {
    const hex = COLOR_BY_ID.get(colorId ?? '')?.hex ?? COLOR_BY_ID.get(DEFAULT_COLOR)?.hex
    if (hex) {
      sendBtn.style.background = hex
      // Icon-Kontrast wie beim Ball: heller Koerper -> dunkles Papier
      const v = parseInt(hex.slice(1), 16)
      const bright = (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255
      sendBtn.style.color = bright > 0.6 ? '#101014' : '#f4f2ec'
      sendBtn.style.borderColor = 'rgba(255,255,255,0.12)'
    }
  }

  /* ---------------------------------------------------- antwort ausfaden */

  /** Antwort sanft ausfaden und danach den Inhalt leeren. */
  function fadeOutReply(done?: () => void) {
    if (reply.classList.contains('hidden')) {
      done?.()
      return
    }
    reply.classList.add('fade-out')
    setTimeout(() => {
      replyBody.replaceChildren()
      reply.classList.remove('fade-out')
      done?.()
    }, 500)
  }

  /* -------------------------------------------------------------- chips */

  /** Anzeigename eines Grants: Root-Grant als "C:\ (full drive)", sonst Ordner. */
function grantLabel(g: Grant): string {
  if (g.isRoot) return `${g.path} (full drive)`
  return g.path.split(/[\\/]/).filter(Boolean).pop() ?? g.path
}

function renderChips() {
    const nodes: HTMLElement[] = []
    // Eigene Nachricht wird bewusst NICHT angezeigt — nur Antwort + Status
    for (const chip of fileChips) {
      const c = document.createElement('span')
      c.className = 'chip clickable'
      c.appendChild(createSvgIcon(iconNameFor(chip), 13))
      const name = document.createElement('span')
      name.className = 'chip-name'
      name.textContent = chip.note ? `${chip.name} — ${chip.note}` : chip.name
      c.appendChild(name)
      c.addEventListener('click', () => {
        fileChips = fileChips.filter((x) => x.id !== chip.id)
        renderChips()
      })
      nodes.push(c)
    }
    for (const g of grants) {
      // Der automatische Root-Grant (C:\ full drive) ist ein Opt-in aus den
      // Pad-Settings und laesst sich hier nicht sinnvoll entfernen — als Chip
      // im Chat-Dock nur nervig. Nicht anzeigen, nur nicht-Root-Grants rendern.
      if (g.isRoot) continue
      const c = document.createElement('span')
      c.className = 'chip grant'
      c.appendChild(createSvgIcon('folder', 13))
      const name = document.createElement('span')
      name.className = 'chip-name'
      name.textContent = grantLabel(g)
      c.appendChild(name)
      const shield = document.createElement('button')
      shield.className = `shield${g.allowSecrets ? ' on' : ''}`
      shield.title = 'allow secrets (never default)'
      shield.appendChild(createSvgIcon('shield', 12))
      shield.addEventListener('click', (e) => {
        e.stopPropagation()
        void bridge.setGrantSecrets?.(g.path, !g.allowSecrets)?.then((fresh) => {
          grants = fresh ?? grants
          renderChips()
        })
      })
      c.appendChild(shield)
      const rm = document.createElement('button')
      rm.className = 'shield'
      rm.title = 'revoke folder grant'
      rm.appendChild(createSvgIcon('close', 11))
      rm.addEventListener('click', (e) => {
        e.stopPropagation()
        void bridge.removeGrant?.(g.path)?.then((fresh) => {
          grants = fresh ?? grants
          renderChips()
        })
      })
      c.appendChild(rm)
      nodes.push(c)
    }
    chipRow.replaceChildren(...nodes)
  }

  function iconNameFor(chip: AttachChip): string {
    switch (chip.kind) {
      case 'image':
        return 'image'
      case 'folder':
      case 'grant':
        return 'folder'
      case 'pdf':
        return 'pdf'
      case 'text':
        return 'text'
      default:
        return 'clip'
    }
  }

  /* ---------------------------------------------------------- antworten */

  function setGlimmer(on: boolean) {
    replyBody.classList.toggle('glimmer', on)
  }

  function setStatusLine(text: string) {
    replyBody.replaceChildren()
    const line = document.createElement('div')
    line.className = 'status-line'
    line.textContent = text
    replyBody.appendChild(line)
    scrollReply(true)
  }

  /** Aktivitaets-Notiz der AI (ueber der Antwort, max 2 sichtbar, aelteste scrollt raus). */
  function addNote(text: string) {
    // Maximal 2 Notizen gleichzeitig: die aelteste rausanimieren
    if (noteRow.children.length >= 2) {
      const oldest = noteRow.children[0] as HTMLElement
      oldest.classList.add('note-out')
      oldest.addEventListener('animationend', () => oldest.remove(), { once: true })
      setTimeout(() => { if (oldest.parentNode) oldest.remove() }, 350)
    }

    const line = document.createElement('div')
    line.className = 'note-line'
    line.textContent = text
    noteRow.appendChild(line)
    scrollReply(true)
  }

  /** Restliche Notizen ausblenden (nach Turn-Ende bleibt nur die Antwort). */
  function clearNotes() {
    for (const child of Array.from(noteRow.children)) {
      const el = child as HTMLElement
      el.classList.add('note-out')
      el.addEventListener('animationend', () => el.remove(), { once: true })
    }
    setTimeout(() => {
      noteRow.replaceChildren()
    }, 350)
  }

  function updateReplyScrollGradients() {
    const canScrollUp = replyScroll.scrollTop > 3
    const canScrollDown = replyScroll.scrollTop + replyScroll.clientHeight < replyScroll.scrollHeight - 3
    replyScroll.classList.toggle('can-scroll-top', canScrollUp)
    replyScroll.classList.toggle('can-scroll-bottom', canScrollDown)
  }

  function scrollReply(force: boolean) {
    if (force || !userScrolledUp) replyScroll.scrollTop = replyScroll.scrollHeight
    updateReplyScrollGradients()
  }

  replyScroll.addEventListener('scroll', updateReplyScrollGradients, { passive: true })
  new ResizeObserver(updateReplyScrollGradients).observe(replyScroll)

  function scheduleStreamRender() {
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      replyBody.replaceChildren(renderMarkdownLite(buffer, { codeClass: 'code-block' }))
      scrollReply(false)
    })
  }

  /* ------------------------------------- gesichts-reaktionen aus dem text */

  /**
   * Der Bloub reagiert im Text mit der Mimik: erkennt der Renderer beim
   * Streamen "aha/jetzt hab ichs"-Phrasen, hopft er freudig; bei "oh nein/
   * Fehler"-Phrasen schuettelt er den Kopf. Mit Cooldown, damit Code-Blöcke
   * oder Aufzählungen ihn nicht in Dauerschleife versetzen.
   */
  const REACT_RULES: Array<{ re: RegExp; kind: 'aha' | 'ohno' }> = [
    {
      re: /jetzt hab ich('?s| es)|ich hab'?s|ich habe es (gefunden|geschafft)|\baha\b|got it|found it|es klappt|hat geklappt|hat funktioniert|geschafft|solved it|erledigt/i,
      kind: 'aha'
    },
    {
      re: /oh nein|oh no\b|uh ?oh|oops|^ups\b|,\s*ups\b|fehler|leider nicht|hat leider|nicht geklappt|nicht funktioniert|schiefgegangen|schiefgelaufen|gescheitert|\berror\b/i,
      kind: 'ohno'
    }
  ]
  let lastReactKind = ''
  let lastReactAt = 0

  function maybeReact() {
    const tail = buffer.slice(-500)
    for (const { re, kind } of REACT_RULES) {
      if (!re.test(tail)) continue
      const now = Date.now()
      if (now - lastReactAt < 6000) return
      if (kind === lastReactKind && now - lastReactAt < 20000) return
      lastReactKind = kind
      lastReactAt = now
      callbacks?.onReact?.(kind)
      return
    }
  }

  /* ------------------------------------------------------------- senden */

  function send() {
    const text = input.value.trim()
    if (!text && fileChips.length === 0) return
    stopSpeech()
    const attachmentIds = fileChips.filter((c) => !c.note).map((c) => c.id)
    fileChips = []
    input.value = ''
    autosizeInput()
    // Animation beim Senden
    inputRow.classList.add('sending')
    setTimeout(() => {
      inputRow.classList.add('collapsed')
      inputRow.classList.remove('sending')
    }, 180)
    streaming = true
    userScrolledUp = false
    buffer = ''
    replyAudio.disabled = true
    noteRow.replaceChildren()
    root.classList.remove('hidden', 'closing')
    reply.classList.remove('hidden')
    replyBody.classList.remove('error')
    setGlimmer(true)
    setStatusLine('thinking …')
    renderChips()
    callbacks?.onThinkingStart?.()
    void bridge.sendChat?.({ text, attachmentIds })
  }

  sendBtn.addEventListener('click', send)

  const dismissChat = () => {
    stopSpeech()
    if (streaming) {
      bridge.abortChat?.()
      streaming = false
      callbacks?.onTurnEnd?.(false)
    }
    root.classList.add('closing')
    setTimeout(() => {
      root.classList.add('hidden')
      root.classList.remove('closing')
      reply.classList.add('hidden')
      inputRow.classList.remove('collapsed', 'sending')
      bridge.hideChat?.()
    }, 160)
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      dismissChat()
    }
  })

  // Paste: Text inline, Bilder als Attachment-Chip
  input.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (!f) continue
        e.preventDefault()
        addFileChip(f)
      }
    }
  })

  function addFileChip(f: File) {
    const path = bridge.pathForFile?.(f)
    const kind = f.type.startsWith('image/') ? 'image' : 'text'
    fileChips.push({
      kind,
      id: path ?? `clip-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: f.name || f.type || 'clipboard',
      size: f.size,
      note: !path ? 'pasted image' : undefined
    })
    renderChips()
  }

  function autosizeInput() {
    input.style.height = 'auto'
    const minH = 40
    const maxH = 90 // entspricht der CSS-max-height (Rest scrollt)
    const scrollH = input.scrollHeight
    const capped = Math.max(minH, Math.min(scrollH, maxH))
    input.style.height = `${capped}px`
  }

  input.addEventListener('input', autosizeInput)

  /* ------------------------------------------------- antwort-eingriffe */

  // Schliessen-Knopf bei Hover ueber die Antwort
  replyClose?.addEventListener('click', (e) => {
    e.stopPropagation()
    stopSpeech()
    noteRow.replaceChildren()
    buffer = ''
    fadeOutReply(() => {
      reply.classList.add('hidden')
      if (inputRow.classList.contains('collapsed')) {
        root.classList.add('hidden')
      }
    })
  })

  // Klick auf die fertige Antwort: Eingabezeile fuer Follow-up zurueckschieben
  reply.addEventListener('click', () => {
    if (streaming) return
    inputRow.classList.remove('collapsed')
    input.focus()
  })

  // Auto-Scroll nur solange der Nutzer nicht selbst hochgescrollt hat
  replyScroll.addEventListener('wheel', (e) => {
    if (e.deltaY < 0 && replyScroll.scrollTop > 0) userScrolledUp = true
    else if (replyScroll.scrollTop + replyScroll.clientHeight >= replyScroll.scrollHeight - 2) userScrolledUp = false
  })

  // Esc versteckt das Dock von ueberall im Pet-Fenster
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismissChat()
  }
  document.addEventListener('keydown', onDocKey)

  /* --------------------------------------------------------- ipc-events */

  bridge.onChatEvent?.((ev: ChatEvent) => {
    switch (ev.type) {
      case 'status':
        setStatusLine(ev.text)
        break
      case 'accepted': {
        // Auto-Turn vom Main (z. B. nach File-Drop): wie ein eigener Send
        // behandeln, damit der Chat-Dock korrekt startet.
        if (!streaming) {
          streaming = true
          userScrolledUp = false
          buffer = ''
          noteRow.replaceChildren()
          root.classList.remove('hidden', 'closing')
          reply.classList.remove('hidden')
          replyBody.classList.remove('error')
          setGlimmer(true)
          setStatusLine('thinking …')
          callbacks?.onThinkingStart?.()
        }
        break
      }
      case 'note':
        addNote(ev.text)
        break
      case 'tools':
        // Tool-Batch laeuft: der Bloub denkt wieder — auch mitten im Stream.
        if (streaming) {
          setGlimmer(true)
          callbacks?.onThinkingStart?.()
        }
        break
      case 'clear':
        // Neues Text-Segment nach Tool-Calls: alten Antwort-Text verwerfen
        buffer = ''
        stopSpeech()
        userScrolledUp = false
        fadeOutReply()
        scrollReply(true)
        break
      case 'token':
        if (streaming && buffer === '') {
          setGlimmer(false)
          callbacks?.onStreamingStart?.()
        }
        buffer += ev.text
        maybeReact()
        scheduleStreamRender()
        break
      case 'done': {
        streaming = false
        setGlimmer(false)
        clearNotes()
        if (replyBody.classList.contains('error')) {
          // Fehler bleibt sichtbar
        } else if (buffer) {
          replyBody.replaceChildren(renderMarkdownLite(buffer, { codeClass: 'code-block' }))
          if (ev.truncated) {
            const note = document.createElement('span')
            note.className = 'truncated-note'
            note.textContent = '[truncated]'
            replyBody.appendChild(note)
          }
        } else {
          replyBody.replaceChildren(document.createTextNode('(no response received — check API key in settings)'))
        }
        scrollReply(false)
        replyAudio.disabled = !buffer.trim()
        speakReplyIfEnabled(buffer)
        callbacks?.onTurnEnd?.(true)
        break
      }
      case 'error': {
        streaming = false
        setGlimmer(false)
        clearNotes()
        root.classList.remove('hidden')
        reply.classList.remove('hidden')
        replyBody.classList.add('error')
        replyBody.replaceChildren(document.createTextNode(ev.message || 'Error communicating with provider'))
        replyAudio.disabled = true
        scrollReply(false)
        callbacks?.onTurnEnd?.(false)
        break
      }
      case 'attachments': {
        let sawGrant = false
        for (const chip of ev.chips) {
          if (chip.kind === 'grant' && chip.path) {
            sawGrant = true
            if (!grants.some((g) => g.path === chip.path)) {
              grants.push({ path: chip.path, allowSecrets: false })
            }
          } else if (chip.id) {
            fileChips.push(chip as FileChip)
          } else {
            fileChips.push({ ...chip, id: `info-${Date.now()}-${Math.random().toString(36).slice(2)}` })
          }
        }
        renderChips()
        if (sawGrant) {
          void bridge.getConfig?.().then((cfg) => {
            grants = cfg.chat?.grants ?? grants
            renderChips()
          })
        }
        break
      }
      case 'pending-tail': {
        const hint = document.createElement('span')
        hint.className = 'truncated-note'
        hint.textContent = '… something arrived while you were away'
        chipRow.appendChild(hint)
        break
      }
      case 'archived':
        // Memory archiviert (Settings "Archive & clear"): letzte Antwort,
        // Chips und Notizen aus der UI entfernen.
        streaming = false
        setGlimmer(false)
        buffer = ''
        stopSpeech()
        userScrolledUp = false
        fileChips = []
        grants = []
        noteRow.replaceChildren()
        renderChips()
        fadeOutReply(() => {
          reply.classList.add('hidden')
          inputRow.classList.remove('collapsed', 'sending')
          if (!streaming && reply.classList.contains('hidden')) {
            root.classList.add('hidden')
          }
        })
        break
      default:
        break
    }
  })

  /* ---------------------------------------------------------------- init */

  async function init() {
    const cfg = await bridge.getConfig?.()
    grants = cfg?.chat?.grants ?? []
    voiceEnabled = !!(cfg?.audio?.voiceEnabled || cfg?.chat?.voiceAlways)
    applyBloubColor(cfg?.color)
    renderChips()
    autosizeInput()
  }

  void init()

  // Voice-Flag aktuell halten (wird im Audio-Tab umgeschaltet)
  bridge.onConfigChanged?.((cfg) => {
    const nextVoiceEnabled = !!(cfg.audio?.voiceEnabled || cfg.chat?.voiceAlways)
    if (voiceEnabled && !nextVoiceEnabled) stopSpeech()
    voiceEnabled = nextVoiceEnabled
  })

  // Sichtbarkeit wird vom Main gesteuert (Hotkey/Doppelklick/Esc)
  bridge.onChatVisibility?.((visible) => {
    if (visible) {
      root.classList.remove('hidden')
      inputRow.classList.remove('collapsed')
      input.focus()
    } else {
      if (streaming || (!reply.classList.contains('hidden') && replyBody.textContent?.trim())) {
        inputRow.classList.add('collapsed')
        input.blur()
      } else {
        root.classList.add('hidden')
        input.blur()
      }
    }
  })

  /* ----------------------------------------------- push-to-talk (mikro) */

  let mediaRecorder: MediaRecorder | null = null
  let audioChunks: BlobPart[] = []
  let micActive = false
  let transcribing = false
  let recordingStream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let levelRaf = 0
  const micLevelEl = root.querySelector('#mic-level') as HTMLElement
  /**
   * Race-Schutz: das PTT-Ende (Alt+X loslassen) kann kommen, BEVOR der
   * asynchrone Start (getUserMedia, AudioContext) fertig ist — frueher wurde
   * das Stop dann verworfen und die Aufnahme lief ewig weiter. Der Wunsch
   * wird gemerkt und vom startenden Code sofort ausgefuehrt.
   */
  let stopRequested = false
  /** Sicherheitsnetz: hakt das keyUp (Alt-Tab, Fokus-Verlust), stoppt spätestens nach 60 s. */
  let maxDurTimer: ReturnType<typeof setTimeout> | null = null
  let recordingStartedAt = 0
  /** Kurzmeldungs-Timer (Mic-Row zeigt Fehler/Busy und blendet sich selbst aus). */
  let flashTimer: ReturnType<typeof setTimeout> | null = null

  function showMic(show: boolean) {
    micActive = show
    micRow.classList.toggle('hidden', !show)
    inputRow.classList.toggle('hidden', show)
    micBtn.classList.toggle('live', show)
    micBtn.title = show ? 'Click to stop & send' : 'Click to talk (or hold the PTT key)'
    if (show) {
      root.classList.remove('hidden')
      input.blur()
      // Kleine Barriere: Laufende Level-Animation anhalten / Level zuruecksetzen
      if (micLevelEl) micLevelEl.style.setProperty('--lvl', '0')
    } else {
      stopLevelAnimation()
      input.focus()
    }
  }

  /**
   * Kurze Statusmeldung im Mic-Row (Fehler, zu kurz, busy): Row einblenden,
   * Text zeigen, nach `ms` wieder ausblenden — ohne laufende Aufnahme zu stoeren.
   */
  function flashMicStatus(text: string, ms = 2600) {
    if (flashTimer) clearTimeout(flashTimer)
    micRow.classList.remove('hidden')
    inputRow.classList.add('hidden')
    micBtn.classList.remove('live')
    setMicStatus(text)
    flashTimer = setTimeout(() => {
      flashTimer = null
      if ((mediaRecorder?.state ?? 'inactive') === 'inactive') {
        micRow.classList.add('hidden')
        inputRow.classList.remove('hidden')
      }
    }, ms)
  }

  function showTranscriptionStatus() {
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = null
    micRow.classList.remove('hidden', 'speaking')
    inputRow.classList.add('hidden')
    micBtn.classList.remove('live')
    setMicStatus('Transcribing…')
  }

  function hideMicStatus() {
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = null
    micRow.classList.add('hidden')
    inputRow.classList.remove('hidden')
  }

  function startLevelAnimation() {
    if (!analyser || levelRaf) return
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      levelRaf = requestAnimationFrame(tick)
      analyser?.getByteFrequencyData(data)
      // Durchschnitt der oberen Bins als "Sprechpegel" (0..255), geglaettet auf 0..1
      let sum = 0
      const n = Math.min(data.length, 256)
      for (let i = 0; i < n; i += 4) sum += data[i] ?? 0
      const avg = sum / (n / 4)
      const level = Math.min(1, avg / 140)
      if (micLevelEl) micLevelEl.style.setProperty('--lvl', String(level.toFixed(3)))
      // "speaking"-Klasse setzen, sobald hörbarer Pegel
      if (micRow) micRow.classList.toggle('speaking', level > 0.08)
    }
    levelRaf = requestAnimationFrame(tick)
  }

  function stopLevelAnimation() {
    if (levelRaf) cancelAnimationFrame(levelRaf)
    levelRaf = 0
    if (micRow) micRow.classList.remove('speaking')
    if (micLevelEl) micLevelEl.style.setProperty('--lvl', '0')
  }

  async function startMicRecording() {
    if (micActive) return
    if (transcribing) {
      flashMicStatus('still transcribing…')
      return
    }
    if (streaming) {
      flashMicStatus('wait for the reply, then talk')
      return
    }
    stopRequested = false
    setMicStatus('Starting mic…')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    } catch {
      flashMicStatus('mic blocked — allow microphone access')
      return
    }
    // Stop-Kommando kam waehrend des async Starts (schneller Tap): Track
    // wieder freigeben und gar nicht erst aufnehmen.
    if (stopRequested) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    recordingStream = stream
    audioChunks = []

    // Lautstaerke-Pegel fuer die Mikro-Animation
    try {
      audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
    } catch {
      analyser = null
    }

    const preferredMime = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm'
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate))
    mediaRecorder = new MediaRecorder(stream, {
      ...(preferredMime ? { mimeType: preferredMime } : {}),
      audioBitsPerSecond: 64000
    })
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data)
    }
    mediaRecorder.onstop = () => {
      const elapsed = Date.now() - recordingStartedAt
      const chunks = audioChunks
      audioChunks = []
      const type = mediaRecorder?.mimeType || 'audio/webm'
      stopMicTracks()
      if (elapsed < 600 || chunks.length === 0) {
        // Versehentlicher Tap: nichts an die AI schicken
        flashMicStatus('too short — hold a bit longer')
        return
      }
      const blob = new Blob(chunks, { type })
      transcribing = true
      showTranscriptionStatus()
      void sendTranscript(blob)
    }
    recordingStartedAt = Date.now()
    mediaRecorder.start(250)
    showMic(true)
    startLevelAnimation()
    setMicStatus('Listening…')
    callbacks?.onListeningChange?.(true)
    // Sicherheitsnetz gegen ewige Aufnahmen (verlorenes keyUp)
    if (maxDurTimer) clearTimeout(maxDurTimer)
    maxDurTimer = setTimeout(() => {
      maxDurTimer = null
      stopMicRecording()
    }, 60000)
    // Falls das Stop-Kommando zwischen den Zeilen kam: sofort ausfuehren
    if (stopRequested) stopMicRecording()
  }

  function stopMicRecording() {
    if (maxDurTimer) {
      clearTimeout(maxDurTimer)
      maxDurTimer = null
    }
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      // Start laeuft noch: Stop-Wunsch merken — startMicRecording fuehrt ihn aus.
      stopRequested = true
      return
    }
    // Die Eingabezeile kommt SOFORT zurueck — Transkription laeuft im Hintergrund.
    showMic(false)
    callbacks?.onListeningChange?.(false)
    mediaRecorder.stop()
  }

  function setMicStatus(text: string) {
    if (micStatus) micStatus.textContent = text
  }

  function stopMicTracks() {
    try {
      audioCtx?.close?.()
    } catch { /* ignore */ }
    audioCtx = null
    analyser = null
    recordingStream?.getTracks().forEach((t) => t.stop())
    recordingStream = null
  }

  /** Browser-Recorder liefern meist WebM/Opus; Gemini-STT akzeptiert WAV offiziell. */
  async function recordingToWav(blob: Blob): Promise<Blob> {
    const decodeCtx = new AudioContext()
    let decoded: AudioBuffer
    try {
      decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer())
    } finally {
      void decodeCtx.close()
    }

    const sampleRate = 16000
    const frameCount = Math.max(1, Math.ceil(decoded.duration * sampleRate))
    const offline = new OfflineAudioContext(1, frameCount, sampleRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const mono = await offline.startRendering()
    const samples = mono.getChannelData(0)
    const wav = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(wav)
    const writeAscii = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
    }
    writeAscii(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    writeAscii(8, 'WAVE')
    writeAscii(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeAscii(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    }
    return new Blob([wav], { type: 'audio/wav' })
  }

  async function sendTranscript(blob: Blob) {
    if (!bridge.transcribeAudio) {
      transcribing = false
      flashMicStatus('transcription unavailable')
      return
    }
    try {
      const wav = await recordingToWav(blob)
      const dataUrl = await blobToDataUrl(wav)
      const base64 = dataUrl.split(',')[1] ?? ''
      const res = await bridge.transcribeAudio({ mime: 'audio/wav', data: base64 })
      if (res?.ok && res.text.trim()) {
        transcribing = false
        hideMicStatus()
        input.value = res.text.trim()
        autosizeInput()
        void send()
      } else {
        transcribing = false
        flashMicStatus(res?.error ? `✗ ${res.error}` : 'not heard — try again', 4200)
      }
    } catch (err) {
      transcribing = false
      flashMicStatus(`✗ ${err instanceof Error ? err.message : String(err)}`, 4200)
    }
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = reject
      r.readAsDataURL(blob)
    })
  }

  /* --------------------------------------------- tts (antwort vorlesen) */

  let ttsCtx: AudioContext | null = null
  const ttsSources = new Set<AudioBufferSourceNode>()
  let ttsNextStart = 0
  let ttsRequestId = 0
  let activeSpeechStream = ''
  let speechStreamDone = false
  let speechChunkQueue = Promise.resolve()

  function updateAudioButton(state: 'idle' | 'loading' | 'playing', error?: string) {
    replyAudio.classList.toggle('loading', state === 'loading')
    replyAudio.classList.toggle('playing', state === 'playing')
    replyAudio.title = error || (state === 'loading'
      ? 'Preparing voice… click to cancel'
      : state === 'playing'
        ? 'Stop speaking'
        : 'Read answer aloud')
    replyAudio.setAttribute('aria-label', state === 'playing' ? 'Stop speaking' : 'Read answer aloud')
  }

  function releasePlayback() {
    for (const source of ttsSources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    ttsSources.clear()
    ttsNextStart = 0
    speechStreamDone = false
  }

  function stopSpeech() {
    ttsRequestId++
    if (activeSpeechStream) void bridge.cancelSpeechStream?.(activeSpeechStream)
    activeSpeechStream = ''
    releasePlayback()
    updateAudioButton('idle')
  }

  function scheduleAudioBuffer(buffer: AudioBuffer, requestId: number) {
    if (!ttsCtx || requestId !== ttsRequestId) return
    const source = ttsCtx.createBufferSource()
    source.buffer = buffer
    source.connect(ttsCtx.destination)
    const startAt = Math.max(ttsCtx.currentTime + 0.055, ttsNextStart)
    ttsNextStart = startAt + buffer.duration
    ttsSources.add(source)
    source.onended = () => {
      ttsSources.delete(source)
      if (speechStreamDone && ttsSources.size === 0 && requestId === ttsRequestId) {
        activeSpeechStream = ''
        ttsNextStart = 0
        updateAudioButton('idle')
      }
    }
    source.start(startAt)
    updateAudioButton('playing')
  }

  async function scheduleSpeechChunk(base64: string, mime: string | undefined, requestId: number) {
    if (requestId !== ttsRequestId) return
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    ttsCtx = ttsCtx || new AudioContext()
    if (ttsCtx.state === 'suspended') await ttsCtx.resume()
    if (requestId !== ttsRequestId) return

    const rawMime = String(mime || '').toLowerCase()
    if (!rawMime.startsWith('audio/l16') && !rawMime.startsWith('audio/pcm')) {
      const decoded = await ttsCtx.decodeAudioData(bytes.buffer.slice(0))
      scheduleAudioBuffer(decoded, requestId)
      return
    }

    const sampleRate = Number(rawMime.match(/rate=(\d+)/)?.[1]) || 24000
    const channels = Number(rawMime.match(/channels=(\d+)/)?.[1]) || 1
    const frames = Math.floor(bytes.byteLength / (2 * channels))
    if (!frames) return
    const audio = ttsCtx.createBuffer(channels, frames, sampleRate)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let channel = 0; channel < channels; channel++) {
      const output = audio.getChannelData(channel)
      for (let frame = 0; frame < frames; frame++) {
        output[frame] = view.getInt16((frame * channels + channel) * 2, true) / 32768
      }
    }
    scheduleAudioBuffer(audio, requestId)
  }

  async function requestSpeech(text: string, force = false) {
    if (!text || !bridge.startSpeechStream || (!force && !voiceEnabled)) return
    stopSpeech()
    const requestId = ttsRequestId
    const clean = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_`>|~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000)
    if (!clean) return
    updateAudioButton('loading')
    try {
      const res = await bridge.startSpeechStream(clean)
      if (requestId !== ttsRequestId) {
        if (res.requestId) void bridge.cancelSpeechStream?.(res.requestId)
        return
      }
      if (!res.ok || !res.requestId) return updateAudioButton('idle', res.error || 'Voice generation failed')
      activeSpeechStream = res.requestId
    } catch (err) {
      if (requestId === ttsRequestId) {
        updateAudioButton('idle', err instanceof Error ? err.message : 'Voice generation failed')
      }
    }
  }

  bridge.onSpeechStreamEvent?.((event) => {
    if (event.requestId !== activeSpeechStream) return
    const requestId = ttsRequestId
    if (event.type === 'chunk') {
      speechChunkQueue = speechChunkQueue
        .then(() => scheduleSpeechChunk(event.data, event.mime, requestId))
        .catch(() => {
          if (requestId === ttsRequestId) {
            stopSpeech()
            updateAudioButton('idle', 'Voice playback failed')
          }
        })
      return
    }
    if (event.type === 'error') {
      stopSpeech()
      updateAudioButton('idle', event.error || 'Voice stream failed')
      return
    }
    speechStreamDone = true
    if (ttsSources.size === 0) {
      activeSpeechStream = ''
      updateAudioButton('idle')
    }
  })

  /** Liest die Antwort vor, wenn "voiceEnabled" aktiv ist. */
  function speakReplyIfEnabled(text: string) {
    void requestSpeech(text)
  }

  replyAudio.addEventListener('click', (e) => {
    e.stopPropagation()
    if (replyAudio.classList.contains('loading') || replyAudio.classList.contains('playing')) {
      stopSpeech()
    } else {
      void requestSpeech(buffer, true)
    }
  })

  bridge.onPttStart?.(() => {
    void startMicRecording()
  })
  bridge.onPttEnd?.(() => {
    stopMicRecording()
  })

  /* --------------------------------------- klick auf den mikro-knopf (mute) */

  /**
   * Klick-Toggle wie bei einer Mute-Taste: erster Klick startet die Aufnahme,
   * ein weiterer Klick "muted" — stoppt sie und schickt das Gesagte als
   * Nachricht ab (gleicher Pfad wie das Loslassen von Alt+X).
   */
  micBtn.addEventListener('click', () => {
    if (micActive || (mediaRecorder?.state ?? 'inactive') === 'recording') {
      stopMicRecording()
    } else {
      void startMicRecording()
    }
  })
}
