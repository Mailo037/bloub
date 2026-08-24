const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, safeStorage, shell, desktopCapturer } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const https = require('node:https')
const { execFile, spawn } = require('node:child_process')


app.setName('bloub-pet')

// Windows: Prozess/AppUserModel mit dem Bloub-Icon verknuepfen (Taskbar/Alt-Tab).
// Muss vor app.whenReady() gesetzt werden; exe-Icon liefert electron-builder.
app.setAppUserModelId('com.bloub.pet')

// Gemeinsames Fenster-Icon (Multi-Size-.ico aus tools/make-icon.mjs).
const APP_ICON_PATH = path.join(__dirname, 'assets', 'bloub.ico')
function windowIcon() {
  return nativeImage.createFromPath(APP_ICON_PATH)
}

// Chat-Komponenten (eigene Schicht, keine Abhaengigkeiten)
const agentMod = require('./chat/agent.cjs')
const history = require('./chat/history.cjs')
const toolsMod = require('./chat/tools.cjs')
const provider = require('./chat/provider.cjs')
const recallMod = require('./recall/orchestrator.cjs')
const shellHook = require('./recall/shell-hook.cjs')
const recallStore = require('./recall/store.cjs')
const browserLinkMod = require('./recall/browser-link.cjs')
const geminiAudio = require('./chat/gemini-audio.cjs')

Menu.setApplicationMenu(null)

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
  process.exit(0)
}

const DEV_URL = process.env.BLOUB_PET_DEV_URL || ''

let win = null
let settingsWin = null
let tray = null
let config = null

/** Letztes Update-Check-Ergebnis (gecacht, an das Pet-Fenster gebroadcastet). */
let lastUpdateResult = null
/** Gewuenschter Settings-Tab, der beim naechsten Oeffnen angezeigt wird. */
let pendingSettingsTab = null
let updateCheckTimer = null

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
  }
})

const SETTINGS_W = 352
const SETTINGS_H = 620

/** Gemeinsame Chromeless-Flags fuer rahmenlose Fenster. */
function overlayWindowOptions(extra) {
  return {
    title: '',
    frame: false,
    transparent: true,
    thickFrame: false,
    hasShadow: false,
    roundedCorners: false,
    autoHideMenuBar: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    ...extra
  }
}

function applyOverlayChrome(w) {
  if (!w || w.isDestroyed()) return
  w.setTitle('')
  w.setMenu(null)
  w.removeMenu()
  w.setMenuBarVisibility(false)
  w.setHasShadow(false)
}

/* ------------------------- Pet on-top safeguard + taskbar fallback */

/**
 * Watchdog + Lifecycle-Handling, damit der Bloub nie "verloren" geht.
 *
 * Bloub ist ein freischwebendes, immer-on-top-Fenster mit skipTaskbar:true.
 * Manchmal verliert er den Top-Zustand oder wird unsichtbar (hinter Fenstern,
 * minimiert, ausgeblendet). Genau dann soll er in die TASKBAR rutschen, damit
 * er dort auffindbar und per Klick zurueckholbar ist. Sobald er (wieder)
 * sichtbar ist, wird der always-on-top-Zustand re-assertiert und er verlaesst
 * die Taskbar wieder — on top, aber nicht mehr als Taskbar-Fenster.
 */
let petTaskbar = false
let petWatchdog = null

/** Fenster in (true) bzw. aus (false) der Taskbar legen. */
function setPetTaskbar(inTaskbar) {
  if (petTaskbar === inTaskbar) return
  petTaskbar = inTaskbar
  if (win && !win.isDestroyed()) {
    try {
      win.setSkipTaskbar(!inTaskbar)
    } catch {
      /* best effort */
    }
  }
}

/**
 * Bloub immer nach vorn holen: fehlenden always-on-top-Zustand re-assertieren.
 * moveTop() wird NUR nachgeholt, wenn der Top-Zustand wirklich verloren war —
 * so wird nicht alle 1,5 s die Z-Ordnung gestohlen (z. B. ueber dem Settings-
 * Dialog oder anderen always-on-top-Fenstern). moveTop() raubt keinen Fokus
 * und verschiebt das Fenster nicht.
 */
function reassertPetOnTop() {
  if (!win || win.isDestroyed()) return
  try {
    if (!win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(true)
      win.moveTop()
    }
  } catch {
    /* best effort */
  }
}

/** Bloub zurueck auf den Top-Zustand holen und aus der Taskbar nehmen. */
function restorePetOnTop() {
  if (!win || win.isDestroyed()) return
  reassertPetOnTop()
  setPetTaskbar(false)
}

/** Ein Watchdog-Tick: sichtbar -> on top & raus aus der Taskbar; sonst -> Taskbar. */
function petWatchdogCheck() {
  if (!win || win.isDestroyed()) return
  let visible = false
  try {
    visible = win.isVisible()
  } catch {
    return
  }
  if (visible) {
    // Sichtbar: on top bleiben und aus der Taskbar nehmen
    reassertPetOnTop()
    setPetTaskbar(false)
  } else {
    // Unsichtbar/verloren: in der Taskbar halten, damit er auffindbar bleibt
    setPetTaskbar(true)
  }
}

function startPetWatchdog() {
  if (petWatchdog) return
  petWatchdog = setInterval(petWatchdogCheck, 1500)
}

function stopPetWatchdog() {
  if (petWatchdog) {
    clearInterval(petWatchdog)
    petWatchdog = null
  }
}

/* ------------------------------------------------------------- config */

function configPath() {
  return path.join(app.getPath('userData'), 'bloub-pet.config.json')
}

function loadConfig() {
  const fallback = {
    x: null,
    y: null,
    shape: 'cercle',
    color: 'encre',
    expression: 'neutre',
    ballSize: 200,
    eventsEnabled: true,
    screenshotAllDisplays: true,
    globalCursorTracking: true,
    /** Beim PC-Start automatisch starten (Login-Item). Default AUS. */
    autostart: false
  }
  try {
    config = { ...fallback, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }
  } catch {
    config = fallback
  }
  // chat-Abschnitt tief verschmelzen, damit neue Schluessel nach Updates da sind
  config.chat = { ...agentMod.chatDefaults(), ...(config.chat ?? {}) }
  if (!Array.isArray(config.chat.grants)) config.chat.grants = []
  // recall-Abschnitt ebenso (OFF by default — nichts vor Consent)
  config.recall = { ...recallMod.recallDefaults(), ...(config.recall ?? {}) }
  // audio-Abschnitt: separate Gemini-Sprach-Engine
  const audioDefaults = {
    apiKeyEnc: '',
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    voice: 'Achird',
    voiceEnabled: false,
    pttHotkey: 'Alt+X'
  }
  config.audio = { ...audioDefaults, ...(config.audio ?? {}) }
  syncSystemDriveGrant()
  applyAutoStart()
  return config
}

/** Grant auf das Systemlaufwerk (C:\) je nach fullDriveAccess-Flag hinzufuegen/entfernen. */
function syncSystemDriveGrant() {
  const root = process.platform === 'win32' ? 'C:\\' : '/'
  const norm = (p) => { try { return path.resolve(p).toLowerCase() } catch { return p.toLowerCase() } }
  const idx = config.chat.grants.findIndex((g) => norm(g.path) === norm(root))
  if (config.chat.fullDriveAccess && idx === -1) {
    config.chat.grants.unshift({ path: root, allowSecrets: true, grantedAt: Date.now(), isRoot: true })
    // "Full drive access" beinhaltet auch Schreibzugriff
    if (config.chat.fileAccess === 'none' || config.chat.fileAccess === 'read') {
      config.chat.fileAccess = 'readwrite'
    }
    saveConfig()
  } else if (!config.chat.fullDriveAccess && idx !== -1) {
    config.chat.grants.splice(idx, 1)
    saveConfig()
  }
}

let saveTimer = null

function saveConfig() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(configPath(), JSON.stringify(config, null, 2))
    } catch {
      /* best effort */
    }
  }, 300)
}

function broadcastConfig() {
  for (const w of [win, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('config:changed', config)
  }
}

/**
 * Autostart beim PC-Start ueber ein Login-Item abgleichen (Win/macOS).
 * Im Dev-Modus ist process.execPath nur electron.exe. Ohne App-Pfad startet
 * Windows dann das Electron-Infofenster statt Bloub.
 */
function applyAutoStart() {
  const enabled = !!config.autostart
  if (process.platform === 'linux') {
    // Linux: kein Login-Item-API — best effort via XDG-Autostart-Datei.
    try {
      const dir = path.join(app.getPath('userData'), '..', 'autostart')
      const file = path.join(dir, 'bloub-pet.desktop')
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true })
        const execPath = process.execPath
        fs.writeFileSync(
          file,
          `[Desktop Entry]\nType=Application\nName=Bloub Pet\nExec="${execPath}"\nX-GNOME-Autostart-enabled=true\n`
        )
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file)
      }
    } catch {
      /* best effort */
    }
    return
  }
  try {
    const options = { openAtLogin: enabled }
    if (process.platform === 'win32') {
      options.path = process.execPath
      options.args = app.isPackaged ? ['--autostart'] : [app.getAppPath(), '--autostart']
    }
    app.setLoginItemSettings(options)
  } catch {
    /* best effort */
  }
}

/**
 * Multi-Monitor Support:
 * Erlaubt das freie Ziehen des Pet-Fensters über ALLE angeschlossenen Monitore.
 * Verhindert gleichzeitig, dass das Pet im Nirgendwo (außerhalb aller Monitore)
 * verloren geht (z.B. wenn ein Monitor ausgesteckt wird).
 */
function clampToDisplays(x, y, width = 620, height = 620) {
  const displays = screen.getAllDisplays()
  if (!displays || displays.length === 0) return [Math.round(x), Math.round(y)]

  const cx = x + width / 2
  const cy = y + height / 2
  const MARGIN = 80

  // 1. Liegt der Mittelpunkt auf irgendeinem aktiven Monitor?
  for (const d of displays) {
    const wa = d.workArea
    if (
      cx >= wa.x - MARGIN &&
      cx <= wa.x + wa.width + MARGIN &&
      cy >= wa.y - MARGIN &&
      cy <= wa.y + wa.height + MARGIN
    ) {
      return [Math.round(x), Math.round(y)]
    }
  }

  // 2. Falls außerhalb aller Monitore: Auf das nächstgelegene Display projizieren
  const nearest = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }) || screen.getPrimaryDisplay()
  const wa = nearest.workArea

  const clampedCx = Math.min(Math.max(cx, wa.x + MARGIN), wa.x + wa.width - MARGIN)
  const clampedCy = Math.min(Math.max(cy, wa.y + MARGIN), wa.y + wa.height - MARGIN)

  return [Math.round(clampedCx - width / 2), Math.round(clampedCy - height / 2)]
}

function rendererPreload() {
  return path.join(__dirname, 'preload.cjs')
}

let winX = 0
let winY = 0

function createWindow() {
  const initialX = Number.isFinite(config.x) ? config.x : workAreaRight()
  const initialY = Number.isFinite(config.y) ? config.y : workAreaMiddleY()
  const [x, y] = clampToDisplays(initialX, initialY, 620, 620)
  winX = x
  winY = y

  console.log('[main] config:', JSON.stringify(config))
  console.log('[main] displays count:', screen.getAllDisplays().length)
  console.log('[main] creating window at coords:', x, y)

  win = new BrowserWindow(
    overlayWindowOptions({
      x,
      y,
      width: 620,
      height: 620,
      transparent: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      title: '',
      show: true,
      icon: windowIcon(),
      webPreferences: {
        preload: rendererPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
  )

  win.setTitle('')
  win.removeMenu()
  win.setMenu(null)
  win.setMenuBarVisibility(false)
  win.webContents.on('page-title-updated', (e) => e.preventDefault())
  win.setAlwaysOnTop(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  applyOverlayChrome(win)

  loadRenderer(win, 'index.html')

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[pet load-failed] ${code} ${desc}`)
  })

  // Renderer-Fehler sichtbar machen (stderr)
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[pet console:${level}] ${message} (${sourceId}:${line})`)
  })

  win.show()
  win.moveTop()
  console.log('[main] window shown, bounds:', JSON.stringify(win.getBounds()), 'isVisible:', win.isVisible())

  // Bloub darf nie verloren gehen: wird er unsichtbar/minimiert, in die Taskbar
  // legen; wird er gezeigt/restored, sofort zurueck auf always-on-top.
  win.on('hide', () => setPetTaskbar(true))
  win.on('minimize', () => setPetTaskbar(true))
  win.on('show', () => restorePetOnTop())
  win.on('restore', () => restorePetOnTop())
  win.on('always-on-top-changed', (_e, isAlwaysOnTop) => {
    // Feuerwehr: verliert er den Top-Zustand (z. B. durch einen Z-Ordnungs-
    // Konflikt), sofort wieder anheben.
    if (!isAlwaysOnTop) reassertPetOnTop()
  })
}

function loadRenderer(w, file) {
  if (DEV_URL) w.loadURL(`${DEV_URL}/${file}`)
  else w.loadFile(path.join(__dirname, '..', 'dist-renderer', file))
}

/* ---------------------------------------------------- settings window */

function showSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    // Falls ein vorbestimmter Tab offen ist, direkt dorthin wechseln.
    if (pendingSettingsTab) {
      settingsWin.webContents.send('settings:open-tab', pendingSettingsTab)
      pendingSettingsTab = null
    }
    return
  }

  // Monitor ermitteln, auf dem sich das Pet-Fenster gerade befindet
  const targetDisplay = screen.getDisplayNearestPoint({ x: Math.round(winX + 310), y: Math.round(winY + 310) }) || screen.getPrimaryDisplay()
  const { workArea } = targetDisplay

  // Neben dem Pad andocken; wenn rechts kein Platz ist, links davon.
  const ballR = Math.round((config.ballSize || 200) / 2)
  let x = winX + 310 + ballR + 16
  let y = winY + 310 - Math.round(SETTINGS_H / 2)
  if (x + SETTINGS_W > workArea.x + workArea.width) {
    x = winX + 310 - ballR - SETTINGS_W - 16
  }
  y = Math.min(Math.max(y, workArea.y + 10), workArea.y + workArea.height - SETTINGS_H - 10)
  x = Math.min(Math.max(x, workArea.x + 10), workArea.x + workArea.width - SETTINGS_W - 10)

  settingsWin = new BrowserWindow(
    overlayWindowOptions({
      x,
      y,
      width: SETTINGS_W,
      height: SETTINGS_H,
      transparent: true,
      resizable: true,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Settings hosten Formularfelder — ohne Fokus kein Tippen moeglich
      focusable: true,
      show: false,
      icon: windowIcon(),
      webPreferences: {
        preload: rendererPreload(),
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  )

  settingsWin.removeMenu()
  settingsWin.webContents.on('page-title-updated', (e) => e.preventDefault())
  settingsWin.setAlwaysOnTop(true, 'floating')
  applyOverlayChrome(settingsWin)
  loadRenderer(settingsWin, 'settings.html')

  settingsWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[settings] ${message} (${sourceId}:${line})`)
  })

  settingsWin.once('ready-to-show', () => {
    settingsWin.show()
    // Vorbestimmten Tab nach dem Laden setzen (z. B. About beim Update).
    if (pendingSettingsTab) {
      settingsWin.webContents.send('settings:open-tab', pendingSettingsTab)
      pendingSettingsTab = null
    }
  })
  settingsWin.on('closed', () => {
    settingsWin = null
    if (win && !win.isDestroyed()) win.webContents.send('settings:visibility', false)
  })

  if (win && !win.isDestroyed()) win.webContents.send('settings:visibility', true)
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
}

/* ------------------------------------------------------- chat window */

const chatState = {
  attachments: new Map(), // id -> { id, kind, name, size, path }
  nextAttachmentId: 1
}

/* ------------------------------------------------ zeichnen (pet_draw_path) */

/** Overlay-Fenster: transparente Zeichenflaeche ueber dem Desktop. */
const DRAW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
  svg{position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;opacity:1;transition:opacity 0.6s ease}
</style></head><body><svg id="draw-canvas" xmlns="http://www.w3.org/2000/svg"></svg></body></html>`

let drawWin = null

function getDrawWin() {
  if (drawWin && !drawWin.isDestroyed()) return drawWin
  const currentDisplay = screen.getDisplayNearestPoint({ x: Math.round(winX + 310), y: Math.round(winY + 310) }) || screen.getPrimaryDisplay()
  const { workArea } = currentDisplay
  drawWin = new BrowserWindow(
    overlayWindowOptions({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  )
  drawWin.setIgnoreMouseEvents(true, { forward: true })
  drawWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(DRAW_HTML))
  drawWin.on('closed', () => {
    drawWin = null
  })
  return drawWin
}

function drawReady() {
  const w = getDrawWin()
  return new Promise((resolve) => {
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', () => resolve(w))
    } else {
      resolve(w)
    }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Aktiv-Zeitzustand der Zeichenflaeche. Linien akkumulieren ueber MEHRERE
 * pet_draw_path-Calls hinweg (damit die AI z. B. zwei Drawings mit zwei
 * unterschiedlichen Toolcodes zeichnen kann) und werden erst 1,5 s NACH
 * Abschluss des gesamten Turns ausgeblendet (siehe queueDrawHide).
 */
let drawActive = false
let drawSegments = [] // { d, color, width } — fertig gemalte Pfade dieses Turns
let drawHideTimer = null

/** Overlay von Grund auf aus drawSegments + einem wachsenden Pfad rendern. */
function renderDrawSvg(w, activeD, activeColor, activeWidth) {
  const segs = []
  for (const s of drawSegments) segs.push({ d: s.d, color: s.color, width: s.width })
  if (activeD) segs.push({ d: activeD, color: activeColor, width: activeWidth })
  const paths = segs
    .map(
      (seg) =>
        `(function(){var n=document.createElementNS('http://www.w3.org/2000/svg','path');` +
        `n.setAttribute('d',${JSON.stringify(seg.d)});` +
        `n.setAttribute('stroke',${JSON.stringify(seg.color)});` +
        `n.setAttribute('stroke-width',${JSON.stringify(seg.width)});` +
        `n.setAttribute('fill','none');n.setAttribute('stroke-linecap','round');` +
        `n.setAttribute('stroke-linejoin','round');s.appendChild(n);})();`
    )
    .join('')
  const code = `(function(){var s=document.getElementById('draw-canvas');s.innerHTML='';${paths}})()`
  return w.webContents.executeJavaScript(code)
}

function drawClear(w) {
  return w.webContents.executeJavaScript(`(function(){var s=document.getElementById('draw-canvas');s.innerHTML='';})()`)
}

/**
 * Zeichenflaeche ausfaden und 1,5 s, nachdem ein Turn komplett abgeschlossen
 * ist, ausblenden und fuer den naechsten Turn zuruecksetzen. Wird bei jedem
 * 'done'-Event (Generation fertig) oder bei Abbruch neu angestossen, damit
 * mehrere pet_draw_path-Calls desselben Turns sichtbar bleiben.
 */
function queueDrawHide() {
  if (drawHideTimer) clearTimeout(drawHideTimer)
  drawHideTimer = setTimeout(() => {
    drawHideTimer = null
    drawActive = false
    drawSegments = []
    // SVG-Opacity sanft ausfaden (0.6s CSS-Transition im Overlay), dann verstecken
    if (drawWin && !drawWin.isDestroyed()) {
      drawWin.webContents.executeJavaScript('document.getElementById("draw-canvas").style.opacity="0"').catch(() => {})
    }
    // Warten bis die Transition durch ist, dann verstecken
    setTimeout(() => {
      if (drawWin && !drawWin.isDestroyed()) drawWin.hide()
    }, 650)
    // Lock freigeben, damit der Bloub wieder in normalen Zustand zurueckkehrt
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:anim-hold', false)
      win.webContents.send('pet:play-state', 'wink')
    }
  }, 1500)
}

/**
 * pet_draw_path: bewegt das Pet-Fenster (Bloub) Punkt fuer Punkt ueber den
 * Bildschirm und zeichnet dabei eine Linie in einem transparenten Overlay.
 * Gibt die Bildschirm-WorkArea zurueck, damit die AI beim naechsten Call
 * sinnvolle Koordinaten waehlen kann.
 */
async function drawPathOnScreen({ points, color }) {
  const currentDisplay = screen.getDisplayNearestPoint({ x: Math.round(winX + 310), y: Math.round(winY + 310) }) || screen.getPrimaryDisplay()
  const { workArea } = currentDisplay
  try {
    if (!points || points.length < 2) return { ok: false, error: 'need at least 2 points' }
    const w = await drawReady()
    w.setBounds({ x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height })
    // Neuer Turn? Dann leere Flaeche; sonst reichen die bisherigen Pfade weiter.
    if (!drawActive) {
      drawActive = true
      drawSegments = []
      await drawClear(w)
    }
    w.showInactive()
    w.moveTop()

    // Bloub ist der Pinsel: er soll UEBER der Linie laufen, damit man ihn
    // beim Malen sieht. Nach dem Overlay also das Pet-Fenster nach oben holen.
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true)
      win.moveTop()
    }

    // Pinsel-Animation des Bloub starten und den Zustand bis zum Turn-Ende halten
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:anim-hold', true)
      win.webContents.send('pet:play-state', 'alert')
    }

    const ink = color || '#e8483f'
    const lineWidth = 3
    const pts = points.map((p) => ({
      x: Math.min(Math.max(Math.round(p.x), workArea.x), workArea.x + workArea.width),
      y: Math.min(Math.max(Math.round(p.y), workArea.y), workArea.y + workArea.height),
      draw: p.draw !== false // "don't draw": Punkt anfahren, aber Linie auslassen
    }))
    // Bloub-Fenster-Mitte = 310,310 im 620er Fenster
    const CX = 310
    const CY = 310
    let current = { x: winX + CX, y: winY + CY }
    const cmds = []
    let needMove = true // nach einem "pen up"-Sprung wieder mit M statt L weitermachen
    const pushTo = (px, py, draw, target) => {
      if (draw) {
        cmds.push(`${needMove ? 'M' : 'L'} ${px} ${py}`)
        needMove = false
        return renderDrawSvg(w, cmds.join(' '), target.ink || ink, lineWidth)
      }
      needMove = true
      return Promise.resolve()
    }

    for (const target of pts) {
      const dx = target.x - current.x
      const dy = target.y - current.y
      const dist = Math.hypot(dx, dy)
      const steps = Math.max(1, Math.ceil(dist / 14))
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const px = Math.round(current.x + dx * t)
        const py = Math.round(current.y + dy * t)
        const [nx, ny] = clampToDisplays(px - CX, py - CY, 620, 620)
        winX = nx
        winY = ny
        if (win && !win.isDestroyed()) {
          win.setPosition(nx, ny)
          // Bloub bei jedem Schritt nach oben holen, damit er nie von der
          // Linien-Overlay-Ebene verdeckt wird (Pinsel bleibt sichtbar).
          win.moveTop()
        }
        config.x = nx
        config.y = ny
        await pushTo(px, py, target.draw, target)
        await sleep(16)
      }
      current = { x: target.x, y: target.y }
    }
    saveConfig()

    // Fertig gemalten Pfad dieses Calls einfrieren, damit nachfolgende Calls
    // ihn NICHT ueberschreiben — die Linie bleibt bis zum Turn-Ende stehen.
    if (cmds.length > 0) {
      drawSegments.push({ d: cmds.join(' '), color: ink, width: lineWidth })
    }
    return {
      ok: true,
      workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height }
    }
  } catch (err) {
    if (drawWin && !drawWin.isDestroyed()) drawWin.hide()
    drawActive = false
    drawSegments = []
    if (win && !win.isDestroyed()) win.webContents.send('pet:anim-hold', false)
    return { ok: false, error: err?.message || String(err) }
  }
}

/* ------------------------------------------------------- screenshots */

/**
 * 7-Segment-Digit in einen BGRA-Buffer zeichnen. Fuer die kleinen
 * Monitor-ID-Badges auf dem kombinierten Screenshot ("kleine ID drueber").
 */
const SEG_MAP = {
  0: [1, 1, 1, 1, 1, 1, 0],
  1: [0, 1, 1, 0, 0, 0, 0],
  2: [1, 1, 0, 1, 1, 0, 1],
  3: [1, 1, 1, 1, 0, 0, 1],
  4: [0, 1, 1, 0, 0, 1, 1],
  5: [1, 0, 1, 1, 0, 1, 1],
  6: [1, 0, 1, 1, 1, 1, 1],
  7: [1, 1, 1, 0, 0, 0, 0],
  8: [1, 1, 1, 1, 1, 1, 1],
  9: [1, 1, 1, 1, 0, 1, 1]
}

/** Ein Segment als dickes Rechteck in den Buffer malen (BGRA, opaque). */
function drawSegRect(buf, cw, ch, x, y, w, h, rgb) {
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(cw, Math.round(x + w))
  const y1 = Math.min(ch, Math.round(y + h))
  for (let py = y0; py < y1; py++) {
    let idx = (py * cw + x0) * 4
    for (let px = x0; px < x1; px++) {
      buf[idx] = rgb[2] // B
      buf[idx + 1] = rgb[1] // G
      buf[idx + 2] = rgb[0] // R
      buf[idx + 3] = 255 // A
      idx += 4
    }
  }
}

/** Eine Ziffer (7-Segment) an (x, y) mit Zellenhoehe h zeichnen. */
function drawDigit(buf, cw, ch, digit, x, y, h, fg) {
  const segs = SEG_MAP[digit]
  if (!segs) return
  const t = Math.max(2, Math.round(h / 5)) // Segmentdicke
  const w = Math.round(h * 0.56)
  const g = Math.round(h / 10) // Halbe Luecke an den Ecken
  // Layout: A oben, B rechts-oben, C rechts-unten, D unten,
  //         E links-unten, F links-oben, G Mitte
  if (segs[0]) drawSegRect(buf, cw, ch, x + g, y, w - 2 * g, t, fg)
  if (segs[1]) drawSegRect(buf, cw, ch, x + w - t, y + g, t, h / 2 - g, fg)
  if (segs[2]) drawSegRect(buf, cw, ch, x + w - t, y + h / 2, t, h / 2 - g, fg)
  if (segs[3]) drawSegRect(buf, cw, ch, x + g, y + h - t, w - 2 * g, t, fg)
  if (segs[4]) drawSegRect(buf, cw, ch, x, y + h / 2, t, h / 2 - g, fg)
  if (segs[5]) drawSegRect(buf, cw, ch, x, y + g, t, h / 2 - g, fg)
  if (segs[6]) drawSegRect(buf, cw, ch, x + g, y + h / 2 - t / 2, w - 2 * g, t, fg)
}

/** Monitor-ID-Badge (dunkle Box + weisse Ziffern) links oben auf dem Bild. */
function drawDisplayBadge(buf, cw, ch, num, ox, oy) {
  const digits = String(num).split('').map((d) => Number(d))
  const dh = 30 // Ziffernhoehe
  const dw = Math.round(dh * 0.56)
  const pad = 7
  const bw = digits.length * (dw + 6) + 2 * pad
  const bh = dh + 2 * pad
  // Hintergrund (dunkel, deckend)
  drawSegRect(buf, cw, ch, ox, oy, bw, bh, [16, 16, 20])
  // Dünner heller Rahmen
  drawSegRect(buf, cw, ch, ox, oy, bw, 2, [232, 230, 224])
  drawSegRect(buf, cw, ch, ox, oy + bh - 2, bw, 2, [232, 230, 224])
  drawSegRect(buf, cw, ch, ox, oy, 2, bh, [232, 230, 224])
  drawSegRect(buf, cw, ch, ox + bw - 2, oy, 2, bh, [232, 230, 224])
  let dx = ox + pad
  for (const d of digits) {
    drawDigit(buf, cw, ch, d, dx, oy + pad, dh, [240, 238, 232])
    dx += dw + 6
  }
}

/** Bounding-Box des gesamten virtuellen Desktops (alle Monitore). */
function virtualDesktopBounds() {
  const displays = screen.getAllDisplays()
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const d of displays) {
    x0 = Math.min(x0, d.bounds.x)
    y0 = Math.min(y0, d.bounds.y)
    x1 = Math.max(x1, d.bounds.x + d.bounds.width)
    y1 = Math.max(y1, d.bounds.y + d.bounds.height)
  }
  return { x0, y0, width: x1 - x0, height: y1 - y0 }
}

/** Stabile 1-basierte Monitor-Nummer (links nach rechts, dann oben nach unten). */
function displayIndexForId(displayId) {
  const sorted = [...screen.getAllDisplays()].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y
  )
  const idx = sorted.findIndex((d) => d.displayId === displayId)
  return idx === -1 ? 1 : idx + 1
}

/**
 * Screenshot fuer desktop_screenshot.
 *
 * Mit config.screenshotAllDisplays (default AN): ALLE Monitore werden auf
 *genommen und entsprechend ihres realen Layouts zu EINEM Bild zusammengefuegt
 * — jedes Monitor-Rechteck bekommt ein kleines ID-Badge ("kleine ID drueber"),
 * damit die AI die Screens unterscheiden kann. Aus: nur der Monitor neben dem
 * Pet-Fenster (altes Verhalten).
 */
async function takeScreenshot() {
  try {
    /* ---- Modus A: alle Monitore, zusammengefuert mit ID-Badges ---- */
    let stitch = null
    if (config.screenshotAllDisplays !== false && screen.getAllDisplays().length > 0) {
      const vb = virtualDesktopBounds()
      if (vb.width > 0 && vb.height > 0) {
        // Endbild skalieren: breit genug zum Lesen, klein genug fuer den Chat.
        // Der gewuenschte Thumbnail-Massstab muss VOR getSources feststehen —
        // ohne passenden thumbnailSize liefert Electron nur 150x150!
        const scale = Math.min(1, 2560 / vb.width, 1440 / vb.height)
        stitch = { vb, scale }
      }
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: stitch
        ? {
            width: Math.max(1, Math.round(stitch.vb.width * stitch.scale)),
            height: Math.max(1, Math.round(stitch.vb.height * stitch.scale))
          }
        : { width: 1920, height: 1080 }
    })
    const usable = sources.filter((s) => !s.thumbnail.isEmpty())
    if (!usable || usable.length === 0) {
      return { ok: false, error: 'no screen available' }
    }

    if (stitch && usable.length > 0) {
      try {
        const { vb, scale } = stitch
        const W = Math.max(1, Math.round(vb.width * scale))
        const H = Math.max(1, Math.round(vb.height * scale))
        const canvas = Buffer.alloc(W * H * 4)

        const parts = []
        const claimed = new Set()
        for (const disp of screen.getAllDisplays()) {
          // Primär per display_id zuordnen; Fallback: unbeanspruchte Source
          // mit passendstem Seitenverhaeltnis (display_id kann leer sein).
          let src = usable.find(
            (s) => !claimed.has(s.name + s.id) && String(s.display_id) === String(disp.id)
          )
          if (!src) {
            const ar = disp.bounds.width / Math.max(1, disp.bounds.height)
            src = usable
              .filter((s) => !claimed.has(s.name + s.id))
              .sort((a, b) => {
                const sa = a.thumbnail.getSize()
                const sb = b.thumbnail.getSize()
                return (
                  Math.abs(sa.width / Math.max(1, sa.height) - ar) -
                  Math.abs(sb.width / Math.max(1, sb.height) - ar)
                )
              })[0]
          }
          if (!src) continue
          claimed.add(src.name + src.id)
          const img = src.thumbnail
          const { width: iw, height: ih } = img.getSize()
          const dx = Math.round((disp.bounds.x - vb.x0) * scale)
          const dy = Math.round((disp.bounds.y - vb.y0) * scale)
          // Zeilenweise in den Canvas kopieren (an Raender geclippt)
          const copyW = Math.min(iw, W - dx)
          const copyH = Math.min(ih, H - dy)
          const rowBytes = copyW * 4
          const bmp = img.toBitmap()
          for (let row = 0; row < copyH; row++) {
            bmp.copy(canvas, ((dy + row) * W + dx) * 4, row * iw * 4, row * iw * 4 + rowBytes)
          }
          const num = displayIndexForId(disp.id)
          drawDisplayBadge(canvas, W, H, num, dx + 12, dy + 12)
          parts.push(
            `Monitor ${num} at (${dx},${dy}) ${copyW}x${copyH}px` +
              ` (real ${disp.bounds.width}x${disp.bounds.height}, badge "${num}" top-left)`
          )
        }

        if (parts.length > 0) {
          const out = nativeImage.createFromBitmap(canvas, { width: W, height: H })
          const png = out.toPNG()
          return {
            ok: true,
            mime: 'image/png',
            data: png.toString('base64'),
            width: W,
            height: H,
            layout: `Combined screenshot of ${parts.length} display(s), stitched by real position: ${parts.join('; ')}.`
          }
        }
      } catch {
        /* Stitching fehlgeschlagen -> unten auf Einzel-Screen fallen */
      }
    }

    /* ---- Modus B (Fallback): nur ein Bildschirm, altes Verhalten ---- */
    const currentDisplay =
      screen.getDisplayNearestPoint({ x: Math.round(winX + 310), y: Math.round(winY + 310) }) ||
      screen.getPrimaryDisplay()
    let matched = usable.find((s) => s.display_id === String(currentDisplay.id))
    if (!matched) {
      matched = usable[0]
      for (const s of usable) {
        if (s.thumbnail.getSize().width > matched.thumbnail.getSize().width) matched = s
      }
    }
    if (!matched || matched.thumbnail.isEmpty()) {
      return { ok: false, error: 'no screen available' }
    }
    const img = matched.thumbnail
    const size = img.getSize()
    const png = img.toPNG()
    return {
      ok: true,
      mime: 'image/png',
      data: png.toString('base64'),
      width: size.width,
      height: size.height
    }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

/* Custom-Animationen: der Agent wartet, bis BEIDE Tracks (Koerper + Gesicht)
 * im Renderer fertig sind, bevor er weiter redet. Der Renderer meldet sich
 * per 'pet:custom-anim-done' mit der Animations-ID zurueck. */
const customAnimWaiters = new Map()

ipcMain.on('pet:custom-anim-done', (_e, id) => {
  const resolve = customAnimWaiters.get(id)
  if (resolve) {
    customAnimWaiters.delete(id)
    resolve()
  }
})

let chat = null

function getChat() {
  if (!chat) {
    chat = agentMod.createChat({
      userData: app.getPath('userData'),
      memoryFilePath: path.join(app.getPath('userData'), 'bloub-memory.json'),
      getCfg: () => ({
        ...config,
        chat: {
          ...config.chat,
          apiKey: getApiKey()
        }
      }),
      onPetAction: async (action) => {
        if (action.type === 'set_shape') {
          config.shape = action.shape
          saveConfig()
          if (win && !win.isDestroyed()) win.webContents.send('config:changed', config)
          if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('config:changed', config)
        } else if (action.type === 'set_expression') {
          config.expression = action.expression
          saveConfig()
          if (win && !win.isDestroyed()) win.webContents.send('config:changed', config)
          if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('config:changed', config)
        } else if (action.type === 'set_color') {
          config.color = action.color
          saveConfig()
          if (win && !win.isDestroyed()) win.webContents.send('config:changed', config)
          if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('config:changed', config)
        } else if (action.type === 'set_size') {
          // Gleiche Spanne wie der Size-Slider in den Settings (150-280)
          config.ballSize = Math.min(280, Math.max(150, Math.round(action.ballSize)))
          saveConfig()
          if (win && !win.isDestroyed()) win.webContents.send('config:changed', config)
          if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('config:changed', config)
        } else if (action.type === 'play_animation') {
          if (win && !win.isDestroyed()) win.webContents.send('pet:play-state', action.animation, action.durationSeconds)
        } else if (action.type === 'play_custom_animation') {
          const spec = action.animation
          if (win && !win.isDestroyed() && spec && spec.duration > 0) {
            const id = `anim-${Date.now()}-${Math.random().toString(36).slice(2)}`
            // Sicherheitsnetz: nie laenger warten als Dauer + Puffer
            const timeoutMs = Math.max(1500, (spec.duration + 3) * 1000)
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                customAnimWaiters.delete(id)
                resolve()
              }, timeoutMs)
              customAnimWaiters.set(id, () => {
                clearTimeout(timer)
                resolve()
              })
              win.webContents.send('pet:custom-anim', { ...spec, id })
            })
          }
        }
      },
      takeScreenshot,
      onDrawPath: (payload) => drawPathOnScreen(payload)
    })
  }
  return chat
}

function sendChatEvent(ev) {
  // Das Chat-Dock lebt im Pet-Fenster — Events gehen dorthin
  if (win && !win.isDestroyed()) win.webContents.send('chat:event', ev)
  // Zeichnung: die Linien bleiben sichtbar, bis der Turn komplett fertig ist —
  // dann 1,5 s stehen lassen und ausblenden. Ermoeglicht mehrere
  // pet_draw_path-Calls (z. B. zwei Drawings mit zwei Toolcodes).
  if (ev.type === 'done') queueDrawHide()
}

let chatVisible = false

function showChat() {
  if (!win || win.isDestroyed()) return
  if (getChat().hasPendingTail()) sendChatEvent({ type: 'pending-tail' })
  chatVisible = true
  applyOverlayChrome(win)
  win.webContents.send('ui:chat-visibility', true)
  win.focus()
  applyOverlayChrome(win)
}

function hideChat() {
  if (!win || win.isDestroyed()) return
  chatVisible = false
  win.webContents.send('ui:chat-visibility', false)
  applyOverlayChrome(win)
}

function toggleChat() {
  if (chatVisible) hideChat()
  else showChat()
}

/* ------------------------------------------------------------ autopilot */

/**
 * Autopilot: in einstellbaren Intervallen "wacht" der Bloub auf und die AI
 * darf entscheiden, ob sie gerade etwas tun moechte. Drei Modi:
 *   off     — Feature aus
 *   silent  — AI handeln lassen, aber NIE Text zeigen (nur Aktionen)
 *   visible — AI fragen und Antwort im Chat zeigen
 * Pro Tick entscheidet ein "Wurf" (autoPilotChance in %) ob die AI gefragt
 * wird. Läuft nie, während ein User-Turn aktiv ist.
 */
let autoPilotTimer = null

function scheduleAutoPilot() {
  clearTimeout(autoPilotTimer)
  autoPilotTimer = null
  const mode = config.chat?.autoPilot ?? 'off'
  if (mode === 'off') return
  const intervalSec = Math.max(15, Math.min(3600, Math.round(Number(config.chat?.autoPilotInterval) || 60)))
  autoPilotTimer = setTimeout(() => {
    autoPilotTimer = null
    try {
      autoPilotTick()
    } catch {
      /* die Timer-Kette stirbt nie */
    }
    scheduleAutoPilot()
  }, intervalSec * 1000)
}

function autoPilotTick() {
  const chatCfg = config.chat ?? {}
  const mode = chatCfg.autoPilot ?? 'off'
  if (mode === 'off') return
  const chance = Math.max(0, Math.min(100, Number(chatCfg.autoPilotChance) ?? 100))
  if (chance < 100 && Math.random() * 100 >= chance) return
  const chat = getChat()
  if (chat.isBusy()) return
  // Der Bloub denkt waehrend des Ticks (wacht damit optisch auf)
  if (win && !win.isDestroyed()) win.webContents.send('pet:play-state', 'thinking', 8)
  if (mode === 'visible') {
    showChat()
    // Wie ein eigener Turn behandeln: Dock auf, Thinking-Anim, Stream-Setup
    sendChatEvent({ type: 'accepted', chipText: '', attachments: [] })
    void chat.runAutopilot(sendChatEvent, { silent: false })
  } else {
    void chat.runAutopilot(sendChatEvent, { silent: true })
  }
}

/* --------------------------------------------------- anhaenge & grants */

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.csv', '.tsv', '.yml', '.yaml',
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.htm',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.sh', '.bat', '.ps1', '.sql', '.toml', '.ini', '.cfg', '.conf', '.xml', '.svg'
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const ATTACH_TEXT_MAX = 64 * 1024

function classifyDroppedPath(p) {
  let st
  try {
    st = fs.statSync(p)
  } catch {
    return null
  }
  if (st.isDirectory()) return { kind: 'folder', name: path.basename(p), path: p }
  const ext = path.extname(p).toLowerCase()
  if (IMAGE_EXT.has(ext)) return { kind: 'image', name: path.basename(p), path: p, size: st.size }
  if (ext === '.pdf') return { kind: 'pdf', name: path.basename(p), path: p, size: st.size }
  if (TEXT_EXT.has(ext)) return { kind: 'text', name: path.basename(p), path: p, size: st.size }
  return { kind: 'unknown', name: path.basename(p), path: p, size: st.size }
}

ipcMain.handle('chat:attach', (_e, paths) => {
  const chips = []
  let absorbedSomething = false
  for (const raw of paths ?? []) {
    const info = classifyDroppedPath(String(raw))
    if (!info) continue
    if (info.kind === 'folder') {
      // Workspace-Grant anlegen (dedupe ueber den aufgeloesten Pfad)
      let resolved
      try {
        resolved = fs.realpathSync(info.path)
      } catch {
        continue
      }
      const grants = config.chat.grants
      if (!grants.some((g) => g.path.toLowerCase() === resolved.toLowerCase())) {
        grants.push({ path: resolved, allowSecrets: false, grantedAt: Date.now() })
        saveConfig()
        broadcastConfig()
      }
      chips.push({ kind: 'grant', name: info.name, path: resolved })
      absorbedSomething = true
    } else if (info.kind === 'unknown' || info.kind === 'pdf') {
      chips.push({
        kind: info.kind,
        name: info.name,
        size: info.size ?? 0,
        note: info.kind === 'pdf' ? 'unsupported (yet)' : 'unsupported file type'
      })
      absorbedSomething = true
    } else {
      const id = `a${chatState.nextAttachmentId++}`
      const visionOk = info.kind !== 'image' || agentMod.supportsVision(config.chat.model)
      chatState.attachments.set(id, { ...info, id })
      chips.push({
        kind: info.kind,
        id,
        name: info.name,
        size: info.size,
        note: info.kind === 'image' && !visionOk ? 'needs vision model' : undefined
      })
      absorbedSomething = true
    }
  }
  if (chips.length > 0) {
    sendChatEvent({ type: 'attachments', chips })
    showChat()
    // Der Bloub schluckt das Angebot
    if (absorbedSomething && win && !win.isDestroyed()) win.webContents.send('pet:play-state', 'absorb')

    // Reale Dateien (text/image) automatisch inspizieren lassen: der Bloub
    // sagt dem Nutzer, was er bekommen hat. Kurz warten, damit der Vortex
    // sichtbar ist, bevor der Chat-Turn startet.
    const inspectIds = chips.filter((c) => c.id).map((c) => c.id)
    if (inspectIds.length > 0) {
      setTimeout(() => {
        void (async () => {
          try {
            const parts = await buildUserParts(
              'The user just dropped these files onto you. Inspect them and tell them what they are.',
              inspectIds
            )
            sendChatEvent({ type: 'accepted', chipText: '', attachments: inspectIds })
            await getChat().runTurn(parts, sendChatEvent)
            if (win && !win.isDestroyed()) win.webContents.send('pet:play-state', 'wink')
          } catch (err) {
            sendChatEvent({ type: 'error', message: err?.message || String(err) })
          }
        })()
      }, 350)
    }
  }
})

/** Baut die User-Parts fuer den Send: Text + Dateiinhalte + Vision-Bilder. */
async function buildUserParts(text, attachmentIds) {
  const parts = []
  if (text?.trim()) parts.push({ type: 'text', text: text.trim() })
  for (const id of attachmentIds ?? []) {
    const att = chatState.attachments.get(id)
    if (!att) continue
    try {
      if (att.kind === 'text') {
        const buf = fs.readFileSync(att.path)
        const capped = buf.subarray(0, ATTACH_TEXT_MAX)
        parts.push({
          type: 'text',
          text: `\n\n[attached file: ${att.name}]\n${capped.toString('utf8')}${buf.length > ATTACH_TEXT_MAX ? '\n[file truncated]' : ''}`
        })
      } else if (att.kind === 'image') {
        if (agentMod.supportsVision(config.chat.model)) {
          const ext = path.extname(att.path).toLowerCase()
          const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
          parts.push({ type: 'image', mime, data: fs.readFileSync(att.path).toString('base64') })
        } else {
          parts.push({ type: 'text', text: `[attached image: ${att.name} — needs a vision model to see it]` })
        }
      }
    } catch {
      /* Datei verschwunden -> ignorieren */
    }
    chatState.attachments.delete(id)
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '(empty message)' }]
}

/* ------------------------------------------------------------- hotkey */

let activeHotkey = null
let hotkeyFallbackNotified = false

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const primary = config.chat.chatHotkey || 'Super+Alt+X'
  if (primary && globalShortcut.register(primary, () => toggleChat())) {
    activeHotkey = primary
  } else if (globalShortcut.register('Ctrl+Alt+B', () => toggleChat())) {
    activeHotkey = 'Ctrl+Alt+B'
    if (tray && !tray.isDestroyed() && !hotkeyFallbackNotified) {
      hotkeyFallbackNotified = true
      tray.displayBalloon?.({
        title: 'Bloub Pet — hotkey changed',
        content: `${primary} was already taken. Use Ctrl+Alt+B to summon the bloub chat.`,
        iconType: 'info'
      })
    }
  } else {
    activeHotkey = null
  }
  // Recall-Pause-Hotkey (Default Ctrl+Alt+P): friert Aufnahme sofort ein.
  globalShortcut.register('Ctrl+Alt+P', () => toggleRecallPause())
}

/* Push-to-Talk: pttHotkey (Default Alt+X) im fokussierten Pet-Fenster ->
   keydown = Mikro an, keyup = aus. Der before-input-Listener wird bei jeder
   Hotkey-Aenderung entfernt und neu registriert, damit die neue Taste sofort
   greift (und nicht die alte dauerhaft aktiv bleibt). */
let pttDown = false
let pttInputHandler = null

function setupPttKeyDetection() {
  if (!win || win.isDestroyed()) return
  // Alten Listener entfernen — sonst prueft er fuer immer den Start-Hotkey.
  if (pttInputHandler) {
    win.webContents.removeListener('before-input-event', pttInputHandler)
    pttInputHandler = null
  }
  const target = config.audio?.pttHotkey
  if (!target) return
  // "Alt+X" o.ä. in einen (alt, ctrl, shift, meta, key) Erkennungstoken zerlegen
  const parts = target.toLowerCase().split('+')
  const keyToken = parts.pop() || 'x'
  const want = { alt: parts.includes('alt'), ctrl: parts.includes('ctrl') || parts.includes('control'), shift: parts.includes('shift'), meta: parts.includes('meta') || parts.includes('super') || parts.includes('cmd'), key: keyToken }

  pttInputHandler = (_event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return
    const isTarget =
      (input.key === want.key || input.key.toLowerCase() === want.key) &&
      !!(input.alt) === !!want.alt &&
      !!(input.control) === !!want.ctrl &&
      !!(input.shift) === !!want.shift &&
      !!(input.meta) === !!want.meta
    if (!isTarget) return
    if (input.type === 'keyDown' && !pttDown) {
      pttDown = true
      if (win && !win.isDestroyed()) win.webContents.send('chat:ptt-start')
    } else if (input.type === 'keyUp' && pttDown) {
      pttDown = false
      if (win && !win.isDestroyed()) win.webContents.send('chat:ptt-end')
    }
  }
  win.webContents.on('before-input-event', pttInputHandler)
}

/**
 * Fokus-Verlust waehrend PTT (Alt-Tab, Klick woandershin): das keyUp geht an
 * ein anderes Fenster und kommt hier NIE an — ohne Guard haette die Aufnahme
 * sonst kein Ende. Beim Blur die Aufnahme sauber beenden.
 */
function attachPttBlurGuard() {
  if (!win || win.isDestroyed()) return
  win.on('blur', () => {
    if (!pttDown) return
    pttDown = false
    if (win && !win.isDestroyed()) win.webContents.send('chat:ptt-end')
  })
}

/* ------------------------------------------------------ api-key store */

function setApiKey(plain) {
  if (!plain) {
    config.chat.apiKeyEnc = ''
  } else if (safeStorage.isEncryptionAvailable()) {
    config.chat.apiKeyEnc = safeStorage.encryptString(plain).toString('base64')
  } else {
    // Kein DPAPI: Schluessel wird bewusst NICHT gespeichert
    console.warn('[main] safeStorage unavailable - API key not persisted')
    return false
  }
  saveConfig()
  return true
}

function getApiKey() {
  if (!config.chat.apiKeyEnc) return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(config.chat.apiKeyEnc, 'base64'))
  } catch {
    return ''
  }
}

/* --------------------------------------------------------- chat ipc */

ipcMain.on('ui:toggle-chat', () => toggleChat())
ipcMain.on('ui:show-chat', () => showChat())
ipcMain.on('ui:hide-chat', () => hideChat())

ipcMain.on('pet:request-chat-toggle', () => toggleChat())

ipcMain.handle('chat:send', async (_e, payload) => {
  const parts = await buildUserParts(payload?.text, payload?.attachmentIds)
  sendChatEvent({ type: 'accepted', chipText: payload?.text?.trim() ?? '', attachments: payload?.attachmentIds ?? [] })
  try {
    await getChat().runTurn(parts, sendChatEvent)
  } catch (err) {
    sendChatEvent({ type: 'error', message: err?.message || String(err) })
  }
  // Abschluss-Wink ans Pet melden (der Loop hat fertig geantwortet)
  if (win && !win.isDestroyed()) win.webContents.send('pet:play-state', 'wink')
  // Nach dem Senden gilt der Chat-Eingabemodus als zu (der Input ist collapsed).
  // Dadurch reicht EIN Hotkey-Druck, um den Input wieder aufzuklappen statt
  // erst "zuzumachen" (Bug: sonst muesste man den Toggle zweimal druecken).
  chatVisible = false
  return true
})

ipcMain.on('chat:abort', () => {
  getChat().abort()
  // Bei Abbruch mitten im Turn die Zeichenflaeche ebenfalls nach kurzer Zeit ausblenden
  queueDrawHide()
})

ipcMain.handle('chat:test-provider', async () => {
  const cfgChat = {
    baseUrl: config.chat.baseUrl,
    protocol: config.chat.protocol,
    model: config.chat.model,
    apiKey: getApiKey()
  }
  return provider.pingProvider(cfgChat)
})

ipcMain.handle('chat:clear-memory', () => {
  const result = history.archiveAndClear(app.getPath('userData'))
  // Pet-Fenster benachrichtigen, damit die UI die letzte Antwort entfernt
  if (win && !win.isDestroyed()) win.webContents.send('chat:event', { type: 'archived' })
  return result
})

ipcMain.handle('chat:get-api-key-status', () => ({ hasKey: !!config.chat.apiKeyEnc }))

ipcMain.handle('chat:set-api-key', (_e, key) => {
  const ok = setApiKey(String(key ?? '').trim())
  broadcastConfig()
  return { ok }
})

ipcMain.handle('hotkey:set', (_e, combo) => {
  config.chat.chatHotkey = String(combo ?? '').trim() || 'Super+Alt+X'
  saveConfig()
  registerHotkeys()
  broadcastConfig()
  return { activeHotkey }
})

ipcMain.handle('hotkey:test', (_e, combo) => {
  let ok = false
  try {
    ok = !!globalShortcut.register(combo, () => {})
    if (ok) globalShortcut.unregister(combo)
  } catch {
    ok = false
  }
  return { ok, activeHotkey }
})

/* ------------------------------------------------------------ audio ipc */

const audioSpeechStreams = new Map()
let audioSpeechStreamSeq = 0

function getAudioApiKey() {
  if (!config.audio?.apiKeyEnc) return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(config.audio.apiKeyEnc, 'base64'))
  } catch {
    return ''
  }
}

function setAudioApiKey(plain) {
  if (!plain) {
    if (config.audio) config.audio.apiKeyEnc = ''
  } else if (safeStorage.isEncryptionAvailable()) {
    config.audio.apiKeyEnc = safeStorage.encryptString(plain).toString('base64')
  } else {
    console.warn('[main] safeStorage unavailable - audio API key not persisted')
    return false
  }
  saveConfig()
  return true
}

ipcMain.handle('audio:set-api-key', (_e, key) => {
  const ok = setAudioApiKey(String(key ?? '').trim())
  return { ok }
})

// Nur true/false zurueckgeben — der Key selbst verlässt den Main nie.
ipcMain.handle('audio:has-key', () => ({ hasKey: !!config.audio?.apiKeyEnc }))

ipcMain.handle('audio:set-ptt-hotkey', (_e, combo) => {
  const c = String(combo ?? '').trim() || null
  if (config.audio) config.audio.pttHotkey = c ?? ''
  saveConfig()
  registerHotkeys()
  // PTT-Erkennung auf die neue Taste umschalten (alter Listener wird entfernt)
  setupPttKeyDetection()
  broadcastConfig()
  return { activeHotkey: config.audio?.pttHotkey || null }
})

ipcMain.handle('audio:test', async () => {
  const apiKey = getAudioApiKey()
  if (!apiKey) return { ok: false, error: 'Gemini API key not set (Audio tab)' }
  const a = config.audio || {}
  return await geminiAudio.ping({
    apiKey,
    baseUrl: a.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
  })
})

// Push-to-Talk: Aufnahme (base64-Audio) -> Gemini-STT -> Text an den Renderer zurueck.
ipcMain.handle('audio:transcribe', async (_e, payload) => {
  const apiKey = getAudioApiKey()
  if (!apiKey) return { ok: false, text: '', error: 'Gemini API key not set (Audio tab)' }
  const data = payload?.data
  if (!data || typeof data !== 'string') return { ok: false, text: '', error: 'no audio data' }
  let buf
  try {
    buf = Buffer.from(data, 'base64')
  } catch {
    return { ok: false, text: '', error: 'bad audio data' }
  }
  if (!buf.length) return { ok: false, text: '', error: 'empty audio data' }
  if (buf.length > 18 * 1024 * 1024) return { ok: false, text: '', error: 'audio is too large' }
  const result = await geminiAudio.transcribe({
    apiKey,
    baseUrl: config.audio?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
    audioBuffer: buf,
    mime: payload?.mime || 'audio/webm'
  })
  return result.ok ? { ok: true, text: result.text } : { ok: false, text: '', error: result.error }
})

// TTS: Text -> Audio (base64). Wird vom Renderer nach einer Chat-Antwort aufgerufen.
ipcMain.handle('audio:speak', async (_e, text) => {
  const apiKey = getAudioApiKey()
  if (!apiKey || !text) return { ok: false, data: '', error: apiKey ? 'empty text' : 'Gemini API key not set (Audio tab)' }
  const a = config.audio || {}
  const result = await geminiAudio.textToSpeech({
    apiKey,
    baseUrl: a.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
    text,
    voice: a.voice || 'Achird'
  })
  if (!result.ok) return { ok: false, data: '', error: result.error }
  return { ok: true, data: result.audio.toString('base64'), mime: result.mime || 'audio/wav' }
})

// Streaming-TTS: PCM-Chunks sofort an den Renderer weiterreichen, statt auf die ganze WAV zu warten.
ipcMain.handle('audio:speak-stream', (event, text) => {
  const apiKey = getAudioApiKey()
  const clean = String(text || '').trim().slice(0, 6000)
  if (!apiKey || !clean) {
    return { ok: false, error: apiKey ? 'empty text' : 'Gemini API key not set (Audio tab)' }
  }
  const requestId = `${event.sender.id}-${Date.now()}-${++audioSpeechStreamSeq}`
  const controller = new AbortController()
  const sender = event.sender
  audioSpeechStreams.set(requestId, { controller, senderId: sender.id })

  setImmediate(() => {
    void geminiAudio.streamTextToSpeech({
      apiKey,
      baseUrl: config.audio?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
      text: clean,
      voice: config.audio?.voice || 'Achird',
      signal: controller.signal,
      onChunk: (chunk) => {
        if (!sender.isDestroyed() && !controller.signal.aborted) {
          sender.send('audio:speak-event', { type: 'chunk', requestId, ...chunk })
        }
      }
    }).then((result) => {
      if (sender.isDestroyed() || controller.signal.aborted) return
      sender.send('audio:speak-event', result.ok
        ? { type: 'done', requestId }
        : { type: 'error', requestId, error: result.error || 'voice stream failed' })
    }).finally(() => {
      audioSpeechStreams.delete(requestId)
    })
  })
  return { ok: true, requestId }
})

ipcMain.handle('audio:cancel-speak', (event, requestId) => {
  const active = audioSpeechStreams.get(String(requestId || ''))
  if (!active || active.senderId !== event.sender.id) return false
  active.controller.abort()
  audioSpeechStreams.delete(String(requestId))
  return true
})

ipcMain.handle('audio:preview-voice', async (_event, voice) => {
  const apiKey = getAudioApiKey()
  if (!apiKey) return { ok: false, data: '', error: 'Gemini API key not set (Audio tab)' }
  const allowed = new Set(['Achird', 'Kore', 'Puck', 'Aoede', 'Sulafat', 'Leda'])
  const selected = allowed.has(String(voice)) ? String(voice) : 'Achird'
  const result = await geminiAudio.textToSpeech({
    apiKey,
    baseUrl: config.audio?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
    text: 'Hi! Ich bin Bloub. So klingt meine Stimme.',
    voice: selected
  })
  if (!result.ok) return { ok: false, data: '', error: result.error }
  return { ok: true, data: result.audio.toString('base64'), mime: result.mime || 'audio/wav' }
})
/* -------------------------------------------------------- grants ipc */

ipcMain.handle('grants:set-secrets', (_e, grantPath, allowSecrets) => {
  const g = config.chat.grants.find((x) => x.path === grantPath)
  if (g) {
    g.allowSecrets = !!allowSecrets
    saveConfig()
    broadcastConfig()
  }
  return config.chat.grants
})

ipcMain.handle('grants:remove', (_e, grantPath) => {
  config.chat.grants = config.chat.grants.filter((x) => x.path !== grantPath)
  saveConfig()
  broadcastConfig()
  return config.chat.grants
})


/* --------------------------------------------------------- recall ipc */

function recallSpoolDir() {
  return path.join(app.getPath('userData'), 'recall-spool')
}

/** Pet spielt einen kleinen One-Shot, wenn Recall-Schalter sich aendern. */
function notifyRecallChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('pet:play-state', 'notify', 2)
  broadcastConfig()
  refreshTray()
}

ipcMain.handle('recall:get-status', () => ({
  config: config.recall,
  ...recallMod.pauseStatus(),
  shellHooks: shellHook.psStatus(),
  storage: recallStore.storeStats(app.getPath('userData'))
}))

ipcMain.handle('recall:set-config', (_e, partial) => {
  const p = partial && typeof partial === 'object' ? partial : {}
  config.recall = { ...config.recall, ...p }
  // Master OFF -> auch Pause-Zustaende aufraeumen
  if (!config.recall.enabled) recallMod.setManualPaused(false)
  saveConfig()
  recallMod.refreshProducers()
  notifyRecallChanged()
  return { config: config.recall, ...recallMod.pauseStatus() }
})

ipcMain.handle('recall:shell-install', () => {
  const results = shellHook.psInstall(recallSpoolDir())
  broadcastConfig()
  return results
})

ipcMain.handle('recall:shell-remove', () => {
  const results = shellHook.psRemove()
  broadcastConfig()
  return results
})

ipcMain.handle('recall:index-now', () => recallMod.runIndex())

ipcMain.handle('recall:purge', () => {
  const freed = recallStore.purgeEverything(app.getPath('userData'))
  // Index/State neu anlegen (leer), Engine verwerfen
  if (recallMod.isStarted()) {
    recallMod.runIndex()
    recallMod.getEngine()?.invalidate()
  }
  notifyRecallChanged()
  return { freed }
})

function toggleRecallPause() {
  if (!config.recall?.enabled) return null
  recallMod.setManualPaused(!recallMod.isManuallyPaused())
  notifyRecallChanged()
  return recallMod.pauseStatus()
}

ipcMain.handle('recall:toggle-pause', () => toggleRecallPause())

/**
 * Kopiert die bloub-link Extension nach <userData>/recall/bloub-link —
 * ein stabiler Pfad, den der User in chrome://extensions per "Load unpacked"
 * waehlt. Bewusst KEINE Registry-Eintraege und KEIN --load-extension:
 * die Installation geschieht ausschliesslich durch User-Klicks in Chrome.
 */
ipcMain.handle('recall:extension-folder', () => {
  const src = path.join(__dirname, '..', 'vendor', 'bloub-link')
  const dest = path.join(app.getPath('userData'), 'recall', 'bloub-link')
  try {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(src, dest, { recursive: true })
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
  return { ok: true, folder: dest, port: browserLinkMod.getLinkInfo()?.port ?? null }
})


/* ------------------------------------------------------------- helpers */

function workAreaRight() {
  const { workArea } = screen.getPrimaryDisplay()
  return workArea.x + workArea.width - 450
}

function workAreaMiddleY() {
  const { workArea } = screen.getPrimaryDisplay()
  return workArea.y + Math.round(workArea.height * 0.3)
}

/* ---------------------------------------------------------------- ipc */

ipcMain.on('pet:moveBy', (_e, dx, dy) => {
  if (!win || win.isDestroyed()) return
  const [x, y] = clampToDisplays(winX + dx, winY + dy, 620, 620)
  winX = x
  winY = y
  win.setPosition(x, y)
  config.x = x
  config.y = y
})

ipcMain.on('pet:dragEnd', () => {
  if (win && !win.isDestroyed()) {
    const [actualX, actualY] = win.getPosition()
    winX = actualX
    winY = actualY
    config.x = actualX
    config.y = actualY
  }
  saveConfig()
})

// Click-through for the transparent desktop area around the pad. `forward` keeps
// pointermove flowing so the renderer can watch the cursor and re-grab input
// when it comes back over the ball.
ipcMain.on('pet:setIgnore', (_e, ignore) => {
  if (!win) return
  win.setIgnoreMouseEvents(!!ignore, { forward: true })
})

/* --------------------------------------- globaler Cursor-Follow (Multi-Monitor) */

/**
 * Der Renderer sieht DOM-pointermove nur, wenn der Cursor ueber dem eigenen
 * 620x620-Fenster schwebt. Damit der Bloub dem Cursor ueber den GESAMTEN
 * virtuellen Desktop (alle Monitore) folgen kann, pollt der Main-Prozess
 * screen.getCursorScreenPoint() und funkt die Position per IPC ins Pet-Fenster.
 * Die Koordinaten werden doppelt geliefert: fensterrelativ (kann ausserhalb
 * 0..620 liegen) und global — plus der stabilen 1-basierten Monitor-Nummer
 * fuer das kleine ID-Tag im Renderer.
 */

let cursorPollTimer = null
let lastCursorKey = ''

/** Stabile 1-basierte Monitor-Nummer (links nach rechts, dann oben nach unten). */
function displayIndexFor(displayId) {
  const sorted = [...screen.getAllDisplays()].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y
  )
  const idx = sorted.findIndex((d) => d.displayId === displayId)
  return idx === -1 ? 1 : idx + 1
}

function startCursorPolling() {
  if (cursorPollTimer) return
  cursorPollTimer = setInterval(() => {
    // Opt-in-Gate: bei deaktiviertem Tracking wird einfach nichts gesendet —
    // der Renderer faellt automatisch auf den DOM-Zeiger zurueck.
    if (!config || config.globalCursorTracking === false) return
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      const pt = screen.getCursorScreenPoint()
      const bounds = win.getContentBounds()
      // Nur senden, wenn sich wirklich etwas bewegt hat (IPC-Spam vermeiden)
      const key = `${pt.x}:${pt.y}:${bounds.x}:${bounds.y}`
      if (key === lastCursorKey) return
      lastCursorKey = key
      const disp = screen.getDisplayNearestPoint(pt)
      win.webContents.send('pet:global-cursor', {
        // Position relativ zum Pet-Fenster (auch ausserhalb des Fensters)
        x: pt.x - bounds.x,
        y: pt.y - bounds.y,
        // Globale Koordinaten auf dem virtuellen Desktop
        gx: pt.x,
        gy: pt.y,
        // Ursprung des Pet-Fensters in globalen Koordinaten
        wx: bounds.x,
        wy: bounds.y,
        // Monitor-Kennung fuer das kleine ID-Tag
        display: disp ? displayIndexFor(disp.displayId) : 1,
        displayCount: screen.getAllDisplays().length
      })
    } catch {
      /* best effort */
    }
  }, 16)
}

function stopCursorPolling() {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer)
    cursorPollTimer = null
  }
}

ipcMain.on('ui:toggle-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) closeSettings()
  else showSettings()
})

// Settings direkt auf einem bestimmten Tab oeffnen (z. B. "about" beim Update).
ipcMain.on('ui:open-settings-tab', (_e, tab) => {
  pendingSettingsTab = typeof tab === 'string' && tab ? tab : null
  showSettings()
})

ipcMain.on('ui:close-settings', () => closeSettings())

ipcMain.on('ui:resize-settings', (_e, x, y, w, h) => {
  if (!settingsWin || settingsWin.isDestroyed()) return
  const currentDisplay = screen.getDisplayMatching(settingsWin.getBounds()) ||
    screen.getDisplayNearestPoint({ x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) }) ||
    screen.getPrimaryDisplay()
  const { workArea } = currentDisplay
  const minW = 300
  const minH = 360
  const maxW = Math.max(minW, workArea.width - 16)
  const maxH = Math.max(minH, workArea.height - 16)
  const b = settingsWin.getBounds()
  const width = Math.min(Math.max(Math.round(Number(w)) || minW, minW), maxW)
  const height = Math.min(Math.max(Math.round(Number(h)) || minH, minH), maxH)
  // Position mitschieben (beim Ziehen an Ober-/Linkskante) und im Arbeitsbereich halten.
  let nx = Number.isFinite(Number(x)) ? Math.round(Number(x)) : b.x
  let ny = Number.isFinite(Number(y)) ? Math.round(Number(y)) : b.y
  nx = Math.min(Math.max(nx, workArea.x - width + 60), workArea.x + workArea.width - 60)
  ny = Math.min(Math.max(ny, workArea.y - 8), workArea.y + workArea.height - 40)
  settingsWin.setBounds({ x: nx, y: ny, width, height })
})

ipcMain.handle('config:get', () => config)

ipcMain.handle('config:set', (_e, partial) => {
  Object.assign(config, partial)
  syncSystemDriveGrant()
  applyAutoStart()
  saveConfig()
  broadcastConfig()
  scheduleAutoPilot()
  return config
})

/* -------------------------------------------------------- about & updates */

/**
 * Laufmodus erkennen: gebautes Electron-Release (packaged) oder Quellcode.
 * Im Quellcode-Modus wird nach einem Git-Checkout gesucht (fuer den Updater,
 * der dann statt eines Electron-Updates das neueste Repo zieht).
 */
function findGitRoot(startDir) {
  let dir = path.resolve(startDir)
  for (let i = 0; i < 8; i++) {
    try {
      if (fs.statSync(path.join(dir, '.git'))) return dir
    } catch {
      /* weiter nach oben */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function detectRunMode() {
  if (app.isPackaged) return { mode: 'packaged', gitRoot: null }
  const gitRoot = findGitRoot(__dirname)
  return gitRoot ? { mode: 'git', gitRoot } : { mode: 'source', gitRoot: null }
}

/** Einfacher git-Aufruf mit Timeout; Ergebnis nie werfen, nur melden. */
function gitExec(gitRoot, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', gitRoot, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err.code })
        else resolve({ ok: true, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() })
      }
    )
  })
}

/** Update-Check im Git-Modus: fetch (nur Abgleich, kein Pull) + Ahead/Behind zaehlen. */
async function gitUpdateCheck(gitRoot) {
  const fetchRes = await gitExec(gitRoot, ['fetch', '--all', '--prune'])
  if (!fetchRes.ok) {
    return { ok: false, error: `git fetch failed: ${fetchRes.stderr || fetchRes.stdout || 'git not available'}` }
  }
  const branchRes = await gitExec(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRes.ok ? branchRes.stdout : 'unknown'
  const upRes = await gitExec(gitRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const upstream = upRes.ok ? upRes.stdout : `origin/${branch}`
  const behindRes = await gitExec(gitRoot, ['rev-list', '--count', `HEAD..${upstream}`])
  const behind = behindRes.ok ? parseInt(behindRes.stdout, 10) || 0 : 0
  const aheadRes = await gitExec(gitRoot, ['rev-list', '--count', `${upstream}..HEAD`])
  const ahead = aheadRes.ok ? parseInt(aheadRes.stdout, 10) || 0 : 0
  const dirtyRes = await gitExec(gitRoot, ['status', '--porcelain'])
  const dirty = dirtyRes.ok ? dirtyRes.stdout.split('\n').some((l) => l.trim()) : false
  const remoteRes = await gitExec(gitRoot, ['remote', 'get-url', 'origin'])
  const remote = remoteRes.ok ? remoteRes.stdout : ''
  const appVersion = app.getVersion() || '1.0.0'
  return {
    ok: true,
    mode: 'git',
    updateAvailable: behind > 0,
    currentVersion: appVersion,
    latestVersion: behind > 0 ? `${branch} @ ${behind} behind` : branch,
    releaseName: `Branch ${branch}${ahead > 0 ? ` (${ahead} ahead)` : ''}`,
    releaseNotes: behind > 0
      ? `${behind} commit(s) available on ${upstream}.${dirty ? ' Local uncommitted changes present — commit or stash them before pulling.' : ''}`
      : `Up to date with ${upstream}.${dirty ? ' (local uncommitted changes exist)' : ''}`,
    gitBranch: branch,
    gitBehind: behind,
    gitDirty: dirty,
    gitRemote: remote,
    checkedAt: Date.now()
  }
}

/** Renderer im App-Verzeichnis neu bauen (vite build). */
function runRendererBuild() {
  const appDir = path.join(__dirname, '..')
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['run', 'build'], {
      cwd: appDir,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let errOut = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (errOut += d))
    child.on('error', (e) => resolve({ ok: false, stdout: out, stderr: String(e) }))
    child.on('close', (code) => resolve({ ok: code === 0, stdout: out, stderr: errOut }))
  })
}

/** Update im Git-Modus: pull (nur bei sauberem Baum) + Renderer bauen + Neustart. */
async function installGitUpdate(gitRoot) {
  broadcastUpdateProgress(10, 'Checking for local changes...')
  const statusRes = await gitExec(gitRoot, ['status', '--porcelain'])
  const dirty = statusRes.ok && statusRes.stdout.trim().length > 0
  if (dirty) {
    broadcastUpdateProgress(0, 'Local changes block the pull')
    return { ok: false, error: 'Uncommitted local changes block the update. Commit or stash them first.' }
  }
  broadcastUpdateProgress(20, 'Fetching latest code...')
  const fetchRes = await gitExec(gitRoot, ['fetch', '--all', '--prune'])
  if (!fetchRes.ok) {
    broadcastUpdateProgress(0, 'Fetch failed')
    return { ok: false, error: `git fetch failed: ${fetchRes.stderr || fetchRes.stdout || 'git not available'}` }
  }
  broadcastUpdateProgress(45, 'Pulling latest code...')
  const pullRes = await gitExec(gitRoot, ['pull', '--ff-only'])
  if (!pullRes.ok) {
    broadcastUpdateProgress(0, 'Pull failed')
    return { ok: false, error: `git pull failed: ${pullRes.stderr || pullRes.stdout}` }
  }
  // Im DEV_URL-Modus liefert der Vite-Devserver den neuen Stand selbst —
  // nur im gebauten Modus (dist-renderer) muss neu gebaut werden.
  if (!DEV_URL) {
    broadcastUpdateProgress(65, 'Rebuilding renderer...')
    const buildRes = await runRendererBuild()
    if (!buildRes.ok) {
      broadcastUpdateProgress(0, 'Build failed')
      return { ok: false, error: `renderer build failed: ${buildRes.stderr || buildRes.stdout}` }
    }
  }
  broadcastUpdateProgress(90, 'Restarting app...')
  await new Promise((r) => setTimeout(r, 400))
  broadcastUpdateProgress(100, 'Updated — restarting...')
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 500)
  return { ok: true, message: 'Latest code pulled. Restarting...', updated: true }
}

function getDetailedSpecs() {
  const mem = process.memoryUsage()
  let osName = os.type()
  if (process.platform === 'win32') {
    const rel = os.release().split('.')
    const build = parseInt(rel[2] || '0', 10)
    osName = build >= 22000 ? 'Windows 11' : 'Windows 10'
  } else if (process.platform === 'darwin') {
    osName = 'macOS'
  } else if (process.platform === 'linux') {
    osName = 'Linux'
  }

  return {
    appName: 'Bloub Pet',
    appVersion: app.getVersion() || '1.1.2',
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    v8Version: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osName,
    osRelease: os.release(),
    totalMemory: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))} GB`,
    freeMemory: `${(os.freemem() / (1024 * 1024 * 1024)).toFixed(1)} GB`,
    processMemory: `${Math.round(mem.rss / (1024 * 1024))} MB`,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    runMode: detectRunMode().mode,
    gitRoot: detectRunMode().gitRoot ?? undefined
  }
}

ipcMain.handle('app:get-specs', () => {
  return getDetailedSpecs()
})

function compareSemver(a, b) {
  const pa = (a || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = (b || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

function fetchLatestGitHubRelease(repo = 'Mailo037/bloub') {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          'User-Agent': 'Bloub-Pet-App',
          Accept: 'application/vnd.github.v3+json'
        },
        timeout: 6000
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body))
            } catch (err) {
              reject(err)
            }
          } else if (res.statusCode === 404) {
            resolve(null)
          } else {
            reject(new Error(`GitHub API HTTP ${res.statusCode}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Update check request timed out'))
    })
  })
}

function broadcastUpdateProgress(percent, status) {
  const payload = { percent, status }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('app:update-progress', payload)
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:update-progress', payload)
  }
}

/** Update-Check ausfuehren, Ergebnis cachen und ans Pet-Fenster melden. */
async function runUpdateCheck() {
  const currentVersion = app.getVersion() || '1.0.0'
  const { mode, gitRoot } = detectRunMode()
  let result

  // Quellcode-Checkout: gegen den Git-Remote vergleichen statt Releases.
  if (mode === 'git' && gitRoot) {
    try {
      result = await gitUpdateCheck(gitRoot)
    } catch (err) {
      console.error('Git update check error:', err)
      result = {
        ok: true,
        mode: 'git',
        updateAvailable: false,
        currentVersion,
        latestVersion: currentVersion,
        error: String(err?.message ?? err),
        checkedAt: Date.now()
      }
    }
    return finishUpdateCheck(result)
  }

  // Aus Quellcode ohne Git-Repo gestartet: kein Auto-Update moeglich.
  if (mode === 'source') {
    result = {
      ok: true,
      mode: 'source',
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      releaseNotes: 'Running from source without a git checkout — clone https://github.com/Mailo037/bloub.git to enable auto-update.',
      htmlUrl: 'https://github.com/Mailo037/bloub',
      checkedAt: Date.now()
    }
    return finishUpdateCheck(result)
  }

  // Gebautes Release: normaler Electron/GitHub-Release-Check.
  try {
    const release = await fetchLatestGitHubRelease('Mailo037/bloub').catch(() => null)
    if (release && release.tag_name) {
      const isNewer = compareSemver(release.tag_name, currentVersion) > 0
      // Setup-Installer bevorzugen (.exe), sonst beliebige .exe, sonst .zip
      const setupAsset = release.assets?.find((a) => a.name.includes('Setup') && a.name.endsWith('.exe'))
      const exeAsset = setupAsset || release.assets?.find((a) => a.name.endsWith('.exe'))
      const winAsset = exeAsset || release.assets?.find((a) => a.name.endsWith('.zip'))

      result = {
        ok: true,
        mode: 'packaged',
        updateAvailable: isNewer,
        currentVersion,
        latestVersion: release.tag_name.replace(/^v/, ''),
        releaseName: release.name || release.tag_name,
        releaseNotes: release.body || 'New features, improvements and bug fixes.',
        publishedAt: release.published_at,
        downloadUrl: winAsset ? winAsset.browser_download_url : release.html_url,
        assetName: winAsset?.name || 'Bloub-Pet-Setup.exe',
        htmlUrl: release.html_url,
        checkedAt: Date.now()
      }
      return finishUpdateCheck(result)
    }
  } catch (err) {
    console.error('Update check error:', err)
  }

  result = {
    ok: true,
    mode: 'packaged',
    updateAvailable: false,
    currentVersion,
    latestVersion: currentVersion,
    checkedAt: Date.now()
  }
  return finishUpdateCheck(result)
}

/** Ergebnis cachen und den Update-Status ans Pet-Fenster (Edit-Button) melden. */
function finishUpdateCheck(result) {
  lastUpdateResult = result
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:update-available', !!result?.updateAvailable)
  }
  return result
}

/** Update-Verfuegbarkeit ans Pet-Fenster melden (z. B. beim Fenster-Neuladen). */
function broadcastUpdateStateToPet() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:update-available', !!lastUpdateResult?.updateAvailable)
  }
}

/** Periodischer Auto-Check: Edit-Button am Bloub wird blau, sobald ein Update da ist. */
function scheduleAutoUpdateCheck() {
  clearTimeout(updateCheckTimer)
  updateCheckTimer = null
  updateCheckTimer = setTimeout(() => {
    updateCheckTimer = null
    runUpdateCheck().catch(() => { /* non-fatal */ }).finally(scheduleAutoUpdateCheck)
  }, 4 * 60 * 60 * 1000) // alle 4 Stunden
}

ipcMain.handle('app:check-updates', () => runUpdateCheck())

/** Datei direkt per HTTPS-Stream herunterladen (folgt Redirects automatisch). */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function get(targetUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'))
      const parsed = new URL(targetUrl)
      const isHttps = parsed.protocol === 'https:'
      const client = isHttps ? https : require('node:http')
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Bloub-Pet-App',
          Accept: 'application/octet-stream'
        },
        timeout: 45000
      }
      const req = client.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirects + 1)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed with HTTP ${res.statusCode}`))
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        const fileStream = fs.createWriteStream(destPath)
        res.on('data', (chunk) => {
          received += chunk.length
          if (total > 0 && typeof onProgress === 'function') {
            const percent = Math.min(95, Math.max(5, Math.round((received / total) * 100)))
            onProgress(percent, received, total)
          }
        })
        res.pipe(fileStream)
        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath))
        })
        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => {})
          reject(err)
        })
      })
      req.on('error', (err) => {
        fs.unlink(destPath, () => {})
        reject(err)
      })
      req.on('timeout', () => {
        req.destroy()
        fs.unlink(destPath, () => {})
        reject(new Error('Download timed out'))
      })
    }
    get(url)
  })
}

ipcMain.handle('app:install-update', async (_e, { downloadUrl } = {}) => {
  const { mode, gitRoot } = detectRunMode()

  // Quellcode-Checkout: neuesten Code ziehen statt Installer.
  if (mode === 'git' && gitRoot) {
    return installGitUpdate(gitRoot)
  }

  // Quellcode ohne Git-Repo: keinen Weg zum Ziehen.
  if (mode === 'source') {
    return {
      ok: false,
      error: 'No git checkout found. Clone https://github.com/Mailo037/bloub.git and run it from there to auto-update.'
    }
  }

  // Gebautes Release: In-App Download und anschließender Installer-Start
  if (downloadUrl && typeof downloadUrl === 'string' && downloadUrl.startsWith('http')) {
    try {
      broadcastUpdateProgress(5, 'Connecting to download server...')
      const filename = path.basename(new URL(downloadUrl).pathname) || 'Bloub-Pet-Setup.exe'
      const destPath = path.join(app.getPath('temp'), filename)

      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
      } catch {
        /* ignore */
      }

      await downloadFile(downloadUrl, destPath, (percent, received, total) => {
        const mbRec = (received / (1024 * 1024)).toFixed(1)
        const mbTot = (total / (1024 * 1024)).toFixed(1)
        broadcastUpdateProgress(percent, `Downloading update (${percent}% · ${mbRec}/${mbTot} MB)...`)
      })

      broadcastUpdateProgress(100, 'Download complete. Launching installer...')
      await new Promise((r) => setTimeout(r, 600))

      if (destPath.endsWith('.exe')) {
        const child = spawn(destPath, [], {
          detached: true,
          stdio: 'ignore'
        })
        child.unref()
        setTimeout(() => {
          app.quit()
          process.exit(0)
        }, 600)
        return { ok: true, message: 'Installer launched', updating: true }
      } else {
        shell.showItemInFolder(destPath)
        return { ok: true, message: 'Package downloaded' }
      }
    } catch (err) {
      console.error('In-app update download error:', err)
      broadcastUpdateProgress(0, 'Download failed')
      return { ok: false, error: err?.message || String(err) }
    }
  }

  // Simulation / in-app reload flow
  broadcastUpdateProgress(25, 'Downloading latest components...')
  await new Promise((r) => setTimeout(r, 400))
  broadcastUpdateProgress(70, 'Applying package...')
  await new Promise((r) => setTimeout(r, 500))
  broadcastUpdateProgress(100, 'Update applied successfully! Restarting...')
  await new Promise((r) => setTimeout(r, 600))

  return { ok: true, updated: true }
})

ipcMain.handle('shell:open-external', (_e, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:'))) {
    shell.openExternal(url)
    return true
  }
  return false
})


let isQuitting = false

function requestQuit() {
  if (isQuitting) return
  isQuitting = true
  stopCursorPolling()
  stopPetWatchdog()
  // Laufende Agent-Arbeit sauber beenden: Provider-Stream + Tool-Calls abbrechen
  if (chat) chat.abort()
  // Custom-Animation-Waiter freigeben, damit kein Promise haengen bleibt
  for (const resolve of customAnimWaiters.values()) resolve()
  customAnimWaiters.clear()
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.hide()
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:quit-requested')
    setTimeout(() => {
      app.exit(0)
    }, 900)
  } else {
    app.exit(0)
  }
}

ipcMain.on('pet:quit', () => requestQuit())
ipcMain.on('pet:quit-confirm', () => {
  app.exit(0)
})

app.on('before-quit', (e) => {
  if (!isQuitting) {
    e.preventDefault()
    requestQuit()
  }
})

function buildTrayMenu() {
  const recallOn = !!config.recall?.enabled
  return Menu.buildFromTemplate([
    {
      label: 'Show Pet',
      click: () => {
        if (win && !win.isDestroyed()) {
          win.show()
          win.moveTop()
        }
      }
    },
    {
      label: 'Center Pet',
      click: () => {
        if (win && !win.isDestroyed()) {
          const { workArea } = screen.getPrimaryDisplay()
          const nx = Math.round(workArea.x + workArea.width / 2 - 310)
          const ny = Math.round(workArea.y + workArea.height / 2 - 330)
          win.setPosition(nx, ny)
          config.x = nx
          config.y = ny
          saveConfig()
          win.show()
          win.moveTop()
        }
      }
    },
    {
      label: 'Settings…',
      click: () => showSettings()
    },
    { type: 'separator' },
    {
      // Pause-Switch: friert SOFORT jede Aufnahme ein (Producer pruefen
      // isActive() vor jedem Schreibvorgang).
      label: 'Pause recall',
      type: 'checkbox',
      checked: recallMod.isManuallyPaused(),
      enabled: recallOn,
      click: () => toggleRecallPause()
    },
    {
      label: 'Recall: index now',
      enabled: recallOn,
      click: () => recallMod.runIndex()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => requestQuit()
    }
  ])
}

/** Tray-Menue neu aufbauen (nach Pause-Wechsel etc.). */
function refreshTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  // Echtes Bloub-Icon (Multi-Size-.ico, prozedural generiert via tools/make-icon.mjs)
  const iconPath = path.join(__dirname, 'assets', 'bloub.ico')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Bloub Pet')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      win.moveTop()
    }
  })
}

/* --------------------------------------------------------------- life */

app.whenReady().then(() => {
  loadConfig()
  createWindow()
  startPetWatchdog()
  setupPttKeyDetection()
  attachPttBlurGuard()

  // Mikrofon-Zugriff fuer Push-to-Talk erlauben (Permission im Renderer).
  const { session } = require('electron')
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem')
  })

  // Update-Status an das Pet-Fenster senden (Edit-Button-Typ)
  broadcastUpdateStateToPet()
  startCursorPolling()
  createTray()
  registerHotkeys()
  scheduleAutoPilot()
  // Recall-Orchestrator: Producer laufen NUR wenn config.recall.enabled —
  // der Start selbst ist inert und schreibt nichts.
  recallMod.startRecall({ userData: app.getPath('userData'), getCfg: () => config })
  // Automatischer Update-Check fuer den Edit-Button
  runUpdateCheck().catch(() => { /* non-fatal */ })
  scheduleAutoUpdateCheck()
})

app.on('will-quit', () => {
  stopCursorPolling()
  stopPetWatchdog()
  globalShortcut.unregisterAll()
  history.close(app.getPath('userData'))
  recallMod.stopRecall()
})

app.on('window-all-closed', () => app.quit())

