import { STATE_BY_ID, type StateId } from '../vendor/bot/states'
import { EXPRESSION_BY_ID, type BotExpression } from '../vendor/bot/expressions'
import type { EyeCfg } from '../vendor/bot/states'
import { SHAPE_BY_ID, COLOR_BY_ID } from '../vendor/bot/skins'
import { RAYON, DEMI_VIEWBOX } from '../vendor/bot/repere'
import { clamp } from '../vendor/bot/math'
import { YAW_MAX, PITCH_MAX, PITCH, SPIN } from '../vendor/ui/gaze'
import { getBridge, makeBotSvg, type PetConfig, type CustomAnimSpec, type CustomAnimKeyframe, type GlobalCursorInfo } from './shared'
import { BotEngine } from '../vendor/bot/engine'
import { mountChat } from './chat'

const bridge = getBridge()

const ballWrap = document.getElementById('ball-wrap')!
const hostSvg = document.getElementById('bot') as unknown as SVGSVGElement
const editBtn = document.getElementById('edit') as HTMLButtonElement
const chatDock = document.getElementById('chat-dock')!
const petMenu = document.getElementById('pet-menu')!
const menuChatBtn = document.getElementById('menu-chat') as HTMLButtonElement
const menuSettingsBtn = document.getElementById('menu-settings') as HTMLButtonElement
const menuQuitBtn = document.getElementById('menu-quit') as HTMLButtonElement

let config: PetConfig
let engine: BotEngine
let bot: ReturnType<typeof makeBotSvg>

let clock = 0
let busyUntil = 0
/** Animations-Lock: solange aktiv, bleibt der aktuelle Zustand stehen und
 * der Bloub geht weder idle noch sleep — bis er explizit freigegeben wird. */
let animHold = false
let nextEventAt = Infinity
let lastInteraction = -10
let dragging = false
let dragMovedTotal = 0
let lastDragScreen: { x: number; y: number } | null = null
let pointer: { x: number; y: number } | null = null
let pointerAt = 0
/**
 * Globaler Cursor (vom Main-Prozess gepollt, gilt auf ALLEN Monitoren).
 * `at` ist performance.now() des letzten Updates — nur dann zaehlt er als
 * frisch und darf den DOM-Zeiger (nur eigenes Fenster) als Blickziel ersetzen.
 */
let globalCursor: (GlobalCursorInfo & { at: number }) | null = null
const GLOBAL_CURSOR_FRESH_MS = 800
let aiming = false
let hoverT = 0
let settingsOpen = false
let ignoring = false
let dragGraceUntil = 0

let activeExprId: string | null = null
let wildness = 0
let isAiThinking = false
let isAiStreaming = false
let lastActivityAt = 0
let lastPointerMoveTime = performance.now()
let lastMoveTime = 0

const TIME_TO_SLEEPY = 90 // 1:30 min — erst danach schlaeft die Expression ein, davor laufen Custom-Events
const TIME_TO_SLEEP = 120 // 2:00 min — Deep-Sleep kommt NACH der Sleepy-Expression

function ink(): string {
  return COLOR_BY_ID.get(config.color)?.hex ?? '#0a0a0c'
}

function applyConfig() {
  document.documentElement.style.setProperty('--ball-size', `${config.ballSize}px`)
  engine.setShape(SHAPE_BY_ID.get(config.shape)?.radii ?? null, clock)
  if (!dragging) {
    activeExprId = config.expression
    engine.setExpression(EXPRESSION_BY_ID.get(config.expression) ?? null, clock)
  }
}

/* --------------------------------------------------- zustands-maschine */

function playOnce(id: string, customDuration?: number) {
  if (id === 'stop' || id === 'idle') {
    engine.setState('idle', clock)
    busyUntil = animHold ? Infinity : 0
    isAiThinking = false
    isAiStreaming = false
    return
  }
  const def = STATE_BY_ID.get(id as StateId)
  if (!def) return
  isAiThinking = false
  isAiStreaming = false
  engine.setState(id as StateId, clock)
  const hold = typeof customDuration === 'number' && customDuration > 0
    ? customDuration
    : Math.max(def.duration ?? 2.4, def.minDuration ?? 0)
  // Bei aktivem Lock bleibt der Zustand stehen, bis er explizit freigegeben wird.
  busyUntil = animHold ? Infinity : clock + hold
}

/**
 * Animations-Lock vom Main-Prozess: haelt den aktuellen Zustand des Bloub
 * fest, bis die Aktion (z. B. das Zeichnen) fertig ist. Beim Freigeben kehrt
 * er normal zurueck (idle bzw. Talk im Stream).
 */
function setAnimHold(hold: boolean) {
  animHold = hold
  if (hold) {
    busyUntil = Infinity
  } else {
    busyUntil = clock
    if (!isAiThinking && !isAiStreaming && engine.state !== 'idle') {
      engine.setState('idle', clock)
    }
  }
}

const IDLE_POOL: Array<[StateId, number]> = [
  ['thinking', 2],
  ['wink', 2],
  ['wide', 1.4],
  ['notify', 1.6],
  ['sleep', 1],
  ['egg', 1],
  ['hexagon', 1],
  ['play', 1.4],
  ['comet', 1],
  ['orbit', 1],
  ['alert', 0.8],
  ['lookaround', 2],
  ['excited', 1.2],
  ['focus', 0.8],
  ['sideeye', 1.6],
  ['stare', 0.8],
  ['scan', 1],
  ['dizzy', 0.8],
  ['peek', 1.4]
]

/**
 * Reaktion waehrend eines laufenden AI-Turns (aha/ohno/nod/shake): wechselt
 * den State, ohne die AI-Flags anzutasten — playOnce wuerde isAiStreaming
 * loeschen und den Turn-Ende-Flow kaputt machen. Nach busyUntil kehrt der
 * tick den Bloub automatisch in den Talk-Zustand zurueck.
 */
function playReaction(id: StateId) {
  const def = STATE_BY_ID.get(id)
  if (!def) return
  engine.setState(id, clock)
  busyUntil = clock + Math.max(def.duration ?? 2, def.minDuration ?? 0)
}

function playRandomIdle() {
  const total = IDLE_POOL.reduce((s, [, w]) => s + w, 0)
  let r = Math.random() * total
  for (const [id, w] of IDLE_POOL) {
    r -= w
    if (r <= 0) {
      playOnce(id)
      return
    }
  }
  playOnce('thinking')
}

const CLICK_REACTIONS: StateId[] = ['wink', 'exclaim', 'notify', 'wide']

/* ------------------------------------------------------ custom anims */

/**
 * Custom-Animationen aus `pet_custom_animate`: Keyframes werden linear
 * interpoliert. Body-Track = CSS-Transformation auf dem SVG (Verschiebung,
 * Skalierung, Rotation, Squash); Expression-Track = engine.setExpression +
 * setLook pro Frame. Bei kind=both laufen beide Tracks parallel und der
 * Abschluss wird erst gemeldet, wenn BEIDE fertig sind (Main wartet darauf).
 */
interface ActiveCustomAnim {
  spec: CustomAnimSpec
  startedAt: number
}

let activeCustomAnim: ActiveCustomAnim | null = null

function sampleKeyframes(
  frames: CustomAnimKeyframe[] | undefined,
  time: number
): Partial<CustomAnimKeyframe> | null {
  if (!frames || frames.length === 0) return null
  if (frames.length === 1) return { ...frames[0] }
  const sorted = [...frames].sort((a, b) => a.t - b.t)
  if (time <= sorted[0]!.t) return { ...sorted[0] }
  const last = sorted[sorted.length - 1]!
  if (time >= last.t) return { ...last }
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (time >= a.t && time <= b.t) {
      const span = b.t - a.t
      const k = span > 0 ? clamp((time - a.t) / span, 0, 1) : 1
      const out: Partial<CustomAnimKeyframe> = { t: time }
      for (const key of Object.keys(a) as Array<keyof CustomAnimKeyframe>) {
        if (key === 't') continue
        const av = a[key]
        const bv = b[key]
        if (typeof av === 'number' && typeof bv === 'number') {
          out[key] = av + (bv - av) * k
        } else if (typeof av === 'number') {
          out[key] = av
        } else if (typeof bv === 'number') {
          out[key] = bv
        }
      }
      return out
    }
  }
  return { ...last }
}

/** Body-Track: CSS-Transformation auf dem SVG (Transform-Origin = Zentrum). */
function applyBodyFrame(f: Partial<CustomAnimKeyframe>) {
  // Werte klemmen, damit uebertriebene AI-Vorgaben nie kaputt aussehen
  const x = clamp(f.x ?? 0, -60, 60)
  const y = clamp(f.y ?? 0, -60, 60)
  const scale = clamp(f.scale ?? 1, 0.6, 1.6)
  const rot = clamp(f.rot ?? 0, -90, 90)
  const squash = clamp(f.squash ?? 1, 0.5, 1.8)
  // Squash/Stretch volumen-erhaltend: hoeher = schmaler, flacher = breiter
  const sx = scale / Math.sqrt(squash)
  const sy = scale * Math.sqrt(squash)
  hostSvg.style.transformOrigin = '50% 50%'
  hostSvg.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${sx}, ${sy})`
}

/** Expression-Track: Gesicht aus Keyframes bauen und in die Engine geben. */
function applyExpressionFrame(f: Partial<CustomAnimKeyframe>) {
  const base = EXPRESSION_BY_ID.get(config.expression) ?? null
  if (!base) return
  const gaze = {
    yaw: clamp(f.yaw ?? base.gaze.yaw, -45, 45),
    pitch: clamp(f.pitch ?? base.gaze.pitch, -40, 40),
    roll: clamp(f.roll ?? base.gaze.roll, -45, 45)
  }
  const eyeW = clamp(f.eyeW ?? 1, 0.4, 2.2)
  const eyeH = clamp(f.eyeH ?? 1, 0.1, 2.2)
  const open = clamp(f.open ?? 1, 0, 1)
  const tilt = clamp(f.tilt ?? 0, -60, 60)
  const split = clamp(f.split ?? base.split, 8, 30)
  const mkEye = (e: EyeCfg, t: number): EyeCfg => ({
    w: e.w * eyeW,
    h: e.h * eyeH,
    open: e.open * open,
    tilt: (e.tilt ?? 0) + t
  })
  const expr: BotExpression = {
    id: base.id,
    gaze,
    split,
    eyes: [mkEye(base.eyes[0], tilt), mkEye(base.eyes[1], -tilt)]
  }
  engine.setExpression(expr, clock)
  // Look direkt setzen, damit der Cursor-Suchlauf nicht mit dem Gesicht kaempft
  engine.setLook({ yaw: gaze.yaw, pitch: gaze.pitch, mix: 1, spin: 0, wander: 0 }, clock, 0.05)
}

function isExpressionCustomAnim(): boolean {
  return !!activeCustomAnim && activeCustomAnim.spec.kind !== 'body'
}

function startCustomAnim(spec: CustomAnimSpec) {
  if (activeCustomAnim) finishCustomAnim(activeCustomAnim.spec.id)
  activeCustomAnim = { spec, startedAt: clock }
  lastActivityAt = clock
  lastInteraction = clock
  if (spec.kind !== 'body') {
    // Gesicht braucht einen baseFace-Zustand — idle
    activeExprId = null
    engine.setState('idle', clock)
    busyUntil = clock + spec.duration + 0.4
  } else {
    busyUntil = Math.max(busyUntil, clock + spec.duration + 0.2)
  }
}

function finishCustomAnim(id?: string) {
  if (activeCustomAnim) {
    hostSvg.style.transform = ''
    activeExprId = null
    activeCustomAnim = null
    engine.setLook(null, clock, 0.4)
    if (id) bridge.notifyCustomAnimDone?.(id)
  }
}

function tickCustomAnim() {
  const anim = activeCustomAnim
  if (!anim) return
  const elapsed = clock - anim.startedAt
  const dur = anim.spec.duration
  const done = elapsed >= dur
  lastActivityAt = clock

  if (anim.spec.kind !== 'expression') {
    const f = sampleKeyframes(anim.spec.bodyKeyframes, Math.min(elapsed, dur))
    if (f) applyBodyFrame(f)
  }
  if (anim.spec.kind !== 'body') {
    const f = sampleKeyframes(anim.spec.expressionKeyframes, Math.min(elapsed, dur))
    if (f) applyExpressionFrame(f)
  }

  if (done) finishCustomAnim(anim.spec.id)
}

const YAW_DRAG_MAX = 24
const PITCH_DRAG_MAX = 18

let dragVx = 0
let dragVy = 0
let smoothDragVx = 0
let smoothDragVy = 0
let dragInertiaT = 0

/* -------------------------------------------------------------- blick */

function ballGeometry(): { cx: number; cy: number; r: number } | null {
  const box = hostSvg.getBoundingClientRect()
  if (!box || box.width === 0 || box.height === 0) return null
  return {
    cx: box.left + box.width / 2,
    cy: box.top + box.height / 2,
    r: (100 / (DEMI_VIEWBOX * 2)) * box.width
  }
}

/* ------------------------------------------------------- monitor-id tag */

let dispTag: HTMLDivElement | null = null

function ensureDisplayTag(): HTMLDivElement {
  if (!dispTag) {
    dispTag = document.createElement('div')
    dispTag.className = 'display-tag hidden'
    document.getElementById('stage')!.appendChild(dispTag)
  }
  return dispTag
}

/**
 * Kleine Monitor-ID ("1/2") direkt am Cursor bzw. — wenn der Cursor auf dem
 * ANDEREN Monitor ist — geklemmt am Fensterrand in Richtung des Cursors.
 * So ist immer sichtbar, auf welchem Screen der globale Cursor gerade liegt.
 */
function tickDisplayTag(
  g: (GlobalCursorInfo & { at: number }) | null,
  show: boolean,
  lookPt: { x: number; y: number } | null
) {
  if (!g || !show || !lookPt) {
    dispTag?.classList.add('hidden')
    return
  }
  const tag = ensureDisplayTag()
  tag.textContent = g.displayCount > 1 ? `${g.display}/${g.displayCount}` : String(g.display)
  const stageRect = document.getElementById('stage')!.getBoundingClientRect()
  const pad = 12
  // Am Cursor kleben, aber sicher innerhalb des eigenen Fensters halten:
  // ist der Cursor auf dem anderen Monitor, wandert das Tag an den Rand.
  const tx = clamp(lookPt.x - stageRect.left + 16, pad, stageRect.width - pad)
  const ty = clamp(lookPt.y - stageRect.top - 20, pad, stageRect.height - pad)
  tag.style.left = `${tx}px`
  tag.style.top = `${ty}px`
  tag.classList.remove('hidden')
}

function tickGaze(dt: number) {
  // Waehrend einer Custom-Expression-Animation steuert die Animation das
  // Gesicht — der Cursor-Suchlauf darf nicht dazwischenfunken.
  if (isExpressionCustomAnim()) {
    tickDisplayTag(null, false, null)
    return
  }

  const geo = ballGeometry()
  const def = STATE_BY_ID.get(engine.state)

  if (dragging) {
    tickDisplayTag(null, false, null)
    // Schnelle Ansprache bei Drag
    const blendRate = 1 - Math.exp(-dt * 24)
    smoothDragVx += (dragVx - smoothDragVx) * blendRate
    smoothDragVy += (dragVy - smoothDragVy) * blendRate
    dragInertiaT = clamp(dragInertiaT + dt / 0.1)

    // Traegheit / G-Kraft: Augen driften entgegengesetzt zur Bewegung
    // Rechts gezogen (vx > 0) -> Augen nach links (yaw < 0)
    // Links gezogen (vx < 0) -> Augen nach rechts (yaw > 0)
    // Nach oben gezogen (vy < 0) -> Augen nach unten (pitch < 0)
    // Nach unten gezogen (vy > 0) -> Augen nach oben (pitch > 0)
    const normVx = clamp(smoothDragVx / 650, -1, 1)
    const normVy = clamp(smoothDragVy / 650, -1, 1)

    const yaw = -normVx * YAW_DRAG_MAX
    // Beim Ziehen nach rechts schaut er nach links oben (PITCH + Up-Bias)
    const pitch = PITCH + 8 * Math.abs(normVx) + normVy * PITCH_DRAG_MAX

    engine.setLook(
      {
        yaw,
        pitch,
        mix: dragInertiaT,
        spin: 0,
        wander: 0
      },
      clock,
      0.03
    )
    aiming = true
    return
  }

  // Wenn Drag gerade beendet wurde: Traegheit geschmeidig abbauen
  if (dragInertiaT > 0.001) {
    tickDisplayTag(null, false, null)
    smoothDragVx *= Math.exp(-dt * 16)
    smoothDragVy *= Math.exp(-dt * 16)
    dragInertiaT = clamp(dragInertiaT - dt / 0.25)

    const normVx = clamp(smoothDragVx / 650, -1, 1)
    const normVy = clamp(smoothDragVy / 650, -1, 1)
    const yaw = -normVx * YAW_DRAG_MAX
    const pitch = PITCH + 8 * Math.abs(normVx) + normVy * PITCH_DRAG_MAX

    engine.setLook(
      {
        yaw,
        pitch,
        mix: dragInertiaT,
        spin: 0,
        wander: 0
      },
      clock,
      0.06
    )
    aiming = true
    return
  }

  // Normales Blick-Tracking auf Cursor (mit Grace-Period nach Drag).
  // Blickziel: bevorzugt der GLOBALE Cursor (vom Main gepollt, gilt auf allen
  // Monitoren — Koordinaten fensterrelativ, also auch <0 oder >620). Nur wenn
  // der globaler Cursor nicht frisch ist, faellt er auf den DOM-Zeiger
  // zurueck, der ausschliesslich das eigene Fenster sieht.
  const inGracePeriod = clock < dragGraceUntil
  const nowMs = performance.now()
  const gFresh = globalCursor && nowMs - globalCursor.at < GLOBAL_CURSOR_FRESH_MS ? globalCursor : null
  const lookPt = gFresh ?? pointer
  const pointerIsRecent =
    nowMs - Math.max(lastPointerMoveTime, gFresh?.at ?? 0) < 3500
  const canAim = !dragging && !inGracePeriod && !!geo && !!lookPt && (def?.baseFace ?? false)
  let active = false
  let nx = 0
  let ny = 0
  if (canAim && geo && lookPt) {
    nx = clamp((lookPt.x - geo.cx) / Math.max(1, window.innerWidth / 2), -1, 1)
    ny = clamp((lookPt.y - geo.cy) / Math.max(1, window.innerHeight / 2), -1, 1)
    const dist = Math.hypot(lookPt.x - geo.cx, lookPt.y - geo.cy)
    // Mit globalem Cursor ist die Aufmerksamkeits-Reichweite der ganze
    // virtuelle Desktop (beide Screens "zusammengefuert"); ohne ihn (alter
    // Fallback) gilt wie bisher die enge Radius-Regel des eigenen Fensters.
    const nearEnough = gFresh ? true : dist <= Math.max(geo.r * 4.5, 340)
    active = (nearEnough && pointerIsRecent) || settingsOpen
  }

  hoverT = clamp(hoverT + (active ? dt / 0.5 : -dt / 0.9))

  if (active || dragging || settingsOpen || isAiThinking || isAiStreaming) {
    lastActivityAt = clock
  }

  tickDisplayTag(gFresh, hoverT > 0.05, lookPt)

  if (hoverT > 0.001) {
    engine.setLook(
      {
        yaw: nx * YAW_MAX,
        pitch: PITCH - ny * PITCH_MAX,
        mix: hoverT,
        spin: 0,
        wander: active ? 0 : 1
      },
      clock
    )
    aiming = true
  } else if (aiming) {
    engine.setLook(null, clock, 0.9)
    aiming = false
  }
}

/* --------------------------------------------------------- durchgriff */

function rectsContain(el: Element, x: number, y: number, pad = 6): boolean {
  const r = el.getBoundingClientRect()
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
}

function updateIgnore(overUi: boolean) {
  const geo = ballGeometry()
  let overBall = false
  if (geo && pointer) {
    overBall = Math.hypot(pointer.x - geo.cx, pointer.y - geo.cy) <= geo.r + 18
  }
  const overEdit = !!pointer && rectsContain(editBtn, pointer.x, pointer.y)
  const chatDockEl = document.getElementById('chat-dock')
  const overChat = !!pointer && chatDockEl && !chatDockEl.classList.contains('hidden') && rectsContain(chatDockEl, pointer.x, pointer.y)
  const petMenuEl = document.getElementById('pet-menu')
  const overMenu = !!pointer && petMenuEl && !petMenuEl.classList.contains('hidden') && rectsContain(petMenuEl, pointer.x, pointer.y)
  const shouldIgnore = !(overUi || overBall || overEdit || overChat || overMenu || dragging)
  if (shouldIgnore !== ignoring) {
    ignoring = shouldIgnore
    bridge.setIgnore(shouldIgnore)
  }
}

/* ---------------------------------------------------------- interaktion */

hostSvg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const geo = ballGeometry()
  if (!geo) return
  if (Math.hypot(e.clientX - geo.cx, e.clientY - geo.cy) > geo.r + 14) return
  try {
    hostSvg.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  dragging = true
  dragMovedTotal = 0
  lastDragScreen = { x: e.screenX, y: e.screenY }
  lastMoveTime = performance.now()
  lastPointerMoveTime = performance.now()
  dragVx = 0
  dragVy = 0
  smoothDragVx = 0
  smoothDragVy = 0
  dragInertiaT = 0
  hostSvg.classList.add('dragging')
  lastInteraction = clock
  lastActivityAt = clock
  if (engine.state === 'sleep') playOnce('wake')
  updateIgnore(false)
})

window.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY }
  pointerAt = performance.now()
  lastPointerMoveTime = performance.now()
  lastActivityAt = clock
  if (engine.state === 'sleep') playOnce('wake')
  const target = e.target as Element | null
  const overUi = !!target?.closest?.('.ui')

  if (dragging && lastDragScreen) {
    const dx = e.screenX - lastDragScreen.x
    const dy = e.screenY - lastDragScreen.y
    const now = performance.now()
    const dt = Math.max(0.001, (now - lastMoveTime) / 1000)
    lastMoveTime = now

    if (dx !== 0 || dy !== 0) {
      bridge.moveBy(dx, dy)
      dragMovedTotal += Math.hypot(dx, dy)
      lastDragScreen = { x: e.screenX, y: e.screenY }

      const instVx = dx / dt
      const instVy = dy / dt
      const blend = Math.min(1, dt * 25)
      smoothDragVx += (instVx - smoothDragVx) * blend
      smoothDragVy += (instVy - smoothDragVy) * blend
    }
  }

  updateIgnore(overUi)
})

window.addEventListener(
  'pointerup',
  (e) => {
    if (!dragging) return
    try {
      hostSvg.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    dragging = false
    dragGraceUntil = clock + 1.65
    bridge.dragEnd?.()
    hostSvg.classList.remove('dragging')
    lastInteraction = clock
    updateIgnore(false)
    // Nur bei einem wirklich heftigen Schleudern benommen werden: hohe
    // Wildness (Speed deutlich ueber der Scared-Schwelle) UND eine
    // nennenswerte Distanz — kleine Zupfer oder kurze Verschiebungen
    // loesen nichts.
    if (wildness > 0.85 && dragMovedTotal > 150) {
      playOnce('dizzy')
    }
  },
  true
)

// Klick (ohne Drag): Reaktion. Doppelklick: Zerplatzen UND Chat-Summon
// (Fallback neben dem globalen Hotkey).
hostSvg.addEventListener('click', (e) => {
  if (dragMovedTotal > 8) return
  const detail = (e as MouseEvent).detail
  lastInteraction = clock
  if (detail >= 2) {
    playOnce('burst')
    bridge.toggleChat?.()
  } else {
    playOnce(CLICK_REACTIONS[Math.floor(Math.random() * CLICK_REACTIONS.length)]!)
  }
})

/* ------------------------------------------------- drop target (fuettern) */

// Strays abfangen, damit Electron nie navigiert — der Ball ist das einzige
// echte Drop-Ziel (der Rest des Fensters ist Click-through).
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

let dragOverActive = false

/** Vortex (absorb) fuer Dragover: einmalig starten, laeuft dann stabil in Rotation. */
function tickDragVortex() {
  if (!dragOverActive) return
  if (engine.state !== 'absorb') {
    playOnce('absorb')
  }
  // Der absorb-State laeuft jetzt selbst: Phase 1 (Aufbau) -> Phase 2 (stabile Rotation,
  // Koerper ausgeblendet). Nie neu starten — der state bleibt, bis dragleave oder drop.
}

hostSvg.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.stopPropagation()
  pointer = { x: e.clientX, y: e.clientY }
  hoverT = Math.max(hoverT, 0.6)
  lastActivityAt = clock
  if (!dragOverActive) {
    dragOverActive = true
    playOnce('absorb')
  }
})

hostSvg.addEventListener('dragleave', () => {
  if (!dragOverActive) return
  dragOverActive = false
  // null zwingt updateDragExpression, die konfigurierte Expression zurueckzuholen
  activeExprId = null
  if (engine.state === 'absorb') playOnce('idle')
})

hostSvg.addEventListener('drop', (e) => {
  e.preventDefault()
  e.stopPropagation()
  dragOverActive = false
  activeExprId = null
  // Finaler Schluck: absorb von vorn starten (Phase 1 sichtbar, dann ausgeblendet)
  if (engine.state === 'absorb') {
    engine.reset('absorb', clock)
    busyUntil = clock + 1.2
  }
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files
    .map((f) => bridge.pathForFile?.(f))
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (paths.length > 0) void bridge.attachPaths?.(paths)
})

/* ------------------------------------------------- context menu */

function showPetMenu(clientX: number, clientY: number) {
  const stage = document.getElementById('stage')!
  const stageRect = stage.getBoundingClientRect()
  const menuWidth = 145
  const menuHeight = 120

  // Gewuenschte Stage-relative Position aus der Cursorposition
  const rawLeft = clientX - stageRect.left
  const rawTop = clientY - stageRect.top

  // Menue immer sicher innerhalb des 620x620 Stage-Containers halten (funktioniert auf jedem Monitor)
  const left = clamp(rawLeft, 8, Math.max(8, (stageRect.width || 620) - menuWidth - 8))
  const top = clamp(rawTop, 8, Math.max(8, (stageRect.height || 620) - menuHeight - 8))

  petMenu.style.left = `${left}px`
  petMenu.style.top = `${top}px`
  petMenu.classList.remove('hidden')
  updateIgnore(true)
}

function hidePetMenu() {
  if (!petMenu.classList.contains('hidden')) {
    petMenu.classList.add('hidden')
    updateIgnore(false)
  }
}

hostSvg.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  e.stopPropagation()
  lastInteraction = clock
  lastActivityAt = clock
  if (engine.state === 'sleep') playOnce('wake')
  showPetMenu(e.clientX, e.clientY)
})

menuChatBtn?.addEventListener('click', (e) => {
  e.stopPropagation()
  hidePetMenu()
  // IMMER oeffnen (nie togglen): nach dem Senden ist der Dock zwar sichtbar,
  // aber der Input eingeklappt — ein Toggle wuerde dann erst verstecken.
  bridge.showChat?.()
})

menuSettingsBtn?.addEventListener('click', (e) => {
  e.stopPropagation()
  hidePetMenu()
  bridge.toggleSettings()
})

menuQuitBtn?.addEventListener('click', (e) => {
  e.stopPropagation()
  hidePetMenu()
  closePet()
})

document.addEventListener('pointerdown', (e) => {
  if (!petMenu.classList.contains('hidden') && !petMenu.contains(e.target as Node)) {
    hidePetMenu()
  }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hidePetMenu()
})

document.addEventListener('contextmenu', (e) => {
  if (!(e.target as Element).closest?.('.ui')) e.preventDefault()
})

function scheduleNextEvent(min = 7, max = 16) {
  nextEventAt = clock + min + Math.random() * (max - min)
}

/* -------------------------------------------------- settings & config */

editBtn.addEventListener('click', () => {
  lastActivityAt = clock
  if (engine.state === 'sleep') playOnce('wake')
  bridge.toggleSettings()
  playOnce('swirl')
})

bridge.onSettingsVisible((visible) => {
  settingsOpen = visible
  document.body.classList.toggle('settings-open', visible)
  if (visible) {
    lastActivityAt = clock
    if (engine.state === 'sleep') playOnce('wake')
  } else {
    updateIgnore(false)
  }
})

bridge.onConfigChanged((fresh) => {
  config = fresh
  applyConfig()
  if (config.eventsEnabled) scheduleNextEvent(3, 8)
})

// Ein-Shots aus dem Main-Prozess (absorb beim Drop, wink nach der Antwort, Bot-Tools)
bridge.onPlayState?.((id, duration) => playOnce(id, duration))

// Animations-Lock: haelt den Zustand, bis die Aktion (z. B. Zeichnen) fertig ist.
bridge.onAnimationHold?.((hold) => setAnimHold(hold))

// Custom-Animationen aus dem Bot-Tool pet_custom_animate
bridge.onCustomAnim?.((spec) => startCustomAnim(spec))

// Globaler Cursor (alle Monitore): Blickquelle Nr. 1. Bewegung irgendwo auf
// dem Desktop zaehlt als Aktivitaet und weckt ihn auf.
bridge.onGlobalCursor?.((p) => {
  globalCursor = { ...p, at: performance.now() }
  lastPointerMoveTime = performance.now()
  if (engine) lastActivityAt = clock
  if (!dragging && engine?.state === 'sleep') playOnce('wake')
})

// Chat-Dock direkt unter dem Ball mounten (gleiches Fenster wie der Bloub)
mountChat(chatDock, {
  onThinkingStart: () => {
    lastActivityAt = clock
    isAiThinking = true
    isAiStreaming = false
    engine.setState('thinking', clock)
  },
  onStreamingStart: () => {
    lastActivityAt = clock
    if (isAiThinking) {
      isAiThinking = false
      isAiStreaming = true
      engine.setState('talk', clock)
      busyUntil = clock + 60
    }
  },
  onTurnEnd: (success: boolean) => {
    lastActivityAt = clock
    isAiThinking = false
    isAiStreaming = false
    if (success) playOnce('wink')
    else engine.setState('idle', clock)
  },
  onReact: (kind) => {
    // Gesichts-Reaktion aus dem Text ("aha" / "oh nein") — haelt den
    // Streaming-Zustand intakt; der tick kehrt danach zum Reden zurueck.
    lastActivityAt = clock
    playReaction(kind === 'ohno' ? 'ohno' : 'aha')
  }
})

function updateDragExpression(dt: number) {
  if (!config || isAiThinking) return
  // Waehrend einer Custom-Expression-Animation ist die Engine schon vom
  // Animations-Player gesteuert — nicht mit der Konfig-Expression ueberschreiben.
  if (isExpressionCustomAnim()) return
  // Waehrend des Dragover-Vortex nicht die Expression umschalten
  if (dragOverActive) return
  let targetExpr: BotExpression | null = null
  let targetKey = ''

  const inactiveDuration = clock - lastActivityAt

  if (dragging) {
    const speed = Math.hypot(smoothDragVx, smoothDragVy)
    // Bei normaler Bewegung: excited (excite). Bei schnellem/wildem Schleudern: scared (effraye)
    const targetWild = speed > 550 ? 1 : 0
    wildness = clamp(wildness + (targetWild ? dt / 0.1 : -dt / 0.25))

    if (wildness > 0.35) {
      targetExpr = EXPRESSION_BY_ID.get('effraye') ?? null
      targetKey = 'effraye'
    } else {
      targetExpr = EXPRESSION_BY_ID.get('excite') ?? null
      targetKey = 'excite'
    }
  } else if (inactiveDuration >= TIME_TO_SLEEPY && engine.state !== 'sleep') {
    // Untouched & untracked -> sleepy eyes!
    wildness = 0
    targetExpr = EXPRESSION_BY_ID.get('somnolent') ?? null
    targetKey = 'somnolent'
  } else {
    wildness = 0
    targetExpr = EXPRESSION_BY_ID.get(config.expression) ?? null
    targetKey = config.expression
  }

  if (targetKey !== activeExprId) {
    activeExprId = targetKey
    engine.setExpression(targetExpr, clock)
  }
}

/* ---------------------------------------------------------------- loop */

let raf = 0
let lastMs = 0

function tick(ms: number) {
  raf = requestAnimationFrame(tick)
  const dt = lastMs ? Math.min((ms - lastMs) / 1000, 0.064) : 0
  lastMs = ms
  clock += dt

  if (!dragging) {
    dragVx = 0
    dragVy = 0
  }

  const inactiveDuration = clock - lastActivityAt

  if (animHold) {
    // Lock aktiv: Zustand festhalten, nichts ueberschreiben (Alert beim Zeichnen etc.)
    // tickCustomAnim() laeuft weiter unten ohnehin an.
  } else if (dragOverActive) {
    // Vortex laeuft solange, bis Drop oder Drag-Leave — kein Sleep, kein Idle
    tickDragVortex()
  } else if (isAiThinking) {
    if (engine.state !== 'thinking') {
      engine.setState('thinking', clock)
    }
  } else if (isAiStreaming && engine.state !== 'talk' && clock >= busyUntil) {
    // Nach einer Reaktion (aha/ohno) mitten im Stream zurueck zum Reden
    engine.setState('talk', clock)
  } else if (!isAiStreaming && !dragging && !settingsOpen && inactiveDuration >= TIME_TO_SLEEP) {
    // Deep sleep state with floating rotating Zs
    if (engine.state !== 'sleep') {
      engine.setState('sleep', clock)
    }
  } else if (!isAiStreaming && engine.state !== 'idle' && engine.state !== 'sleep' && clock >= busyUntil) {
    engine.setState('idle', clock)
  }

  if (
    config.eventsEnabled &&
    !settingsOpen &&
    !dragging &&
    !dragOverActive &&
    !isAiThinking &&
    !isAiStreaming &&
    inactiveDuration < TIME_TO_SLEEPY &&
    Number.isFinite(nextEventAt) &&
    clock >= nextEventAt &&
    engine.state === 'idle' &&
    clock - lastInteraction > 3
  ) {
    playRandomIdle()
    scheduleNextEvent()
  }

  updateDragExpression(dt)
  tickGaze(dt)
  tickCustomAnim()
  bot.update(engine.sample(clock), ink())
}

let isExiting = false

function closePet() {
  if (isExiting) return
  isExiting = true
  // Laufende Custom-Animation sauber beenden (Body-Transform zuruecksetzen)
  if (activeCustomAnim) finishCustomAnim(activeCustomAnim.spec.id)
  // Chat-Dock mit Ausblend-Animation schliessen, falls sichtbar
  if (!chatDock.classList.contains('hidden')) {
    chatDock.classList.add('closing')
  }
  hidePetMenu()
  ballWrap.classList.remove('spawn-in')
  ballWrap.classList.add('despawn-out')
  playOnce('burst')
  setTimeout(() => {
    bridge.confirmQuit?.()
  }, 480)
}

bridge.onQuitRequested?.(() => closePet())

/* ---------------------------------------------------------------- init */

async function init() {
  config = await bridge.getConfig()

  engine = new BotEngine(RAYON, 'idle', null, null)

  bot = makeBotSvg()
  hostSvg.setAttribute('viewBox', bot.svg.getAttribute('viewBox')!)
  while (bot.svg.firstChild) hostSvg.appendChild(bot.svg.firstChild)

  applyConfig()
  scheduleNextEvent(4, 9)

  ballWrap.classList.add('spawn-in')
  playOnce('wink')

  bot.update(engine.sample(0), ink())
  raf = requestAnimationFrame(tick)

  // Debug-Hook (CDP/Selbstkontrolle): Zustaende und Anims von aussen erzwingen.
  ;(window as unknown as Record<string, unknown>).__bloubDebug = {
    play: playOnce,
    state: () => engine.state
  }
}

void init()
