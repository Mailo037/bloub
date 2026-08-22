import { BotEngine, type BotFrame } from '../vendor/bot/engine'
import { POSES } from '../vendor/bot/states'
import { EXPRESSION_BY_ID, DEFAULT_EXPRESSION } from '../vendor/bot/expressions'
import {
  SHAPE_BY_ID,
  COLOR_BY_ID,
  DEFAULT_SHAPE,
  DEFAULT_COLOR,
  mixHex
} from '../vendor/bot/skins'
import { RAYON, DEMI_VIEWBOX } from '../vendor/bot/repere'
import { NOTIF_BLUE } from '../vendor/bot/decor'

/* --------------------------------------------------------- shared types */

export interface PetConfig {
  x: number | null
  y: number | null
  shape: string
  color: string
  expression: string
  ballSize: number
  eventsEnabled: boolean
}

export interface PetBridge {
  moveBy(dx: number, dy: number): void
  dragEnd?(): void
  setIgnore(ignore: boolean): void
  getConfig(): Promise<PetConfig>
  updateConfig(partial: Partial<PetConfig>): Promise<void>
  onConfigChanged(cb: (config: PetConfig) => void): void
  toggleSettings(): void
  closeSettings(): void
  resizeSettings(x: number, y: number, width: number, height: number): void
  onSettingsVisible(cb: (visible: boolean) => void): void
  onQuitRequested?(cb: () => void): void
  confirmQuit?(): void
  quit(): void
}

export function getBridge(): PetBridge {
  return (window as unknown as { bloubPet: PetBridge }).bloubPet
}

/* ------------------------------------------------------- english labels */

export const EXPRESSION_LABELS: Record<string, string> = {
  neutre: 'neutral',
  attentif: 'attentive',
  surpris: 'surprised',
  excite: 'excited',
  heureux: 'happy',
  hilare: 'gleeful',
  colere: 'angry',
  triste: 'sad',
  effraye: 'scared',
  mefiant: 'suspicious',
  confus: 'confused',
  curieux: 'curious',
  fier: 'proud',
  timide: 'shy',
  blase: 'bored',
  somnolent: 'sleepy'
}

export const SHAPE_LABELS: Record<string, string> = {
  cercle: 'circle',
  galet: 'pebble',
  squircle: 'squircle',
  capsule: 'capsule',
  triangle: 'triangle',
  hexagone: 'hexagon',
  nuage: 'cloud',
  goutte: 'droplet'
}

const LIGHT_PAPER = '#f4f2ec'
const DARK_PAPER = '#101014'

/**
 * Papierfarbe hinter den Auglöchern. Auf sehr hellen Körperfarben (Weiß, Creme,
 * Amber, Grau) wären die hellen Augen unsichtbar – dort kehrt das Papier um und
 * die Augen werden dunkel.
 */
export function paperFor(inkHex: string): string {
  const v = parseInt(inkHex.slice(1), 16)
  const r = (v >> 16) & 255
  const g = (v >> 8) & 255
  const b = v & 255
  const bright = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return bright > 0.6 ? DARK_PAPER : LIGHT_PAPER
}

/* ------------------------------------------------------------ svg bauen */

let uidCounter = 0

export const SVG_NS = 'http://www.w3.org/2000/svg'

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/**
 * Port der SVG-Struktur aus BloubBot.vue: Augen als Löcher in einer Maske,
 * Arcs mit Verlauf in zwei Hälften (hinter/vor dem Körper), Partikel davor
 * oder dahinter, Benachrichtigungs-Pastille in Blau.
 */
export interface BotDom {
  svg: SVGSVGElement
  update(frame: BotFrame, ink: string): void
}

export function makeBotSvg(): BotDom {
  const uid = `b${uidCounter++}`
  const svg = el('svg', {
    viewBox: `${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`
  })

  const defs = el('defs')
  const grads = el('g')
  defs.append(grads)

  const backArcs = el('g', { fill: 'none', 'stroke-linecap': 'round' })
  const dotsBehind = el('g')

  // Koerpergruppe: Koerper und Augen als saubere Vektorelemente
  const bodyGroup = el('g')
  const bodyPath = el('path')
  const eyesGroup = el('g')

  bodyGroup.append(bodyPath, eyesGroup)

  const dotsFront = el('g')
  const notifCircle = el('circle', { fill: NOTIF_BLUE, visibility: 'hidden' })
  const frontArcs = el('g', { fill: 'none', 'stroke-linecap': 'round' })

  svg.append(defs, backArcs, dotsBehind, bodyGroup, dotsFront, notifCircle, frontArcs)

  function dotNode(dot: BotFrame['dots'][number], ink: string, paper: string): SVGElement {
    const fill = dot.color ?? (dot.depth === undefined ? ink : mixHex(paper, ink, dot.depth))
    if (dot.d) {
      return el('path', {
        d: dot.d,
        fill,
        opacity: dot.opacity,
        transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`
      })
    }
    return el('circle', { cx: dot.x, cy: dot.y, r: dot.r, fill, opacity: dot.opacity })
  }

  function update(frame: BotFrame, ink: string) {
    const paper = paperFor(ink)

    // Koerper
    bodyPath.setAttribute('d', frame.bodyPath)
    bodyPath.setAttribute('fill', ink)
    bodyGroup.setAttribute('opacity', String(frame.bodyAlpha))

    // Augen direkt in passender Kontrastfarbe (paper) zeichnen
    eyesGroup.replaceChildren(
      ...frame.eyes.map((eye) =>
        el('path', {
          d: eye.d,
          transform: eye.matrix,
          opacity: eye.alpha,
          fill: paper
        })
      )
    )

    // Pastille (Notification-Badge)
    if (frame.notif) {
      notifCircle.setAttribute('cx', String(frame.notif.x))
      notifCircle.setAttribute('cy', String(frame.notif.y))
      notifCircle.setAttribute('r', String(frame.notif.r))
      notifCircle.removeAttribute('visibility')
    } else {
      notifCircle.setAttribute('visibility', 'hidden')
    }

    // Verlaeufe der Arcs
    grads.replaceChildren(
      ...frame.arcs.map((arc) => {
        const grad = el('linearGradient', {
          id: `${uid}-${arc.id}`,
          gradientUnits: 'userSpaceOnUse',
          x1: arc.grad.x1,
          y1: arc.grad.y1,
          x2: arc.grad.x2,
          y2: arc.grad.y2
        })
        arc.grad.stops.forEach((c, i) => {
          grad.appendChild(
            el('stop', { offset: i / (arc.grad.stops.length - 1), 'stop-color': c })
          )
        })
        return grad
      })
    )

    backArcs.replaceChildren(
      ...frame.arcs.map((arc) =>
        el('path', {
          d: arc.back,
          stroke: `url(#${uid}-${arc.id})`,
          'stroke-width': arc.width,
          opacity: arc.opacity
        })
      )
    )
    frontArcs.replaceChildren(
      ...frame.arcs.map((arc) =>
        el('path', {
          d: arc.front,
          stroke: `url(#${uid}-${arc.id})`,
          'stroke-width': arc.width,
          opacity: arc.opacity
        })
      )
    )

    const behind = frame.dotsBehind ? frame.dots : []
    const frontDots = frame.dotsBehind ? [] : frame.dots
    dotsBehind.replaceChildren(...behind.map((d) => dotNode(d, ink, paper)))
    dotsFront.replaceChildren(...frontDots.map((d) => dotNode(d, ink, paper)))
  }

  return { svg, update }
}

/* -------------------------------------------------- eingefrorene minis */

export function frozenPreview(
  sizePx: number,
  opts: { shapeId?: string; expressionId?: string; colorId?: string }
): SVGSVGElement {
  const radii = SHAPE_BY_ID.get(opts.shapeId ?? DEFAULT_SHAPE)?.radii ?? null
  const expr = EXPRESSION_BY_ID.get(opts.expressionId ?? DEFAULT_EXPRESSION) ?? null
  const inkHex = COLOR_BY_ID.get(opts.colorId ?? DEFAULT_COLOR)?.hex ?? '#0a0a0c'
  const engine = new BotEngine(RAYON, 'idle', radii, expr)
  const bot = makeBotSvg()
  bot.update(engine.sample(POSES.idle), inkHex)
  bot.svg.setAttribute('width', String(sizePx))
  bot.svg.setAttribute('height', String(sizePx))
  return bot.svg
}
