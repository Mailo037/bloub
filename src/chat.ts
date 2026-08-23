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
}

export function mountChat(root: HTMLElement, callbacks?: MountChatCallbacks): void {
  const bridge = getBridge()

  root.innerHTML = `
    <div id="chip-row"></div>
    <div id="note-row"></div>
    <div id="reply" class="hidden">
      <button id="reply-close" aria-label="Hide answer" title="Hide answer">✕</button>
      <div id="reply-scroll"><div id="reply-body"></div></div>
    </div>
    <div id="input-row">
      <textarea id="chat-input" rows="1" placeholder="ask the bloub…" spellcheck="false"></textarea>
      <button id="send" aria-label="Send">➤</button>
    </div>
  `

  const chipRow = root.querySelector('#chip-row') as HTMLElement
  const noteRow = root.querySelector('#note-row') as HTMLElement
  const reply = root.querySelector('#reply') as HTMLElement
  const replyClose = root.querySelector('#reply-close') as HTMLButtonElement | null
  const replyScroll = root.querySelector('#reply-scroll') as HTMLElement
  const replyBody = root.querySelector('#reply-body') as HTMLElement
  const inputRow = root.querySelector('#input-row') as HTMLElement
  const input = root.querySelector('#chat-input') as HTMLTextAreaElement
  const sendBtn = root.querySelector('#send') as HTMLButtonElement

  interface FileChip extends AttachChip {
    id: string
  }

  let fileChips: FileChip[] = []
  let grants: Grant[] = []
  let streaming = false
  let buffer = ''
  let rafPending = false
  let userScrolledUp = false

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
    const minH = 48
    const scrollH = input.scrollHeight
    const capped = Math.max(minH, Math.min(scrollH, 5 * 20 + 24))
    input.style.height = `${capped}px`
  }

  input.addEventListener('input', autosizeInput)

  /* ------------------------------------------------- antwort-eingriffe */

  // Schliessen-Knopf bei Hover ueber die Antwort
  replyClose?.addEventListener('click', (e) => {
    e.stopPropagation()
    noteRow.replaceChildren()
    reply.classList.add('hidden')
    replyBody.replaceChildren()
    buffer = ''
    if (inputRow.classList.contains('collapsed')) {
      root.classList.add('hidden')
    }
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
        userScrolledUp = false
        replyBody.replaceChildren()
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
        userScrolledUp = false
        fileChips = []
        grants = []
        noteRow.replaceChildren()
        replyBody.replaceChildren()
        renderChips()
        reply.classList.add('hidden')
        inputRow.classList.remove('collapsed', 'sending')
        if (!streaming && reply.classList.contains('hidden')) {
          root.classList.add('hidden')
        }
        break
      default:
        break
    }
  })

  /* ---------------------------------------------------------------- init */

  async function init() {
    const cfg = await bridge.getConfig?.()
    grants = cfg?.chat?.grants ?? []
    applyBloubColor(cfg?.color)
    renderChips()
    autosizeInput()
  }

  void init()

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
}
