import { BotEngine, type Look } from '../vendor/bot/engine'
import { EXPRESSION_BY_ID, DEFAULT_EXPRESSION } from '../vendor/bot/expressions'
import { SHAPES, COLORS, SHAPE_BY_ID, COLOR_BY_ID } from '../vendor/bot/skins'
import { STATE_BY_ID, type StateId } from '../vendor/bot/states'
import { RAYON } from '../vendor/bot/repere'
import { clamp, r2 } from '../vendor/bot/math'
import { YAW_MAX, PITCH_MAX, PITCH } from '../vendor/ui/gaze'
import { makeBotSvg, SVG_NS, SHAPE_LABELS, COLOR_LABELS } from '../src/shared'
import { fetchRelease, isRelease, releaseView, type Release, type ReleaseState } from './release'

/* Startwerte; squircle + bleu entsprechen dem App-Icon. */
const START_SHAPE = 'squircle'
const START_COLOR = 'bleu'
const FOLLOW_CURSOR = true

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

const byId = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T

/* ------------------------------------------------------------ avatare */

/**
 * Drei Instanzen der echten Engine (Hero, Desktop-Buehne, Customize). Jede hat
 * ihren eigenen Blick, Form und Farbe teilen sie sich.
 */
interface Avatar {
  host: SVGSVGElement
  group: SVGGElement
  engine: BotEngine
  bot: ReturnType<typeof makeBotSvg>
  hoverT: number
  look: 'aim' | 'still' | 'free'
}

let shapeId = START_SHAPE
let colorId = START_COLOR
let clock = 0
let lastMs = 0
let bounceAt = -10
let pointer: { x: number; y: number } | null = null
let lastPointerMove = -Infinity

const radiiOf = (id: string) => SHAPE_BY_ID.get(id)?.radii ?? null

function mountAvatar(host: SVGSVGElement): Avatar {
  const engine = new BotEngine(RAYON, 'idle', radiiOf(shapeId), EXPRESSION_BY_ID.get(DEFAULT_EXPRESSION) ?? null)
  const bot = makeBotSvg()
  // Wie pet.ts: Inhalt in das vorhandene SVG umhaengen. Die Gruppe traegt den Bounce.
  const group = document.createElementNS(SVG_NS, 'g')
  while (bot.svg.firstChild) group.appendChild(bot.svg.firstChild)
  host.appendChild(group)
  return { host, group, engine, bot, hoverT: 0, look: 'free' }
}

const hero = mountAvatar(byId('hero-bot').querySelector('svg')!)
const desk = mountAvatar(byId<SVGSVGElement>('desk-bot'))
const studio = mountAvatar(byId<SVGSVGElement>('studio-bot'))
const avatars = [hero, desk, studio]

/** Ohne Bewegung: Blick der Pose, keine Drift. */
const STILL: Look = { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 0 }

/** Blickregel aus pet.ts (tickGaze), auf den Viewport statt aufs Pet-Fenster bezogen. */
function aim(a: Avatar, rect: DOMRect, dt: number, recent: boolean) {
  const def = STATE_BY_ID.get(a.engine.state)
  let nx = 0
  let ny = 0
  if (pointer) {
    nx = clamp((pointer.x - (rect.left + rect.width / 2)) / Math.max(1, window.innerWidth / 2), -1, 1)
    ny = clamp((pointer.y - (rect.top + rect.height / 2)) / Math.max(1, window.innerHeight / 2), -1, 1)
  }
  const active = FOLLOW_CURSOR && !!pointer && recent && (def?.baseFace ?? false)
  a.hoverT = clamp(a.hoverT + (active ? dt / 0.5 : -dt / 0.9))

  if (a.hoverT > 0.001) {
    const wander = active || reducedMotion.matches ? 0 : 1
    a.engine.setLook({ yaw: nx * YAW_MAX, pitch: PITCH - ny * PITCH_MAX, mix: a.hoverT, spin: 0, wander }, clock)
    a.look = 'aim'
    return
  }
  const rest = reducedMotion.matches ? 'still' : 'free'
  if (a.look !== rest) {
    a.engine.setLook(rest === 'still' ? STILL : null, clock, 0.9)
    a.look = rest
  }
}

/** Huepfer aus dem Handoff: b = sin(14t)·e^(−4.5t)·0.14, unten bleibt am Boden. */
function bounceTransform(t: number): string {
  if (reducedMotion.matches || t < 0 || t >= 1.2) return ''
  const b = Math.sin(t * 14) * Math.exp(-t * 4.5) * 0.14
  const sy = 1 - b
  const sx = 1 + b * 0.7
  return `translate(0 ${r2((1 - sy) * RAYON)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)})`
}

function tick(ms: number) {
  requestAnimationFrame(tick)
  const dt = lastMs ? Math.min((ms - lastMs) / 1000, 0.064) : 0
  lastMs = ms
  clock += dt

  const ink = COLOR_BY_ID.get(colorId)?.hex ?? '#3b93f0'
  const squash = bounceTransform(clock - bounceAt)
  const recent = performance.now() - lastPointerMove < 3500

  for (const a of avatars) {
    const rect = a.host.getBoundingClientRect()
    // ausserhalb des Viewports nichts zeichnen (und kein 0/0 in den Blick)
    if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) continue
    aim(a, rect, dt, recent)
    if (squash) a.group.setAttribute('transform', squash)
    else a.group.removeAttribute('transform')
    a.bot.update(a.engine.sample(clock), ink)
  }
}

window.addEventListener(
  'pointermove',
  (e) => {
    pointer = { x: e.clientX, y: e.clientY }
    lastPointerMove = performance.now()
  },
  { passive: true }
)

byId('hero-bot').addEventListener('click', () => {
  bounceAt = clock
})

/* ---------------------------------------------------------- customize */

const shapeList = byId('shape-list')
const colorList = byId('color-list')

function syncPickers() {
  for (const btn of shapeList.querySelectorAll<HTMLButtonElement>('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.id === shapeId))
  }
  for (const btn of colorList.querySelectorAll<HTMLButtonElement>('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.id === colorId))
  }
  byId('shape-label').textContent = SHAPE_LABELS[shapeId] ?? shapeId
  byId('color-label').textContent = COLOR_LABELS[colorId] ?? colorId
}

function pickShape(id: string) {
  shapeId = id
  for (const a of avatars) a.engine.setShape(radiiOf(id), clock)
  bounceAt = clock
  syncPickers()
}

function pickColor(id: string) {
  colorId = id
  syncPickers()
}

for (const shape of SHAPES) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'shape-btn'
  btn.dataset.id = shape.id
  btn.textContent = SHAPE_LABELS[shape.id] ?? shape.id
  btn.addEventListener('click', () => pickShape(shape.id))
  shapeList.append(btn)
}

for (const color of COLORS) {
  const label = COLOR_LABELS[color.id] ?? color.id
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'swatch'
  btn.dataset.id = color.id
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.style.background = color.hex
  btn.addEventListener('click', () => pickColor(color.id))
  colorList.append(btn)
}

// Anzahl direkt aus skins.ts, damit die Ueberschrift nie veraltet
for (const el of document.querySelectorAll<HTMLElement>('[data-count="shapes"]')) el.textContent = String(SHAPES.length)
for (const el of document.querySelectorAll<HTMLElement>('[data-count="colors"]')) el.textContent = String(COLORS.length)

syncPickers()

/* -------------------------------------------------------------- tools */

const toolRows = [...byId('tool-list').querySelectorAll<HTMLButtonElement>('[role="switch"]')]

function syncToolCount() {
  const on = toolRows.filter((row) => row.getAttribute('aria-checked') === 'true').length
  byId('tool-count').textContent = `${on} of ${toolRows.length} tools enabled — tap to toggle`
}

for (const row of toolRows) {
  row.addEventListener('click', () => {
    row.setAttribute('aria-checked', String(row.getAttribute('aria-checked') !== 'true'))
    syncToolCount()
  })
}
syncToolCount()

/* --------------------------------------------------------- dock demo */

const DESK: Array<[string, string]> = [
  ['Rename these screenshots by date?', 'Done — 23 files renamed to YYYY-MM-DD. Want me to sort them into folders too?'],
  ['What did I name the API test file?', 'It’s api/tests/smoke.test.ts — last edited this morning.'],
  ['Remind me what Ctrl+K does here', 'It opens the chat list. Ctrl+N starts a new chat.']
]

const deskPrompt = byId('desk-prompt')
const deskReply = byId('desk-reply')
const deskThinking = byId('desk-thinking')

function deskState(id: StateId) {
  desk.engine.setState(id, clock)
}

/**
 * Wie im Pet: denken -> 'thinking', Antwort streamt -> 'talk', danach 'idle'.
 * Bei reduzierter Bewegung steht die Demo still (fertige Antwort, 'idle') und
 * laeuft erst weiter, wenn die Einstellung wieder aus ist.
 */
function runDesk(i: number) {
  const [prompt, reply] = DESK[i % DESK.length]!
  deskPrompt.textContent = prompt
  if (reducedMotion.matches) {
    deskReply.textContent = reply
    deskThinking.hidden = true
    deskState('idle')
    reducedMotion.addEventListener('change', () => runDesk(i + 1), { once: true })
    return
  }
  deskReply.textContent = ''
  deskThinking.hidden = false
  deskState('thinking')
  window.setTimeout(() => {
    deskThinking.hidden = true
    deskState('talk')
    let n = 0
    const step = () => {
      n += 2
      deskReply.textContent = reply.slice(0, n)
      if (n < reply.length) {
        window.setTimeout(step, 28)
      } else {
        deskState('idle')
        window.setTimeout(() => runDesk(i + 1), 3200)
      }
    }
    step()
  }, 1100)
}

/* ------------------------------------------------------------ release */

const CACHE_KEY = 'bloub-landing-release'
const CACHE_TTL = 10 * 60 * 1000

function applyReleaseToDom(state: ReleaseState) {
  const view = releaseView(state)
  for (const el of document.querySelectorAll<HTMLElement>('[data-release-text]')) {
    const value = view.text[el.dataset.releaseText as keyof typeof view.text]
    if (value !== undefined) el.textContent = value
  }
  for (const el of document.querySelectorAll<HTMLAnchorElement>('[data-release-href]')) {
    const value = view.href[el.dataset.releaseHref as keyof typeof view.href]
    if (value !== undefined) el.href = value
  }
}

/** Beim Build eingebettetes Release (vite.config.ts), falls die API gerade nicht antwortet. */
function readSeed(): Release | null {
  try {
    const data: unknown = JSON.parse(document.getElementById('release-seed')?.textContent || 'null')
    return isRelease(data) ? data : null
  } catch {
    return null
  }
}

function readCache(): Release | null {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as { at?: number; data?: unknown } | null
    if (cached && typeof cached.at === 'number' && Date.now() - cached.at < CACHE_TTL && isRelease(cached.data)) {
      return cached.data
    }
  } catch {
    /* localStorage gesperrt oder kaputt: einfach neu laden */
  }
  return null
}

function writeCache(data: Release) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }))
  } catch {
    /* ohne Cache weiter */
  }
}

/** Holt bei jedem Aufruf das neueste Release (max. alle 10 min pro Browser, API-Limit 60/h). */
async function loadRelease() {
  const cached = readCache()
  if (cached) return applyReleaseToDom(cached)
  try {
    const release = await fetchRelease({ timeoutMs: 10000 })
    writeCache(release)
    applyReleaseToDom(release)
  } catch {
    applyReleaseToDom(readSeed() ?? 'failed')
  }
}

/* --------------------------------------------------------------- start */

for (const a of avatars) a.bot.update(a.engine.sample(0), COLOR_BY_ID.get(colorId)?.hex ?? '#3b93f0')
requestAnimationFrame(tick)
runDesk(0)
void loadRelease()
