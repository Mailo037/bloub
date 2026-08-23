// Activity Recall — Orchestrator.
// Besitzt alle Producer-Lebenszyklen (Spool-Tailer, Focus-Poller, Clipboard,
// Browser-Link), den Pause-Zustand (manuell via Tray/Hotkey + Auto-Pause bei
// Passwort-Titel-Fenstern) und den Indexierungs-Rhythmus (stuendlich, beim
// App-Start und on demand).
// Grundprinzip: Solange isActive() false ist, schreibt KEIN Producer etwas.

const store = require('./store.cjs')
const spoolMod = require('./spool.cjs')
const focusMod = require('./focus.cjs')
const indexEngine = require('./index-engine.cjs')
const browserLink = require('./browser-link.cjs')

// Fenster-Titel, die Auto-Pause ausloesen (best-effort, bewusst breit).
const AUTO_PAUSE_TITLE_RE = /password|login|log in|sign in|bank|incognito|inprivate|passwort|anmeldung/i

const DEFAULTS = {
  enabled: false, // Master-Switch: OFF by default, nichts vor Consent
  shell: true,
  clipboard: false,
  browserLink: 'off', // off | extension | cdp
  retentionDays: 14
}

let state = null

function recallDefaults() {
  return { ...DEFAULTS }
}

/** Alle Producer starten (oder aktualisieren). idempotent. */
function startRecall({ userData, getCfg, hooks = {} }) {
  stopRecall()
  const cfg = () => ({ ...recallDefaults(), ...(getCfg()?.recall ?? {}) })
  state = {
    userData,
    getCfg: cfg,
    hooks,
    stopped: false,
    manualPaused: false, // Tray/Hotkey "Pause recall"
    autoPaused: false, // Passwort-Titel erkannt
    stopFns: [],
    indexTimer: null,
    engine: indexEngine.createQueryEngine(userData),
    lastFocusAt: {}
  }

  // Spool-Tailer nur bei aktivem Master UND Shell-Opt-in (Hooks schreiben
  // sonst ohnehin nichts; der Tailer soll aber auch nicht laufen).
  // Focus-Poller ebenso beim Master.
  applyShellTailer()
  applyFocusPoller()

  // Indexierung: stuendlich + einmal beim Start
  runIndex()
  state.indexTimer = setInterval(() => runIndex(), 3600_000)

  // Optionale Producer laut Config
  applyClipboardTap()
  void applyBrowserLink()

  return state
}

/** Nach Config-Aenderungen rufen: Producer an/abpassen. */
function refreshProducers() {
  if (!state) return
  applyShellTailer()
  applyFocusPoller()
  applyClipboardTap()
  void applyBrowserLink()
}

/** Shell-Spool-Tailer nur wenn Master AN UND Shell-Opt-in AN. */
function applyShellTailer() {
  const existing = state.stopFns.find((f) => f.__isSpoolStop)
  const want = !!state.getCfg().enabled && state.getCfg().shell !== false
  if (want && !existing) {
    const stop = spoolMod.startTailer(state.userData)
    stop.__isSpoolStop = true
    state.stopFns.push(stop)
  } else if (!want && existing) {
    state.stopFns = state.stopFns.filter((f) => f !== existing)
    existing()
  }
}

/** Clipboard-Tap nur wenn Master AN UND Clipboard-Opt-in AN. */
function applyClipboardTap() {
  const existing = state.stopFns.find((f) => f.__isClipboardStop)
  const want = !!state.getCfg().enabled && !!state.getCfg().clipboard
  if (want && !existing) {
    const clipboardMod = require('./clipboard.cjs')
    const tap = clipboardMod.startClipboardTap({ userData: state.userData })
    const stop = () => tap.stop()
    stop.__isClipboardStop = true
    state.clipboardRing = () => tap.ring()
    state.stopFns.push(stop)
  } else if (!want && existing) {
    state.stopFns = state.stopFns.filter((f) => f !== existing)
    existing()
    state.clipboardRing = null
  } else if (!want) {
    state.clipboardRing = null
  }
}

/**
 * Browser-Link: 'extension' -> lokalen HTTP-Endpunkt starten (die Extension
 * verbindet sich selbst); 'cdp' -> Chrome mit Debugging-Port neu starten und
 * per CDP den Snapshot injizieren; 'off' -> beides stoppen.
 */
async function applyBrowserLink() {
  if (!state) return
  const mode = state.getCfg().browserLink || 'off'
  const wantServer = mode === 'extension'

  if (wantServer && !state.linkHandle) {
    try {
      state.linkHandle = await browserLink.startBrowserLink({ userData: state.userData })
      try {
        state.hooks?.onBrowserLinkStarted?.(browserLink.getLinkInfo())
      } catch { /* ignore */ }
    } catch {
      state.linkHandle = null
    }
  } else if (!wantServer && state.linkHandle) {
    browserLink.stopBrowserLink()
    state.linkHandle = null
  }

  // CDP-Modus: Attach aufbauen/abbauen
  const wantCdp = mode === 'cdp'
  if (wantCdp && !state.cdpClient) {
    try {
      const cdp = require('./cdp.cjs')
      const chromeInfo = cdp.findChromeExecutable()
      const port = 9222 + Math.floor(Math.random() * 500)
      if (chromeInfo) await cdp.launchSupervised({ exe: chromeInfo.exe, port })
      // Kurz warten, bis der DevTools-Port da ist, dann attachen.
      setTimeout(async () => {
        if (!state || state.getCfg().browserLink !== 'cdp') return
        try {
          state.cdpClient = await cdp.attachAndWatch({
            httpPort: port,
            onPage: (payload) => ingestBrowserEvent(payload)
          })
        } catch {
          state.cdpClient = null
        }
      }, 6000)
    } catch {
      /* best effort — Settings zeigt den Fehler ueber getStatus */
    }
  } else if (!wantCdp && state.cdpClient) {
    try { state.cdpClient.close() } catch { /* ignore */ }
    state.cdpClient = null
  }
}

function applyFocusPoller() {
  const existing = state.stopFns.find((f) => f.__isFocusStop)
  const want = !!state.getCfg().enabled
  if (want && !existing) {
    const stop = focusMod.startFocusPoller({
      userData: state.userData,
      onFocus: (app, title) => {
        // Auto-Pause: Titel riecht nach Passwoertern/Banking -> sofort
        // pausieren (best-effort Heuristik, dokumentiert). Re-Aktivierung,
        // sobald wieder ein harmloses Fenster im Vordergrund ist.
        if (AUTO_PAUSE_TITLE_RE.test(String(title ?? ''))) {
          setAutoPaused(true)
        } else {
          setAutoPaused(false)
        }
      }
    }).stop
    stop.__isFocusStop = true
    state.stopFns.push(stop)
  } else if (!want && existing) {
    state.stopFns = state.stopFns.filter((f) => f !== existing)
    existing()
  }
}

function stopRecall() {
  if (!state) return
  state.stopped = true
  clearInterval(state.indexTimer)
  for (const stop of state.stopFns) {
    try {
      stop()
    } catch {
      /* ignore */
    }
  }
  state.stopFns = []
  try {
    browserLink.stopBrowserLink()
  } catch {
    /* ignore */
  }
  if (state.cdpClient) {
    try { state.cdpClient.close() } catch { /* ignore */ }
    state.cdpClient = null
  }
  state = null
}

function isStarted() {
  return !!state
}

function getUserData() {
  return state?.userData ?? null
}

function isEnabled() {
  return !!state?.getCfg().enabled
}

function isManuallyPaused() {
  return !!state?.manualPaused
}

function isAutoPaused() {
  return !!state?.autoPaused
}

/**true, wenn Producer schreiben duerfen UND Tools antworten duerfen. */
function isActive() {
  return isStarted() && isEnabled() && !isManuallyPaused() && !isAutoPaused()
}

function setManualPaused(paused) {
  if (!state) return false
  state.manualPaused = !!paused
  return true
}

function setAutoPaused(paused) {
  if (!state) return
  if (!!paused !== state.autoPaused) {
    state.autoPaused = !!paused
    try {
      state.hooks?.onPauseChanged?.(pauseStatus())
    } catch {
      /* ignore */
    }
  }
}

function togglePaused() {
  if (!state) return false
  state.manualPaused = !state.manualPaused
  return state.manualPaused
}

function pauseStatus() {
  return {
    active: isActive(),
    manualPaused: isManuallyPaused(),
    autoPaused: isAutoPaused(),
    enabled: isEnabled(),
    browserLinkPort: state?.linkHandle?.port ?? null,
    clipboardRunning: !!state?.clipboardRing && !!state.getCfg().clipboard,
    cdpAttached: !!state?.cdpClient
  }
}

/* -------------------------------------------------------------- indexing */

function runIndex() {
  if (!state) return { indexed: 0 }
  const res = indexEngine.indexEvents({
    userData: state.userData,
    retentionDays: state.getCfg().retentionDays
  })
  if (res.indexed > 0 || res.purgedShards > 0 || res.trimmedFile) {
    state.engine.invalidate()
  }
  return res
}

function getEngine() {
  return state?.engine ?? null
}

/* -------------------------------------------------------- browser events */

// Zweite Verteidigungslinie neben der Producer-Redaktion: Felder mit
// Passwort-/Zahlungsbezug werden auch beim Empfang nochmal verworfen.
const SECRET_FIELD_RE = /passwo|password|cc[-_]|credit.?card|cardnumber|cvv|cvc|one[-_]?time[-_]?code/i

/**
 * Payload des Browser-Links (Extension oder CDP) in ein kanonisches Event
 * ueberfuehren: { url, host, title, trigger, fields:[{label,value}] }.
 * Redaction passiert bereits IM Producer (Extension/CDP-Snapshot); hier
 * wird gebunden, normalisiert und NACHTRAGLICH noch einmal gefiltert.
 */
function ingestBrowserEvent(payload) {
  if (!isActive()) return null
  const rawFields = Array.isArray(payload?.fields) ? payload.fields.slice(0, 20) : []
  const fields = []
  const summaryParts = []
  for (const f of rawFields) {
    if (!f || typeof f !== 'object') continue
    const label = String(f.label ?? '').slice(0, 120)
    const value = String(f.value ?? '').slice(0, 500)
    if (!value) continue
    if (SECRET_FIELD_RE.test(label) || SECRET_FIELD_RE.test(value.slice(0, 40))) continue
    fields.push({ label, value })
    summaryParts.push(`${label}: ${value}`)
  }
  const text = summaryParts.join(' | ').slice(0, 4000)
  return store.appendEvent(state.userData, {
    ts: Date.now(),
    source: 'browser',
    app: String(payload?.host ?? '').slice(0, 200),
    title: String(payload?.title ?? '').slice(0, 500),
    kind: 'action',
    text,
    detail: {
      url: String(payload?.url ?? '').slice(0, 2000),
      host: String(payload?.host ?? '').slice(0, 200),
      trigger: String(payload?.trigger ?? 'submit').slice(0, 40),
      fieldCount: fields.length
    }
  })
}

module.exports = {
  recallDefaults,
  startRecall,
  stopRecall,
  refreshProducers,
  isStarted,
  getUserData,
  isEnabled,
  isActive,
  isManuallyPaused,
  isAutoPaused,
  setManualPaused,
  togglePaused,
  pauseStatus,
  runIndex,
  getEngine,
  ingestBrowserEvent,
  AUTO_PAUSE_TITLE_RE
}
