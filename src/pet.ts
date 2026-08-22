import { STATE_BY_ID, type StateId } from '../vendor/bot/states'
import { EXPRESSION_BY_ID, type BotExpression } from '../vendor/bot/expressions'
import { SHAPE_BY_ID, COLOR_BY_ID } from '../vendor/bot/skins'
import { RAYON, DEMI_VIEWBOX } from '../vendor/bot/repere'
import { clamp } from '../vendor/bot/math'
import { YAW_MAX, PITCH_MAX, PITCH, SPIN } from '../vendor/ui/gaze'
import { getBridge, makeBotSvg, type PetConfig } from './shared'
import { BotEngine } from '../vendor/bot/engine'

const bridge = getBridge()

const ballWrap = document.getElementById('ball-wrap')!
const hostSvg = document.getElementById('bot') as unknown as SVGSVGElement
const editBtn = document.getElementById('edit') as HTMLButtonElement

let config: PetConfig
let engine: BotEngine
let bot: ReturnType<typeof makeBotSvg>

let clock = 0
let busyUntil = 0
let nextEventAt = Infinity
let lastInteraction = -10
let dragging = false
let dragMovedTotal = 0
let lastDragScreen: { x: number; y: number } | null = null
let pointer: { x: number; y: number } | null = null
let aiming = false
let hoverT = 0
let settingsOpen = false
let ignoring = false
let dragGraceUntil = 0

let activeExprId: string | null = null
let wildness = 0

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

function playOnce(id: StateId) {
  const def = STATE_BY_ID.get(id)
  if (!def) return
  engine.setState(id, clock)
  const hold = Math.max(def.duration ?? 2.4, def.minDuration ?? 0)
  busyUntil = clock + hold + 0.15
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
  ['alert', 0.8]
]

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

function tickGaze(dt: number) {
  const geo = ballGeometry()
  const def = STATE_BY_ID.get(engine.state)

  if (dragging) {
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

  // Normales Blick-Tracking auf Cursor (mit Grace-Period nach Drag)
  const inGracePeriod = clock < dragGraceUntil
  const canAim = !dragging && !inGracePeriod && !!geo && !!pointer && (def?.baseFace ?? false)
  let active = false
  let nx = 0
  let ny = 0
  if (canAim && geo && pointer) {
    nx = clamp((pointer.x - geo.cx) / Math.max(1, window.innerWidth / 2), -1, 1)
    ny = clamp((pointer.y - geo.cy) / Math.max(1, window.innerHeight / 2), -1, 1)
    const dist = Math.hypot(pointer.x - geo.cx, pointer.y - geo.cy)
    active = dist <= Math.max(geo.r * 4.5, 340) || settingsOpen
  }

  hoverT = clamp(hoverT + (active ? dt / 0.5 : -dt / 0.9))

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
  const shouldIgnore = !(overUi || overBall || overEdit || dragging)
  if (shouldIgnore !== ignoring) {
    ignoring = shouldIgnore
    bridge.setIgnore(shouldIgnore)
  }
}

let lastMoveTime = 0

/* ---------------------------------------------------------- interaktion */

hostSvg.addEventListener('pointerdown', (e) => {
  const geo = ballGeometry()
  if (!geo) return
  if (Math.hypot(e.clientX - geo.cx, e.clientY - geo.cy) > geo.r + 10) return
  try {
    hostSvg.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  dragging = true
  dragMovedTotal = 0
  lastDragScreen = { x: e.screenX, y: e.screenY }
  lastMoveTime = performance.now()
  dragVx = 0
  dragVy = 0
  smoothDragVx = 0
  smoothDragVy = 0
  dragInertiaT = 0
  hostSvg.classList.add('dragging')
  lastInteraction = clock
  updateIgnore(false)
})

window.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY }
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
  },
  true
)

// Klick (ohne Drag): Reaktion. Doppelklick: Zerplatzen.
hostSvg.addEventListener('click', (e) => {
  if (dragMovedTotal > 8) return
  const detail = (e as MouseEvent).detail
  lastInteraction = clock
  if (detail >= 2) playOnce('burst')
  else playOnce(CLICK_REACTIONS[Math.floor(Math.random() * CLICK_REACTIONS.length)]!)
})

document.addEventListener('contextmenu', (e) => {
  if (!(e.target as Element).closest?.('.ui')) e.preventDefault()
})

function scheduleNextEvent(min = 7, max = 16) {
  nextEventAt = clock + min + Math.random() * (max - min)
}

/* -------------------------------------------------- settings & config */

editBtn.addEventListener('click', () => {
  bridge.toggleSettings()
  playOnce('swirl')
})

bridge.onSettingsVisible((visible) => {
  settingsOpen = visible
  document.body.classList.toggle('settings-open', visible)
  if (!visible) updateIgnore(false)
})

bridge.onConfigChanged((fresh) => {
  config = fresh
  applyConfig()
  if (config.eventsEnabled) scheduleNextEvent(3, 8)
})

function updateDragExpression(dt: number) {
  if (!config) return
  let targetExpr: BotExpression | null = null
  let targetKey = ''

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

  if (engine.state !== 'idle' && clock >= busyUntil) {
    engine.setState('idle', clock)
  }

  if (
    config.eventsEnabled &&
    !settingsOpen &&
    !dragging &&
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
  bot.update(engine.sample(clock), ink())
}

let isExiting = false

bridge.onQuitRequested?.(() => {
  if (isExiting) return
  isExiting = true
  ballWrap.classList.remove('spawn-in')
  ballWrap.classList.add('despawn-out')
  playOnce('burst')
  setTimeout(() => {
    bridge.confirmQuit?.()
  }, 440)
})

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
}

void init()
