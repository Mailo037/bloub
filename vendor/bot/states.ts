import {
  COMET_DOT,
  COMET_RIBBONS,
  DOT_PEAK,
  DOT_R,
  DOT_X,
  GLYPH_Z,
  NOTIF_ANGLE,
  NOTIF_DIST,
  NOTIF_MARGIN,
  NOTIF_POP,
  NOTIF_R,
  RINGS,
  SWOOSH,
  particles,
  type ArcSpec,
  type DotRender
} from './decor'
import { EYE_H, EYE_SPLIT, EYE_W, REST_GAZE, type HeadGaze } from './face'
import { TAU, clamp, easings } from './math'
import {
  circle,
  hullOfCircles,
  polyPath,
  profileFromPolygon,
  silhouette,
  type Silhouette
} from './shape'

export interface EyeCfg {
  /** largeur locale (axe court de la gelule), en unites de rayon de boule */
  w: number
  /** hauteur locale (axe long) */
  h: number
  /** 1 = ouvert, 0 = ferme */
  open: number
  /**
   * Inclinaison propre de la gelule, en degres, positif = le haut part a
   * droite. Appliquee APRES le repere tangent de la sphere. Sans elle, les deux
   * yeux penchent forcement du meme cote (le roulis de tete) et la colere comme
   * la tristesse, qui demandent des inclinaisons en miroir, sont hors de portee.
   */
  tilt?: number
}

export interface Pose {
  /** silhouette du corps, en unites de rayon de boule */
  sil: Silhouette
  /** decalage global du corps ET des yeux */
  offX: number
  offY: number
  gaze: HeadGaze
  /** demi-ecart des yeux sur la sphere, en degres */
  split: number
  /** [oeil interieur, oeil exterieur] */
  eyes: [EyeCfg, EyeCfg]
  /** opacite des yeux : sert aux etats sans visage */
  eyeAlpha: number
  bodyAlpha: number
  dots: DotRender[]
  arcs: ArcSpec[]
  notif: { x: number; y: number; r: number; notch: number } | null
  /** true = le decor passe derriere le corps (particules de l'eclatement) */
  dotsBehind: boolean
}

const pair = (w: number, h: number): [EyeCfg, EyeCfg] => [
  { w, h, open: 1 },
  { w, h, open: 1 }
]

function base(over: Partial<Pose> = {}): Pose {
  return {
    sil: circle(1),
    offX: 0,
    offY: 0,
    gaze: { ...REST_GAZE },
    split: EYE_SPLIT,
    eyes: pair(EYE_W, EYE_H),
    eyeAlpha: 1,
    bodyAlpha: 1,
    dots: [],
    arcs: [],
    notif: null,
    dotsBehind: false,
    ...over
  }
}

/* --------------------------------------------------- formes non radiales */

/**
 * Barre du "!" vertical : enveloppe convexe de deux cercles.
 * Mesure : cercle haut (0, -0.505) r 0.132, cercle bas (0, +0.130) r 0.075,
 * flancs rectilignes. Elle est donc tronconique (rapport haut/bas 1.76).
 */
const BAR_UPRIGHT_CY = -0.1875
const BAR_UPRIGHT = profileFromPolygon(
  hullOfCircles(0, -0.505, 0.132, 0, 0.13, 0.075),
  0,
  BAR_UPRIGHT_CY
)

/** Barre du "!" penche : capsule pure (largeur constante 0.269, longueur 0.776). */
const BAR_ITALIC = profileFromPolygon(hullOfCircles(0, -0.2535, 0.1345, 0, 0.2535, 0.1345), 0, 0)

const barUpright = (pose: Partial<Silhouette> = {}): Silhouette => ({
  radii: [...BAR_UPRIGHT],
  rot: 0,
  cx: 0,
  cy: BAR_UPRIGHT_CY,
  sx: 1,
  sy: 1,
  ...pose
})

const barItalic = (pose: Partial<Silhouette> = {}): Silhouette => ({
  radii: [...BAR_ITALIC],
  rot: 0,
  cx: 0,
  cy: 0,
  sx: 1,
  sy: 1,
  ...pose
})

/**
 * Le point du "!" penche n'est pas un disque : c'est une goutte, bout rond
 * (r 0.118) du cote de la barre et pointe effilee a l'oppose, longueur 0.300
 * dans l'axe du glyphe. Centree sur le barycentre du bout rond.
 */
const TEAR = polyPath(hullOfCircles(0, 0, 0.118, 0, 0.172, 0.012))

/**
 * Le triangle ne tourne pas sur lui-meme : son centre decrit un cercle de
 * rayon 0.213 autour de l'origine (mesure). C'est ce decalage qui donne
 * l'impression qu'il bascule au lieu de pivoter sur place.
 */
const TRI_ORBIT = 0.213

function spinningTriangle(rot: number): Silhouette {
  return silhouette('triangle', {
    rot,
    cx: -TRI_ORBIT * Math.sin(rot),
    cy: TRI_ORBIT * Math.cos(rot)
  })
}

/* ------------------------------------------------------------------ etats */

export type StateId =
  | 'idle'
  | 'thinking'
  | 'wink'
  | 'wide'
  | 'alert'
  | 'notify'
  | 'exclaim'
  | 'sleep'
  | 'egg'
  | 'hexagon'
  | 'play'
  | 'orbit'
  | 'burst'
  | 'comet'
  /** chat: der Bloub verschlingt einen Drop (Vortex), ~1 s */
  | 'absorb'
  /** chat: loopender Sprech-Zustand mit pulsierendem Mund */
  | 'talk'
  /** Augen-Fokus: neugieriger Blick, der seitlich hin- und herschweift */
  | 'lookaround'
  /** Augen-Fokus: aufgedreht — grosse Augen, schnelles Hin- und Herspringen */
  | 'excited'
  /** Augen-Fokus: konzentriertes Starren mit zusammengekniffenen Augen */
  | 'focus'
  /** Augen-Fokus: misstrauischer Seitblick mit schmalerem Auge */
  | 'sideeye'
  /** Augen-Fokus: starrer, unblinzelnder Blick direkt nach vorn */
  | 'stare'
  /** Augen-Fokus: schnelles vertikales Abtasten (Lesen/Suchen) */
  | 'scan'
  /** Augen-Fokus: Schwindel — Augen kreisen, Koerper schwankt */
  | 'dizzy'
  /** Koerper+Augen: schuechternes Lurken — duckt sich und lugt nach oben */
  | 'peek'
  /** Aufwachen aus dem Tiefschlaf: strecken, Augen ploppen auf, kleiner Huepfer */
  | 'wake'
  /** Reaktion: "aha, jetzt hab ichs!" — Hopfer mit weiten Augen und Funken */
  | 'aha'
  /** Reaktion: "oh nein" — besorgtes Kopfschuetteln */
  | 'ohno'
  /** Reaktion: zustimmendes Nicken */
  | 'nod'
  /** Reaktion: klares Kopfschuetteln ("nein") */
  | 'shake'
  /** transition d'interface, pas une animation du catalogue : hors `SEQUENCE` */
  | 'swirl'

export interface StateDef {
  id: StateId
  /** duree de maintien quand la sequence complete est jouee */
  duration: number
  /**
   * duree en dessous de laquelle l'animation est coupee avant d'aboutir : le
   * "!" ne revient pas, le corps reste eclate. Elle se lit dans les constantes
   * de `pose` ci-dessous, elle ne se choisit pas. Absente = l'etat ignore le
   * temps ou boucle, n'importe quelle duree lui va (voir `MIN_BLOCK`).
   */
  minDuration?: number
  /** duree du morph d'entree */
  morph: number
  /** true = l'entree est masquee par un clignement, comme dans la video */
  blinkIn: boolean
  /**
   * true = le corps est la silhouette "au repos", donc remplacable par la forme
   * choisie dans le personnalisateur. Les etats qui dessinent leur propre forme
   * (le "!", les points, l'oeuf, le triangle...) valent false : c'est cette forme
   * la qui EST l'animation.
   */
  baseBody: boolean
  /**
   * true = l'etat porte le visage "au repos", donc remplacable par l'expression
   * choisie. Seul `idle` : les autres etats a visage ont une expression relevee
   * sur la video, c'est precisement ce qu'on reproduit.
   */
  baseFace: boolean
  pose(local: number): Pose
}

/** Onde de pulsation qui parcourt les trois points de gauche a droite. */
function dotPulse(t: number, index: number): number {
  const period = 1.4
  const duration = 0.42
  const offset = index * 0.18
  const p = ((((t - offset) % period) + period) % period)
  if (p >= duration) return 0
  return 0.5 - 0.5 * Math.cos((p / duration) * TAU)
}

function glyphZ(s: number): string {
  const w = s * 0.88
  const h = s * 1.05
  const t = s * 0.32
  const mid = s * 0.28
  return `M ${-w} ${-h} L ${w} ${-h} L ${w} ${-h + t} L ${-w + mid} ${h - t} L ${w} ${h - t} L ${w} ${h} L ${-w} ${h} L ${-w} ${h - t} L ${w - mid} ${-h + t} L ${-w} ${-h + t} Z`
}

export const STATES: StateDef[] = [
  {
    id: 'idle',
    duration: 2.4,
    morph: 0.45,
    blinkIn: false,
    baseFace: true,
    baseBody: true,
    pose: () => base()
  },

  {
    id: 'thinking',
    duration: 2.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: (t) => {
      const mid = dotPulse(t, 1)
      // Les points lateraux sortent des flancs de la boule
      const emerge = 0.3 + 0.7 * easings.easeInOutCubic(clamp(t / 0.4))
      return base({
        // la boule DEVIENT le point du milieu : le morph reste continu
        sil: circle(DOT_R * (1 + (DOT_PEAK - 1) * mid), { cx: DOT_X[1]! }),
        eyeAlpha: 0,
        dots: [0, 2].map((i) => {
          const k = dotPulse(t, i)
          return {
            x: DOT_X[i]! * emerge,
            y: 0,
            r: DOT_R * (1 + (DOT_PEAK - 1) * k),
            opacity: 0.55 + 0.45 * k
          }
        })
      })
    }
  },

  {
    id: 'wink',
    duration: 1.6,
    morph: 0.3,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: -5.37, pitch: 4.55, roll: 6.7 },
        split: 16.25,
        // L'oeil ferme n'est pas l'oeil ouvert ecrase : c'est un tiret
        // horizontal PLUS LARGE que l'oeil ouvert (0.447 contre 0.236).
        eyes: [
          { w: 0.236, h: 0.464, open: 1 },
          { w: 0.447, h: 0.089, open: 1 }
        ]
      })
  },

  {
    id: 'wide',
    duration: 1.8,
    morph: 0.55,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: 6.92, pitch: -21.96, roll: 11.6 },
        split: 18.43,
        eyes: pair(0.356, 0.875)
      })
  },

  {
    id: 'alert',
    duration: 2.4,
    minDuration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // Pinselschwung: Sanftes Gleiten nach rechts und kontinuierliches Zurueckschwingen nach links
      const p = clamp(t / 2.2)
      // Sinus-Welle 0 -> 1 -> 0 mit easeInOutCubic: weiches Wenden an beiden Umkehrpunkten (kein Stocken)
      const stroke = Math.sin(p * Math.PI)
      const x = easings.easeInOutCubic(stroke) * 0.68 - 0.08
      const buzz = Math.sin(t * 3 * TAU) * 0.004 * stroke
      const tilt = ((17.7 - stroke * 4.5) * Math.PI) / 180
      return base({
        sil: barItalic({ rot: tilt, cx: x, cy: -0.325 - buzz }),
        eyeAlpha: 0,
        dots: [
          {
            // Der Tropfen folgt geschmeidig der Pinselspitze
            x: x - Math.sin(tilt) * 0.58,
            y: -0.325 + Math.cos(tilt) * 0.58 + buzz * 2.8,
            r: 0.118,
            d: TEAR,
            rot: (tilt * 180) / Math.PI,
            opacity: 1
          }
        ]
      })
    }
  },

  {
    /**
     * Augen-Fokus: Neugieriges Umschauen. Der Koerper bleibt fast still, nur
     * der Blick schweift in weichen Bogen nach links, rechts, wieder links —
     * mit kurzer Mitte-Pause wie beim Abtasten der Umgebung.
     */
    id: 'lookaround',
    duration: 3.2,
    morph: 0.4,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      // Zweieinhalb Schwuene: sin gibt weiche Wenden an den Blickwechseln
      const sweep = Math.sin(t * (TAU / 1.3)) * 30 - 6
      // Kopf folgt dem Blick leicht versetzt und gerafft
      const roll = sweep * 0.22
      const pitch = -5 + Math.sin(t * (TAU / 2.6)) * 5
      // Augen sind etwas grosser als Ruhe (aufmerksam), aber nicht weit
      const eyes = pair(EYE_W * 1.12, EYE_H * 0.98)
      return base({
        gaze: { yaw: sweep, pitch, roll },
        split: 16.8,
        eyes,
        offX: sweep * 0.0022
      })
    }
  },

  {
    /**
     * Augen-Fokus: Aufgedreht/aufgeregt. Grosse runde Augen, der Blick springt
     * schnell zwischen Punkten hin und her, der Koerper huepft klein mit
     * Squash/Stretch — die Aufregung sitzt komplett im Auge.
     */
    id: 'excited',
    duration: 2.6,
    minDuration: 2.2,
    morph: 0.35,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      // Schnelles Hin-und-her-Rattern des Blicks (+ kleines Zittern)
      const dart = Math.sin(t * 9.4) * 26 + Math.sin(t * 21) * 4
      const pitch = -12 + Math.sin(t * 7.7) * 7
      // Kleiner Huepfer: |sin| gibt Stoss- statt Schweb-Bewegung
      const hop = Math.abs(Math.sin(t * TAU / 0.65))
      const squash = 1 + hop * 0.07
      // Funken: drei kleine Punkte tanzen um den Kopf
      const dots = [0, 1, 2].map((i) => {
        const a = t * TAU * 0.9 + (i / 3) * TAU
        return {
          x: Math.cos(a) * 1.18,
          y: -0.55 + Math.sin(a) * 0.28,
          r: 0.05 + 0.02 * Math.sin(t * TAU * 1.6 + i),
          opacity: 0.55 + 0.35 * Math.sin(t * TAU * 1.3 + i * 2)
        }
      })
      return base({
        sil: { ...circle(1), sx: 1 / Math.sqrt(squash), sy: squash, cy: -hop * 0.05 },
        gaze: { yaw: dart, pitch, roll: dart * 0.08 },
        split: 18.6,
        eyes: pair(0.33, 0.66),
        dots
      })
    }
  },

  {
    /**
     * Augen-Fokus: Konzentration. Zusammengekniffene Augen, Blick fest nach
     * vorn mit feinem Mikro-Zittern, Koerper leichtet leicht vor (Zoom-In).
     */
    id: 'focus',
    duration: 2.4,
    morph: 0.45,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      const lean = easings.easeInOutCubic(clamp(t / 0.9))
      const tremble = Math.sin(t * 13) * 1.6
      const squintEyes: [EyeCfg, EyeCfg] = [
        { w: EYE_W * 0.62, h: EYE_H * 0.42, open: 1 },
        { w: EYE_W * 0.62, h: EYE_H * 0.42, open: 1 }
      ]
      return base({
        sil: circle(1 + lean * 0.04, { cy: lean * 0.03 }),
        gaze: { yaw: tremble, pitch: 3, roll: 0 },
        split: 14.2,
        eyes: squintEyes
      })
    }
  },

  {
    /**
     * Augen-Fokus: Misstrauischer Seitblick. Beide Augen wandern langsam weit
     * zur Seite und schmaelern dabei — klassisches "hmm, wirklich?".
     */
    id: 'sideeye',
    duration: 2.4,
    morph: 0.45,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      // Langsames Hinueberschielen, halten, zurueck
      const swing = Math.sin(clamp(t / 2.0) * Math.PI)
      const yaw = easings.easeInOutCubic(swing) * 34 - 4
      const narrow = 1 - swing * 0.3
      return base({
        gaze: { yaw, pitch: 6, roll: yaw * 0.12 },
        split: 15.5,
        eyes: pair(EYE_W * 0.8 * narrow + 0.02, EYE_H * 0.62),
        offX: yaw * 0.0015
      })
    }
  },

  {
    /**
     * Augen-Fokus: Der Starre-Blick. Augen gross und unblinzelnd, Blick fest
     * nach vorn auf den Nutzer (leicht von unten), Koerper absolut still.
     */
    id: 'stare',
    duration: 2.8,
    minDuration: 2,
    morph: 0.5,
    baseFace: false,
    baseBody: true,
    blinkIn: false,
    pose: () =>
      base({
        gaze: { yaw: 0, pitch: 14, roll: 0 },
        split: 17.5,
        eyes: pair(0.3, 0.72)
      })
  },

  {
    /**
     * Augen-Fokus: Schnelles Abtasten. Der Blick springt in kurzen Schritten
     * hoch und runter, wie beim Lesen oder Absuchen einer Liste.
     */
    id: 'scan',
    duration: 2.4,
    morph: 0.35,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      // Treppige Spruenge statt Welle: sign(sin) gibt klare Haltepunkte
      const step = Math.sign(Math.sin(t * TAU / 0.36))
      const pitch = step * 16
      const yaw = Math.sin(t * TAU / 0.9) * 10
      return base({
        gaze: { yaw, pitch, roll: 0 },
        split: 16,
        eyes: pair(EYE_W * 0.95, EYE_H * 0.88)
      })
    }
  },

  {
    /**
     * Augen-Fokus: Schwindel. Die Augen kreisen runde fuer Runde im Kopf,
     * der Koerper schwankt traege gegengleich — "wieviel habe ich getrunken?".
     */
    id: 'dizzy',
    duration: 3,
    minDuration: 2.4,
    morph: 0.4,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      const a = t * TAU * 0.55
      const sway = Math.sin(t * TAU * 0.28) * 0.06
      const wobble = 1 + Math.sin(t * TAU * 0.85) * 0.03
      return base({
        sil: { ...circle(wobble), rot: sway * 40, cx: sway },
        // Yaw/Pitch beschreiben zusammen einen Kreis auf der Kugel
        gaze: { yaw: Math.cos(a) * 38, pitch: Math.sin(a) * 26, roll: sway * 60 },
        // Verwirrte Augen (wie 'confus'): ein Auge gross und gekippt, das
        // andere zu einem flachen Quergestreiften gequetscht.
        split: 16.5,
        eyes: [
          { w: EYE_W * 1.08, h: EYE_H * 1.07, open: 1, tilt: -18 },
          { w: EYE_W * 1.5, h: EYE_H * 0.41, open: 1, tilt: 14 }
        ]
      })
    }
  },

  {
    /**
     * Koerper+Augen: Schuechternes Lurken. Der Bloub duckt sich halb weg
     * (Squash nach unten) und lugt vorsichtig mit grossen Augen nach oben —
     * erst von einer Seite, dann schuechtern zur Mitte.
     */
    id: 'peek',
    duration: 2.6,
    minDuration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      const duck = easings.easeInOutCubic(clamp(t / 0.6)) * easings.easeInOutCubic(clamp((2.5 - t) / 0.5))
      const side = Math.sin(t * TAU / 1.7) * 18
      const shyEyes: [EyeCfg, EyeCfg] = [
        { w: 0.24, h: 0.52, open: 1 },
        { w: 0.24, h: 0.52, open: 1 }
      ]
      return base({
        sil: { ...circle(1), sy: 1 - duck * 0.22, cy: duck * 0.2 },
        gaze: { yaw: side, pitch: -20 - duck * 6, roll: side * 0.25 },
        split: 17,
        eyes: shyEyes
      })
    }
  },

  {
    /**
     * Aufwachen aus dem Tiefschlaf: schlafend zusammengequetscht mit
     * geschlossenen Augen, dann ein tiefes Strecken, die Augen ploppen weit
     * auf und zum Schluss ein kleiner Freuden-Hupfer. Wird beim ersten
     * Kontakt nach dem Tiefschlaf gespielt.
     */
    id: 'wake',
    duration: 1.8,
    minDuration: 1.5,
    morph: 0.35,
    baseFace: false,
    baseBody: true,
    blinkIn: false,
    pose: (t) => {
      const sleepy = 1 - easings.easeInOutCubic(clamp(t / 0.5))
      const stretch = Math.sin(clamp((t - 0.35) / 0.65) * Math.PI)
      const hop =
        Math.abs(Math.sin(clamp((t - 1.0) / 0.8) * Math.PI)) *
        clamp((t - 1.0) / 0.2) *
        clamp((1.8 - t) / 0.25)
      const squash = (1 - sleepy * 0.16) * (1 + stretch * 0.14) * (1 - hop * 0.06)
      const open = easings.easeOutCubic(clamp((t - 0.8) / 0.3))
      const ew = 0.28 + 0.06 * open
      const eh = 0.07 + 0.5 * open
      return base({
        sil: { ...circle(1), sy: squash, sx: 1 / Math.sqrt(squash), cy: -stretch * 0.04 - hop * 0.1 },
        gaze: { yaw: 0, pitch: 10 - 24 * open, roll: 0 },
        split: 16.5,
        eyes: [
          { w: ew, h: eh, open: 1, tilt: -6 * (1 - open) },
          { w: ew, h: eh, open: 1, tilt: 6 * (1 - open) }
        ],
        eyeAlpha: 1
      })
    }
  },

  {
    /**
     * Reaktion "aha, jetzt hab ichs!": kurzes Antizipations-Ducken, dann ein
     * spritziger Hopfer mit weit aufgerissenen Augen und Funken ueber dem Kopf.
     */
    id: 'aha',
    duration: 1.4,
    minDuration: 1.2,
    morph: 0.25,
    baseFace: false,
    baseBody: true,
    blinkIn: false,
    pose: (t) => {
      const duck = Math.max(0, 1 - t / 0.16)
      const hop = Math.sin(clamp((t - 0.14) / 0.6) * Math.PI) * clamp((t - 0.14) / 0.1)
      const settle = 1 - easings.easeInOutCubic(clamp((t - 0.95) / 0.45))
      const squash = (1 - duck * 0.12) * (1 + hop * 0.1) * (1 + settle * 0.04)
      const sparkT = clamp((t - 0.2) / 1.0)
      const dots = [0, 1, 2].map((i) => {
        const a = -Math.PI / 2 + (i - 1) * 0.7 + sparkT * 0.6
        return {
          x: Math.cos(a) * (0.95 + i * 0.12),
          y: -0.75 + Math.sin(a) * 0.22 - sparkT * 0.25,
          r: 0.045 + 0.015 * Math.sin(t * TAU * 2 + i * 2),
          opacity: clamp(sparkT * 3) * (1 - sparkT) * 0.9
        }
      }).filter((d) => d.opacity > 0.01)
      return base({
        sil: { ...circle(1), sy: squash, sx: 1 / Math.sqrt(squash), cy: -hop * 0.12 },
        gaze: { yaw: 0, pitch: -14 + 14 * easings.easeInOutCubic(clamp((t - 0.9) / 0.5)), roll: 0 },
        split: 18.5,
        eyes: pair(0.38, 0.6),
        dots
      })
    }
  },

  {
    /**
     * Reaktion "oh nein": besorgtes Kopfschuetteln. Der Blick schuettelt
     * seitlich mit einer Einhuellenden (baut auf, ebbt sauber ab), die Augen
     * sind schraeg gestellt und wirken sorgenvoll — die Koerpersprache vom
     * "das lief leider schief".
     */
    id: 'ohno',
    duration: 1.8,
    minDuration: 1.5,
    morph: 0.3,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      const shake = Math.sin(t * TAU * 2.4) * 22 * Math.sin(clamp(t / 1.8) * Math.PI)
      // Besorgte Augen: Oberkanten neigen sich schraeg nach innen (mirrored tilt)
      const worried: [EyeCfg, EyeCfg] = [
        { w: 0.22, h: 0.4, open: 1, tilt: -22 },
        { w: 0.22, h: 0.4, open: 1, tilt: 22 }
      ]
      return base({
        gaze: { yaw: shake, pitch: -4, roll: shake * 0.18 },
        split: 16,
        eyes: worried,
        offX: shake * 0.0012
      })
    }
  },

  {
    /** Reaktion: zweifaches zustimmendes Nicken. */
    id: 'nod',
    duration: 1.4,
    minDuration: 1.2,
    morph: 0.3,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      const env = Math.sin(clamp(t / 1.4) * Math.PI)
      const pitch = Math.sin(t * TAU * 1.7) * 16 * env
      return base({
        gaze: { yaw: 0, pitch, roll: 0 },
        split: 16,
        eyes: pair(EYE_W * 1.05, EYE_H * 0.95),
        offY: pitch * 0.0008
      })
    }
  },

  {
    /** Reaktion: klares Kopfschuetteln — "nein". */
    id: 'shake',
    duration: 1.4,
    minDuration: 1.2,
    morph: 0.3,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      const env = Math.sin(clamp(t / 1.4) * Math.PI)
      const yaw = Math.sin(t * TAU * 2.2) * 20 * env
      return base({
        gaze: { yaw, pitch: 2, roll: yaw * 0.12 },
        split: 16,
        eyes: pair(EYE_W * 0.95, EYE_H * 0.9),
        offX: yaw * 0.001
      })
    }
  },

  {
    id: 'notify',
    duration: 2.2,
    morph: 0.5,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: (t) => {
      // Pop du point bleu : pic a +14 % vers 0.3 s puis stabilisation.
      const p = clamp(t / 0.45)
      const pop = 1 + (NOTIF_POP - 1) * Math.sin(p * Math.PI) * (1 - p * 0.35)
      const r = NOTIF_R * (p < 1 ? pop : 1)
      const a = (NOTIF_ANGLE * Math.PI) / 180
      return base({
        // le regard part a l'oppose de la pastille
        gaze: { yaw: -21.94, pitch: -5.82, roll: -12.2 },
        split: 18.89,
        eyes: pair(0.505, 0.498),
        notif: {
          x: Math.cos(a) * NOTIF_DIST,
          y: Math.sin(a) * NOTIF_DIST,
          r,
          notch: r + NOTIF_MARGIN
        }
      })
    }
  },

  {
    id: 'exclaim',
    duration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: () =>
      base({
        sil: barUpright(),
        eyeAlpha: 0,
        dots: [{ x: -0.012, y: 0.526, r: 0.113, opacity: 1 }]
      })
  },

  {
    id: 'sleep',
    duration: 600,
    morph: 0.6,
    baseFace: false,
    baseBody: true,
    blinkIn: false,
    pose: (t) => {
      // Sanftes, tiefes Schlafatmen (Atmung und leichtes Neigen des Kopfes)
      const breathCycle = (t * TAU) / 3.2
      const breath = Math.sin(breathCycle)
      const breathSquash = 1 + breath * 0.045
      const headTilt = -4 + breath * 2

      // Geschlossene schlafende Augen (friedlich zugezogene Schlitze)
      const sleepEyes: [EyeCfg, EyeCfg] = [
        { w: 0.28, h: 0.07, open: 1, tilt: -6 },
        { w: 0.28, h: 0.07, open: 1, tilt: 6 }
      ]

      // 3 kontinuierlich aufsteigende "Z"-Partikel nach rechts oben mit sanfter Rotation und Ein-/Ausblenden
      const numZs = 3
      const cycleDuration = 3.2
      const dots: DotRender[] = []

      for (let i = 0; i < numZs; i++) {
        const offset = i * (cycleDuration / numZs)
        const progress = ((((t + offset) % cycleDuration) + cycleDuration) % cycleDuration) / cycleDuration

        // Startpunkt rechts oben an der Schläfe/Wange
        const startX = 0.38 + i * 0.04
        const startY = -0.15 - i * 0.03

        // Bogen nach rechts oben
        const x = startX + progress * 0.72 + Math.sin(progress * Math.PI * 1.5 + i * 1.8) * 0.08
        const y = startY - progress * 1.12 - Math.pow(progress, 1.3) * 0.25

        // Größe wächst sanft mit dem Aufsteigen
        const r = 0.065 + progress * 0.075

        // Leichte zufällige/organische Rotation
        const baseRot = -10 + i * 16
        const rot = baseRot + Math.sin(progress * TAU + i * 2.2) * 22

        // Ein- und Ausblenden (weiches Fade-in am Anfang, Fade-out am Ende)
        let opacity = 0
        if (progress < 0.2) {
          opacity = easings.easeOutCubic(progress / 0.2)
        } else if (progress > 0.65) {
          opacity = 1 - easings.easeInOutCubic((progress - 0.65) / 0.35)
        } else {
          opacity = 1
        }
        opacity *= 0.85

        if (opacity > 0.01) {
          dots.push({
            x,
            y,
            r,
            d: glyphZ(r),
            rot,
            opacity
          })
        }
      }

      return base({
        sil: {
          ...circle(1),
          sx: 1 / Math.sqrt(breathSquash),
          sy: breathSquash,
          cy: breath * 0.025
        },
        gaze: { yaw: 8, pitch: -12, roll: headTilt },
        split: 16.5,
        eyes: sleepEyes,
        eyeAlpha: 0.9,
        dots
      })
    }
  },

  {
    id: 'egg',
    duration: 1.8,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () =>
      base({
        sil: silhouette('egg'),
        gaze: { yaw: 19.97, pitch: 26.01, roll: -17.1 },
        // les yeux se resserrent comme le corps
        split: 11.07,
        eyes: pair(0.164, 0.385)
      })
  },

  {
    id: 'hexagon',
    duration: 1.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () =>
      base({
        sil: silhouette('hexagon'),
        gaze: { yaw: 23.11, pitch: 24.42, roll: -13.3 },
        split: 13.37,
        eyes: pair(0.177, 0.411)
      })
  },

  {
    id: 'play',
    duration: 2,
    morph: 0.5,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: (t) => {
      const fade = easings.easeInOutCubic(clamp(t / 0.4)) * easings.easeInOutCubic(clamp((2.2 - t) / 0.5))
      const sweepX = 0.45 - easings.easeInOutCubic(clamp(t / 1.8)) * 0.9
      return base({
        sil: spinningTriangle(0),
        gaze: { yaw: 12, pitch: -8, roll: -6 },
        split: 15,
        eyes: pair(0.18, 0.34),
        arcs: SWOOSH.map((s, i) => ({
          id: `sw${i}`,
          seed: { ...s, cx: sweepX },
          t,
          opacity: fade
        }))
      })
    }
  },

  {
    id: 'orbit',
    duration: 3.4,
    // le corps a fini de se relacher du triangle vers la boule a 1.6 + 0.9
    minDuration: 2.5,
    morph: 0.6,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // Rotation mesuree : rampe sur 0.35 s puis 1.25 tour/s (sens antihoraire).
      const ramp = easings.easeInOutCubic(clamp(t / 0.35))
      const rot = -TAU * 1.25 * t * ramp
      // Le corps se relache du triangle vers la boule pendant l'orbite.
      const back = easings.easeInOutCubic(clamp((t - 1.6) / 0.9))
      const tri = spinningTriangle(rot)
      const ball = circle(1, { rot })
      const sil: Silhouette = {
        radii: tri.radii.map((r, i) => r + (ball.radii[i]! - r) * back),
        rot,
        cx: tri.cx * (1 - back),
        cy: tri.cy * (1 - back),
        sx: 1,
        sy: 1
      }
      const fade = clamp(t / 0.8) * clamp((3.6 - t) / 0.9)
      return base({
        sil,
        // les yeux filent autour de la sphere ~3x plus vite que la silhouette
        gaze: {
          yaw: REST_GAZE.yaw + Math.sin(t * 6.5) * 65 * (1 - back),
          pitch: -4 + back * 32,
          roll: -13
        },
        eyes: pair(0.18, 0.34 + back * 0.07),
        // les anneaux entrent un par un sur 0.8 s
        arcs: RINGS.map((s, i) => ({
          id: `rg${i}`,
          seed: s,
          t,
          opacity: fade * clamp((t - i * 0.13) / 0.3)
        }))
      })
    }
  },

  {
    /**
     * Entree dans la vue des reglages.
     *
     * SEUL etat qui n'est pas releve sur la video : il est CHOISI, comme la
     * couleur `--ink`. Il emprunte le vocabulaire d'`orbit` — les memes anneaux,
     * avec leurs parametres mesures — mais coupe court : 1 s au lieu de 3,4, la
     * moitie des anneaux, et aucun triangle.
     *
     * Les deux drapeaux a `true` sont tout l'interet de cet etat :
     *
     * - `baseBody` laisse la forme choisie remplacer le corps, donc la vue peut
     *   imposer le cercle et le galet ou la goutte y MORPHENT au lieu de sauter ;
     * - `baseFace` fait porter le visage de repos, donc le suivi du curseur
     *   s'applique des cette entree. Un etat qui aurait sa propre pose de regard
     *   (comme `orbit`) rendrait la main a l'etat suivant en pleine course, et
     *   les yeux sauteraient d'un coup a la reprise.
     *
     * Il n'est volontairement PAS dans `SEQUENCE` : ce n'est pas une animation du
     * catalogue, c'est une transition d'interface.
     */
    id: 'swirl',
    duration: 1.3,
    minDuration: 1.3,
    morph: 0.3,
    baseFace: true,
    baseBody: true,
    blinkIn: true,
    pose: (t) =>
      base({
        arcs: RINGS.slice(0, 3).map((s, i) => ({
          id: `sw${i}`,
          seed: s,
          t,
          opacity: easings.easeInOutCubic(clamp((t - i * 0.06) / 0.18)) * easings.easeInOutCubic(clamp((1.25 - t) / 0.35))
        }))
      })
  },

  {
    id: 'burst',
    duration: 2.6,
    // le corps est recompose a 1.7 + 0.7
    minDuration: 2.4,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // Effondrement mesure : 1.0 -> 0.166 en 0.7 s, ease-out, sans rebond.
      const collapse = 1 - 0.834 * easings.easeInOutCubic(clamp(t / 0.7))
      const regrow = easings.easeInOutCubic(clamp((t - 1.7) / 0.7))
      return base({
        sil: circle(collapse + (1 - collapse) * regrow),
        eyeAlpha: clamp((t - 1.85) / 0.4),
        dots: particles(t, 1),
        dotsBehind: true
      })
    }
  },

  {
    /**
     * Chat: der Bloub verschlingt einen Drop. Einmaliger Smart-Loop:
     * Phase 1 (0-1s) expandiert der Punktring von innen nach aussen
     * (Wirbel baut sich auf), Phase 2 ziehen sich die Punkte wieder ins
     * Zentrum zurueck und ROTIEREN dort stabil weiter — der State muss nie
     * neu gestartet werden, er bleibt als sichtbarer Vortex stehen, waehrend
     * der Koerper ausgeblendet ist (nur der Vortex ist sichtbar).
     */
    id: 'absorb',
    duration: 1.2,
    minDuration: 1.1,
    morph: 0.3,
    baseFace: true,
    baseBody: true,
    blinkIn: false,
    pose: (t) => {
      const N = 10
      // Phase 1: Wirbel baut sich von innen nach aussen auf (0..1s)
      const build = clamp(t / 1.0)
      const ring = 0.3 + build * 1.35 // 0.3 -> 1.65
      const swirl = t * TAU * 0.7
      // Phase 2: zurueck ins Zentrum + stabile Rotation (ab ~1s)
      const spin = Math.max(0, t - 1.0)
      const spinR = 0.32 + 0.07 * Math.sin(spin * 2.1) // leicht pulsierender Radius
      const spinA = spin * TAU * 1.5
      const swallowed = build >= 1
      const dots = Array.from({ length: N }, (_, i) => {
        const a = (i / N) * TAU + (build < 1 ? swirl : spinA) + i * 0.13
        const r = build < 1 ? ring : spinR
        const pulse = Math.sin(spin * 3.2 + i * 0.9)
        return {
          x: Math.cos(a) * r,
          y: Math.sin(a) * r * 0.92,
          r: build < 1 ? 0.05 + build * 0.03 : 0.055 + 0.018 * pulse,
          opacity: build < 1 ? 0.6 + build * 0.3 : 0.85 + 0.12 * pulse
        }
      })
      // Waehrend des Aufbaus wippt der Koerper mit, danach wird er ausgeblendet
      const gulp = Math.sin(clamp(t / 1.0) * Math.PI) ** 2
      return base({
        sil: circle(1 + gulp * 0.06),
        bodyAlpha: swallowed ? 0 : 1,
        eyeAlpha: swallowed ? 0 : 1,
        dots
      })
    }
  },

  {
    /**
     * Chat: Sprechen. Loopender Zustand (grosse duration wie `idle`): die
     * Augen sind leicht verengt, ein kleiner Mund unten pulst mit ~0.22 s
     * Periode. Der Mund ist ein Papier-Loch (wie die Augen) — als Tinte
     * waere er unsichtbar und nur als Artefakt sichtbar, wenn er ein Auge
     * ueberlappt. Etwas tiefer gesetzt, damit er die Augen meidet.
     */
    id: 'talk',
    duration: 600,
    morph: 0.35,
    baseFace: true,
    baseBody: true,
    blinkIn: true,
    pose: (t) => {
      const mouth = 0.5 - 0.5 * Math.cos((t * TAU) / 0.22)
      return base({
        eyes: pair(EYE_W * 0.82, EYE_H * 0.82),
        dots: [
          {
            x: 0,
            y: 0.42,
            r: 0.03 + mouth * 0.045,
            opacity: 0.95,
            color: 'paper'
          }
        ]
      })
    }
  },

  {
    id: 'comet',
    duration: 2.4,
    minDuration: 2.4,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      const collapse = 1 - (1 - COMET_DOT) * easings.easeInOutCubic(clamp(t / 0.55))
      const regrow = easings.easeInOutCubic(clamp((t - 1.7) / 0.65))
      const fade = easings.easeInOutCubic(clamp((t - 0.1) / 0.3)) * easings.easeInOutCubic(clamp((2.2 - t) / 0.35))
      return base({
        sil: circle(collapse + (1 - collapse) * regrow, {
          cy: Math.sin(clamp(t / 1.7) * Math.PI) * 0.035
        }),
        eyeAlpha: easings.easeInOutCubic(clamp((t - 1.85) / 0.45)),
        arcs: COMET_RIBBONS.map((s, i) => ({ id: `cm${i}`, seed: s, t, opacity: fade }))
      })
    }
  }
]

export const STATE_BY_ID = new Map(STATES.map((s) => [s.id, s]))

/** Ordre de lecture de la sequence complete, calque sur la video de reference. */
/**
 * Date, en temps local, ou chaque etat est le plus lisible : c'est la pose que
 * montrent les vignettes et la planche. Rendu deterministe, donc comparable
 * d'une execution a l'autre. Le type force a couvrir tout nouvel etat.
 */
export const POSES: Record<StateId, number> = {
  idle: 1,
  thinking: 1.1,
  wink: 0.8,
  wide: 0.8,
  alert: 0.75,
  notify: 0.9,
  exclaim: 0.8,
  sleep: 0.45,
  egg: 0.8,
  hexagon: 0.8,
  play: 0.9,
  orbit: 1.2,
  swirl: 0.5,
  burst: 0.45,
  comet: 1.15,
  absorb: 0.55,
  talk: 0.3,
  lookaround: 1.4,
  excited: 0.9,
  focus: 1.2,
  sideeye: 1.3,
  stare: 1.6,
  scan: 1.2,
  dizzy: 1.8,
  peek: 1.4,
  wake: 0.9,
  aha: 0.35,
  ohno: 0.8,
  nod: 0.6,
  shake: 0.6
}

export const SEQUENCE: StateId[] = [
  'idle',
  'thinking',
  'wink',
  'wide',
  'alert',
  'notify',
  'exclaim',
  'sleep',
  'egg',
  'hexagon',
  'play',
  'orbit',
  'burst',
  'comet',
  'lookaround',
  'excited',
  'focus',
  'sideeye',
  'stare',
  'scan',
  'dizzy',
  'peek'
]
