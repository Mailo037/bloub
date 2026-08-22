import { EXPRESSIONS } from '../vendor/bot/expressions'
import { SHAPES, COLORS } from '../vendor/bot/skins'
import { getBridge, frozenPreview, EXPRESSION_LABELS, SHAPE_LABELS, type PetConfig } from './shared'

const bridge = getBridge()

const exprPills = document.getElementById('expr-pills')!
const shapePills = document.getElementById('shape-pills')!
const colorRow = document.getElementById('color-row')!
const sizeRange = document.getElementById('size-range') as HTMLInputElement
const eventsToggle = document.getElementById('events-toggle') as HTMLInputElement

let config: PetConfig

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
  eventsToggle.checked = config.eventsEnabled
})

sizeRange.addEventListener('input', () => {
  void bridge.updateConfig({ ballSize: Number(sizeRange.value) })
})

eventsToggle.addEventListener('change', () => {
  void bridge.updateConfig({ eventsEnabled: eventsToggle.checked })
})

document.getElementById('close')!.addEventListener('click', () => bridge.closeSettings())
document.getElementById('quit-btn')!.addEventListener('click', () => bridge.quit())

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
  eventsToggle.checked = config.eventsEnabled
  buildPills()
  refreshSelections()
}

void init()
