import { EXPRESSIONS } from '../vendor/bot/expressions'
import { SHAPES, COLORS } from '../vendor/bot/skins'
import {
  getBridge,
  frozenPreview,
  createSvgIcon,
  EXPRESSION_LABELS,
  SHAPE_LABELS,
  type Grant,
  type PetConfigShape,
  type RecallStatus,
  type UpdateCheckResult
} from './shared'

import { createSegmented, createSelect, createSwitch, confirmDialog, type SelectHandle } from './ui/kit'

const bridge = getBridge()

const exprPills = document.getElementById('expr-pills')!
const shapePills = document.getElementById('shape-pills')!
const colorRow = document.getElementById('color-row')!
const sizeRange = document.getElementById('size-range') as HTMLInputElement
const sizeVal = document.getElementById('size-val')!

// Custom-UI statt nativer Widgets (Regel: siehe docs/ai-chat-design.md)
const eventsSwitch = createSwitch({
  label: 'Random events',
  onChange: (checked) => {
    void bridge.updateConfig({ eventsEnabled: checked })
  }
})
document.getElementById('events-toggle-slot')!.replaceChildren(eventsSwitch.el)

// Screenshots: ALLE Monitore zu einem Bild zusammenfuegen (mit ID-Badges)
const screenshotAllSwitch = createSwitch({
  label: 'Screenshots: all displays',
  onChange: (checked) => {
    void bridge.updateConfig({ screenshotAllDisplays: checked })
  }
})
document.getElementById('screenshot-all-slot')!.replaceChildren(screenshotAllSwitch.el)

// Globaler Cursor-Follow ueber alle Monitore (Blick + ID-Tag am Cursor)
const globalCursorSwitch = createSwitch({
  label: 'Global cursor tracking',
  onChange: (checked) => {
    void bridge.updateConfig({ globalCursorTracking: checked })
  }
})
document.getElementById('global-cursor-slot')!.replaceChildren(globalCursorSwitch.el)

// Beim PC-Start automatisch starten (Login-Item)
const autostartSwitch = createSwitch({
  label: 'Start with PC',
  onChange: (checked) => {
    void bridge.updateConfig({ autostart: checked })
  }
})
document.getElementById('autostart-toggle-slot')!.replaceChildren(autostartSwitch.el)

// Globale Dateizugriffs-Stufe: none / read / readwrite
const fileAccessSeg = createSegmented({
  options: [
    { value: 'none', label: 'None' },
    { value: 'read', label: 'Read' },
    { value: 'readwrite', label: 'Read & write' }
  ],
  onChange: (value) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), fileAccess: value as 'none' | 'read' | 'readwrite' }
    })
  }
})
document.getElementById('file-access-slot')!.replaceChildren(fileAccessSeg.el)

// Terminal-Zugriff (Opt-in): shell_exec fuer die AI
const terminalSwitch = createSwitch({
  label: 'Terminal access',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), shellEnabled: checked }
    })
  }
})
document.getElementById('terminal-toggle-slot')!.replaceChildren(terminalSwitch.el)

// Persistentes Memory (Opt-in): memory_write/memory_get fuer die AI
const memorySwitch = createSwitch({
  label: 'Memory',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), memoryEnabled: checked }
    })
  }
})
document.getElementById('memory-toggle-slot')!.replaceChildren(memorySwitch.el)

// Voller Zugriff auf das Systemlaufwerk (C:\) — Opt-in, wird nicht automatisch gesetzt
const driveSwitch = createSwitch({
  label: 'Full drive access (C:\\)',
  onChange: (checked) => {
    // syncSystemDriveGrant im Main ergaenzt/entfernt den Root-Grant
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), fullDriveAccess: checked }
    })
  }
})
document.getElementById('drive-toggle-slot')!.replaceChildren(driveSwitch.el)

/* ------------------------------------------- actions (was die AI darf) */

// Expressions aendern (pet_set_expression)
const exprAccessSwitch = createSwitch({
  label: 'Change expressions',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), expressionAccess: checked }
    })
  }
})
document.getElementById('expr-access-slot')!.replaceChildren(exprAccessSwitch.el)

// Animationen (pet_animate / pet_stop_animation / pet_custom_animate)
const animAccessSwitch = createSwitch({
  label: 'Play animations',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), animationAccess: checked }
    })
  }
})
document.getElementById('anim-access-slot')!.replaceChildren(animAccessSwitch.el)

// Aussehen aendern (pet_set_shape / pet_set_color / pet_set_size)
const appearAccessSwitch = createSwitch({
  label: 'Change shape, color & size',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), appearanceAccess: checked }
    })
  }
})
document.getElementById('appear-access-slot')!.replaceChildren(appearAccessSwitch.el)

// Zeichnen auf dem Desktop (pet_draw_path)
const drawAccessSwitch = createSwitch({
  label: 'Draw on screen',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), drawAccess: checked }
    })
  }
})
document.getElementById('draw-access-slot')!.replaceChildren(drawAccessSwitch.el)

const maxToolCallsInput = document.getElementById('max-tool-calls') as HTMLInputElement
const maxDrawCallsInput = document.getElementById('max-draw-calls') as HTMLInputElement

maxToolCallsInput.addEventListener('change', () => {
  const n = Math.min(60, Math.max(1, Math.round(Number(maxToolCallsInput.value) || 12)))
  maxToolCallsInput.value = String(n)
  void bridge.updateConfig({
    chat: { ...(config.chat ?? {}), ...grantsInto({}), maxToolCallsPerTurn: n }
  })
})

maxDrawCallsInput.addEventListener('change', () => {
  const n = Math.min(20, Math.max(0, Math.round(Number(maxDrawCallsInput.value) || 0)))
  maxDrawCallsInput.value = String(n)
  void bridge.updateConfig({
    chat: { ...(config.chat ?? {}), ...grantsInto({}), maxDrawCallsPerTurn: n }
  })
})

/* ------------------------------------------------------- autopilot (Pad) */

// Modus: aus / unsichtbar (nur Aktionen, nie Text) / sichtbar (Antwort im Chat)
const autoPilotModeSeg = createSegmented({
  options: [
    { value: 'off', label: 'Off' },
    { value: 'silent', label: 'Silent' },
    { value: 'visible', label: 'Visible' }
  ],
  onChange: (value) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), autoPilot: value }
    })
  }
})
document.getElementById('autopilot-mode-slot')!.replaceChildren(autoPilotModeSeg.el)

// Intervall zwischen den Selbst-Check-ins
const autoPilotIntervalSeg = createSegmented({
  options: [
    { value: '30', label: '30 s' },
    { value: '60', label: '1 min' },
    { value: '120', label: '2 min' },
    { value: '300', label: '5 min' }
  ],
  onChange: (value) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), autoPilotInterval: Number(value) }
    })
  }
})
document.getElementById('autopilot-interval-slot')!.replaceChildren(autoPilotIntervalSeg.el)

// "Wurf" pro Tick: wie oft die AI ueberhaupt gefragt wird
const autoPilotChanceSeg = createSegmented({
  options: [
    { value: '100', label: 'Always' },
    { value: '50', label: '50 %' },
    { value: '25', label: '25 %' }
  ],
  onChange: (value) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), autoPilotChance: Number(value) }
    })
  }
})
document.getElementById('autopilot-chance-slot')!.replaceChildren(autoPilotChanceSeg.el)

let config: PetConfigShape

function markSelected(container: HTMLElement, selectedId: string) {
  for (const pill of container.querySelectorAll<HTMLElement>('.pill, .swatch')) {
    pill.classList.toggle('selected', pill.dataset.id === selectedId)
  }
}

function refreshSelections() {
  markSelected(exprPills, config.expression)
  markSelected(shapePills, config.shape)
  markSelected(colorRow, config.color)
}

function buildPills() {
  // expressions: frozen mini avatar in the currently selected shape + color
  exprPills.replaceChildren(
    ...EXPRESSIONS.map((expr) => {
      const pill = document.createElement('button')
      pill.className = 'pill'
      pill.dataset.id = expr.id
      pill.appendChild(
        frozenPreview(42, { expressionId: expr.id, shapeId: config.shape, colorId: config.color })
      )
      const label = document.createElement('span')
      label.textContent = EXPRESSION_LABELS[expr.id] ?? expr.id
      pill.appendChild(label)
      pill.addEventListener('click', () => {
        void bridge.updateConfig({ expression: expr.id })
      })
      return pill
    })
  )

  shapePills.replaceChildren(
    ...SHAPES.map((shape) => {
      const pill = document.createElement('button')
      pill.className = 'pill'
      pill.dataset.id = shape.id
      // Formen zeigen die aktuell gewaehlte Farbe und Expression mit an
      pill.appendChild(
        frozenPreview(42, {
          shapeId: shape.id,
          colorId: config.color,
          expressionId: config.expression
        })
      )
      const label = document.createElement('span')
      label.textContent = SHAPE_LABELS[shape.id] ?? shape.id
      pill.appendChild(label)
      pill.addEventListener('click', () => {
        void bridge.updateConfig({ shape: shape.id })
      })
      return pill
    })
  )

  colorRow.replaceChildren(
    ...COLORS.map((color) => {
      const swatch = document.createElement('button')
      swatch.className = 'swatch'
      swatch.style.background = color.hex
      swatch.title = color.id
      swatch.dataset.id = color.id
      swatch.addEventListener('click', () => {
        void bridge.updateConfig({ color: color.id })
      })
      return swatch
    })
  )
}

// Aenderungen kommen per Broadcast zurueck – auch die eigenen. Die Minis in
// den Pillen haengen an Form, Farbe und Expression, also bei jedem davon neu bauen.
bridge.onConfigChanged((fresh) => {
  const rebuildMinis =
    !config ||
    fresh.shape !== config.shape ||
    fresh.color !== config.color ||
    fresh.expression !== config.expression
  config = fresh
  if (rebuildMinis && config) {
    buildPills()
  }
  refreshSelections()
  sizeRange.value = String(config.ballSize)
  sizeVal.textContent = String(config.ballSize)
  eventsSwitch.setValue(config.eventsEnabled)
  screenshotAllSwitch.setValue(config.screenshotAllDisplays !== false)
  globalCursorSwitch.setValue(config.globalCursorTracking !== false)
  autostartSwitch.setValue(!!config.autostart)
  syncChatFields()
  syncRecallFields()
  syncAudioFields()
  renderGrants(config.chat?.grants ?? [])
  updateAboutAvatar()
})


sizeRange.addEventListener('input', () => {
  sizeVal.textContent = sizeRange.value
  void bridge.updateConfig({ ballSize: Number(sizeRange.value) })
})

const scrollContainer = document.getElementById('scroll')

function updateScrollGradients() {
  if (!scrollContainer) return
  const canScrollUp = scrollContainer.scrollTop > 4
  const canScrollDown = scrollContainer.scrollTop + scrollContainer.clientHeight < scrollContainer.scrollHeight - 4
  scrollContainer.classList.toggle('can-scroll-top', canScrollUp)
  scrollContainer.classList.toggle('can-scroll-bottom', canScrollDown)
}

scrollContainer?.addEventListener('scroll', updateScrollGradients, { passive: true })
if (scrollContainer) {
  new ResizeObserver(updateScrollGradients).observe(scrollContainer)
}

/** Aktiver Tab fuer die Suchenavigation (Modul-Ebene). */
let currentSearchTab = 'look'

/** Auf einen Tab umschalten (Tab-Button und Pane sichtbar machen). */
function switchTab(tabId: string) {
  const btn = document.querySelector<HTMLButtonElement>(`#tabs [data-tab="${tabId}"]`)
  if (!btn) return
  currentSearchTab = tabId
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs [data-tab]')) {
    b.classList.toggle('on', b === btn)
  }
  for (const pane of document.querySelectorAll<HTMLElement>('.pane')) {
    pane.classList.toggle('hidden', pane.id !== `pane-${tabId}`)
  }
  scrollContainer?.scrollTo({ top: 0, behavior: 'instant' })
  requestAnimationFrame(updateScrollGradients)
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabs [data-tab]')) {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab ?? 'look')
  })
}


function closeSettingsWindow() {
  const card = document.getElementById('card')
  if (card) {
    card.classList.add('closing')
    setTimeout(() => {
      bridge.closeSettings()
    }, 160)
  } else {
    bridge.closeSettings()
  }
}

document.getElementById('close')!.addEventListener('click', closeSettingsWindow)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettingsWindow()
})
document.getElementById('quit-btn')!.addEventListener('click', () => bridge.quit())

/* ------------------------------------------------------- chat section */

const baseUrlInput = document.getElementById('chat-baseurl') as HTMLInputElement
const modelInput = document.getElementById('chat-model') as HTMLInputElement
const apiKeyInput = document.getElementById('chat-apikey') as HTMLInputElement
const testResult = document.getElementById('chat-test-result')!
const testBtn = document.getElementById('chat-test-btn') as HTMLButtonElement
const hotkeyInput = document.getElementById('chat-hotkey') as HTMLInputElement
const hotkeyStatus = document.getElementById('hotkey-status')!
const hotkeyTestBtn = document.getElementById('hotkey-test-btn') as HTMLButtonElement
const grantList = document.getElementById('grant-list')!
const clearMemoryBtn = document.getElementById('clear-memory-btn') as HTMLButtonElement

let userPickedProtocol = false
let grantsCache: Grant[] = []

function grantsInto(obj: Record<string, unknown>) {
  obj.grants = grantsCache
  return obj
}

// Custom-Select statt nativem <select> (UI-Kit-Regel)
const protocolSelect: SelectHandle = createSegmented({
  options: [
    { value: 'openai-completions', label: 'Compatible' },
    { value: 'openai-responses', label: 'Responses' },
    { value: 'anthropic-messages', label: 'Anthropic' }
  ],
  onChange: () => {
    userPickedProtocol = true // manuelle Wahl schlaegt die Host-Vermutung
    pushChatConfig()
  }
})
document.getElementById('chat-protocol')!.replaceChildren(protocolSelect.el)

const toolsSwitch = createSwitch({
  label: 'Tool use',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), toolsEnabled: checked }
    })
  }
})
document.getElementById('chat-tools-toggle-slot')!.replaceChildren(toolsSwitch.el)

const voiceSwitch = createSwitch({
  label: 'Always answer with voice',
  onChange: (checked) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), voiceAlways: checked }
    })
  }
})
document.getElementById('chat-voice-toggle-slot')!.replaceChildren(voiceSwitch.el)

const verbositySeg = createSegmented({
  options: [
    { value: 'concise', label: 'Concise' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'detailed', label: 'Detailed' }
  ],
  onChange: (value) => {
    void bridge.updateConfig({
      chat: { ...(config.chat ?? {}), ...grantsInto({}), verbosity: value }
    })
  }
})
document.getElementById('chat-verbosity-slot')!.replaceChildren(verbositySeg.el)

function syncChatFields() {
  const c = config.chat
  if (!c) return
  // Felder, die gerade fokussiert sind, nicht ueberschreiben
  if (document.activeElement !== baseUrlInput) baseUrlInput.value = c.baseUrl ?? ''
  if (document.activeElement !== protocolSelect.el) protocolSelect.setValue(c.protocol ?? 'openai-completions')
  if (document.activeElement !== modelInput) modelInput.value = c.model ?? ''
  if (document.activeElement !== hotkeyInput) hotkeyInput.value = c.chatHotkey ?? ''
  toolsSwitch.setValue(!!c.toolsEnabled)
  voiceSwitch.setValue(!!c.voiceAlways)
  verbositySeg.setValue(c.verbosity ?? 'balanced')
  fileAccessSeg.setValue(c.fileAccess ?? 'read')
  terminalSwitch.setValue(!!c.shellEnabled)
  memorySwitch.setValue(!!c.memoryEnabled)
  driveSwitch.setValue(!!c.fullDriveAccess)
  autoPilotModeSeg.setValue(c.autoPilot ?? 'off')
  autoPilotIntervalSeg.setValue(String(c.autoPilotInterval ?? 60))
  autoPilotChanceSeg.setValue(String(c.autoPilotChance ?? 100))
  exprAccessSwitch.setValue(c.expressionAccess !== false)
  animAccessSwitch.setValue(c.animationAccess !== false)
  appearAccessSwitch.setValue(c.appearanceAccess !== false)
  drawAccessSwitch.setValue(c.drawAccess !== false)
  if (document.activeElement !== maxToolCallsInput) maxToolCallsInput.value = String(c.maxToolCallsPerTurn ?? 12)
  if (document.activeElement !== maxDrawCallsInput) maxDrawCallsInput.value = String(c.maxDrawCallsPerTurn ?? 2)
}

function renderGrants(grants: Grant[]) {
  grantsCache = grants
  grantList.replaceChildren(
    ...grants.map((g) => {
      const chip = document.createElement('div')
      chip.className = 'grant-chip'
      const name = document.createElement('span')
      name.className = 'grant-name'
      name.title = g.path
      name.textContent = g.isRoot ? `${g.path} (full drive)` : (g.path.split(/[\\/]/).filter(Boolean).pop() ?? g.path)
      const shield = document.createElement('button')
      shield.className = `shield${g.allowSecrets ? ' on' : ''}`
      shield.title = 'allow secrets (never default on)'
      shield.appendChild(createSvgIcon('shield', 12))
      shield.addEventListener('click', () => {
        void bridge.setGrantSecrets?.(g.path, !g.allowSecrets)?.then((fresh) => {
          grantsCache = fresh ?? grantsCache
          renderGrants(grantsCache)
        })
      })
      const rm = document.createElement('button')
      rm.className = 'shield'
      rm.title = g.isRoot ? 'revoke full-drive access' : 'revoke grant'
      rm.appendChild(createSvgIcon('close', 11))
      rm.addEventListener('click', () => {
        void bridge.removeGrant?.(g.path)?.then((fresh) => {
          grantsCache = fresh ?? grantsCache
          renderGrants(grantsCache)
        })
      })
      chip.append(name, shield, rm)
      return chip
    })
  )
}

function debounce<T extends (...args: never[]) => void>(ms: number, fn: T): T {
  let t: ReturnType<typeof setTimeout> | undefined
  return ((...args: never[]) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }) as T
}

/** Protokoll-Vermutung nach Host — die manuelle Wahl gewinnt immer. */
function guessProtocol(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'api.anthropic.com') return 'anthropic-messages'
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) {
      return 'openai-completions'
    }
  } catch {
    /* noch keine gueltige URL */
  }
  return null
}

const pushChatConfig = debounce(400, () => {
  void bridge.updateConfig({
    chat: { ...(config.chat ?? {}), ...grantsInto({}), ...chatFieldOverrides() }
  })
})

function chatFieldOverrides() {
  return {
    baseUrl: baseUrlInput.value.trim(),
    protocol: protocolSelect.getValue(),
    model: modelInput.value.trim(),
    chatHotkey: hotkeyInput.value.trim() || 'Super+Alt+X'
  }
}

baseUrlInput.addEventListener('input', () => {
  if (!userPickedProtocol) {
    const guess = guessProtocol(baseUrlInput.value.trim())
    if (guess) protocolSelect.setValue(guess)
  }
  pushChatConfig()
})

modelInput.addEventListener('input', pushChatConfig)

hotkeyInput.addEventListener('input', () => {
  pushChatConfig()
  void bridge.setHotkey?.(hotkeyInput.value.trim())?.then(({ activeHotkey }) => {
    updateHotkeyStatus(activeHotkey)
  })
})

function updateHotkeyStatus(active: string | null) {
  const wanted = hotkeyInput.value.trim() || 'Super+Alt+X'
  if (!active) hotkeyStatus.textContent = '✗ no combo registered'
  else if (active !== wanted) hotkeyStatus.textContent = `fallback active: ${active}`
  else hotkeyStatus.textContent = `active: ${active}`
}

hotkeyTestBtn.addEventListener('click', () => {
  void bridge.testHotkey?.(hotkeyInput.value.trim())?.then(({ ok, activeHotkey }) => {
    updateHotkeyStatus(ok ? activeHotkey : null)
  })
})

testBtn.addEventListener('click', () => {
  testBtn.disabled = true
  testResult.textContent = 'testing …'
  testResult.className = ''
  void bridge.testProvider?.()?.then((res) => {
    testBtn.disabled = false
    if (res.ok) {
      testResult.textContent = '✓ connected'
      testResult.className = 'ok'
    } else {
      testResult.textContent = `✗ ${res.error ?? 'failed'}`
      testResult.className = 'err'
      testResult.title = res.error ?? ''
    }
  })
})

apiKeyInput.addEventListener('change', () => {
  const key = apiKeyInput.value.trim()
  if (!key) return
  void bridge.setApiKey?.(key)?.then(({ ok }) => {
    apiKeyInput.value = ''
    apiKeyInput.placeholder = ok ? '(saved)' : '(storage unavailable)'
  })
})

// In-Fenster-Dialog statt window.confirm() — nicht-fokussierbare Fenster
// koennen gar keine nativen Dialoge zeigen, und die UI-Regel verbietet sie eh.
clearMemoryBtn.addEventListener('click', () => {
  void confirmDialog({
    title: 'Clear chat memory?',
    message: 'The current history is archived to chat-history.archived-<ts>.jsonl — nothing is deleted.',
    okLabel: 'Archive & clear',
    danger: true
  }).then((yes) => {
    if (!yes) return
    void bridge.clearMemory?.()?.then(() => {
      clearMemoryBtn.textContent = '(archived)'
      setTimeout(() => {
        clearMemoryBtn.textContent = 'Clear memory'
      }, 2000)
    })
  })
})

/* ------------------------------------------------------ about & updates */

const aboutAvatarPreview = document.getElementById('about-avatar-preview')
const aboutAppVersion = document.getElementById('about-app-version')
const checkUpdatesBtn = document.getElementById('check-updates-btn') as HTMLButtonElement
const updateIndicator = document.getElementById('update-indicator')
const updateStatusText = document.getElementById('update-status-text')
const updateModeLine = document.getElementById('update-mode-line')
const updateDetailsCard = document.getElementById('update-details-card')
const updateCardTitle = document.getElementById('update-card-title')
const updateCardDate = document.getElementById('update-card-date')
const updateCardNotes = document.getElementById('update-card-notes')
const installUpdateBtn = document.getElementById('install-update-btn') as HTMLButtonElement
const viewReleaseBtn = document.getElementById('view-release-btn') as HTMLButtonElement
const updateProgressWrap = document.getElementById('update-progress-wrap')
const updateProgressFill = document.getElementById('update-progress-fill')
const updateProgressText = document.getElementById('update-progress-text')

let currentUpdateInfo: UpdateCheckResult | null = null

function updateAboutAvatar() {
  if (!aboutAvatarPreview || !config) return
  aboutAvatarPreview.replaceChildren(
    frozenPreview(40, {
      shapeId: config.shape,
      colorId: config.color,
      expressionId: config.expression
    })
  )
}

async function loadSpecs() {
  if (!bridge.getAppSpecs) return
  try {
    const specs = await bridge.getAppSpecs()
    if (aboutAppVersion) aboutAppVersion.textContent = `v${specs.appVersion}`
    renderUpdateModeLine(specs.runMode)
    const elRunMode = document.getElementById('spec-run-mode')
    if (elRunMode) {
      elRunMode.textContent =
        specs.runMode === 'git'
          ? `source checkout${specs.gitRoot ? ` · ${specs.gitRoot}` : ''}`
          : specs.runMode === 'source'
            ? 'source (no git)'
            : 'packaged app'
    }
    const elOs = document.getElementById('spec-os')
    const elArch = document.getElementById('spec-arch')
    const elElectron = document.getElementById('spec-electron')
    const elChrome = document.getElementById('spec-chrome')
    const elNode = document.getElementById('spec-node')
    const elV8 = document.getElementById('spec-v8')
    const elMem = document.getElementById('spec-mem')

    if (elOs) elOs.textContent = `${specs.osName} (${specs.osRelease})`
    if (elArch) elArch.textContent = `${specs.platform} / ${specs.arch}`
    if (elElectron) elElectron.textContent = `v${specs.electronVersion}`
    if (elChrome) elChrome.textContent = `v${specs.chromeVersion}`
    if (elNode) elNode.textContent = `v${specs.nodeVersion}`
    if (elV8) elV8.textContent = `v${specs.v8Version}`
    if (elMem) elMem.textContent = `${specs.processMemory} (System: ${specs.freeMemory} free / ${specs.totalMemory})`
  } catch (err) {
    console.error('Failed to load specs:', err)
  }
}

function renderUpdateModeLine(runMode: string | undefined) {
  if (!updateModeLine) return
  if (runMode === 'git') {
    updateModeLine.innerHTML =
      'Running from <b>git checkout</b> — updates pull the latest code instead of an installer.'
  } else if (runMode === 'source') {
    updateModeLine.innerHTML =
      'Running from <b>source</b> without a git repo — clone <b>Mailo037/bloub</b> to enable auto-update.'
  } else {
    updateModeLine.innerHTML =
      'Running the <b>packaged app</b> — updates use the release installer.'
  }
}

function setUpdateStatus(state: 'idle' | 'busy' | 'ok' | 'alert' | 'err', text: string) {
  if (updateIndicator) {
    updateIndicator.className = `update-indicator ${state}`
  }
  if (updateStatusText) {
    updateStatusText.textContent = text
  }
}

async function handleCheckUpdates() {
  if (!checkUpdatesBtn || !bridge.checkForUpdates) return
  checkUpdatesBtn.disabled = true
  setUpdateStatus('busy', 'Checking for updates...')
  updateDetailsCard?.classList.add('hidden')
  updateProgressWrap?.classList.add('hidden')

  try {
    const res = await bridge.checkForUpdates()
    currentUpdateInfo = res

    // Git-Modus: statt Releases der Remote-Stand des Checkouts.
    if (res.mode === 'git') {
      const remoteLabel = res.gitBranch ? `origin/${res.gitBranch}` : 'remote'
      if (res.updateAvailable) {
        setUpdateStatus('alert', `New code available (${res.gitBehind} commit(s) behind)`)
        if (updateDetailsCard && updateCardTitle && updateCardNotes) {
          updateCardTitle.textContent = `Branch ${res.gitBranch ?? 'HEAD'}`
          if (updateCardDate) updateCardDate.textContent = ''
          updateCardNotes.textContent = res.releaseNotes || `${res.gitBehind} commit(s) behind ${remoteLabel}.`
          updateDetailsCard.classList.remove('hidden')
        }
        if (installUpdateBtn) {
          installUpdateBtn.textContent = 'Pull & restart'
          installUpdateBtn.disabled = !!res.gitDirty
          installUpdateBtn.title = res.gitDirty ? 'Commit or stash local changes first' : ''
        }
      } else {
        setUpdateStatus('ok', res.gitDirty ? `Up to date (${remoteLabel}) — local changes present` : `Up to date with ${remoteLabel}`)
        if (installUpdateBtn) installUpdateBtn.textContent = 'Pull & restart'
      }
      return
    }

    // Quellcode ohne Git: kein Auto-Update moeglich.
    if (res.mode === 'source') {
      setUpdateStatus('idle', 'Source run — no git repo to pull from')
      if (updateDetailsCard && updateCardTitle && updateCardNotes) {
        updateCardTitle.textContent = 'Manual update required'
        if (updateCardDate) updateCardDate.textContent = ''
        updateCardNotes.textContent = res.releaseNotes || 'Clone https://github.com/Mailo037/bloub.git to enable auto-update.'
        updateDetailsCard.classList.remove('hidden')
      }
      if (installUpdateBtn) {
        installUpdateBtn.textContent = 'Install update'
        installUpdateBtn.disabled = true
      }
      return
    }

    // Packaged: normaler Release-Check.
    if (res.updateAvailable) {
      setUpdateStatus('alert', `New version available (v${res.latestVersion})`)
      if (updateDetailsCard && updateCardTitle && updateCardNotes) {
        updateCardTitle.textContent = res.releaseName || `Bloub Pet v${res.latestVersion}`
        if (updateCardDate) {
          updateCardDate.textContent = res.publishedAt
            ? new Date(res.publishedAt).toLocaleDateString()
            : ''
        }
        updateCardNotes.textContent = res.releaseNotes || 'Includes latest fixes and improvements.'
        updateDetailsCard.classList.remove('hidden')
      }
      if (installUpdateBtn) installUpdateBtn.textContent = 'Install update'
    } else {
      setUpdateStatus('ok', `You have the latest version (v${res.currentVersion})`)
    }
  } catch (err) {
    setUpdateStatus('err', 'Failed to check for updates')
    console.error(err)
  } finally {
    setTimeout(() => {
      checkUpdatesBtn.disabled = false
    }, 600)
  }
}

async function handleInstallUpdate() {
  if (!installUpdateBtn || !bridge.installUpdate) return
  installUpdateBtn.disabled = true
  const isGit = currentUpdateInfo?.mode === 'git'
  setUpdateStatus('busy', isGit ? 'Pulling latest code...' : 'Downloading update...')
  updateProgressWrap?.classList.remove('hidden')
  if (updateProgressFill) updateProgressFill.style.width = '10%'
  if (updateProgressText) updateProgressText.textContent = 'Connecting...'

  try {
    const res = await bridge.installUpdate({ downloadUrl: currentUpdateInfo?.downloadUrl })
    if (res.ok) {
      setUpdateStatus('ok', res.message || 'Update completed!')
      if (updateProgressFill) updateProgressFill.style.width = '100%'
      if (updateProgressText) updateProgressText.textContent = 'Ready!'
    } else {
      setUpdateStatus('err', res.error || 'Update failed')
      if (updateProgressText) updateProgressText.textContent = res.error || 'Update failed'
    }
  } catch (err) {
    setUpdateStatus('err', 'Update installation failed')
    console.error(err)
  } finally {
    installUpdateBtn.disabled = false
  }
}

bridge.onUpdateProgress?.((p) => {
  if (updateProgressWrap) updateProgressWrap.classList.remove('hidden')
  if (updateProgressFill) updateProgressFill.style.width = `${p.percent}%`
  if (updateProgressText) updateProgressText.textContent = p.status
})

checkUpdatesBtn?.addEventListener('click', () => void handleCheckUpdates())
installUpdateBtn?.addEventListener('click', () => void handleInstallUpdate())

// Main bittet das Settings-Fenster, direkt einen bestimmten Tab zu oeffnen
// (z. B. "about", wenn das Update nur einen Klick entfernt sein soll).
bridge.onOpenTab?.((tab) => {
  switchTab(tab)
})

viewReleaseBtn?.addEventListener('click', () => {
  if (currentUpdateInfo?.htmlUrl) {
    void bridge.openExternal?.(currentUpdateInfo.htmlUrl)
  }
})

document.getElementById('link-github')?.addEventListener('click', () => {
  void bridge.openExternal?.('https://github.com/Mailo037/bloub')
})
document.getElementById('link-releases')?.addEventListener('click', () => {
  void bridge.openExternal?.('https://github.com/Mailo037/bloub/releases')
})
document.getElementById('link-issues')?.addEventListener('click', () => {
  void bridge.openExternal?.('https://github.com/Mailo037/bloub/issues')
})

/* --------------------------------------------------------- recall section */

const recallMasterSwitch = createSwitch({
  label: 'Record my activity',
  onChange: (checked) => {
    void bridge.recallSetConfig?.({ enabled: checked })
  }
})
document.getElementById('recall-master-slot')!.replaceChildren(recallMasterSwitch.el)

// Terminal capture: eigener Opt-in-Schalter neben dem Master
const recallShellSwitch = createSwitch({
  label: 'Terminal commands',
  onChange: (checked) => {
    void bridge.recallSetConfig?.({ shell: checked })
    if (checked && !config.recall?.enabled) {
      // Shell-Producer braucht den Master — bewusst MIT anstellen
      void bridge.recallSetConfig?.({ enabled: true })
    }
  }
})
document.getElementById('recall-shell-slot')!.replaceChildren(recallShellSwitch.el)

const recallClipboardSwitch = createSwitch({
  label: 'Clipboard history',
  onChange: (checked) => {
    void bridge.recallSetConfig?.({ clipboard: checked, ...(config.recall?.enabled === false ? { enabled: false } : {}) })
  }
})
document.getElementById('recall-clipboard-slot')!.replaceChildren(recallClipboardSwitch.el)

const recallBrowserSeg = createSegmented({
  options: [
    { value: 'off', label: 'Off' },
    { value: 'extension', label: 'Guided extension' },
    { value: 'cdp', label: 'Supervised relaunch' }
  ],
  onChange: (value) => {
    void bridge.recallSetConfig?.({ browserLink: value })
  }
})
document.getElementById('recall-browser-slot')!.replaceChildren(recallBrowserSeg.el)

const recallPauseIndicator = document.getElementById('recall-pause-indicator')!
const recallPauseDot = document.getElementById('recall-pause-dot')!
const recallPauseBtn = document.getElementById('recall-pause-btn') as HTMLButtonElement
recallPauseBtn.addEventListener('click', () => {
  void bridge.recallTogglePause?.()
})

const recallShellStatus = document.getElementById('recall-shell-status')!
const recallShellDot = document.getElementById('recall-shell-dot')!
const shellInstallBtn = document.getElementById('recall-shell-install-btn') as HTMLButtonElement
const shellRemoveBtn = document.getElementById('recall-shell-remove-btn') as HTMLButtonElement

shellInstallBtn.addEventListener('click', () => {
  void bridge.recallShellInstall?.()?.then((results) => {
    const okCount = results.filter((r) => r.changed).length
    const err = results.find((r) => r.error)
    recallShellStatus.textContent = err
      ? `✗ ${err.error}`
      : okCount > 0
        ? '✓ profile hooks installed — open a new terminal'
        : 'already installed'
    void refreshRecallStatus()
  })
})

shellRemoveBtn.addEventListener('click', () => {
  void bridge.recallShellRemove?.()?.then(() => {
    recallShellStatus.textContent = 'profile hooks removed'
    void refreshRecallStatus()
  })
})

const BROWSER_HINTS: Record<string, string> = {
  off: 'Off: only window titles of browser windows are recorded (via app focus).',
  extension:
    'Guided extension: press "Prepare extension folder" below, then in Chrome open chrome://extensions → enable Developer mode → "Load unpacked" → pick that folder → click the bloub-link icon and Connect. Prefer downloading? Grab the ZIP from the GitHub release link.',
  cdp: 'Supervised relaunch: Chrome is restarted with a local debugging port and Bloub captures your outbound submits directly. Close all Chrome windows first, otherwise Chrome ignores the port.'
}
function syncBrowserHint(mode: string) {
  const el = document.getElementById('recall-browser-hint')
  if (el) el.textContent = BROWSER_HINTS[mode] ?? BROWSER_HINTS.off!
  // Extension-Zeile nur im Guided-Extension-Modus zeigen
  const row = document.getElementById('recall-extension-row')
  if (row) row.style.display = mode === 'extension' ? '' : 'none'
}

const extBtn = document.getElementById('recall-ext-btn') as HTMLButtonElement
extBtn?.addEventListener('click', () => {
  const statusEl = document.getElementById('recall-ext-status')
  if (statusEl) statusEl.textContent = 'copying…'
  void bridge.recallExtensionFolder?.()?.then((res) => {
    if (!statusEl) return
    if (res.ok) {
      statusEl.textContent =
        `✓ ${res.folder}` + (res.port ? ` · listening on port ${res.port}` : ' · enable the toggle first')
    } else {
      statusEl.textContent = `✗ ${res.error}`
    }
  })
})

/** Release-Download der Extension (ZIP) — statt losen Dateien im Repo. */
const BLOUB_LINK_GITHUB_URL = 'https://github.com/Mailo037/bloub/releases/tag/bloub-link-v1.0.0'
document.getElementById('recall-ext-github-btn')?.addEventListener('click', () => {
  void bridge.openExternal?.(BLOUB_LINK_GITHUB_URL)
})

const retentionInput = document.getElementById('recall-retention') as HTMLInputElement
retentionInput.addEventListener('change', () => {
  const days = Math.min(365, Math.max(1, Math.round(Number(retentionInput.value) || 14)))
  retentionInput.value = String(days)
  void bridge.recallSetConfig?.({ retentionDays: days })
  storageMsg.textContent = `retention set to ${days} days`
})

const storageMsg = document.getElementById('recall-storage-line')!
const storageEventsEl = document.getElementById('recall-storage-events')!
const storageSizeEl = document.getElementById('recall-storage-size')!
const storageOldestEl = document.getElementById('recall-storage-oldest')!

document.getElementById('recall-index-now-btn')?.addEventListener('click', () => {
  void bridge.recallIndexNow?.()?.then((r) => {
    storageMsg.textContent = `indexing… ${r.indexed} new events folded in`
    setTimeout(() => void refreshRecallStatus(), 800)
  })
})

document.getElementById('recall-purge-btn')?.addEventListener('click', () => {
  void confirmDialog({
    title: 'Purge everything?',
    message: 'Deletes ALL recorded activity: raw events, spool files and search index. This cannot be undone.',
    okLabel: 'Purge',
    danger: true
  }).then((ok) => {
    if (!ok) return
    void bridge.recallPurge?.()?.then(({ freed }) => {
      storageMsg.textContent = `purged (~${Math.max(1, Math.round(freed / 1024))} KB freed)`
      void refreshRecallStatus()
    })
  })
})

let lastRecallStatus: RecallStatus | null = null

/** Setzt den Status-Punkt (on/warn/off) anhand eines Zustands. */
function setRecallDot(el: HTMLElement, state: 'on' | 'warn' | 'off' | 'idle') {
  el.className = `recall-status-dot ${state === 'idle' ? '' : state}`.trim()
}

async function refreshRecallStatus() {
  const st = await bridge.recallGetStatus?.()
  if (!st) return
  lastRecallStatus = st
  // Pause-Anzeige spiegelt den Tray-Zustand
  if (!st.enabled) {
    recallPauseIndicator.textContent = 'Recording off'
    setRecallDot(recallPauseDot, 'off')
    recallPauseBtn.disabled = true
  } else if (st.autoPaused) {
    recallPauseIndicator.textContent = 'Auto-paused (sensitive window)'
    setRecallDot(recallPauseDot, 'warn')
    recallPauseBtn.disabled = true
  } else if (st.manualPaused) {
    recallPauseIndicator.textContent = 'Paused'
    setRecallDot(recallPauseDot, 'warn')
    recallPauseBtn.disabled = false
    recallPauseBtn.textContent = 'Resume'
  } else {
    recallPauseIndicator.textContent = 'Recording'
    setRecallDot(recallPauseDot, 'on')
    recallPauseBtn.disabled = false
    recallPauseBtn.textContent = 'Pause now'
  }
  // Shell-Hook-Status
  const hooks = st.shellHooks ?? []
  const installed = hooks.filter((h) => h.installed).length
  if (hooks.length === 0) {
    recallShellStatus.textContent = 'No PowerShell profile found'
    setRecallDot(recallShellDot, 'off')
  } else if (installed === 0) {
    recallShellStatus.textContent = 'Not hooked — install below'
    setRecallDot(recallShellDot, 'off')
    shellRemoveBtn.disabled = true
  } else if (installed < hooks.length) {
    recallShellStatus.textContent = `${installed}/${hooks.length} profiles hooked`
    setRecallDot(recallShellDot, 'warn')
    shellRemoveBtn.disabled = false
  } else {
    recallShellStatus.textContent = `${installed} profile${installed === 1 ? '' : 's'} hooked`
    setRecallDot(recallShellDot, 'on')
    shellRemoveBtn.disabled = false
  }
  // Storage-Summary
  const { bytes, lines, oldestTs } = st.storage ?? { bytes: 0, lines: 0, oldestTs: null }
  storageEventsEl.textContent = lines.toLocaleString()
  storageSizeEl.textContent = `${(bytes / 1024).toFixed(0)} KB`
  storageOldestEl.textContent = oldestTs
    ? new Date(oldestTs).toLocaleDateString()
    : '—'
  storageMsg.textContent = `Retention: ${config.recall?.retentionDays ?? 14} days`
}

/** Felder aus der frischen Config befuellen (ohne Fokus-Override). */
function syncRecallFields() {
  const r = config.recall
  if (!r) return
  recallMasterSwitch.setValue(!!r.enabled)
  recallShellSwitch.setValue(r.shell !== false)
  recallClipboardSwitch.setValue(!!r.clipboard)
  recallBrowserSeg.setValue(r.browserLink ?? 'off')
  syncBrowserHint(r.browserLink ?? 'off')
  if (document.activeElement !== retentionInput) retentionInput.value = String(r.retentionDays ?? 14)
  void refreshRecallStatus()
}

/* -------------------------------------------------------- audio / sprache */

// Separater Gemini-Sprachbereich: STT + TTS, unabhaengig vom Chat-Provider.

const audioModelSeg = createSegmented({
  options: [
    { value: 'gemini-2.5-flash-native-audio-preview-12-2025', label: '2.5 Flash Audio' },
    { value: 'gemini-3.1-flash-live-preview', label: '3.1 Flash Live' }
  ],
  onChange: (value) => pushAudioConfig({ model: value })
})
document.getElementById('audio-model-slot')!.replaceChildren(audioModelSeg.el)

const audioApiKeyInput = document.getElementById('audio-apikey') as HTMLInputElement
const audioTestResult = document.getElementById('audio-test-result')!
const audioTestBtn = document.getElementById('audio-test-btn') as HTMLButtonElement
const audioPreviewBtn = document.getElementById('audio-preview-btn') as HTMLButtonElement
const audioPreviewResult = document.getElementById('audio-preview-result')!
const audioPttInput = document.getElementById('audio-ptt') as HTMLInputElement

const audioVoiceSelect = createSelect({
  options: [
    { value: 'Achird', label: 'Achird — friendly' },
    { value: 'Kore', label: 'Kore — firm' },
    { value: 'Puck', label: 'Puck — upbeat' },
    { value: 'Aoede', label: 'Aoede — breezy' },
    { value: 'Sulafat', label: 'Sulafat — warm' },
    { value: 'Leda', label: 'Leda — youthful' }
  ],
  onChange: (voice) => {
    stopVoicePreview()
    pushAudioConfig({ voice })
  }
})
document.getElementById('audio-voice-picker-slot')!.replaceChildren(audioVoiceSelect.el)

const audioVoiceSwitch = createSwitch({
  label: 'Read replies aloud',
  onChange: (checked) => pushAudioConfig({ voiceEnabled: checked })
})
document.getElementById('audio-voice-slot')!.replaceChildren(audioVoiceSwitch.el)

/** Audio-Änderungen an den Main schicken (mergt in den audio-Block). */
function pushAudioConfig(partial: Record<string, unknown>) {
  void bridge.updateConfig({ audio: { ...(config.audio ?? {}), ...partial } })
}

audioApiKeyInput?.addEventListener('change', () => {
  void bridge.setAudioApiKey?.(audioApiKeyInput.value.trim()).then(({ ok }) => {
    if (ok) {
      audioApiKeyInput.value = ''
      audioApiKeyInput.placeholder = '(saved)'
    }
  })
})

audioPttInput?.addEventListener('change', () => {
  const combo = audioPttInput.value.trim()
  void bridge.setAudioPttHotkey?.(combo || null)?.then((res) => {
    audioPttInput.value = res?.activeHotkey ?? combo
  })
})

let voicePreviewAudio: HTMLAudioElement | null = null
let voicePreviewUrl = ''

function stopVoicePreview() {
  voicePreviewAudio?.pause()
  voicePreviewAudio = null
  if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl)
  voicePreviewUrl = ''
}

audioPreviewBtn?.addEventListener('click', () => {
  if (!bridge.previewAudioVoice) {
    audioPreviewResult.textContent = 'not supported'
    return
  }
  stopVoicePreview()
  audioPreviewBtn.disabled = true
  audioPreviewResult.textContent = 'Generating…'
  void bridge.previewAudioVoice(audioVoiceSelect.getValue()).then(async (res) => {
    audioPreviewBtn.disabled = false
    if (!res.ok || !res.data) {
      audioPreviewResult.textContent = `✗ ${res.error || 'failed'}`
      return
    }
    const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0))
    voicePreviewUrl = URL.createObjectURL(new Blob([bytes], { type: res.mime || 'audio/wav' }))
    voicePreviewAudio = new Audio(voicePreviewUrl)
    voicePreviewAudio.onended = () => {
      stopVoicePreview()
      audioPreviewResult.textContent = '✓ ready'
    }
    voicePreviewAudio.onerror = () => {
      stopVoicePreview()
      audioPreviewResult.textContent = '✗ playback failed'
    }
    audioPreviewResult.textContent = 'Playing…'
    await voicePreviewAudio.play()
  }).catch((err) => {
    stopVoicePreview()
    audioPreviewBtn.disabled = false
    audioPreviewResult.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`
  })
})

audioTestBtn?.addEventListener('click', () => {
  if (!bridge.testAudioConnection) {
    audioTestResult.textContent = 'not supported'
    return
  }
  audioTestBtn.disabled = true
  audioTestResult.textContent = 'Testing…'
  void bridge.testAudioConnection?.().then((res) => {
    audioTestBtn.disabled = false
    audioTestResult.textContent = res.ok ? '✓ voice engine ready' : `✗ ${res.error || 'failed'}`
  })
})

document.getElementById('audio-guide-aistudio')?.addEventListener('click', () => {
  void bridge.openExternal?.('https://aistudio.google.com/app/apikey')
})
document.getElementById('audio-guide-pricing')?.addEventListener('click', () => {
  void bridge.openExternal?.('https://ai.google.dev/gemini-api/docs/pricing')
})

/** Audio-Felder aus der frischen Config befuellen. */
function syncAudioFields() {
  const a = config.audio
  if (!a) return
  audioModelSeg.setValue(a.model ?? '')
  audioVoiceSwitch.setValue(!!a.voiceEnabled)
  audioVoiceSelect.setValue(a.voice ?? 'Achird')
  if (document.activeElement !== audioApiKeyInput) {
    // Feld NICHT leeren — der eingegebene Wert bleibt sichtbar. Nur den
    // Platzhalter als Hinweis setzen, ob ein Key hinterlegt ist.
    void bridge.getAudioKeyStatus?.()?.then(({ hasKey }) => {
      audioApiKeyInput.placeholder = hasKey ? '(saved)' : '(not set)'
    })
  }
  if (document.activeElement !== audioPttInput) {
    audioPttInput.value = a.pttHotkey ?? ''
  }
}

/* ---- Resize: Ziehen an Kanten und Ecken ---- */

const MIN_W = 300
const MIN_H = 360

for (const handle of document.querySelectorAll<HTMLElement>('.rz')) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const dir = handle.dataset.dir ?? ''
    const start = {
      mx: e.screenX,
      my: e.screenY,
      x: window.screenX,
      y: window.screenY,
      w: window.innerWidth,
      h: window.innerHeight
    }

    const move = (ev: PointerEvent) => {
      const dx = ev.screenX - start.mx
      const dy = ev.screenY - start.my
      let { x, y, w, h } = start
      if (dir.includes('e')) w = start.w + dx
      if (dir.includes('s')) h = start.h + dy
      if (dir.includes('w')) {
        w = start.w - dx
        x = start.x + dx
      }
      if (dir.includes('n')) {
        h = start.h - dy
        y = start.y + dy
      }
      // Mindestgroesse: die gegenueberliegende Kante bleibt am Cursor haften.
      if (w < MIN_W) {
        if (dir.includes('w')) x -= MIN_W - w
        w = MIN_W
      }
      if (h < MIN_H) {
        if (dir.includes('n')) y -= MIN_H - h
        h = MIN_H
      }
      bridge.resizeSettings(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
}

async function init() {
  config = await bridge.getConfig()
  sizeRange.value = String(config.ballSize)
  sizeVal.textContent = String(config.ballSize)
  eventsSwitch.setValue(config.eventsEnabled)
  screenshotAllSwitch.setValue(config.screenshotAllDisplays !== false)
  globalCursorSwitch.setValue(config.globalCursorTracking !== false)
  autostartSwitch.setValue(!!config.autostart)
  buildPills()
  refreshSelections()
  syncChatFields()
  syncRecallFields()
  syncAudioFields()
  renderGrants(config.chat?.grants ?? [])
  updateAboutAvatar()
  void loadSpecs()
  void bridge.getApiKeyStatus?.()?.then(({ hasKey }) => {
    apiKeyInput.placeholder = hasKey ? '(saved)' : '(not set)'
  })
}

void init()

/* =====================================================================
   Zusammenklappbare Sections + Suchleiste
   ===================================================================== */

function setupCollapsible(): void {
  for (const well of document.querySelectorAll<HTMLElement>('.well.collapsible')) {
    const head = well.querySelector<HTMLElement>('.well-head')
    if (!head) continue
    // Idempotent: ein zweiter Aufruf darf denselben Header nicht doppelt
    // verkabeln (zwei Toggles = kein sichtbarer Effekt).
    if (head.dataset.collapsibleBound) continue
    head.dataset.collapsibleBound = '1'
    head.addEventListener('click', (e) => {
      // Klicks auf inaktive Controls im Header nicht schlucken (z.B. size-val ist nur Text)
      well.classList.toggle('open', !well.classList.contains('open'))
    })
  }
}

const searchToggleBtn = document.getElementById('search-toggle')
const searchBar = document.getElementById('search-bar')
const searchInput = document.getElementById('search-input') as HTMLInputElement | null

/** Bestimmt die durchsuchbaren Texte einer Well (Header + sichtbare Labels/Hints). */
function wellSearchText(well: HTMLElement): string {
  const parts: string[] = []
  const head = well.querySelector('.well-head')
  if (head) parts.push(head.textContent ?? '')
  // Labels (fld-Label-Text) und Hints einsammeln - ohne Kontrollwerte
  for (const el of well.querySelectorAll<HTMLElement>('.fld, .hint, .toggle-slot, .pills, #color-row, .about-desc')) {
    parts.push(el.textContent ?? '')
  }
  return parts.join(' ').toLowerCase()
}

function setupSearch(): void {
  if (!searchToggleBtn || !searchBar) return

  let searchOpen = false

  const toggleSearch = (open: boolean) => {
    searchOpen = open
    searchBar.classList.toggle('hidden', !open)
    if (open) {
      searchInput?.focus()
    } else if (searchInput) {
      searchInput.value = ''
      clearSearch()
    }
  }

  searchToggleBtn.addEventListener('click', () => toggleSearch(!searchOpen))

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleSearch(false)
  })

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase()
      if (!q) {
        clearSearch()
        return
      }
      // Alle Sections ueber ALLE Tabs hinweg durchsuchen und automatisch zum
      // passenden Tab springen (Treffer in anderen Tabs werden sichtbar).
      let anyHit = false
      let firstHitTab: string | null = null
      for (const well of document.querySelectorAll<HTMLElement>('.well.collapsible')) {
        const hit = wellSearchText(well).includes(q)
        well.classList.toggle('search-hit', hit)
        well.classList.toggle('search-hidden', !hit)
        if (hit && !well.classList.contains('open')) well.classList.add('open')
        if (hit) {
          anyHit = true
          if (!firstHitTab) {
            const pane = well.closest<HTMLElement>('.pane')
            if (pane) firstHitTab = pane.id.replace('pane-', '')
          }
        }
      }
      // Bei Treffern in einem anderen Tab automatisch dorthin wechseln
      if (firstHitTab && firstHitTab !== currentSearchTab) {
        switchTab(firstHitTab)
      }
    })
  }

  function clearSearch() {
    for (const well of document.querySelectorAll<HTMLElement>('.well.collapsible')) {
      well.classList.remove('search-hit', 'search-hidden')
    }
  }
}

/* Nur EINMAL aufrufen: jeder Doppelaufruf haengt jeden Header DOPPELT an
 * einen Click-Listener — die beiden Toggles heben sich gegenseitig auf und
 * die Section laesst sich nicht mehr zusammen- oder aufklappen. */
setupCollapsible()
setupSearch()


