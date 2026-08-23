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

/* ----------------------------------------------------- custom animations */

/**
 * Ein Keyframe einer Custom-Animation. `t` ist die Zeit in Sekunden ab Start.
 * Body-Werte steuern die Koerper-Transformation (Verschiebung in px, Skalierung,
 * Rotation in Grad, Squash/Stretch vertikal), Expression-Werte das Gesicht.
 */
export interface CustomAnimKeyframe {
  t: number
  /* body track */
  x?: number
  y?: number
  scale?: number
  rot?: number
  squash?: number
  /* expression track */
  yaw?: number
  pitch?: number
  roll?: number
  split?: number
  eyeW?: number
  eyeH?: number
  open?: number
  tilt?: number
}

export interface CustomAnimSpec {
  /** Vom Main vergeben; der Renderer echoet ihn beim Abschluss zurueck. */
  id?: string
  /** was animiert wird: Koerper, Gesicht oder beides parallel */
  kind: 'body' | 'expression' | 'both'
  /** Gesamtdauer in Sekunden */
  duration: number
  bodyKeyframes?: CustomAnimKeyframe[]
  expressionKeyframes?: CustomAnimKeyframe[]
}

/* --------------------------------------------------------- shared types */

export interface PetConfig extends PetConfigShape {}

export interface Grant {
  path: string
  allowSecrets?: boolean
  grantedAt?: number
  /** Automatischer Root-Grant (Systemlaufwerk) — wird beim Start angelegt. */
  isRoot?: boolean
}

export interface ChatConfig {
  baseUrl: string
  protocol: string
  model: string
  apiKeyEnc: string
  maxHistoryTurns: number
  voiceAlways: boolean
  chatHotkey: string
  toolsEnabled: boolean
  grants: Grant[]
  /** Wie ausfuehrlich Bloub antwortet: concise | balanced | detailed */
  verbosity: string
  /** Globale Dateizugriffs-Stufe fuer Grants: none | read | readwrite */
  fileAccess: 'none' | 'read' | 'readwrite'
  /** Terminal/Shell-Befehle erlauben (Pad-Settings Opt-in). */
  shellEnabled: boolean
  /** Persistentes Memory fuer die AI (speichert/chattuebergreifend Fakten). */
  memoryEnabled: boolean
  /** Voller Zugriff auf das Systemlaufwerk (C:\) — Pad-Settings Opt-in. */
  fullDriveAccess: boolean
  /* ---- Actions: was die AI mit ihren Pet-Tools tun darf ---- */
  /** Expressions aendern (pet_set_expression). */
  expressionAccess: boolean
  /** Animationen abspielen (pet_animate / pet_stop_animation / pet_custom_animate). */
  animationAccess: boolean
  /** Aussehen aendern (pet_set_shape / pet_set_color / pet_set_size). */
  appearanceAccess: boolean
  /** Zeichnen auf dem Desktop (pet_draw_path). */
  drawAccess: boolean
  /** Max. Tool-Calls pro Turn (alle Tools zusammen). */
  maxToolCallsPerTurn: number
  /** Max. pet_draw_path-Calls pro Turn. */
  maxDrawCallsPerTurn: number
  /** Autopilot: 'off' | 'silent' | 'visible' — periodische Selbst-Check-ins der AI. */
  autoPilot: string
  /** Autopilot-Intervall in Sekunden. */
  autoPilotInterval: number
  /** Autopilot-Wahrscheinlichkeit pro Tick in Prozent (0-100). */
  autoPilotChance: number
}

export type PetConfigShape = {
  x: number | null
  y: number | null
  shape: string
  color: string
  expression: string
  ballSize: number
  eventsEnabled: boolean
  chat?: Partial<ChatConfig>
  recall?: Partial<RecallConfig>
}

/**
 * Globale Cursor-Position vom Main-Prozess (pollt screen.getCursorScreenPoint).
 * Gilt auf dem gesamten virtuellen Desktop — also ueber ALLE Monitore hinweg.
 */
export interface GlobalCursorInfo {
  /** Position relativ zum Pet-Fenster (kann auch ausserhalb 0..620 liegen). */
  x: number
  y: number
  /** Globale Koordinaten auf dem virtuellen Desktop. */
  gx: number
  gy: number
  /** Ursprung des Pet-Fensters in globalen Koordinaten. */
  wx: number
  wy: number
  /** Stabile 1-basierte Monitor-Nummer unter dem Cursor (links -> rechts). */
  display: number
  /** Anzahl aktiver Monitore. */
  displayCount: number
}

/** Activity Recall (Opt-in, default AUS): was wird lokal aufgezeichnet. */
export interface RecallConfig {
  /** Master-Switch: nichts wird aufgezeichnet, bevor der User zusagt. */
  enabled: boolean
  /** Terminal-Befehle aufzeichnen (Shell-Hooks + Spool). */
  shell: boolean
  /** Clipboard-Tap (zusaetzlich opt-in, default aus). */
  clipboard: boolean
  /** Browser-Link: 'off' | 'extension' | 'cdp'. */
  browserLink: string
  /** Aufbewahrung in Tagen. */
  retentionDays: number
}

/** Status-Meldung des Recall-Orchestrators fuer die Settings. */
export interface RecallStatus {
  active: boolean
  manualPaused: boolean
  autoPaused: boolean
  enabled: boolean
  browserLinkPort?: number | null
  clipboardRunning?: boolean
  cdpAttached?: boolean
  shellHooks?: { file: string; installed: boolean }[]
  storage?: { bytes: number; lines: number; oldestTs?: number | null; newestTs?: number | null }
}

/** Attachment-Chip wie er vom Main an chatWin gemeldet wird. */
export interface AttachChip {
  kind: 'text' | 'image' | 'folder' | 'pdf' | 'unknown' | 'grant'
  id?: string
  name: string
  size?: number
  path?: string
  note?: string
}

/** Normalisierte Events des Agent-Loops, per IPC an chatWin. */
export type ChatEvent =
  | { type: 'accepted'; chipText: string; attachments: string[] }
  | { type: 'status'; text: string }
  /** Menschenlesbare Aktivitaets-Notiz der AI (z. B. "adding a little life ✨") — wird UEBER der Antwort gerendert und zaehlt nicht als Antwort. */
  | { type: 'note'; text: string }
  | { type: 'token'; text: string }
  /** Tool-Batch beginnt auszufuehren — der Bloub denkt wieder, auch mitten im Stream. */
  | { type: 'tools' }
  /** Neuer Text-Segment beginnt (nach Tool-Calls): alten Antwort-Text verwerfen. */
  | { type: 'clear' }
  | { type: 'done'; truncated: boolean }
  | { type: 'error'; message: string }
  | { type: 'attachments'; chips: AttachChip[] }
  | { type: 'pending-tail' }
  /** Chat-Memory wurde archiviert (Settings "Archive & clear") — letzte Antwort aus der UI entfernen. */
  | { type: 'archived' }

export interface AppSpecs {
  appName: string
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  v8Version: string
  platform: string
  arch: string
  osName: string
  osRelease: string
  totalMemory: string
  freeMemory: string
  processMemory: string
  isPackaged: boolean
  userDataPath: string
  /** 'packaged' = gebautes Electron-Release, 'git' = Checkout, 'source' = Quellcode ohne Git. */
  runMode: 'packaged' | 'git' | 'source'
  gitRoot?: string
}

export interface UpdateCheckResult {
  ok: boolean
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  releaseName?: string
  releaseNotes?: string
  publishedAt?: string
  downloadUrl?: string
  htmlUrl?: string
  checkedAt?: number
  error?: string
  /** Woher die App laeuft: 'packaged' (Electron-Release), 'git' (Checkout) oder 'source' (ohne Git). */
  mode?: 'packaged' | 'git' | 'source'
  /** Nur im git-Modus: Branch des Checkouts. */
  gitBranch?: string
  /** Nur im git-Modus: Commits, die der lokale Checkout hinter dem Remote liegt. */
  gitBehind?: number
  /** Nur im git-Modus: uncommittete lokale Aenderungen (blockieren einen Pull). */
  gitDirty?: boolean
  /** Nur im git-Modus: Remote-URL, von der gezogen wird. */
  gitRemote?: string
}

export interface UpdateProgressPayload {
  percent: number
  status: string
}

export interface PetBridge {
  moveBy(dx: number, dy: number): void
  dragEnd?(): void
  setIgnore(ignore: boolean): void
  getConfig(): Promise<PetConfig>
  updateConfig(partial: Partial<PetConfig>): Promise<void>
  onConfigChanged(cb: (config: PetConfigShape) => void): void
  toggleSettings(): void
  closeSettings(): void
  resizeSettings(x: number, y: number, width: number, height: number): void
  onSettingsVisible(cb: (visible: boolean) => void): void
  onQuitRequested?(cb: () => void): void
  confirmQuit?(): void
  quit(): void
  /* chat summon + drop target (pet window) */
  toggleChat?(): void
  attachPaths?(paths: string[]): Promise<void>
  pathForFile?(file: File): string
  onPlayState?(cb: (id: string, duration?: number) => void): void
  /** Dock-Sichtbarkeit im Pet-Fenster (main-gesteuert) */
  onChatVisibility?(cb: (visible: boolean) => void): void
  /** Custom-Animation vom Main-Prozess (pet window) */
  onCustomAnim?(cb: (spec: CustomAnimSpec) => void): void
  /** Pet meldet Abschluss einer Custom-Animation (beide Tracks fertig). */
  notifyCustomAnimDone?(id: string): void
  /** Globaler Cursor (alle Monitore), vom Main-Prozess gepollt. */
  onGlobalCursor?(cb: (p: GlobalCursorInfo) => void): void
  /* chat window */
  sendChat?(payload: { text: string; attachmentIds: string[] }): Promise<boolean>
  /** Chat-Dock IMMER oeffnen (Kontextmenue "Open input") — togglet nie. */
  showChat?(): void
  abortChat?(): void
  hideChat?(): void
  onChatEvent?(cb: (ev: ChatEvent) => void): void
  testProvider?(): Promise<{ ok: boolean; error?: string }>
  clearMemory?(): Promise<string | null>
  getApiKeyStatus?(): Promise<{ hasKey: boolean }>
  setApiKey?(key: string): Promise<{ ok: boolean }>
  setHotkey?(combo: string): Promise<{ activeHotkey: string | null }>
  testHotkey?(combo: string): Promise<{ ok: boolean; activeHotkey: string | null }>
  setGrantSecrets?(path: string, allowSecrets: boolean): Promise<Grant[]>
  removeGrant?(path: string): Promise<Grant[]>
  /* activity recall */
  recallGetStatus?(): Promise<RecallStatus & { config: Partial<RecallConfig> }>
  recallSetConfig?(partial: Partial<RecallConfig>): Promise<{ config: Partial<RecallConfig> } & RecallStatus>
  recallShellInstall?(): Promise<{ file: string; changed: boolean; error?: string }[]>
  recallShellRemove?(): Promise<{ file: string; changed: boolean; error?: string }[]>
  recallIndexNow?(): Promise<{ indexed: number; purgedShards: number; errors?: unknown[] }>
  recallPurge?(): Promise<{ freed: number }>
  recallTogglePause?(): Promise<RecallStatus | null>
  recallExtensionFolder?(): Promise<{ ok: boolean; folder?: string; port?: number | null; error?: string }>
  /* about & updates */
  getAppSpecs?(): Promise<AppSpecs>
  checkForUpdates?(): Promise<UpdateCheckResult>
  installUpdate?(opts?: { downloadUrl?: string }): Promise<{ ok: boolean; message?: string; error?: string; updated?: boolean; openedBrowser?: boolean }>
  openExternal?(url: string): Promise<boolean>
  onUpdateProgress?(cb: (p: UpdateProgressPayload) => void): void
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
  goutte: 'droplet',
  etoile: 'star',
  coeur: 'heart',
  pentagone: 'pentagon',
  losange: 'diamond',
  croissant: 'crescent',
  ovale: 'oval',
  octogone: 'octagon'
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
    // color='paper' ist ein Sentinel fuer "Papierfarbe wie die Augen" — noetig
    // fuer den Sprech-Mund, der als Tinte unsichtbar waere (Koerper ist Tinte).
    const fill = dot.color === 'paper'
      ? paper
      : dot.color ?? (dot.depth === undefined ? ink : mixHex(paper, ink, dot.depth))
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

/* ----------------------------------------------------------- svg icons */

const SVG_PATHS: Record<string, string> = {
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  pdf: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  text: '<path d="M17 6.1H3"/><path d="M21 12.1H3"/><path d="M15.1 18H3"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'
}


export function createSvgIcon(name: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.classList.add('svg-icon')
  svg.innerHTML = SVG_PATHS[name] ?? SVG_PATHS.clip!
  return svg
}
