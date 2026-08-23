// Erstellt das Bloub-App-Icon prozedural (keine Abhaengigkeiten):
//  - rendert den korallenroten Blob mit Augen per Signed-Distance-Funktion
//  - schreibt PNGs (256/128/64/48/32/16) mit eigenem Encoder (zlib)
//  - verpackt alles in ein echtes Multi-Size-Windows-.ico
// Aufruf: node tools/make-icon.mjs
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------- PNG-Encoder */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

/** RGBA-Puffer -> PNG-Datei (Farbtyp 6, Filter 0). */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------ Blob-Rendering */

// Echter Bloub-Look (aus vendor/bot uebernommen, siehe face.ts / skins.ts):
//  - Koerper: Squircle (Superellipse n=4.2) in der Palette-Farbe "bleu"
//  - Augen: schmale weisse Ovale OHNE Pupillen, ausgerichtet wie im Ruhe-Zustand
//    (REST_GAZE: yaw 28.49, pitch 28.62, roll -13, EYE_SPLIT 15.46)
const BODY_N = 4.2
const BODY_COLOR = [59, 147, 240] // #3b93f0 ("bleu")
const BODY_TOP = [86, 168, 246] // dezente Aufhellung oben
const EYE_W = 0.186 // halbe Augenbreite in Ballradius (face.ts)
const EYE_H = 0.412 // halbe Augenhoehen in Ballradius (face.ts)
const REST_GAZE = { yaw: 28.49, pitch: 28.62, roll: -13 }
const EYE_SPLIT = 15.46

const clamp = (v, a, b) => Math.min(Math.max(v, a), b)
const deg = (d) => (d * Math.PI) / 180

/** Dreht zwei Vektoren eines Orthonormalpaares in ihrer gemeinsamen Ebene (face.ts). */
function spin(u, v, angle) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s]
  ]
}

/** Augenpositionen + Tangentialmatrix wie eyePoses() in face.ts. */
function eyePoses() {
  let f = [0, 0, 1]
  let right = [1, 0, 0]
  let down = [0, 1, 0]
  ;[f, right] = spin(f, right, deg(REST_GAZE.yaw))
  ;[down, f] = spin(down, f, deg(REST_GAZE.pitch))
  ;[right, down] = spin(right, down, deg(REST_GAZE.roll))
  const build = (side) => {
    const [ef, er] = spin(f, right, deg(EYE_SPLIT * side))
    return { x: ef[0], y: ef[1], a: er[0], b: er[1], c: down[0], d: down[1] }
  }
  return [build(-1), build(1)]
}

/**
 * Rendert den Bloub: blauer Squircle mit zwei weissen Oval-Augen im Ruhe-Blick.
 * Koordinaten normalisiert; Antialiasing weich ueber Kantdistanz.
 */
function renderBlob(size) {
  const px = new Uint8ClampedArray(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  // Squircle-Ecke (Diagonale) liegt bei 2^(1/n) — darauf normalisieren, damit
  // die Form bis nah an den Rand reicht, ohne abgeschnitten zu werden.
  const corner = Math.pow(2, 1 / BODY_N)
  const R = (size / 2) * 0.94 / corner // Ballradius in px
  const eyes = eyePoses()
  const invDet = 1 / (R * R) // Augen-Matrix ist orthonormal * R

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5 - cx) / R
      const ny = (y + 0.5 - cy) / R

      // Superellipse-Distanz: 0 im Innern, wachsend nach aussen
      const f = Math.pow(Math.pow(Math.abs(nx), BODY_N) + Math.pow(Math.abs(ny), BODY_N), 1 / BODY_N)
      const bodyCov = clamp((corner - f) * R / 1.5 + 0.5, 0, 1)

      let r = 0; let g = 0; let b = 0; let a = 0
      if (bodyCov > 0) {
        // Sehr dezenter Verlauf (Reference ist fast flach)
        const shade = clamp((ny + 1.2) / 2.4, 0, 1)
        r = BODY_TOP[0] + (BODY_COLOR[0] - BODY_TOP[0]) * shade
        g = BODY_TOP[1] + (BODY_COLOR[1] - BODY_TOP[1]) * shade
        b = BODY_TOP[2] + (BODY_COLOR[2] - BODY_TOP[2]) * shade

        // Augen: weisse Ovale in der Tangentialebene (keine Pupillen)
        for (const eye of eyes) {
          const dx = nx - eye.x
          const dy = ny - eye.y
          // Inverse der Matrix [a c; b d] (Spalten wie SVG matrix(a,b,c,d))
          const det = eye.a * eye.d - eye.b * eye.c
          const u = (eye.d * dx - eye.c * dy) / det
          const v = (-eye.b * dx + eye.a * dy) / det
          const q = Math.hypot(u / EYE_W, v / EYE_H)
          const cov = clamp((1 - q) * R / 1.5 + 0.5, 0, 1)
          if (cov > 0) {
            r += (255 - r) * cov
            g += (255 - g) * cov
            b += (255 - b) * cov
          }
        }

        r *= bodyCov; g *= bodyCov; b *= bodyCov
        a = bodyCov * 255
      }

      const i = (y * size + x) * 4
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
    }
  }
  return px
}

/* ---------------------------------------------------------------- ICO-Writer */

/** Multi-Size-.ico: alle Eintraege als eingebettete PNGs (Windows Vista+). */
function buildIco(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const entries = []
  let offset = 6 + 16 * count
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size // 0 bedeutet 256
    e[1] = e[0]
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

/* --------------------------------------------------------------------- main */

const SIZES = [256, 128, 64, 48, 32, 16]
const pngs = SIZES.map((size) => ({
  size,
  data: encodePng(size, size, renderBlob(size))
}))

const assetsDir = path.join(root, 'electron', 'assets')
fs.mkdirSync(assetsDir, { recursive: true })
fs.mkdirSync(path.join(root, 'build'), { recursive: true })

fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(pngs))
fs.writeFileSync(path.join(assetsDir, 'bloub.ico'), buildIco(pngs))
fs.writeFileSync(path.join(assetsDir, 'bloub.png'), pngs[0].data)

for (const { size, data } of pngs) {
  fs.writeFileSync(path.join(assetsDir, `bloub-${size}.png`), data)
}
console.log('icon written:', path.join(root, 'build', 'icon.ico'))
console.log('tray/window icons:', assetsDir)
