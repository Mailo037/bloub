/**
 * Eigenstaendiges Chatfenster: Verlauf mehrerer Chats, Streaming-Antworten mit
 * sichtbaren Arbeitsschritten, Anhaenge (Knopf, Drag & Drop, Einfuegen),
 * verstaendliche Fehler mit "Retry" und eine Chat-Liste mit Suche.
 */
import { initDictation } from './dictation'
import { initModelSelector } from './model-selector'
import { getBridge, createSvgIcon, frozenPreview, type AttachChip, type ChatEvent, type ChatRecord, type ChatSummary } from './shared'
import { renderMarkdownLite } from './markdown-lite'
import { activityLabel, formatBytes, friendlyError, isSystemNote, userMessageView } from './chat-format'
import { confirmDialog } from './ui/kit'

/** Prompt, mit dem main.cjs einen Datei-Drop auf den Bloub selbst ausloest. */
const DROP_INSPECT_PROMPT = 'The user just dropped these files onto you. Inspect them and tell them what they are.'

const SUGGESTIONS: Array<{ label: string; prompt: string; send: boolean }> = [
  { label: 'What can you do?', prompt: 'What can you do? Give me a short overview of how you can help me.', send: true },
  { label: "What's on my screen?", prompt: 'Take a look at my screen and tell me what you see.', send: true },
  { label: 'Summarize a text', prompt: 'Summarize this in a few short bullet points:\n\n', send: false },
  { label: 'Surprise me with a new look', prompt: 'Surprise me: give yourself a new shape and color that fits my mood today!', send: true }
]

interface RunState {
  generating: boolean
  /** Kein Text im aktuellen Segment — der Bloub denkt oder arbeitet mit Tools. */
  working: boolean
  text: string
  status: string
  steps: string[]
  /** Turn wurde in diesem Fenster gestartet (accepted-Echo nicht doppelt rendern). */
  selfSent: boolean
}

interface LiveRow {
  row: HTMLElement
  content: HTMLElement
  activity: HTMLDetailsElement
}

interface PendingAttachment {
  chip: AttachChip
  /** Object-URL fuer Bild-Vorschauen (nur wenn eine Datei vorlag) */
  preview?: string
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el
}

function icon(svg: string): Element {
  const t = document.createElement('template')
  t.innerHTML = svg.trim()
  return t.content.firstElementChild!
}

const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>'
const ICON_RETRY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
const ICON_STEPS = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'
const ICON_MORE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>'

function initStandaloneChat(): void {
  const bridge = getBridge()
  const historyDrawer = $('history-drawer')
  const drawerScrim = $('drawer-scrim')
  const toggleHistoryBtn = $('toggle-history-btn') as HTMLButtonElement
  const historySearchInput = $('history-search-input') as HTMLInputElement
  const historyList = $('history-list')
  const currentChatTitle = $('current-chat-title') as HTMLButtonElement
  const currentChatTitleText = currentChatTitle.querySelector<HTMLElement>('.chat-title-text')!
  const renameChatInput = $('rename-chat-input') as HTMLInputElement
  const emptyState = $('empty-state')
  const welcomeTitle = $('welcome-title')
  const welcomeAvatar = $('welcome-avatar')
  const setupCallout = $('setup-callout')
  const suggestionsEl = $('suggestions')
  const recentBox = $('recent-chats-box')
  const recentChatsList = $('recent-chats-list')
  const messagesContainer = $('messages-container')
  const jumpLatest = $('jump-latest') as HTMLButtonElement
  const attachmentTray = $('attachment-tray')
  const hiddenFileInput = $('hidden-file-input') as HTMLInputElement
  const input = $('standalone-input') as HTMLTextAreaElement
  const composerMicBtn = $('composer-mic-btn') as HTMLButtonElement
  const sendBtn = $('standalone-send-btn') as HTMLButtonElement
  const sendIcon = $('send-icon')
  const stopIcon = $('stop-icon')
  const composerHint = $('composer-hint')
  const dropOverlay = $('drop-overlay')
  const toast = $('toast')
  initModelSelector(bridge)

  let activeChatId = 'default'
  const runs = new Map<string, RunState>()
  let live: LiveRow | null = null
  let pending: PendingAttachment[] = []
  let stickToBottom = true
  let renderQueued = false
  let switchSerial = 0
  let dialogOpen = false

  const workingIndicator = document.createElement('div')
  workingIndicator.className = 'chat-working hidden'
  workingIndicator.setAttribute('role', 'status')
  workingIndicator.setAttribute('aria-live', 'polite')
  workingIndicator.innerHTML = '<span class="chat-working-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="chat-working-text">Thinking…</span>'
  const workingText = workingIndicator.querySelector<HTMLElement>('.chat-working-text')!

  function run(chatId = activeChatId): RunState | undefined {
    return runs.get(chatId)
  }

  function ensureRun(chatId: string): RunState {
    let r = runs.get(chatId)
    if (!r) {
      r = { generating: false, working: false, text: '', status: '', steps: [], selfSent: false }
      runs.set(chatId, r)
    }
    return r
  }

  const isGenerating = (chatId = activeChatId) => !!run(chatId)?.generating

  /* ------------------------------------------------------------ toast */

  let toastTimer: ReturnType<typeof setTimeout> | undefined
  function showToast(text: string, ms = 2600) {
    clearTimeout(toastTimer)
    toast.textContent = text
    toast.classList.remove('hidden')
    toastTimer = setTimeout(() => toast.classList.add('hidden'), ms)
  }

  /* --------------------------------------------------- window controls */

  $('win-min').addEventListener('click', () => bridge.minimizeChatWindow?.())
  $('win-max').addEventListener('click', () => bridge.maximizeChatWindow?.())
  $('win-close').addEventListener('click', () => bridge.closeChatWindow?.())
  $('setup-open-settings').addEventListener('click', () => bridge.openSettingsTab?.('connections'))

  /* ------------------------------------------------------------ drawer */

  const drawerOpen = () => !historyDrawer.classList.contains('hidden')
  function openDrawer(focusSearch = true) {
    historyDrawer.classList.remove('hidden')
    drawerScrim.classList.remove('hidden')
    toggleHistoryBtn.setAttribute('aria-expanded', 'true')
    void refreshHistory(historySearchInput.value)
    if (focusSearch) historySearchInput.focus()
  }
  function closeDrawer() {
    historyDrawer.classList.add('hidden')
    drawerScrim.classList.add('hidden')
    toggleHistoryBtn.setAttribute('aria-expanded', 'false')
  }
  toggleHistoryBtn.addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()))
  $('close-history-btn').addEventListener('click', closeDrawer)
  drawerScrim.addEventListener('click', closeDrawer)
  $('btn-show-all-chats').addEventListener('click', () => openDrawer())
  historySearchInput.addEventListener('input', () => void refreshHistory(historySearchInput.value))
  historySearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (historySearchInput.value) {
        historySearchInput.value = ''
        void refreshHistory('')
      } else closeDrawer()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      historyList.querySelector<HTMLElement>('.history-item-content')?.focus()
    }
  })

  /* ------------------------------------------------------------ composer */

  // Measure the actual compact layout on every input, then apply the final
  // layout synchronously (no intermediate frame). Never measure a tall input
  // to decide whether it fits beside the tools; that makes the state oscillate.
  function refreshComposerLayout() {
    const pill = input.closest<HTMLElement>('.composer-pill')
    if (!pill || pill.classList.contains('dictating')) return
    const attach = pill.querySelector('#composer-attach-btn')
    const actions = pill.querySelector('.composer-actions')
    if (!attach || !actions) return
    const scrollTop = input.scrollTop
    pill.classList.remove('composer-tall')
    input.before(attach)
    input.style.height = '30px'
    const stack = input.value.length > 0 && input.scrollHeight > input.clientHeight
    pill.classList.toggle('composer-tall', stack)
    if (stack) {
      actions.before(attach)
      // Measure height only AFTER the input has its final full-row width.
      input.style.height = '30px'
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`
    }
    input.scrollTop = scrollTop
  }
  input.addEventListener('input', refreshComposerLayout)
  window.addEventListener('resize', refreshComposerLayout)
  refreshComposerLayout()

  function setComposerText(text: string) {
    input.value = text
    refreshComposerLayout()
    input.focus()
    input.setSelectionRange(text.length, text.length)
  }

  function updateComposerHint() {
    composerHint.textContent = isGenerating()
      ? 'Bloub is answering · Esc or ■ to stop'
      : 'Enter to send · Shift+Enter for a new line · drop files to attach'
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      // Enter darf eine laufende Antwort nie abbrechen — nur der Stop-Knopf/Esc.
      if (isGenerating()) {
        showToast('Bloub is still answering — press Esc or ■ to stop it first.')
        return
      }
      void send()
    }
  })

  sendBtn.addEventListener('click', () => {
    if (isGenerating()) stopGenerating()
    else void send()
  })

  /* ---------------------------------------------------------- anhaenge */

  $('composer-attach-btn').addEventListener('click', () => hiddenFileInput.click())
  hiddenFileInput.addEventListener('change', () => {
    void addFiles(Array.from(hiddenFileInput.files || []))
    hiddenFileInput.value = ''
  })

  input.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  })

  // Drag & Drop ins ganze Fenster
  let dragDepth = 0
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth++
    dropOverlay.classList.remove('hidden')
  })
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) dropOverlay.classList.add('hidden')
  })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    dropOverlay.classList.add('hidden')
    void addFiles(Array.from(e.dataTransfer?.files ?? []))
  })

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
  }

  async function addFiles(files: File[]) {
    for (const file of files) {
      try {
        const path = bridge.pathForFile?.(file) || ''
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
        let chips: AttachChip[] = []
        if (path) {
          chips = (await bridge.attachPaths?.([path], { inspect: false }))?.chips ?? []
        } else if (file.type.startsWith('image/')) {
          const res = await bridge.attachData?.({ name: file.name, mime: file.type, data: await fileToBase64(file) })
          if (res?.ok && res.chip) chips = [res.chip]
          else showToast(res?.error || 'Could not attach the pasted image.')
        } else {
          showToast(`“${file.name || 'This item'}” can't be attached — save it as a file first.`)
        }
        for (const chip of chips) {
          if (chip.kind === 'grant') {
            showToast(`Bloub can now access the folder “${chip.name}”.`, 3600)
          } else if (!chip.id) {
            showToast(`“${chip.name}” can't be attached: ${chip.note || 'unsupported file type'}.`, 3600)
          } else if (!pending.some((p) => p.chip.id === chip.id)) {
            pending.push({ chip, preview: chip.kind === 'image' ? preview : undefined })
          }
        }
      } catch (err) {
        showToast(`Could not attach “${file.name}”: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    renderAttachmentTray()
    input.focus()
  }

  function attachmentChip(chip: AttachChip, preview?: string, onRemove?: () => void): HTMLElement {
    const el = document.createElement('span')
    el.className = `attach-chip${chip.note ? ' has-note' : ''}`
    el.title = chip.note ? `${chip.name} — ${chip.note}` : chip.name
    if (preview) {
      const img = document.createElement('img')
      img.src = preview
      img.alt = ''
      img.className = 'attach-thumb'
      el.append(img)
    } else {
      el.append(createSvgIcon(chip.kind === 'image' ? 'image' : chip.kind === 'folder' || chip.kind === 'grant' ? 'folder' : 'text', 14))
    }
    const copy = document.createElement('span')
    copy.className = 'attach-copy'
    const name = document.createElement('span')
    name.className = 'attach-name'
    name.textContent = chip.name
    copy.append(name)
    const meta = chip.note || formatBytes(chip.size)
    if (meta) {
      const small = document.createElement('small')
      small.textContent = meta
      copy.append(small)
    }
    el.append(copy)
    if (onRemove) {
      const rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'attach-remove'
      rm.title = `Remove ${chip.name}`
      rm.setAttribute('aria-label', `Remove ${chip.name}`)
      rm.textContent = '✕'
      rm.addEventListener('click', onRemove)
      el.append(rm)
    }
    return el
  }

  function renderAttachmentTray() {
    attachmentTray.classList.toggle('hidden', pending.length === 0)
    attachmentTray.replaceChildren(
      ...pending.map((p) =>
        attachmentChip(p.chip, p.preview, () => {
          pending = pending.filter((x) => x !== p)
          renderAttachmentTray()
          input.focus()
        })
      )
    )
  }

  /* ------------------------------------------------------------ scrolling */

  const nearBottom = () => messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80
  messagesContainer.addEventListener('scroll', () => {
    stickToBottom = nearBottom()
    jumpLatest.classList.toggle('hidden', stickToBottom)
  }, { passive: true })
  jumpLatest.addEventListener('click', () => {
    stickToBottom = true
    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' })
    jumpLatest.classList.add('hidden')
  })

  function scrollToBottom(force = false) {
    if (force) stickToBottom = true
    if (stickToBottom) messagesContainer.scrollTop = messagesContainer.scrollHeight
  }

  /* -------------------------------------------------------- empty state */

  function showConversation(show: boolean) {
    emptyState.classList.toggle('hidden', show)
    messagesContainer.classList.toggle('hidden', !show)
    if (!show) jumpLatest.classList.add('hidden')
  }

  function greeting(): string {
    const h = new Date().getHours()
    if (h < 5) return 'Up late? I\'m here.'
    if (h < 12) return 'Good morning!'
    if (h < 18) return 'Good afternoon!'
    return 'Good evening!'
  }

  function renderSuggestions() {
    suggestionsEl.replaceChildren(
      ...SUGGESTIONS.map((s) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'suggestion'
        b.textContent = s.label
        b.title = s.send ? s.prompt : 'Fill in the message box'
        b.addEventListener('click', () => {
          setComposerText(s.prompt)
          if (s.send) void send()
        })
        return b
      })
    )
  }
  renderSuggestions()

  async function refreshWelcome() {
    welcomeTitle.textContent = greeting()
    try {
      const cfg = await bridge.getConfig()
      welcomeAvatar.replaceChildren(frozenPreview(64, { shapeId: cfg.shape, colorId: cfg.color, expressionId: cfg.expression }))
      const baseUrl = cfg.chat?.baseUrl || ''
      const local = /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl)
      const keyStatus = await bridge.getApiKeyStatus?.()
      const missing = !cfg.chat?.model || (!local && keyStatus?.hasKey === false)
      setupCallout.classList.toggle('hidden', !missing)
    } catch {
      setupCallout.classList.add('hidden')
    }
  }
  bridge.onConfigChanged(() => void refreshWelcome())

  /* ------------------------------------------------------- message rows */

  function addCopyButton(actions: HTMLElement, source: HTMLElement) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-copy'
    button.title = 'Copy message'
    button.setAttribute('aria-label', 'Copy message')
    button.append(icon(ICON_COPY))
    const label = document.createElement('span')
    label.textContent = 'Copy'
    label.setAttribute('aria-live', 'polite')
    button.append(label)
    let reset: ReturnType<typeof setTimeout> | undefined
    button.addEventListener('click', async () => {
      // Read at click time so streaming messages copy their latest text.
      const text = source.innerText
      if (!text.trim()) return
      clearTimeout(reset)
      try {
        await navigator.clipboard.writeText(text)
        label.textContent = 'Copied'
      } catch {
        label.textContent = 'Copy failed'
      }
      reset = setTimeout(() => { label.textContent = 'Copy' }, 1800)
    })
    actions.append(button)
  }

  function addRetryButton(actions: HTMLElement, label: string) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-action message-retry'
    button.title = label === 'Retry' ? 'Send the last message again' : 'Ask Bloub to answer the last message again'
    button.append(icon(ICON_RETRY))
    const span = document.createElement('span')
    span.textContent = label
    button.append(span)
    button.addEventListener('click', () => void retryLast())
    actions.append(button)
  }

  function appendUserRow(view: { text: string; files: string[]; images: string[]; label?: string }): HTMLElement {
    const row = document.createElement('div')
    row.className = 'message-row user'
    if (view.images.length || view.files.length) {
      const atts = document.createElement('div')
      atts.className = 'user-attachments'
      for (const src of view.images) {
        const img = document.createElement('img')
        img.className = 'user-image'
        img.src = src
        img.alt = 'Attached image'
        atts.append(img)
      }
      for (const name of view.files) atts.append(attachmentChip({ kind: 'text', name }))
      row.append(atts)
    }
    if (view.label) {
      const note = document.createElement('div')
      note.className = 'user-event'
      note.textContent = view.label
      row.append(note)
    }
    if (view.text) {
      const bubble = document.createElement('div')
      bubble.className = 'user-bubble'
      bubble.textContent = view.text
      row.append(bubble)
      const actions = document.createElement('div')
      actions.className = 'message-actions'
      addCopyButton(actions, bubble)
      row.append(actions)
    }
    messagesContainer.append(row)
    return row
  }

  function buildActivity(steps: string[], open: boolean): HTMLDetailsElement {
    const details = document.createElement('details')
    details.className = 'activity'
    details.open = open
    const summary = document.createElement('summary')
    summary.append(icon(ICON_STEPS))
    const label = document.createElement('span')
    label.className = 'activity-summary'
    summary.append(label)
    const list = document.createElement('ol')
    list.className = 'activity-list'
    details.append(summary, list)
    for (const step of steps) appendStep(details, step)
    updateActivitySummary(details, open)
    return details
  }

  function appendStep(details: HTMLDetailsElement, text: string) {
    const li = document.createElement('li')
    if (text.startsWith('⚠')) li.className = 'warn'
    li.textContent = text.replace(/^⚠\s*/, '')
    details.querySelector('.activity-list')!.append(li)
    details.classList.remove('hidden')
  }

  function updateActivitySummary(details: HTMLDetailsElement, running: boolean) {
    const n = details.querySelectorAll('.activity-list li').length
    details.classList.toggle('hidden', n === 0)
    details.classList.toggle('running', running)
    details.querySelector('.activity-summary')!.textContent = running
      ? 'Working on it…'
      : `${n} ${n === 1 ? 'step' : 'steps'}`
  }

  function appendAssistantRow(text: string, steps: string[], opts: { running?: boolean; truncated?: boolean; actions?: boolean } = {}): LiveRow {
    const row = document.createElement('div')
    row.className = 'message-row assistant'
    const activity = buildActivity(steps, !!opts.running)
    const content = document.createElement('div')
    content.className = 'assistant-content'
    if (text) content.append(renderMarkdownLite(text))
    row.append(activity, content)
    if (opts.truncated) appendStopped(row)
    const actions = document.createElement('div')
    actions.className = 'message-actions'
    addCopyButton(actions, content)
    row.append(actions)
    row.classList.toggle('is-empty', !text)
    messagesContainer.append(row)
    return { row, content, activity }
  }

  function appendStopped(row: HTMLElement) {
    if (row.querySelector('.message-stopped')) return
    const note = document.createElement('div')
    note.className = 'message-stopped'
    note.textContent = 'Stopped — this answer may be incomplete.'
    row.querySelector('.message-actions')?.before(note) ?? row.append(note)
  }

  function errorCard(message: string, retry: boolean): HTMLElement {
    const info = friendlyError(message)
    const card = document.createElement('div')
    card.className = 'error-notice'
    card.setAttribute('role', 'alert')
    const title = document.createElement('strong')
    title.textContent = info.title
    const hint = document.createElement('p')
    hint.textContent = info.hint
    card.append(title, hint)
    if (info.detail) {
      const detail = document.createElement('details')
      detail.className = 'error-detail'
      const summary = document.createElement('summary')
      summary.textContent = 'Details'
      const pre = document.createElement('code')
      pre.textContent = info.detail
      detail.append(summary, pre)
      // Kurze Meldungen direkt zeigen — nur lange Texte einklappen.
      detail.open = info.detail.length <= 160
      card.append(detail)
    }
    const buttons = document.createElement('div')
    buttons.className = 'error-actions'
    if (retry) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'error-btn primary'
      b.textContent = 'Retry'
      b.addEventListener('click', () => void retryLast())
      buttons.append(b)
    }
    if (info.fixInSettings) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'error-btn'
      b.textContent = 'Open Connections'
      b.addEventListener('click', () => bridge.openSettingsTab?.('connections'))
      buttons.append(b)
    }
    if (buttons.childElementCount) card.append(buttons)
    return card
  }

  /** Nur die letzte Antwort bekommt "Regenerate"/"Retry". */
  function refreshLastTurnActions() {
    messagesContainer.querySelectorAll('.message-retry').forEach((b) => b.remove())
    const rows = messagesContainer.querySelectorAll<HTMLElement>('.message-row')
    const last = rows[rows.length - 1]
    rows.forEach((r) => r.classList.toggle('is-last', r === last))
    if (isGenerating()) return
    if (!last?.classList.contains('assistant') || last.querySelector('.error-notice')) return
    const actions = last.querySelector<HTMLElement>('.message-actions')
    if (actions) addRetryButton(actions, last.classList.contains('is-empty') ? 'Retry' : 'Regenerate')
  }

  /* -------------------------------------------------- history -> dom */

  function stepsFromRecords(records: ChatRecord[], toolErrors: Set<string>): string[] {
    const steps: string[] = []
    for (const rec of records) {
      for (const tc of rec.toolCalls ?? []) {
        const label = activityLabel(tc.name, tc.argsJson)
        steps.push(tc.id && toolErrors.has(tc.id) ? `⚠ ${label}` : label)
      }
    }
    return steps
  }

  /**
   * Gespeicherte Records als Gespraech rendern: User-Nachricht, gesammelte
   * Arbeitsschritte aus Tool-Calls, finale Antwort. System-Hinweise und
   * Zwischen-Text vor Tool-Calls bleiben unsichtbar (wie im Live-Stream).
   */
  function renderHistory(records: ChatRecord[], liveTail: RunState | undefined) {
    const toolErrors = new Set<string>()
    for (const rec of records) {
      if (rec.role === 'tool' && rec.isError && rec.toolCallId) toolErrors.add(rec.toolCallId)
    }
    let turn: ChatRecord[] = []
    let open = false
    const flushTurn = (isLast: boolean) => {
      if (!open) return
      const final = turn.find((r) => r.role === 'assistant' && !r.toolCalls?.length)
      const steps = stepsFromRecords(turn, toolErrors)
      if (isLast && liveTail?.generating) {
        live = appendAssistantRow(liveTail.text, liveTail.steps.length ? liveTail.steps : steps, { running: true })
      } else if (final && (final.content?.trim() || final.truncated)) {
        appendAssistantRow(final.content ?? '', steps, { truncated: !!final.truncated })
      } else {
        const row = appendAssistantRow('', steps)
        const missing = document.createElement('div')
        missing.className = 'message-missing'
        missing.textContent = final ? 'Bloub finished without writing an answer.' : 'No answer was received for this message.'
        row.row.querySelector('.message-actions')?.before(missing)
      }
      turn = []
      open = false
    }
    for (const rec of records) {
      if (rec.role === 'user' && !isSystemNote(rec)) {
        flushTurn(false)
        const view = userMessageView(rec)
        const dropped = view.text === DROP_INSPECT_PROMPT
        appendUserRow({
          text: dropped ? '' : view.text,
          files: view.files,
          images: view.images.map((img) => `data:${img.mime};base64,${img.data}`),
          label: dropped ? 'Dropped onto Bloub' : undefined
        })
        open = true
      } else if (open) {
        turn.push(rec)
      }
    }
    flushTurn(true)
  }

  /* ------------------------------------------------------------- chats */

  async function switchToChat(chatId: string) {
    const serial = ++switchSerial
    activeChatId = chatId
    await bridge.selectChat?.(chatId)
    const chat = await bridge.getChat?.(chatId)
    if (serial !== switchSerial) return
    currentChatTitleText.textContent = chat?.title || 'New chat'
    cancelRename()
    live = null
    messagesContainer.replaceChildren()
    const r = run(chatId)
    renderHistory(chat?.records ?? [], r)
    if (r?.generating && !live) {
      // Turn laeuft, aber der User-Record ist noch nicht gespeichert
      live = appendAssistantRow(r.text, r.steps, { running: true })
    }
    showConversation(messagesContainer.childElementCount > 0)
    stickToBottom = true
    setGenerating(isGenerating(chatId))
    refreshLastTurnActions()
    scrollToBottom(true)
    void refreshHistory(historySearchInput.value)
    void refreshWelcome()
  }

  async function startNewChat() {
    const session = await bridge.newChat?.()
    if (session) {
      await switchToChat(session.id)
      closeDrawer()
      input.focus()
    }
  }
  $('new-chat-btn').addEventListener('click', () => void startNewChat())

  /* ------------------------------------------------------------- rename */

  function beginRename() {
    currentChatTitle.classList.add('hidden')
    renameChatInput.classList.remove('hidden')
    renameChatInput.value = currentChatTitleText.textContent ?? ''
    renameChatInput.focus()
    renameChatInput.select()
  }
  function cancelRename() {
    renameChatInput.classList.add('hidden')
    currentChatTitle.classList.remove('hidden')
  }
  currentChatTitle.addEventListener('click', beginRename)
  renameChatInput.addEventListener('blur', () => {
    if (renameChatInput.classList.contains('hidden')) return
    const title = renameChatInput.value.trim()
    cancelRename()
    if (title && title !== currentChatTitleText.textContent) {
      currentChatTitleText.textContent = title
      void bridge.renameChat?.(activeChatId, title)?.then(() => refreshHistory(historySearchInput.value))
    }
  })
  renameChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      renameChatInput.blur()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      cancelRename()
      currentChatTitle.focus()
    }
  })

  /* ------------------------------------------------------- chat list */

  function dateGroup(ts: number): string {
    const d = new Date(ts)
    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const day = 24 * 60 * 60 * 1000
    if (ts >= startOfToday) return 'Today'
    if (ts >= startOfToday - day) return 'Yesterday'
    if (ts >= startOfToday - 7 * day) return 'Previous 7 days'
    if (ts >= startOfToday - 30 * day) return 'Previous 30 days'
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }

  function shortDate(ts: number): string {
    const group = dateGroup(ts)
    if (group === 'Today') return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (group === 'Yesterday') return 'Yesterday'
    return new Date(ts).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
  }

  let historyRefreshSerial = 0
  async function refreshHistory(filter = '') {
    if (!bridge.listChats) return
    const serial = ++historyRefreshSerial
    const query = filter.trim()
    const allChats = await bridge.listChats()
    const items = query && bridge.searchChats ? await bridge.searchChats(query) : allChats
    if (serial !== historyRefreshSerial) return

    const nodes: HTMLElement[] = []
    if (items.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = query ? `No chats match “${query}”.` : 'No chats yet. Your conversations will show up here.'
      nodes.push(empty)
    }
    let group = ''
    for (const chat of items) {
      const ts = chat.updatedAt || chat.createdAt || 0
      const g = query ? 'Results' : dateGroup(ts)
      if (g !== group) {
        group = g
        const h = document.createElement('div')
        h.className = 'history-group'
        h.textContent = g
        nodes.push(h)
      }
      const snippet = 'snippet' in chat ? (chat as { snippet?: string }).snippet : (chat as ChatSummary).lastSnippet
      nodes.push(historyItem(chat.id, chat.title, snippet || '', ts))
    }
    historyList.replaceChildren(...nodes)
    renderRecents(allChats)
  }

  function historyItem(id: string, title: string, snippet: string, ts: number): HTMLElement {
    const item = document.createElement('div')
    item.className = `history-item${id === activeChatId ? ' active' : ''}`
    const content = document.createElement('div')
    content.className = 'history-item-content'
    content.tabIndex = 0
    content.setAttribute('role', 'button')
    content.setAttribute('aria-label', title)
    const titleEl = document.createElement('span')
    titleEl.className = 'history-item-title'
    titleEl.textContent = title
    const meta = document.createElement('span')
    meta.className = 'history-item-meta'
    meta.textContent = snippet ? snippet.replace(/\s+/g, ' ') : shortDate(ts)
    content.append(titleEl, meta)
    const open = () => {
      void switchToChat(id)
      closeDrawer()
    }
    // Ganze Zeile klickbar — ausser Menue und Umbenennen-Feld
    item.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('.history-item-actions, .history-rename')) open()
    })
    content.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const all = Array.from(historyList.querySelectorAll<HTMLElement>('.history-item-content'))
        const next = all[all.indexOf(content) + (e.key === 'ArrowDown' ? 1 : -1)]
        if (next) next.focus()
        else if (e.key === 'ArrowUp') historySearchInput.focus()
      }
    })

    const actions = document.createElement('div')
    actions.className = 'history-item-actions'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'item-action-btn more'
    more.title = 'Manage chat'
    more.setAttribute('aria-label', `Manage chat “${title}”`)
    more.setAttribute('aria-expanded', 'false')
    more.append(icon(ICON_MORE))
    const menu = document.createElement('div')
    menu.className = 'history-action-menu hidden'
    menu.setAttribute('role', 'menu')
    const menuItem = (label: string, cls: string, handler: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `item-action-btn ${cls}`
      b.setAttribute('role', 'menuitem')
      b.textContent = label
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        hideMenu()
        handler()
      })
      menu.append(b)
    }
    const hideMenu = () => { menu.classList.add('hidden'); more.setAttribute('aria-expanded', 'false') }
    menuItem('Rename', 'rename', () => renameInList(item, titleEl, id, title))
    menuItem('Regenerate title', 'regen-title', async () => {
      const fresh = await bridge.regenerateChatTitle?.(id)
      if (fresh && id === activeChatId) currentChatTitleText.textContent = fresh
      void refreshHistory(historySearchInput.value)
    })
    menuItem('Archive', 'archive', async () => {
      await bridge.archiveChat?.(id)
      showToast('Chat archived.')
      if (id === activeChatId) await startNewChat()
      else void refreshHistory(historySearchInput.value)
    })
    menuItem('Delete…', 'delete', async () => {
      dialogOpen = true
      const yes = await confirmDialog({
        title: 'Delete this chat?',
        message: `“${title}” will be deleted permanently. This can't be undone.`,
        okLabel: 'Delete',
        danger: true
      })
      // Das Esc/Enter, das den Dialog schliesst, darf nicht noch Drawer oder Stream treffen.
      setTimeout(() => { dialogOpen = false })
      if (!yes) return
      if (isGenerating(id)) bridge.abortChat?.(id)
      await bridge.deleteChat?.(id)
      runs.delete(id)
      showToast('Chat deleted.')
      if (id === activeChatId) await switchToChat((await bridge.getActiveChat?.()) || 'default')
      else void refreshHistory(historySearchInput.value)
    })
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      const willOpen = menu.classList.contains('hidden')
      historyList.querySelectorAll('.history-action-menu').forEach((m) => m.classList.add('hidden'))
      historyList.querySelectorAll('.more').forEach((b) => b.setAttribute('aria-expanded', 'false'))
      if (!willOpen) return
      menu.classList.remove('hidden')
      more.setAttribute('aria-expanded', 'true')
      const r = more.getBoundingClientRect()
      menu.style.left = `${Math.max(8, Math.min(r.right - 190, window.innerWidth - 198))}px`
      menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`
      menu.querySelector<HTMLElement>('button')?.focus()
    })
    item.addEventListener('focusout', (e) => { if (!item.contains(e.relatedTarget as Node)) hideMenu() })
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
        e.stopPropagation()
        hideMenu()
        more.focus()
      }
    })
    actions.append(more, menu)
    item.append(content, actions)
    return item
  }

  function renameInList(item: HTMLElement, titleEl: HTMLElement, id: string, title: string) {
    const field = document.createElement('input')
    field.type = 'text'
    field.className = 'history-rename'
    field.value = title
    field.maxLength = 60
    field.setAttribute('aria-label', 'Chat name')
    titleEl.replaceWith(field)
    field.focus()
    field.select()
    let done = false
    const finish = async (save: boolean) => {
      if (done) return
      done = true
      const next = field.value.trim()
      if (save && next && next !== title) {
        await bridge.renameChat?.(id, next)
        if (id === activeChatId) currentChatTitleText.textContent = next
      }
      void refreshHistory(historySearchInput.value)
    }
    field.addEventListener('click', (e) => e.stopPropagation())
    field.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); void finish(true) }
      else if (e.key === 'Escape') void finish(false)
    })
    field.addEventListener('blur', () => void finish(true))
    item.classList.add('renaming')
  }

  function renderRecents(allChats: ChatSummary[]) {
    const recents = allChats.filter((c) => c.id !== activeChatId).slice(0, 3)
    recentBox.classList.toggle('hidden', recents.length === 0)
    recentChatsList.replaceChildren(
      ...recents.map((c) => {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'recent-chat-chip'
        const title = document.createElement('div')
        title.className = 'recent-chat-chip-title'
        title.textContent = c.title
        const date = document.createElement('span')
        date.className = 'recent-chat-chip-date'
        date.textContent = shortDate(c.updatedAt || c.createdAt || 0)
        chip.append(title, date)
        chip.addEventListener('click', () => void switchToChat(c.id))
        return chip
      })
    )
  }

  /* ------------------------------------------------------ generating */

  function renderWorkingIndicator() {
    const r = run()
    const visible = !!r?.generating && !!r.working
    workingIndicator.classList.toggle('hidden', !visible)
    workingText.textContent = r?.status || r?.steps[r.steps.length - 1]?.replace(/^⚠\s*/, '') || 'Thinking…'
    messagesContainer.append(workingIndicator)
    if (visible) {
      showConversation(true)
      scrollToBottom()
    }
  }

  function setGenerating(generating: boolean) {
    renderWorkingIndicator()
    sendIcon.classList.toggle('hidden', generating)
    stopIcon.classList.toggle('hidden', !generating)
    sendBtn.classList.toggle('stop', generating)
    sendBtn.title = generating ? 'Stop generating' : 'Send'
    sendBtn.setAttribute('aria-label', sendBtn.title)
    updateComposerHint()
  }

  function renderLiveText() {
    renderQueued = false
    const r = run()
    if (!live || !r) return
    live.content.replaceChildren(renderMarkdownLite(r.text))
    live.row.classList.toggle('is-empty', !r.text)
    scrollToBottom()
  }

  function scheduleLiveRender() {
    // Erstes Token sofort zeigen; versteckte Fenster bekommen keine
    // Animation-Frames — auch dort direkt rendern.
    if (document.visibilityState === 'hidden' || !live?.content.childElementCount) return renderLiveText()
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(renderLiveText)
  }

  function finishLiveRow(opts: { truncated?: boolean; error?: string }) {
    if (!live) return
    const r = run()
    if (r) live.content.replaceChildren(...(r.text ? [renderMarkdownLite(r.text)] : []))
    live.row.classList.toggle('is-empty', !live.content.textContent?.trim())
    updateActivitySummary(live.activity, false)
    live.activity.open = false
    if (opts.truncated) appendStopped(live.row)
    if (opts.error !== undefined) live.row.querySelector('.message-actions')?.before(errorCard(opts.error, true))
    live = null
  }

  function startLiveTurn(chatId: string, selfSent: boolean) {
    const r = ensureRun(chatId)
    Object.assign(r, { generating: true, working: true, text: '', status: '', steps: [], selfSent })
    if (chatId === activeChatId) {
      live = appendAssistantRow('', [], { running: true })
      showConversation(true)
      setGenerating(true)
      refreshLastTurnActions()
      scrollToBottom(true)
    }
  }

  function stopGenerating() {
    const chatId = activeChatId
    if (!isGenerating(chatId)) return
    bridge.abortChat?.(chatId)
    const r = ensureRun(chatId)
    r.generating = false
    finishLiveRow({ truncated: true })
    setGenerating(false)
  }

  async function send() {
    if (input.closest('.composer-pill')?.classList.contains('dictating')) return
    if (isGenerating()) return
    const text = input.value.trim()
    if (!text && pending.length === 0) return

    const attachments = pending
    pending = []
    renderAttachmentTray()
    input.value = ''
    refreshComposerLayout()

    appendUserRow({
      text,
      files: attachments.filter((a) => !a.preview).map((a) => a.chip.name),
      images: attachments.filter((a) => a.preview).map((a) => a.preview!)
    })
    const chatId = activeChatId
    startLiveTurn(chatId, true)
    try {
      await bridge.sendChat?.({
        text,
        attachmentIds: attachments.map((a) => a.chip.id).filter((id): id is string => !!id),
        chatId
      })
    } catch (err) {
      handleError(chatId, `Failed to send: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function retryLast() {
    const chatId = activeChatId
    if (isGenerating(chatId)) return
    // Alles nach der letzten User-Nachricht verwerfen; die Nachricht selbst bleibt stehen.
    const rows = Array.from(messagesContainer.querySelectorAll<HTMLElement>('.message-row'))
    const lastUser = rows.map((r) => r.classList.contains('user')).lastIndexOf(true)
    if (lastUser < 0) return
    rows.slice(lastUser + 1).forEach((r) => r.remove())
    startLiveTurn(chatId, true)
    try {
      const ok = await bridge.retryChat?.(chatId)
      if (!ok && isGenerating(chatId)) handleError(chatId, 'Could not retry this message.')
    } catch (err) {
      handleError(chatId, err instanceof Error ? err.message : String(err))
    }
  }

  function handleError(chatId: string, message: string) {
    const r = ensureRun(chatId)
    r.generating = false
    r.selfSent = false
    if (chatId !== activeChatId) return
    if (!live) live = appendAssistantRow('', [], { running: false })
    finishLiveRow({ error: message })
    setGenerating(false)
    scrollToBottom()
  }

  /* -------------------------------------------------------- dictation */

  const dictation = initDictation(bridge, input, composerMicBtn, send, () => activeChatId)
  bridge.onPttStart?.(() => {
    if (document.hasFocus()) void dictation.start()
  })
  bridge.onPttEnd?.(() => {
    if (dictation.isRecording) dictation.stop()
  })

  /* ---------------------------------------------------------- shortcuts */

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      void startNewChat()
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (drawerOpen() && document.activeElement === historySearchInput) closeDrawer()
      else openDrawer()
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      // Esc in Menues, Umbenennen oder Dialogen schliesst nur diese selbst.
      if (dialogOpen || document.querySelector('.k-overlay')) return
      if ((e.target as Element | null)?.closest?.('.model-selector, .history-rename, #rename-chat-input')) return
      if (drawerOpen()) {
        closeDrawer()
        toggleHistoryBtn.focus()
      } else if (isGenerating()) {
        stopGenerating()
      }
    }
  })

  /* ------------------------------------------------------- ipc events */

  bridge.onChatEvent?.((ev: ChatEvent) => {
    const chatId = ev.chatId || activeChatId
    const active = chatId === activeChatId

    switch (ev.type) {
      case 'accepted': {
        const r = ensureRun(chatId)
        if (!r.selfSent && !r.generating) {
          // Turn von aussen (Pet-Dock, Datei-Drop, Autopilot): Nachricht + Platzhalter zeigen.
          if (active) {
            if (ev.chipText) appendUserRow({ text: ev.chipText, files: [], images: [] })
            else if (ev.attachments?.length) appendUserRow({ text: '', files: [], images: [], label: 'Dropped onto Bloub' })
            else appendUserRow({ text: '', files: [], images: [], label: 'Bloub checked in on its own' })
          }
          startLiveTurn(chatId, false)
        } else {
          r.generating = true
          r.working = true
          if (active) setGenerating(true)
        }
        break
      }
      case 'status':
      case 'tools': {
        const r = ensureRun(chatId)
        if (!r.generating) startLiveTurn(chatId, false)
        r.working = true
        r.status = ev.type === 'status' ? ev.text : ''
        if (active) setGenerating(true)
        break
      }
      case 'note': {
        const r = ensureRun(chatId)
        r.steps.push(ev.text)
        r.status = ''
        if (active && live) {
          appendStep(live.activity, ev.text)
          updateActivitySummary(live.activity, true)
          renderWorkingIndicator()
        }
        break
      }
      case 'clear': {
        const r = ensureRun(chatId)
        r.text = ''
        r.working = true
        if (active) {
          if (live) {
            live.content.replaceChildren()
            live.row.classList.add('is-empty')
          }
          renderWorkingIndicator()
        }
        break
      }
      case 'token': {
        const r = ensureRun(chatId)
        if (!r.generating) startLiveTurn(chatId, false)
        r.working = false
        r.status = ''
        r.text += ev.text
        if (active) {
          // Tokens koennen vor dem accepted-Echo ankommen: Platzhalter bei Bedarf anlegen.
          if (!live) live = appendAssistantRow('', r.steps, { running: true })
          renderWorkingIndicator()
          scheduleLiveRender()
        }
        break
      }
      case 'title':
        if (ev.title) {
          if (active) currentChatTitleText.textContent = ev.title
          void refreshHistory(historySearchInput.value)
        }
        break
      case 'done': {
        const r = ensureRun(chatId)
        const wasGenerating = r.generating
        r.generating = false
        r.selfSent = false
        if (active) {
          if (wasGenerating) finishLiveRow({ truncated: ev.truncated })
          setGenerating(false)
          refreshLastTurnActions()
          scrollToBottom()
          void refreshHistory(historySearchInput.value)
        }
        runs.delete(chatId)
        break
      }
      case 'error':
        handleError(chatId, ev.message)
        if (active) refreshLastTurnActions()
        break
      case 'archived':
        // Settings "Archive current chat": den frischen aktiven Chat zeigen
        runs.delete(activeChatId)
        void bridge.getActiveChat?.().then((id) => switchToChat(id || 'default'))
        break
      default:
        // 'attachments' / 'pending-tail' gehoeren zum Pet-Dock
        break
    }
  })

  // Start with active chat
  bridge.getActiveChat?.()
    .then((id) => switchToChat(id || 'default'))
    .catch(() => switchToChat('default'))
  updateComposerHint()
  input.focus()
}

if (typeof document !== 'undefined' && document.getElementById('standalone-chat')) {
  initStandaloneChat()
}
