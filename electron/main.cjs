const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Stabile GPU-Beschleunigung fuer echtes Windows DWM Acrylic Blur
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('use-angle', 'd3d11')

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

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
  }
})

const SETTINGS_W = 336
const SETTINGS_H = 640

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
    eventsEnabled: true
  }
  try {
    config = { ...fallback, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }
  } catch {
    config = fallback
  }
  return config
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

function clampToWorkArea(x, y) {
  const { workArea } = screen.getPrimaryDisplay()
  return [
    Math.min(Math.max(x, workArea.x - 200), workArea.x + workArea.width - 420),
    Math.min(Math.max(y, workArea.y - 200), workArea.y + workArea.height - 420)
  ]
}

function rendererPreload() {
  return path.join(__dirname, 'preload.cjs')
}

let winX = 0
let winY = 0

function createWindow() {
  const [x, y] = clampToWorkArea(
    Number.isFinite(config.x) ? config.x : workAreaRight(),
    Number.isFinite(config.y) ? config.y : workAreaMiddleY()
  )
  winX = x
  winY = y

  console.log('[main] config:', JSON.stringify(config))
  console.log('[main] primary display workArea:', JSON.stringify(screen.getPrimaryDisplay().workArea))
  console.log('[main] creating window at coords:', x, y)

  win = new BrowserWindow({
    x,
    y,
    width: 620,
    height: 620,
    transparent: true,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    focusable: false,
    show: true,
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  win.webContents.on('page-title-updated', (e) => e.preventDefault())
  win.setAlwaysOnTop(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

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
}

function loadRenderer(w, file) {
  if (DEV_URL) w.loadURL(`${DEV_URL}/${file}`)
  else w.loadFile(path.join(__dirname, '..', 'dist-renderer', file))
}

/* ---------------------------------------------------- settings window */

function showSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    return
  }

  // Neben dem Pad andocken; wenn rechts kein Platz ist, links davon.
  const { workArea } = screen.getPrimaryDisplay()
  const ballR = Math.round((config.ballSize || 200) / 2)
  let x = winX + 310 + ballR + 16
  let y = winY + 310 - Math.round(SETTINGS_H / 2)
  if (x + SETTINGS_W > workArea.x + workArea.width) {
    x = winX + 310 - ballR - SETTINGS_W - 16
  }
  y = Math.min(Math.max(y, workArea.y + 10), workArea.y + workArea.height - SETTINGS_H - 10)
  x = Math.min(Math.max(x, workArea.x + 10), workArea.x + workArea.width - SETTINGS_W - 10)

  settingsWin = new BrowserWindow({
    x,
    y,
    width: SETTINGS_W,
    height: SETTINGS_H,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    thickFrame: false,
    roundedCorners: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  settingsWin.webContents.on('page-title-updated', (e) => e.preventDefault())
  settingsWin.setAlwaysOnTop(true, 'floating')
  loadRenderer(settingsWin, 'settings.html')

  settingsWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[settings] ${message} (${sourceId}:${line})`)
  })

  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => {
    settingsWin = null
    if (win && !win.isDestroyed()) win.webContents.send('settings:visibility', false)
  })

  if (win && !win.isDestroyed()) win.webContents.send('settings:visibility', true)
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
}

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
  const [x, y] = clampToWorkArea(Math.round(winX + dx), Math.round(winY + dy))
  winX = x
  winY = y
  win.setPosition(x, y)
  config.x = x
  config.y = y
})

ipcMain.on('pet:dragEnd', () => {
  saveConfig()
})

// Click-through for the transparent desktop area around the pad. `forward` keeps
// pointermove flowing so the renderer can watch the cursor and re-grab input
// when it comes back over the ball.
ipcMain.on('pet:setIgnore', (_e, ignore) => {
  if (!win) return
  win.setIgnoreMouseEvents(!!ignore, { forward: true })
})

ipcMain.on('ui:toggle-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) closeSettings()
  else showSettings()
})

ipcMain.on('ui:close-settings', () => closeSettings())

ipcMain.on('ui:resize-settings', (_e, x, y, w, h) => {
  if (!settingsWin || settingsWin.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
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
  saveConfig()
  broadcastConfig()
  return config
})

let isQuitting = false

function requestQuit() {
  if (isQuitting) return
  isQuitting = true
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.hide()
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:quit-requested')
    setTimeout(() => {
      app.exit(0)
    }, 700)
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

function createTray() {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0YuksAAAAUUlEQVQ4y2NgGAWjYBSMgoEBjIwM/xmoYAYGBgYmEvw/CvD/jQz/mZCJEQwXAPFjUcz4j8bHqRg0gIk0w4FmMBEaHjCqgFEwGgWjYBSQCQAAM7wK0qP75/YAAAAASUVORK5CYII=',
      'base64'
    )
  )
  tray = new Tray(icon)
  tray.setToolTip('Bloub Pad')
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show & Center Pet',
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
      label: 'Settings',
      click: () => showSettings()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => requestQuit()
    }
  ])
  tray.setContextMenu(contextMenu)
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
  createTray()
})

app.on('window-all-closed', () => app.quit())

