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
  type UpdateCheckResult
} from './shared'

import { createSegmented, createSwitch, confirmDialog, type SelectHandle } from './ui/kit'

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
  syncChatFields()
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

for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabs [data-tab]')) {
  btn.addEventListener('click', () => {
    const id = btn.dataset.tab ?? 'look'
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs [data-tab]')) {
      b.classList.toggle('on', b === btn)
    }
    for (const pane of document.querySelectorAll<HTMLElement>('.pane')) {
      pane.classList.toggle('hidden', pane.id !== `pane-${id}`)
    }
    scrollContainer?.scrollTo({ top: 0, behavior: 'instant' })
    requestAnimationFrame(updateScrollGradients)
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
        updateCardTitle.textContent = res.releaseName || `Bloub Pad v${res.latestVersion}`
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
  if (updateProgressText) updateProgressText.textContent = `${p.status} (${p.percent}%)`
})

checkUpdatesBtn?.addEventListener('click', () => void handleCheckUpdates())
installUpdateBtn?.addEventListener('click', () => void handleInstallUpdate())

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
  buildPills()
  refreshSelections()
  syncChatFields()
  renderGrants(config.chat?.grants ?? [])
  updateAboutAvatar()
  void loadSpecs()
  void bridge.getApiKeyStatus?.()?.then(({ hasKey }) => {
    apiKeyInput.placeholder = hasKey ? '(saved)' : '(not set)'
  })
}

void init()


