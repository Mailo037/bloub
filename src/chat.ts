import { initDictation } from './dictation'
import { initLiveVoice } from './live-voice'
import { initModelSelector } from './model-selector'
/**
 * Chat-Dock im Pet-Fenster: Eingabe-Pill plus Antwort unter dem Ball. Kein
 * eigenes Fenster mehr — der Bloub spricht direkt unter sich. Wird von
 * pet.ts gemountet; Sichtbarkeit steuert main.cjs ueber chat:visibility.
 */
import { getBridge, createSvgIcon, type ChatEvent, type AttachChip, type Grant, type ChatSummary, type ChatSearchResult } from './shared'
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
    <div id="pet-chat-toolbar"><button id="pet-compose" title="Nachricht schreiben" aria-label="Nachricht schreiben"><svg viewBox="0 0 24 24"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M16 3l5 5-9 9-5 1 1-5Z"/></svg></button><span class="pet-toolbar-divider" aria-hidden="true"></span><button id="pet-open-chat" title="Chatfenster öffnen" aria-label="Chatfenster öffnen"><svg viewBox="0 0 24 24"><path d="M4 5h16v12H9l-5 4ZM8 9h8M8 13h5"/></svg></button></div>
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
      <textarea id="chat-input" rows="1" placeholder="Nachricht an Bloub…" spellcheck="false"></textarea>
      <button id="mic-hold" type="button" aria-label="Hold to talk" title="Hold to talk">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"/>
          <path d="M5 10a7 7 0 0 0 14 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          <path d="M12 17v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
      </button>
      <button id="send" aria-label="Senden"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
    </div>
    <div id="mic-row" class="hidden">
      <div id="mic-btn" aria-hidden="true">
        <div id="mic-level">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
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
  const micHoldBtn = root.querySelector('#mic-hold') as HTMLButtonElement
  const sendBtn = root.querySelector('#send') as HTMLButtonElement
  const micRow = root.querySelector('#mic-row') as HTMLElement
  const micBtn = root.querySelector('#mic-btn') as HTMLElement
  const micStatus = root.querySelector('#mic-status') as HTMLElement
  const voiceDivider = document.createElement('span')
  voiceDivider.className = 'pet-toolbar-divider'
  voiceDivider.setAttribute('aria-hidden', 'true')
  root.querySelector('#pet-chat-toolbar')!.append(voiceDivider, micHoldBtn)
  inputRow.classList.add('collapsed')
  const dockContent = document.createElement('div')
  dockContent.className = 'pet-dock-content'
  dockContent.append(...Array.from(root.children))
  const mini = document.createElement('button')
  mini.className = 'pet-dock-mini'
  mini.setAttribute('aria-label', 'Bloub-Steuerung öffnen')
  root.append(dockContent, mini)
  let lastTyping = 0
  let awayTimer: ReturnType<typeof setTimeout> | undefined
  function compact(next: boolean) {
    if (next && root.classList.contains('voice-active')) return
    root.classList.toggle('pet-compact', next)
    dockContent.inert = next
    mini.tabIndex = next ? 0 : -1
    if (next) input.blur()
  }
  function proximity(x: number, y: number) {
    const r = root.getBoundingClientRect()
    const distance = Math.hypot(Math.max(0, Math.abs(x - (r.left + r.width / 2)) - 160), Math.max(0, Math.abs(y - r.top) - 100))
    if (distance < 55) { clearTimeout(awayTimer); awayTimer = undefined; compact(false) }
    else if (distance > 130 && !awayTimer) awayTimer = setTimeout(() => {
      awayTimer = undefined
      if (performance.now() - lastTyping > 1800 && !root.querySelector('#mic-hold.holding')) compact(true)
    }, 650)
  }
  bridge.onGlobalCursor?.(p => proximity(p.x, p.y))
  window.addEventListener('pointermove', e => proximity(e.clientX, e.clientY))
  mini.addEventListener('pointerenter', () => compact(false))
  mini.addEventListener('click', () => compact(false))
  input.addEventListener('input', () => { lastTyping = performance.now() })
  compact(false)
  root.classList.remove('hidden')
  root.querySelector('#pet-compose')!.addEventListener('click', () => {
    compact(false)
    root.classList.add('pet-composer-open')
    inputRow.classList.remove('collapsed')
    input.focus()
  })
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'pet-composer-back'
  back.setAttribute('aria-label', 'Eingabe schließen')
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6"/></svg>'
  inputRow.prepend(back)
  back.addEventListener('click', () => { root.classList.remove('pet-composer-open'); inputRow.classList.add('collapsed'); input.blur() })
  root.querySelector('#pet-open-chat')!.addEventListener('click', () => { void bridge.openChatWindow?.() })
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
    const minH = 30
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
        // Eine per Sprache gestartete Nachricht darf nach der Antwort niemals
        // den Transkriptions-Overlay zuruecklassen. Der normale Send-Flow hat
        // die Eingabe bereits eingeklappt; daher bleibt das Dock sauber bei
        // der Antwort, ohne das Mikrofon wieder einzublenden.
        transcribing = false
        hideMicStatus()
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
        // Auch bei einer Provider-/Netzwerkantwort den Sprachzustand beenden,
        // damit der Nutzer wieder direkt eine neue Eingabe machen kann.
        transcribing = false
        hideMicStatus()
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
      compact(false)
      if (!root.classList.contains('pet-composer-open')) inputRow.classList.add('collapsed')
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
  let micStarting = false
  let transcribing = false
  let recordingStream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let levelRaf = 0
  const micLevelEl = root.querySelector('#mic-level') as HTMLElement
  const micBars = Array.from(micLevelEl.querySelectorAll<HTMLElement>('span'))
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
  // Zeitpunkt des echten Drueckens. Das Mikrofon kann nach dem Druecken noch
  // kurz aufwachen; die Haltezeit darf dadurch nicht als versehentlicher Tap
  // fehlinterpretiert werden.
  let holdStartedAt = 0
  /** Kurzmeldungs-Timer (Mic-Row zeigt Fehler/Busy und blendet sich selbst aus). */
  let flashTimer: ReturnType<typeof setTimeout> | null = null

  function showMic(show: boolean) {
    micActive = show
    micRow.classList.toggle('hidden', !show)
    micRow.classList.remove('transcribing', 'starting')
    inputRow.classList.toggle('hidden', show)
    micBtn.classList.toggle('live', show)
    micHoldBtn.classList.toggle('holding', show)
    micHoldBtn.setAttribute('aria-pressed', show ? 'true' : 'false')
    if (show) {
      root.classList.remove('hidden')
      input.blur()
      micBtn.style.setProperty('--lvl', '0')
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
    micRow.classList.remove('transcribing', 'starting')
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
    micRow.classList.remove('hidden', 'speaking', 'starting')
    micRow.classList.add('transcribing')
    inputRow.classList.add('hidden')
    micBtn.classList.remove('live')
    setMicStatus('Transcribing…')
  }

  function hideMicStatus() {
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = null
    micRow.classList.add('hidden')
    micRow.classList.remove('transcribing', 'starting')
    inputRow.classList.remove('hidden')
  }

  /** Sofortiges Feedback beim Druecken, noch bevor getUserMedia fertig ist. */
  function showMicStarting() {
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = null
    micActive = false
    micRow.classList.remove('hidden', 'transcribing', 'speaking')
    micRow.classList.add('starting')
    inputRow.classList.add('hidden')
    micBtn.classList.remove('live')
    micHoldBtn.classList.add('holding')
    micHoldBtn.setAttribute('aria-pressed', 'true')
    root.classList.remove('hidden', 'closing')
    input.blur()
    micBtn.style.setProperty('--lvl', '0')
    setMicStatus('Starting mic… keep holding')
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
      micBtn.style.setProperty('--lvl', String(level.toFixed(3)))
      const barBins = [3, 7, 12, 20, 31]
      for (let i = 0; i < micBars.length; i++) {
        const raw = (data[barBins[i] ?? 3] ?? 0) / 170
        const shaped = Math.min(1, Math.max(level * 0.42, raw))
        micBars[i]!.style.height = `${Math.round(5 + shaped * 23)}px`
      }
      // "speaking"-Klasse setzen, sobald hörbarer Pegel
      if (micRow) micRow.classList.toggle('speaking', level > 0.08)
    }
    levelRaf = requestAnimationFrame(tick)
  }

  function stopLevelAnimation() {
    if (levelRaf) cancelAnimationFrame(levelRaf)
    levelRaf = 0
    if (micRow) micRow.classList.remove('speaking')
    micBtn.style.setProperty('--lvl', '0')
    for (const bar of micBars) bar.style.height = '5px'
  }

  async function startMicRecording() {
    if (root.classList.contains('voice-active')) return
    if (micActive || micStarting) return
    if (transcribing) {
      flashMicStatus('still transcribing…')
      return
    }
    if (streaming) {
      flashMicStatus('wait for the reply, then talk')
      return
    }
    stopRequested = false
    micStarting = true
    if (!holdStartedAt) holdStartedAt = Date.now()
    showMicStarting()
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
      micStarting = false
      holdStartedAt = 0
      flashMicStatus('mic blocked — allow microphone access')
      return
    }
    // Stop-Kommando kam waehrend des async Starts (schneller Tap): Track
    // wieder freigeben und gar nicht erst aufnehmen.
    if (stopRequested) {
      micStarting = false
      holdStartedAt = 0
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
    try {
      mediaRecorder = new MediaRecorder(stream, {
        ...(preferredMime ? { mimeType: preferredMime } : {}),
        audioBitsPerSecond: 64000
      })
    } catch {
      micStarting = false
      holdStartedAt = 0
      stopMicTracks()
      flashMicStatus('microphone recording is unavailable')
      return
    }
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data)
    }
    mediaRecorder.onstop = () => {
      const elapsed = Date.now() - recordingStartedAt
      const heldFor = Date.now() - (holdStartedAt || recordingStartedAt)
      holdStartedAt = 0
      const chunks = audioChunks
      audioChunks = []
      const type = mediaRecorder?.mimeType || 'audio/webm'
      stopMicTracks()
      // Akzeptiere eine bewusst gehaltene Eingabe auch dann, wenn das
      // getUserMedia-Startup einen Teil der Aufnahmezeit beansprucht hat.
      if (chunks.length === 0 || (elapsed < 250 && heldFor < 600)) {
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
    try {
      mediaRecorder.start(250)
    } catch {
      micStarting = false
      holdStartedAt = 0
      stopMicTracks()
      flashMicStatus('microphone recording could not start')
      return
    }
    micStarting = false
    showMic(true)
    startLevelAnimation()
    setMicStatus('Listening… release to send')
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
    if (micStarting) {
      // Start laeuft noch: Stop-Wunsch merken — startMicRecording fuehrt ihn aus.
      stopRequested = true
      hideMicStatus()
      return
    }
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return
    // Loslassen wechselt ohne Flackern direkt von der Live-Welle zur Transkription.
    micActive = false
    micBtn.classList.remove('live')
    micHoldBtn.classList.remove('holding')
    micHoldBtn.setAttribute('aria-pressed', 'false')
    stopLevelAnimation()
    showTranscriptionStatus()
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
      const res = await bridge.transcribeAudio({ mime: 'audio/wav', data: base64, source: 'voice-chat' })
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

  /* ------------------------------------------ press-and-hold mikro-knopf */

  let holdPointerId: number | null = null
  let keyboardHolding = false

  function finishPointerHold(pointerId: number) {
    if (holdPointerId !== pointerId) return
    holdPointerId = null
    try {
      if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId)
    } catch { /* pointer already gone */ }
    stopMicRecording()
  }

  function finishKeyboardHold() {
    if (!keyboardHolding) return
    keyboardHolding = false
    stopMicRecording()
  }

  function finishAnyHold() {
    if (holdPointerId !== null) finishPointerHold(holdPointerId)
    finishKeyboardHold()
  }

  const liveVoice = initLiveVoice(root, micHoldBtn, active => callbacks?.onListeningChange?.(active))
  bridge.onChatVisibility?.(visible => { if (!visible && liveVoice.active) liveVoice.stop() })
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && liveVoice.active) { liveVoice.stop(); event.stopImmediatePropagation() } }, true)
}

/* =====================================================================
   Standalone Chat Window Application
   ===================================================================== */

function initStandaloneChat(): void {
  const bridge = getBridge()
  const winMin = document.getElementById('win-min') as HTMLButtonElement | null
  const winMax = document.getElementById('win-max') as HTMLButtonElement | null
  const winClose = document.getElementById('win-close') as HTMLButtonElement | null
  const toggleHistoryBtn = document.getElementById('toggle-history-btn') as HTMLButtonElement | null
  const closeHistoryBtn = document.getElementById('close-history-btn') as HTMLButtonElement | null
  const historyDrawer = document.getElementById('history-drawer') as HTMLElement | null
  const historySearchInput = document.getElementById('history-search-input') as HTMLInputElement | null
  const historyList = document.getElementById('history-list') as HTMLElement | null
  const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement | null
  const currentChatTitle = document.getElementById('current-chat-title') as HTMLElement | null
  const renameChatInput = document.getElementById('rename-chat-input') as HTMLInputElement | null
  const emptyState = document.getElementById('empty-state') as HTMLElement | null
  const recentChatsList = document.getElementById('recent-chats-list') as HTMLElement | null
  const btnShowAllChats = document.getElementById('btn-show-all-chats') as HTMLButtonElement | null
  const messagesContainer = document.getElementById('messages-container') as HTMLElement | null
  const chatNotesBar = document.getElementById('chat-notes-bar') as HTMLElement | null
  const composerAttachBtn = document.getElementById('composer-attach-btn') as HTMLButtonElement | null
  const hiddenFileInput = document.getElementById('hidden-file-input') as HTMLInputElement | null
  const standaloneInput = document.getElementById('standalone-input') as HTMLTextAreaElement | null
  const composerMicBtn = document.getElementById('composer-mic-btn') as HTMLButtonElement | null
  const standaloneSendBtn = document.getElementById('standalone-send-btn') as HTMLButtonElement | null
  const sendIcon = document.getElementById('send-icon') as HTMLElement | null
  const stopIcon = document.getElementById('stop-icon') as HTMLElement | null
  initModelSelector(bridge)

  if (!standaloneInput || !standaloneSendBtn) return

  let activeChatId = 'default'
  const generatingByChat = new Map<string, boolean>()
  const workingByChat = new Map<string, boolean>()
  const workingIndicator = document.createElement('div')
  workingIndicator.className = 'chat-working hidden'
  workingIndicator.setAttribute('role', 'status')
  workingIndicator.setAttribute('aria-live', 'polite')
  workingIndicator.innerHTML = '<span class="chat-working-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Bloub arbeitet …</span>'
  function renderWorkingIndicator() {
    const visible = !!generatingByChat.get(activeChatId) && !!workingByChat.get(activeChatId)
    workingIndicator.classList.toggle('hidden', !visible)
    messagesContainer?.append(workingIndicator)
    if (visible) {
      emptyState?.classList.add('hidden')
      messagesContainer?.classList.remove('hidden')
      scrollToBottom()
    }
  }
  const streamingTextByChat = new Map<string, string>()
  let activeAssistantBubble: HTMLElement | null = null
  let activeAttachments: AttachChip[] = []

  // Window controls
  winMin?.addEventListener('click', () => bridge.minimizeChatWindow?.())
  winMax?.addEventListener('click', () => bridge.maximizeChatWindow?.())
  winClose?.addEventListener('click', () => bridge.closeChatWindow?.())

  // Drawer toggling
  const openDrawer = () => {
    historyDrawer?.classList.remove('hidden')
    refreshHistory()
    historySearchInput?.focus()
  }
  const closeDrawer = () => {
    historyDrawer?.classList.add('hidden')
  }
  toggleHistoryBtn?.addEventListener('click', () => {
    if (historyDrawer?.classList.contains('hidden')) openDrawer()
    else closeDrawer()
  })
  closeHistoryBtn?.addEventListener('click', closeDrawer)
  btnShowAllChats?.addEventListener('click', openDrawer)

  // Measure the actual compact layout on every input, then apply the final
  // layout synchronously (no intermediate frame). Never measure a tall input
  // to decide whether it fits beside the tools; that makes the state oscillate.
  function refreshComposerLayout() {
    if (!standaloneInput) return
    const pill = standaloneInput.closest<HTMLElement>('.composer-pill')
    if (!pill || pill.classList.contains('dictating')) return
    const attach = pill.querySelector('#composer-attach-btn')
    const actions = pill.querySelector('.composer-actions')
    if (!attach || !actions) return
    const scrollTop = standaloneInput.scrollTop
    pill.classList.remove('composer-tall')
    standaloneInput.before(attach)
    standaloneInput.style.height = '30px'
    const stack = standaloneInput.value.length > 0 && standaloneInput.scrollHeight > standaloneInput.clientHeight
    pill.classList.toggle('composer-tall', stack)
    if (stack) {
      actions.before(attach)
      // Measure height only AFTER the input has its final full-row width.
      standaloneInput.style.height = '30px'
      standaloneInput.style.height = `${Math.min(standaloneInput.scrollHeight, 140)}px`
    }
    standaloneInput.scrollTop = scrollTop
  }
  standaloneInput.addEventListener('input', refreshComposerLayout)
  window.addEventListener('resize', refreshComposerLayout)
  refreshComposerLayout()

  // Keyboard shortcut: Enter sends, Shift+Enter newline
  standaloneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      triggerSend()
    }
  })

  // Rename handling
  currentChatTitle?.addEventListener('click', () => {
    if (!renameChatInput || !currentChatTitle) return
    currentChatTitle.classList.add('hidden')
    renameChatInput.classList.remove('hidden')
    renameChatInput.value = currentChatTitle.textContent ?? ''
    renameChatInput.focus()
    renameChatInput.select()
  })

  const saveRename = async () => {
    if (!renameChatInput || !currentChatTitle) return
    const newTitle = renameChatInput.value.trim()
    renameChatInput.classList.add('hidden')
    currentChatTitle.classList.remove('hidden')
    if (newTitle && newTitle !== currentChatTitle.textContent) {
      currentChatTitle.textContent = newTitle
      await bridge.renameChat?.(activeChatId, newTitle)
      refreshHistory()
    }
  }

  renameChatInput?.addEventListener('blur', saveRename)
  renameChatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      renameChatInput?.blur()
    } else if (e.key === 'Escape') {
      if (renameChatInput && currentChatTitle) {
        renameChatInput.value = currentChatTitle.textContent ?? ''
        renameChatInput.classList.add('hidden')
        currentChatTitle.classList.remove('hidden')
      }
    }
  })

  // New Chat
  newChatBtn?.addEventListener('click', async () => {
    const session = await bridge.newChat?.()
    if (session) {
      switchToChat(session.id)
    }
  })

  // File attach handling
  composerAttachBtn?.addEventListener('click', () => {
    hiddenFileInput?.click()
  })
  hiddenFileInput?.addEventListener('change', async () => {
    const files = Array.from(hiddenFileInput?.files || [])
    if (!files.length) return
    const paths = files.map((f) => bridge.pathForFile?.(f) || '').filter(Boolean)
    if (paths.length && bridge.attachPaths) {
      const res = await bridge.attachPaths(paths) as unknown as { ok?: boolean; chips?: AttachChip[] }
      if (res?.chips) {
        for (const chip of res.chips) {
          if (!activeAttachments.some((a) => a.id === chip.id)) {
            activeAttachments.push(chip)
          }
        }
        renderAttachmentChips()
      }
    }
    if (hiddenFileInput) hiddenFileInput.value = ''
  })

  function renderAttachmentChips() {
    if (!chatNotesBar) return
    if (activeAttachments.length === 0) {
      chatNotesBar.classList.add('hidden')
      chatNotesBar.innerHTML = ''
      return
    }
    chatNotesBar.classList.remove('hidden')
    chatNotesBar.innerHTML = ''
    for (const chip of activeAttachments) {
      const el = document.createElement('span')
      el.className = 'activity-note-pill'
      el.innerHTML = `📎 ${escapeHtml(chip.name)} <button type="button" class="remove-chip-btn" style="background:none;border:none;color:inherit;cursor:pointer;margin-left:4px">✕</button>`
      el.querySelector('.remove-chip-btn')!.addEventListener('click', () => {
        activeAttachments = activeAttachments.filter((a) => a.id !== chip.id)
        renderAttachmentChips()
      })
      chatNotesBar.appendChild(el)
    }
  }

  // Refresh history list (supports query with bridge.searchChats)
  async function refreshHistory(filter = '') {
    if (!bridge.listChats || !historyList) return
    const query = filter.trim()
    historyList.innerHTML = ''

    if (query && bridge.searchChats) {
      const searchResults = await bridge.searchChats(query)
      for (const res of searchResults) {
        const item = document.createElement('div')
        item.className = `history-item ${res.id === activeChatId ? 'active' : ''}`
        item.innerHTML = `
          <div class="history-item-content">
            <span class="history-item-title">${escapeHtml(res.title)}</span>
            <span class="history-item-meta">${escapeHtml(res.snippet || 'Treffer')}</span>
          </div>
        `
        item.addEventListener('click', () => {
          switchToChat(res.id)
          closeDrawer()
        })
        historyList.appendChild(item)
      }
      return
    }

    const allChats = await bridge.listChats()
    for (const chat of allChats) {
      const snippet = chat.lastSnippet || chat.lastMessage || ''
      const item = document.createElement('div')
      item.className = `history-item ${chat.id === activeChatId ? 'active' : ''}`
      item.innerHTML = `
        <div class="history-item-content">
          <span class="history-item-title">${escapeHtml(chat.title)}</span>
          ${snippet ? `<span class="history-item-meta">${escapeHtml(snippet)}</span>` : ''}
        </div>
        <div class="history-item-actions">
          <button class="item-action-btn more" title="Chat verwalten" aria-label="Chat verwalten" aria-expanded="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button>
          <div class="history-action-menu hidden">
            <button class="item-action-btn regen-title">Titel neu generieren</button>
            <button class="item-action-btn archive">Archivieren</button>
          </div>
        </div>
      `
      const more = item.querySelector<HTMLButtonElement>('.more')!
      const menu = item.querySelector<HTMLElement>('.history-action-menu')!
      const hideMenu = () => { menu.classList.add('hidden'); more.setAttribute('aria-expanded', 'false') }
      more.onclick = () => {
        const open = menu.classList.contains('hidden')
        historyList.querySelectorAll('.history-action-menu').forEach(m => m.classList.add('hidden'))
        historyList.querySelectorAll('.more').forEach(b => b.setAttribute('aria-expanded', 'false'))
        if (open) {
          menu.classList.remove('hidden')
          more.setAttribute('aria-expanded', 'true')
          const r = more.getBoundingClientRect()
          menu.style.left = Math.max(8, Math.min(r.right - 190, window.innerWidth - 198)) + 'px'
          menu.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) + 'px'
        }
      }
      item.addEventListener('focusout', e => { if (!item.contains(e.relatedTarget as Node)) hideMenu() })
      item.addEventListener('keydown', e => { if (e.key === 'Escape') { hideMenu(); more.focus() } })
      const content = item.querySelector<HTMLElement>('.history-item-content')!
      content.tabIndex = 0
      content.setAttribute('role', 'button')
      content.setAttribute('aria-label', chat.title)
      content.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); content.click() } })
      item.querySelector('.history-item-content')!.addEventListener('click', () => {
        switchToChat(chat.id)
        closeDrawer()
      })
      item.querySelector('.item-action-btn.regen-title')!.addEventListener('click', async (e) => {
        e.stopPropagation()
        hideMenu()
        const newTitle = await bridge.regenerateChatTitle?.(chat.id)
        if (newTitle && activeChatId === chat.id && currentChatTitle) {
          currentChatTitle.textContent = newTitle
        }
        refreshHistory(historySearchInput?.value || '')
      })
      item.querySelector('.item-action-btn.archive')!.addEventListener('click', async (e) => {
        e.stopPropagation()
        hideMenu()
        await bridge.archiveChat?.(chat.id)
        if (activeChatId === chat.id) {
          const fresh = await bridge.newChat?.()
          if (fresh) switchToChat(fresh.id)
        } else {
          refreshHistory(historySearchInput?.value || '')
        }
      })
      historyList.appendChild(item)
    }

    // Also update recent chats on empty state
    if (recentChatsList) {
      recentChatsList.innerHTML = ''
      const recents = allChats.filter(c => c.id !== activeChatId).slice(0, 3)
      for (const c of recents) {
        const date = new Date(c.updatedAt || c.createdAt || 0)
        const today = new Date()
        const yesterday = new Date(today)
        yesterday.setDate(today.getDate() - 1)
        const dateLabel = date.toDateString() === today.toDateString() ? 'Heute'
          : date.toDateString() === yesterday.toDateString() ? 'Gestern'
          : date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'recent-chat-chip'
        chip.innerHTML = `
          <div class="recent-chat-chip-title">${escapeHtml(c.title)}</div>
          <span class="recent-chat-chip-date">${escapeHtml(dateLabel)}</span>
        `
        chip.addEventListener('click', () => {
          switchToChat(c.id)
        })
        recentChatsList.appendChild(chip)
      }
    }
  }

  historySearchInput?.addEventListener('input', () => {
    refreshHistory(historySearchInput.value)
  })

  // Switch chat: preserves messages and in-flight generation state
  async function switchToChat(chatId: string) {
    activeChatId = chatId
    await bridge.selectChat?.(chatId)
    const chat = await bridge.getChat?.(chatId)
    if (currentChatTitle) {
      currentChatTitle.textContent = chat?.title || 'Chat'
    }

    if (messagesContainer) {
      messagesContainer.innerHTML = ''
      const records = chat?.records || []
      const isChatGenerating = !!generatingByChat.get(chatId)
      const currentStreaming = streamingTextByChat.get(chatId) || ''

      if (records.length === 0 && !isChatGenerating) {
        emptyState?.classList.remove('hidden')
        messagesContainer.classList.add('hidden')
      } else {
        emptyState?.classList.add('hidden')
        messagesContainer.classList.remove('hidden')
        for (const rec of records) {
          if (rec.role === 'user') {
            const text = rec.parts?.[0]?.text || rec.content || ''
            appendMessageBubble('user', text)
          } else if (rec.role === 'assistant') {
            appendMessageBubble('assistant', rec.content || '')
          }
        }
        if (isChatGenerating) {
          const row = document.createElement('div')
          row.className = 'message-row assistant'
          const content = document.createElement('div')
          content.className = 'assistant-content'
          content.replaceChildren(renderMarkdownLite(currentStreaming))
          row.appendChild(content)
          messagesContainer.appendChild(row)
          activeAssistantBubble = content
        } else {
          activeAssistantBubble = null
        }
        scrollToBottom()
      }
      setGenerating(isChatGenerating)
    }
    refreshHistory()
  }

  function appendMessageBubble(role: 'user' | 'assistant', text: string): HTMLElement {
    emptyState?.classList.add('hidden')
    messagesContainer?.classList.remove('hidden')
    const row = document.createElement('div')
    row.className = `message-row ${role}`
    if (role === 'user') {
      const bubble = document.createElement('div')
      bubble.className = 'user-bubble'
      bubble.textContent = text
      row.appendChild(bubble)
    } else {
      const content = document.createElement('div')
      content.className = 'assistant-content'
      content.replaceChildren(renderMarkdownLite(text))
      row.appendChild(content)
    }
    messagesContainer?.appendChild(row)
    scrollToBottom()
    return row
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function setGenerating(generating: boolean) {
    if (!generating) workingByChat.delete(activeChatId)
    renderWorkingIndicator()
    sendIcon?.classList.toggle('hidden', generating)
    stopIcon?.classList.toggle('hidden', !generating)
    standaloneSendBtn?.classList.toggle('stop', generating)
    if (standaloneSendBtn) {
      standaloneSendBtn.title = generating ? 'Abbrechen' : 'Senden'
    }
  }

  async function triggerSend() {
    if (standaloneInput?.closest('.composer-pill')?.classList.contains('dictating')) return
    if (generatingByChat.get(activeChatId)) {
      bridge.abortChat?.(activeChatId)
      generatingByChat.set(activeChatId, false)
      setGenerating(false)
      return
    }
    const text = standaloneInput?.value.trim() || ''
    if (!text && activeAttachments.length === 0) return

    if (standaloneInput) {
      standaloneInput.value = ''
      refreshComposerLayout()
    }

    const toSendIds = activeAttachments.map((a) => a.id).filter(Boolean) as string[]
    activeAttachments = []
    renderAttachmentChips()

    appendMessageBubble('user', text)
    generatingByChat.set(activeChatId, true)
    workingByChat.set(activeChatId, true)
    streamingTextByChat.set(activeChatId, '')
    setGenerating(true)

    // Create placeholder assistant row
    const row = document.createElement('div')
    row.className = 'message-row assistant'
    const content = document.createElement('div')
    content.className = 'assistant-content'
    row.appendChild(content)
    messagesContainer?.appendChild(row)
    activeAssistantBubble = content
    renderWorkingIndicator()
    scrollToBottom()

    const sentChatId = activeChatId
    try {
      await bridge.sendChat?.({
        text,
        attachmentIds: toSendIds,
        chatId: sentChatId
      })
    } catch (err) {
      generatingByChat.set(sentChatId, false)
      workingByChat.delete(sentChatId)
      if (activeChatId === sentChatId) {
        setGenerating(false)
        const errNotice = document.createElement('div')
        errNotice.className = 'error-notice'
        errNotice.textContent = `Fehler beim Senden: ${err instanceof Error ? err.message : String(err)}`
        activeAssistantBubble?.appendChild(errNotice)
      }
    }
  }

  standaloneSendBtn.addEventListener('click', triggerSend)

  const dictation = initDictation(bridge, standaloneInput, composerMicBtn, triggerSend, () => activeChatId)
  const startStandaloneRecording = () => dictation.start()
  const stopStandaloneRecording = () => dictation.stop()

  // Route PTT events if chat window is focused
  bridge.onPttStart?.(() => {
    if (document.hasFocus()) {
      void startStandaloneRecording()
    }
  })
  bridge.onPttEnd?.(() => {
    if (dictation.isRecording) {
      stopStandaloneRecording()
    }
  })

  // Listen to bridge events
  bridge.onChatEvent?.((ev) => {
    const targetChat = ev.chatId || activeChatId

    if (ev.type === 'accepted' || ev.type === 'tools' || ev.type === 'status') {
      generatingByChat.set(targetChat, true)
      workingByChat.set(targetChat, true)
      if (targetChat === activeChatId) setGenerating(true)
    } else if (ev.type === 'token') {
      workingByChat.set(targetChat, false)
      if (targetChat === activeChatId) renderWorkingIndicator()
      const current = (streamingTextByChat.get(targetChat) || '') + ev.text
      streamingTextByChat.set(targetChat, current)
      if (targetChat === activeChatId && activeAssistantBubble) {
        activeAssistantBubble.replaceChildren(renderMarkdownLite(current))
        scrollToBottom()
      }
    } else if (ev.type === 'note') {
      if (targetChat === activeChatId && chatNotesBar) {
        chatNotesBar.classList.remove('hidden')
        const pill = document.createElement('span')
        pill.className = 'activity-note-pill'
        pill.textContent = ev.text
        chatNotesBar.appendChild(pill)
        setTimeout(() => pill.remove(), 4000)
      }
    } else if (ev.type === 'attachments') {
      if (targetChat === activeChatId && ev.chips) {
        for (const c of ev.chips) {
          if (!activeAttachments.some((a) => a.id === c.id)) {
            activeAttachments.push(c)
          }
        }
        renderAttachmentChips()
      }
    } else if (ev.type === 'title') {
      if (ev.title) {
        if (targetChat === activeChatId && currentChatTitle) {
          currentChatTitle.textContent = ev.title
        }
        refreshHistory()
      }
    } else if (ev.type === 'clear') {
      workingByChat.set(targetChat, true)
      if (targetChat === activeChatId) renderWorkingIndicator()
      streamingTextByChat.set(targetChat, '')
      if (targetChat === activeChatId && activeAssistantBubble) {
        activeAssistantBubble.innerHTML = ''
      }
    } else if (ev.type === 'done') {
      generatingByChat.set(targetChat, false)
      streamingTextByChat.delete(targetChat)
      if (targetChat === activeChatId) {
        setGenerating(false)
        activeAssistantBubble = null
        refreshHistory()
      }
    } else if (ev.type === 'error') {
      generatingByChat.set(targetChat, false)
      if (targetChat === activeChatId) {
        setGenerating(false)
        if (activeAssistantBubble) {
          const errNotice = document.createElement('div')
          errNotice.className = 'error-notice'
          errNotice.textContent = `Fehler: ${ev.message}`
          activeAssistantBubble.appendChild(errNotice)
        }
      }
    }
  })

  // Start with active chat
  bridge.getActiveChat?.().then((id) => {
    switchToChat(id || 'default')
  }).catch(() => {
    switchToChat('default')
  })
}

if (typeof document !== 'undefined' && document.getElementById('standalone-chat')) {
  initStandaloneChat()
}
