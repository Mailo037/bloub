import { PROFILE_SAMPLES } from './profiles'
import {
  hullOfCircles,
  profileFromPolygon,
  regularPolygonProfile,
  superellipseProfile,
  unionOfCirclesProfile
} from './shape'
import type { Point } from './shape'

/**
 * Formes et couleurs proposees par le personnalisateur du bot.
 *
 * A la difference des silhouettes d'animation (`profiles.ts`), celles-ci ne sont
 * PAS relevees sur la video : elles sont construites analytiquement d'apres la
 * grille du personnalisateur d'origine. Deux sources distinctes, donc, et c'est
 * volontaire — les etats animes doivent rester fideles a la video, les formes de
 * base sont un choix d'utilisateur.
 */

/**
 * Les identifiants sont enumeres plutot que deduits du tableau : c'est ce qui
 * permet a la couche i18n de verifier A LA COMPILATION que chaque forme a bien
 * sa traduction dans les trois langues (`t(\`shapes.${id}\`)` ne compile que si
 * la cle existe). Un `as const` sur le tableau aurait le meme effet mais
 * rendrait `radii` en lecture seule, alors que le moteur le passe tel quel.
 */
export type ShapeId =
  | 'cercle'
  | 'galet'
  | 'squircle'
  | 'capsule'
  | 'triangle'
  | 'hexagone'
  | 'nuage'
  | 'goutte'
  | 'etoile'
  | 'coeur'
  | 'pentagone'
  | 'losange'
  | 'croissant'
  | 'ovale'
  | 'octogone'
  | 'soleil'
  | 'fleur'
  | 'fantome'
  | 'argile'

export interface BotShape {
  id: ShapeId
  radii: number[]
}

/** Ramene le rayon maximal a `max` pour que toutes les formes pesent pareil a l'oeil. */
function normalize(radii: number[], max = 1): number[] {
  const peak = Math.max(...radii)
  if (peak <= 0) return radii
  const k = max / peak
  return radii.map((r) => r * k)
}

const ANGLES = Array.from({ length: PROFILE_SAMPLES }, (_, i) => (i / PROFILE_SAMPLES) * Math.PI * 2)

/** Galet : cercle deforme par deux harmoniques basses, donc irregulier mais lisse. */
const pebble = normalize(
  ANGLES.map((a) => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)),
  1.02
)

/** Nuage : union de bosses, large en bas, deux lobes en haut. */
const cloud = normalize(
  unionOfCirclesProfile([
    { x: -0.44, y: 0.2, r: 0.54 },
    { x: 0.46, y: 0.2, r: 0.5 },
    { x: 0.02, y: 0.3, r: 0.6 },
    { x: -0.24, y: -0.3, r: 0.48 },
    { x: 0.3, y: -0.24, r: 0.44 }
  ]),
  1.02
)

/** Goutte : gros disque en bas, pointe effilee en haut. */
const droplet = normalize(
  profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05), 0, 0),
  1.04
)

/** Etoile 5 branches : polygone en etoile concave, profileFromPolygon. */
function starPolygon(points: number, outerR: number, innerR: number, rotDeg = 0): Point[] {
  const rot = (rotDeg * Math.PI) / 180
  return Array.from({ length: points * 2 }, (_, i) => {
    const a = rot + (i / (points * 2)) * Math.PI * 2
    const r = i % 2 === 0 ? outerR : innerR
    return { x: Math.cos(a) * r, y: Math.sin(a) * r }
  })
}

/** Coeur : deux lobes en haut, pointe en bas (y negiert: Screen-y zeigt nach unten). */
function heartPolygon(count = 48): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2
    const s = Math.sin(t)
    const x = 16 * s * s * s
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    return { x: x / 16, y: -y / 16 }
  })
}

const star = normalize(profileFromPolygon(starPolygon(5, 1.0, 0.45, -90), 0, 0), 1.0)
const heart = normalize(profileFromPolygon(heartPolygon(), 0, 0), 1.02)
const pentagon = normalize(regularPolygonProfile(5, 1.08, 0.3, -90), 1.0)
/** Losange : Raute mit Ecken oben/unten/links/rechts (schlank, kein Wuerfel). */
const diamond = normalize(
  profileFromPolygon(
    [
      { x: 0, y: -1.02 },
      { x: 0.62, y: 0 },
      { x: 0, y: 1.02 },
      { x: -0.62, y: 0 }
    ],
    0,
    0
  ),
  1.0
)
const crescent = normalize(unionOfCirclesProfile([{ x: 0.15, y: 0, r: 1.0 }, { x: -0.45, y: 0, r: 0.95 }]), 1.02)
const oval = normalize(superellipseProfile(2, 1, 1.25), 1.1)
const octagon = normalize(regularPolygonProfile(8, 1.02, 0.22, -67.5), 1.0)

/** Soleil : couronne d'aigrettes fines, bien plus piquante que l'etoile a 5 branches. */
const sun = normalize(profileFromPolygon(starPolygon(14, 1.0, 0.74, -90), 0, 0), 1.0)

/** Fleur : cinq lobes arrondis autour d'un coeur, union de disques (comme le nuage). */
const flower = normalize(
  unionOfCirclesProfile([
    { x: 0, y: 0, r: 0.52 },
    ...Array.from({ length: 5 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 5) * Math.PI * 2
      return { x: Math.cos(a) * 0.55, y: Math.sin(a) * 0.55, r: 0.48 }
    })
  ]),
  1.02
)

/**
 * Fantome : dome plein en haut, ourlet ondule en bas ( trois festons pendants).
 * Polygone explicite car l'ourlet n'a pas d'expression radiale simple ; la forme
 * reste etoilee vue de l'origine, donc profileFromPolygon s'applique.
 */
function ghostPolygon(): Point[] {
  const pts: Point[] = []
  const cy = -0.05
  // dome : de 180deg a 360deg (y ecran vers le bas, donc au-dessus du centre)
  for (let i = 0; i <= 32; i++) {
    const a = Math.PI + (i / 32) * Math.PI
    pts.push({ x: Math.cos(a), y: cy + Math.sin(a) })
  }
  // ourlet : trois demi-cercles pendants, de droite a gauche
  const hem = 0.5
  const r = 0.325
  for (let k = 0; k < 3; k++) {
    const cx = 0.65 - k * 2 * r
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * Math.PI
      pts.push({ x: cx + Math.cos(a) * r, y: hem + Math.sin(a) * r * 1.1 })
    }
  }
  return pts
}
const ghost = normalize(profileFromPolygon(ghostPolygon(), 0, 0), 1.02)

/** Argile : blob malaxe, plus cabosse que le galet (harmoniques plus marquees). */
const clay = normalize(
  ANGLES.map(
    (a) => 1 + 0.085 * Math.cos(2 * a + 1.3) + 0.06 * Math.cos(3 * a + 0.4) + 0.03 * Math.cos(5 * a + 2.6)
  ),
  1.03
)

/** Capsule couchee : enveloppe de deux disques cote a cote. */
const capsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62), 0, 0)

export const SHAPES: BotShape[] = [
  { id: 'cercle', radii: new Array(PROFILE_SAMPLES).fill(1) },
  { id: 'galet', radii: pebble },
  // 1.15 et pas 1.02 : sur une superellipse le rayon maximal est la diagonale,
  // donc normaliser dessus donne une forme qui parait plus petite que le cercle.
  { id: 'squircle', radii: normalize(superellipseProfile(4.2), 1.15) },
  { id: 'capsule', radii: capsule },
  // -90deg : un sommet vers le haut de l'ecran (y est oriente vers le bas)
  { id: 'triangle', radii: regularPolygonProfile(3, 1.12, 0.34, -90) },
  // 0deg : sommets a gauche et a droite, donc aretes du haut et du bas plates
  { id: 'hexagone', radii: regularPolygonProfile(6, 1.04, 0.26, 0) },
  { id: 'nuage', radii: cloud },
  { id: 'goutte', radii: droplet },
  { id: 'etoile', radii: star },
  { id: 'coeur', radii: heart },
  { id: 'pentagone', radii: pentagon },
  { id: 'losange', radii: diamond },
  { id: 'croissant', radii: crescent },
  { id: 'ovale', radii: oval },
  { id: 'octogone', radii: octagon },
  { id: 'soleil', radii: sun },
  { id: 'fleur', radii: flower },
  { id: 'fantome', radii: ghost },
  { id: 'argile', radii: clay }
]

// Map indexee par `string` et non par `ShapeId` : les appelants interrogent avec
// une valeur relue du localStorage ou d'une prop, donc non validee.
export const SHAPE_BY_ID = new Map<string, BotShape>(SHAPES.map((s) => [s.id, s]))
export const DEFAULT_SHAPE = 'cercle'

export type ColorId =
  | 'encre'
  | 'creme'
  | 'brun'
  | 'rouge'
  | 'orange'
  | 'ambre'
  | 'vert'
  | 'turquoise'
  | 'bleu'
  | 'violet'
  | 'rose'
  | 'gris'
  | 'aqua'
  | 'menthe'
  | 'lavande'
  | 'saumon'
  | 'or'
  | 'argent'
  | 'cerise'
  | 'kaki'
  | 'corail'
  | 'prune'

export interface BotColor {
  id: ColorId
  hex: string
}

/** Palette du personnalisateur d'origine. */
export const COLORS: BotColor[] = [
  { id: 'encre', hex: '#0a0a0c' },
  { id: 'brun', hex: '#8b5e3c' },
  { id: 'rouge', hex: '#e8483f' },
  { id: 'orange', hex: '#f08a24' },
  { id: 'ambre', hex: '#f0b429' },
  { id: 'vert', hex: '#3ecf8e' },
  { id: 'turquoise', hex: '#2fbfa0' },
  { id: 'bleu', hex: '#3b93f0' },
  { id: 'violet', hex: '#8b5cf6' },
  { id: 'rose', hex: '#e152b0' },
  { id: 'gris', hex: '#a3a3a3' },
  { id: 'creme', hex: '#f1efe9' },
  { id: 'aqua', hex: '#22d3ee' },
  { id: 'menthe', hex: '#34d399' },
  { id: 'lavande', hex: '#c084fc' },
  { id: 'saumon', hex: '#fb923c' },
  { id: 'or', hex: '#facc15' },
  { id: 'argent', hex: '#d4d4d8' },
  { id: 'cerise', hex: '#f43f5e' },
  { id: 'kaki', hex: '#a3a635' },
  { id: 'corail', hex: '#f97066' },
  { id: 'prune', hex: '#7c3aed' }
]

export const COLOR_BY_ID = new Map<string, BotColor>(COLORS.map((c) => [c.id, c]))
export const DEFAULT_COLOR = 'encre'

/** Melange deux couleurs hex. Sert a la brume de profondeur des particules. */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (h: string) => {
    const v = parseInt(h.slice(1), 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  const a = parse(from)
  const b = parse(to)
  const c = a.map((x, i) => Math.round(x + (b[i]! - x) * t))
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`
}
