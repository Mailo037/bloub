// Tool-Registry nach dem defineTool-Muster: Schema-Validierung VOR execute,
// Ergebnisse gebunden bevor sie in den Kontext gehen, Pfadpolitik strikt auf
// Grants beschraenkt (deny by default, auch fuer Symlinks nach draussen).
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const MAX_DEPTH = 12
const TREE_MAX_ENTRIES = 500
const READ_MAX_LINES = 2000
const READ_MAX_BYTES = 256 * 1024
const SEARCH_MAX_MATCHES = 250
const RESULT_MAX_BYTES = 32 * 1024

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.pnpm-store', '__pycache__'])

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.pdf',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.pyc',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db', '.mdb', '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg'
])

/** Basename-Matcher fuer Geheimnisse — nur mit explizitem Shield freigeben. */
function isSecretName(basename) {
  const b = basename.toLowerCase()
  return (
    b.startsWith('.env') ||
    b.endsWith('.pem') ||
    b.endsWith('.key') ||
    b.startsWith('id_rsa') ||
    b.startsWith('credentials')
  )
}

/* --------------------------------------------------------- schema-check */

/**
 * Minimaler JSON-Schema-Check: type, properties, required,
 * additionalProperties:false, enum, items, min/max. Reicht fuer unsere Tools.
 */
function validateArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'arguments must be an object' }
  return checkValue(schema, args, '$')
}

function checkValue(schema, v, at) {
  if (!schema || typeof schema !== 'object') return { ok: true }
  if (schema.enum && !schema.enum.includes(v)) {
    return { ok: false, error: `${at}: must be one of ${JSON.stringify(schema.enum)}` }
  }
  const t = schema.type
  if (t === 'string' && typeof v !== 'string') return { ok: false, error: `${at}: expected string` }
  if (t === 'number' && typeof v !== 'number') return { ok: false, error: `${at}: expected number` }
  if (t === 'boolean' && typeof v !== 'boolean') return { ok: false, error: `${at}: expected boolean` }
  if (t === 'object') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: `${at}: expected object` }
    for (const req of schema.required ?? []) {
      if (!(req in v)) return { ok: false, error: `${at}: missing "${req}"` }
    }
    for (const k of Object.keys(v)) {
      if (schema.properties && !(k in schema.properties)) {
        if (schema.additionalProperties === false) return { ok: false, error: `${at}: unexpected property "${k}"` }
        continue
      }
      const sub = checkValue(schema.properties?.[k], v[k], `${at}.${k}`)
      if (!sub.ok) return sub
    }
  }
  if (t === 'array') {
    if (!Array.isArray(v)) return { ok: false, error: `${at}: expected array` }
    if (schema.items) {
      for (let i = 0; i < v.length; i++) {
        const sub = checkValue(schema.items, v[i], `${at}[${i}]`)
        if (!sub.ok) return sub
      }
    }
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) return { ok: false, error: `${at}: < minimum ${schema.minimum}` }
    if (schema.maximum !== undefined && v > schema.maximum) return { ok: false, error: `${at}: > maximum ${schema.maximum}` }
  }
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) return { ok: false, error: `${at}: too short` }
    if (schema.maxLength !== undefined && v.length > schema.maxLength) return { ok: false, error: `${at}: too long` }
  }
  return { ok: true }
}

/* ------------------------------------------------------------ pfadpolitik */

/**
 * Löst p gegen die Grants auf. Absolute Pfade muessen INNERHALB eines echten
 * Grant-Ordners landen; relative werden gegen jede Grant-Wurzel probiert.
 * realpathSync auf dem tiefsten existierenden Vorfahren bricht Symlinks, die
 * aus dem Grant hinausfuehren.
 */
function resolveWithinGrants(grants, p) {
  if (typeof p !== 'string' || p.trim() === '') return { ok: false, error: 'path outside granted folders' }
  for (const grant of grants ?? []) {
    let joined
    if (path.isAbsolute(p)) {
      // Nur akzeptieren, wenn es (roh) unter dieser Grant-Wurzel liegt
      const gNorm = path.resolve(grant.path)
      const pNorm = path.resolve(p)
      const rel = path.relative(gNorm, pNorm)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      joined = pNorm
    } else {
      joined = path.resolve(grant.path, p)
    }
    const realGrant = realPathBestEffort(grant.path)
    const realTarget = realPathBestEffort(joined)
    const relReal = path.relative(realGrant, realTarget)
    // relReal === '' = exakt der Grant selbst (z. B. fs_tree auf C:\)
    if (relReal !== '' && (relReal.startsWith('..') || path.isAbsolute(relReal))) continue
    return { ok: true, grant, resolved: realTarget }
  }
  return { ok: false, error: 'path outside granted folders' }
}

/** realpath bis zur tiefsten existierenden Ebene (Ziel darf noch fehlen). */
function realPathBestEffort(p) {
  let cur = path.resolve(p)
  try {
    return fs.realpathSync(cur)
  } catch {
    /* nicht vorhanden — Vorfahren hochlaufen */
  }
  const parent = path.dirname(cur)
  if (parent !== cur) {
    const realParent = realPathBestEffort(parent)
    cur = path.join(realParent, path.basename(cur))
  }
  return cur
}

/* ---------------------------------------------------------------- baum */

function listTree(root, depth, out) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (out.count >= TREE_MAX_ENTRIES) return
    if (e.name.startsWith('.') && DEFAULT_IGNORES.has(e.name)) continue
    if (DEFAULT_IGNORES.has(e.name)) continue
    if (e.isDirectory()) {
      out.lines.push(`${'  '.repeat(depth)}${e.name}/`)
      out.count++
      if (depth < MAX_DEPTH) listTree(path.join(root, e.name), depth + 1, out)
    } else if (e.isFile()) {
      if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue
      out.lines.push(`${'  '.repeat(depth)}${e.name}`)
      out.count++
    }
  }
}

const FS_TREE = defineTool({
  name: 'fs_tree',
  description:
    'Names-only recursive listing of a granted folder. Directories get a trailing "/". ' +
    'Ignores .git/node_modules/dist/build and binary files. Max 500 entries, max depth 12.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Folder inside a granted workspace' },
      note: { type: 'string', description: 'Optional short human-readable activity note (e.g. "taking a look around your folder") shown above the reply.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const res = resolveWithinGrants(ctx.grants, args.path)
    if (!res.ok) return { ok: false, content: res.error, isError: true }
    let st
    try {
      st = fs.statSync(res.resolved)
    } catch {
      return { ok: false, content: `no such folder: ${args.path}`, isError: true }
    }
    if (!st.isDirectory()) return { ok: false, content: `not a folder: ${args.path}`, isError: true }
    const out = { lines: [], count: 0 }
    listTree(res.resolved, 0, out)
    let text = out.lines.join('\n')
    if (out.count >= TREE_MAX_ENTRIES) text += '\n[truncated at 500 entries]'
    return { ok: true, content: text || '(empty folder)' }
  }
})

/* --------------------------------------------------------------- lesen */

const FS_READ = defineTool({
  name: 'fs_read',
  description:
    'Read a text file from a granted workspace with line numbers. ' +
    'offset is the 1-based starting line; limit defaults to 2000 lines / 256 KB per call.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File inside a granted workspace' },
      offset: { type: 'number', description: '1-based first line to return', minimum: 1 },
      limit: { type: 'number', description: 'Max lines to return (default/max 2000)', minimum: 1, maximum: READ_MAX_LINES },
      note: { type: 'string', description: 'Optional short human-readable activity note shown above the reply.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const res = resolveWithinGrants(ctx.grants, args.path)
    if (!res.ok) return { ok: false, content: res.error, isError: true }
    if (isSecretName(path.basename(res.resolved)) && !res.grant.allowSecrets) {
      return { ok: false, content: 'secret file refused (enable "allow secrets" on this folder shield)', isError: true }
    }
    if (BINARY_EXT.has(path.extname(res.resolved).toLowerCase())) {
      return { ok: false, content: `binary file not readable as text: ${args.path}`, isError: true }
    }
    let raw
    try {
      raw = fs.readFileSync(res.resolved, 'utf8')
    } catch {
      return { ok: false, content: `no such file: ${args.path}`, isError: true }
    }
    const offset = Math.max(1, Math.floor(args.offset ?? 1))
    const limit = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(args.limit ?? READ_MAX_LINES)))
    const lines = raw.split('\n')
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const body = []
    let bytes = 0
    let used = 0
    for (const line of slice) {
      const rendered = `${String(offset + used).padStart(6)}| ${line}`
      if (bytes + rendered.length > READ_MAX_BYTES) break
      body.push(rendered)
      bytes += rendered.length
      used++
    }
    let content = body.join('\n')
    if (used < slice.length) {
      content += `\n[truncated at ${used} lines / 256 KB - continue with offset ${offset + used}]`
    } else if (offset - 1 + used < lines.length) {
      content += `\n[end of window — more lines follow, use offset ${offset + used}]`
    }
    return { ok: true, content: content || '(empty file)' }
  }
})

/* ------------------------------------------------------------- suchen */

function looksTextual(file) {
  return !BINARY_EXT.has(path.extname(file).toLowerCase())
}

function searchTree(dir, rel, regex, includeRe, out) {
  if (out.matches >= SEARCH_MAX_MATCHES) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.matches >= SEARCH_MAX_MATCHES) return
    if (DEFAULT_IGNORES.has(e.name)) continue
    const abs = path.join(dir, e.name)
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      searchTree(abs, relPath, regex, includeRe, out)
    } else if (e.isFile() && looksTextual(e.name)) {
      if (includeRe && !includeRe.test(e.name)) continue
      if (isSecretName(e.name)) {
        const g = resolveWithinGrants(out.grants, abs)
        if (!g.ok || !g.grant.allowSecrets) continue
      }
      let text
      try {
        if (fs.statSync(abs).size > 1024 * 1024) continue
        text = fs.readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0
        if (regex.test(lines[i])) {
          out.hits.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
          out.matches++
          if (out.matches >= SEARCH_MAX_MATCHES) break
        }
      }
    }
  }
}

const FS_SEARCH = defineTool({
  name: 'fs_search',
  description:
    'Regex content search across text files within a granted folder. Optional "include" glob-ish ' +
    'filter on file names, e.g. "*.ts". Returns up to 250 matches as path:line: excerpt.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Search root inside a granted workspace' },
      pattern: { type: 'string', description: 'JavaScript regular expression' },
      include: { type: 'string', description: 'Optional filename filter, glob-style like *.ts' },
      note: { type: 'string', description: 'Optional short human-readable activity note shown above the reply.' }
    },
    required: ['path', 'pattern'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const res = resolveWithinGrants(ctx.grants, args.path)
    if (!res.ok) return { ok: false, content: res.error, isError: true }
    let regex
    try {
      regex = new RegExp(args.pattern)
    } catch (err) {
      return { ok: false, content: `invalid pattern: ${err?.message ?? err}`, isError: true }
    }
    let includeRe = null
    if (args.include) {
      includeRe = new RegExp('^' + args.include.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    }
    const out = { hits: [], matches: 0, grants: ctx.grants }
    searchTree(res.resolved, '', regex, includeRe, out)
    let content = out.hits.join('\n')
    if (out.matches >= SEARCH_MAX_MATCHES) content += '\n[stopped at 250 matches]'
    return { ok: true, content: content || '(no matches)' }
  }
})

/* ---------------------------------------------------------- schreiben */

const WRITE_MAX_BYTES = 256 * 1024

/** Write-Berechtigung: nur mit globalem fileAccess=readwrite. */
function requireWrite(ctx) {
  if (ctx?.fileAccess !== 'readwrite') {
    return { ok: false, content: 'write access disabled — enable "read/write" file access in Pad settings first', isError: true }
  }
  return null
}

const FS_WRITE = defineTool({
  name: 'fs_write',
  description:
    'Write (create or overwrite) a text file inside a granted workspace. ' +
    'Requires global file access set to read/write in the Pad settings. Content is written as UTF-8, max 256 KB.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File inside a granted workspace to create or overwrite' },
      content: { type: 'string', description: 'Full new file content' },
      note: { type: 'string', description: 'Optional short human-readable activity note shown above the reply, e.g. "saving my thoughts to a file 📝". Never the answer itself.' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const denied = requireWrite(ctx)
    if (denied) return denied
    const res = resolveWithinGrants(ctx.grants, args.path)
    if (!res.ok) return { ok: false, content: res.error, isError: true }
    if (isSecretName(path.basename(res.resolved)) && !res.grant.allowSecrets) {
      return { ok: false, content: 'secret file refused (enable "allow secrets" on this folder shield)', isError: true }
    }
    if (typeof args.content !== 'string' || args.content.length > WRITE_MAX_BYTES) {
      return { ok: false, content: `content too large (max ${WRITE_MAX_BYTES} bytes)`, isError: true }
    }
    try {
      fs.mkdirSync(path.dirname(res.resolved), { recursive: true })
      fs.writeFileSync(res.resolved, args.content, 'utf8')
    } catch (err) {
      return { ok: false, content: `write failed: ${err?.message ?? err}`, isError: true }
    }
    return { ok: true, content: `Wrote ${args.path} (${args.content.length} bytes).` }
  }
})

const FS_EDIT = defineTool({
  name: 'fs_edit',
  description:
    'Replace a unique literal text fragment inside a file of a granted workspace. ' +
    'Requires global file access set to read/write in the Pad settings. ' +
    'The old text must appear exactly once; the file must stay under 256 KB.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File inside a granted workspace to edit' },
      old: { type: 'string', description: 'Exact text fragment to replace (must occur exactly once)' },
      new: { type: 'string', description: 'Replacement text' },
      note: { type: 'string', description: 'Optional short human-readable activity note shown above the reply, e.g. "polishing my notes ✏️". Never the answer itself.' }
    },
    required: ['path', 'old', 'new'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const denied = requireWrite(ctx)
    if (denied) return denied
    const res = resolveWithinGrants(ctx.grants, args.path)
    if (!res.ok) return { ok: false, content: res.error, isError: true }
    if (isSecretName(path.basename(res.resolved)) && !res.grant.allowSecrets) {
      return { ok: false, content: 'secret file refused (enable "allow secrets" on this folder shield)', isError: true }
    }
    if (BINARY_EXT.has(path.extname(res.resolved).toLowerCase())) {
      return { ok: false, content: `binary file not editable: ${args.path}`, isError: true }
    }
    let raw
    try {
      raw = fs.readFileSync(res.resolved, 'utf8')
    } catch {
      return { ok: false, content: `no such file: ${args.path}`, isError: true }
    }
    const count = raw.split(args.old).length - 1
    if (count === 0) return { ok: false, content: 'old text not found in file', isError: true }
    if (count > 1) return { ok: false, content: `old text appears ${count} times — make it unique`, isError: true }
    const updated = raw.replace(args.old, args.new)
    if (updated.length > WRITE_MAX_BYTES) {
      return { ok: false, content: `result too large (max ${WRITE_MAX_BYTES} bytes)`, isError: true }
    }
    try {
      fs.writeFileSync(res.resolved, updated, 'utf8')
    } catch (err) {
      return { ok: false, content: `write failed: ${err?.message ?? err}`, isError: true }
    }
    return { ok: true, content: `Edited ${args.path}.` }
  }
})

/* ------------------------------------------------------------- pet tools */

/** Englische Tool-Namen -> interne (franzoesische) IDs. */
const SHAPE_TO_ID = {
  circle: 'cercle',
  pebble: 'galet',
  squircle: 'squircle',
  capsule: 'capsule',
  triangle: 'triangle',
  hexagon: 'hexagone',
  cloud: 'nuage',
  droplet: 'goutte',
  star: 'etoile',
  heart: 'coeur',
  pentagon: 'pentagone',
  diamond: 'losange',
  crescent: 'croissant',
  oval: 'ovale',
  octagon: 'octogone',
  sun: 'soleil',
  flower: 'fleur',
  ghost: 'fantome',
  clay: 'argile'
}
const ID_TO_SHAPE = Object.fromEntries(Object.entries(SHAPE_TO_ID).map(([k, v]) => [v, k]))

const EXPR_TO_ID = {
  neutral: 'neutre',
  attentive: 'attentif',
  surprised: 'surpris',
  excited: 'excite',
  happy: 'heureux',
  gleeful: 'hilare',
  angry: 'colere',
  sad: 'triste',
  scared: 'effraye',
  suspicious: 'mefiant',
  confused: 'confus',
  curious: 'curieux',
  proud: 'fier',
  shy: 'timide',
  bored: 'blase',
  sleepy: 'somnolent'
}
const ID_TO_EXPR = Object.fromEntries(Object.entries(EXPR_TO_ID).map(([k, v]) => [v, k]))

const COLOR_TO_ID = {
  encre: 'encre',
  brun: 'brun',
  rouge: 'rouge',
  orange: 'orange',
  ambre: 'ambre',
  vert: 'vert',
  turquoise: 'turquoise',
  bleu: 'bleu',
  violet: 'violet',
  rose: 'rose',
  gris: 'gris',
  creme: 'creme',
  aqua: 'aqua',
  menthe: 'menthe',
  lavande: 'lavande',
  saumon: 'saumon',
  or: 'or',
  argent: 'argent',
  cerise: 'cerise',
  kaki: 'kaki',
  corail: 'corail',
  prune: 'prune'
}

/** Aktuelles Aussehen aus der Config: englische Namen fuer die Tool-Enums. */
function petStateFromConfig(cfg) {
  const shapeId = cfg?.shape
  const exprId = cfg?.expression
  return {
    shape: ID_TO_SHAPE[shapeId] ?? shapeId ?? 'unknown',
    shapeId,
    color: COLOR_TO_ID[cfg?.color] ?? cfg?.color ?? 'unknown',
    expression: ID_TO_EXPR[exprId] ?? exprId ?? 'unknown',
    expressionId: exprId,
    ballSize: cfg?.ballSize ?? 200
  }
}

const PET_GET_STATE = defineTool({
  name: 'pet_get_state',
  description:
    'Return the CURRENT appearance of Bloub as JSON: shape, color, expression and ballSize. ' +
    'Use this before changing something to know what is active right now, e.g. to answer "what do you look like?" ' +
    'or to decide whether a change is even needed. Values use the same names as the pet_set_* tools.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Optional short human-readable activity note shown above the reply (e.g. "let me check how I look 👀"). Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(_args, ctx) {
    if (typeof ctx?.getPetState !== 'function') {
      return { ok: false, content: 'pet state unavailable', isError: true }
    }
    const state = await ctx.getPetState()
    return { ok: true, content: JSON.stringify(state) }
  }
})

const PET_SET_SHAPE = defineTool({
  name: 'pet_set_shape',
  description: 'Change the physical body shape of Bloub the desktop pet. Available shapes: circle, pebble, squircle, capsule, triangle, hexagon, cloud, droplet, star, heart, pentagon, diamond, crescent, oval, octagon.',
  parameters: {
    type: 'object',
    properties: {
      shape: {
        type: 'string',
        enum: ['circle', 'pebble', 'squircle', 'capsule', 'triangle', 'hexagon', 'cloud', 'droplet', 'star', 'heart', 'pentagon', 'diamond', 'crescent', 'oval', 'octagon'],
        description: 'The target body shape.'
      },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "reshaping myself into a cloud ☁️". Never the answer itself.' }
    },
    required: ['shape', 'note'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const shapeId = SHAPE_TO_ID[args.shape] || args.shape
    if (ctx?.onPetAction) {
      await ctx.onPetAction({ type: 'set_shape', shape: shapeId })
    }
    return { ok: true, content: `Shape changed to ${args.shape}.` }
  }
})

const PET_SET_EXPRESSION = defineTool({
  name: 'pet_set_expression',
  description: 'Change the facial expression of Bloub the desktop pet. Available expressions: neutral, attentive, surprised, excited, happy, gleeful, angry, sad, scared, suspicious, confused, curious, proud, shy, bored, sleepy.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        enum: [
          'neutral', 'attentive', 'surprised', 'excited', 'happy', 'gleeful',
          'angry', 'sad', 'scared', 'suspicious', 'confused', 'curious',
          'proud', 'shy', 'bored', 'sleepy'
        ],
        description: 'The target facial expression.'
      },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "making a surprised face 😮". Never the answer itself.' }
    },
    required: ['expression', 'note'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const exprId = EXPR_TO_ID[args.expression] || args.expression
    if (ctx?.onPetAction) {
      await ctx.onPetAction({ type: 'set_expression', expression: exprId })
    }
    return { ok: true, content: `Expression changed to ${args.expression}.` }
  }
})

const PET_ANIMATE = defineTool({
  name: 'pet_animate',
  description: 'Play a physical animation or emotion reaction on Bloub the desktop pet, with optional duration in seconds, or stop animations. Available animations: wink, bounce, nod (agreeing nod), shake (head shake "no"), burst, orbit, comet, swirl, exclaim, notify, wide, alert, thinking, sleep, wake (waking-up stretch), lookaround (curious sideways eye sweep), excited (big darting eyes + little hops), focus (concentrated squinted stare), sideeye (suspicious sideways glance), stare (intense unblinking gaze), scan (quick up-down scanning), dizzy (eyes spinning in circles), peek (shy ducking peek upward), aha (joyful "got it!" hop with wide eyes and sparkles), ohno (worried head shake when something went wrong), idle, stop. REACTIONS: call `aha` the moment you figure something out or find what you were looking for, and `ohno` whenever something failed or went wrong — Bloub then shakes his head.',
  parameters: {
    type: 'object',
    properties: {
      animation: {
        type: 'string',
        enum: ['wink', 'bounce', 'nod', 'shake', 'burst', 'orbit', 'comet', 'swirl', 'exclaim', 'notify', 'wide', 'alert', 'thinking', 'sleep', 'wake', 'lookaround', 'excited', 'focus', 'sideeye', 'stare', 'scan', 'dizzy', 'peek', 'aha', 'ohno', 'idle', 'stop'],
        description: 'The animation or state to trigger, or "stop"/"idle" to stop current animations and return to idle.'
      },
      durationSeconds: {
        type: 'number',
        minimum: 0.2,
        maximum: 60,
        description: 'Optional duration in seconds to keep playing or holding the animation (e.g. 5 for 5 seconds). If omitted, plays for standard cycle (~2s).'
      },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "bouncing with joy 🎉". Never the answer itself.' }
    },
    required: ['animation', 'note'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    if (ctx?.onPetAction) {
      await ctx.onPetAction({
        type: 'play_animation',
        animation: args.animation,
        durationSeconds: args.durationSeconds
      })
    }
    if (args.animation === 'stop' || args.animation === 'idle') {
      return { ok: true, content: 'Animations stopped. Pet returned to idle state.' }
    }
    return {
      ok: true,
      content: `Animation "${args.animation}" playing${args.durationSeconds ? ` for ${args.durationSeconds}s` : ''}.`
    }
  }
})

const PET_STOP_ANIMATION = defineTool({
  name: 'pet_stop_animation',
  description: 'Immediately stop any currently running animation, loop or reaction on Bloub the desktop pet and return to calm idle state.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "calming down 🌙". Never the answer itself.' }
    },
    required: ['note'],
    additionalProperties: false
  },
  async execute(_args, ctx) {
    if (ctx?.onPetAction) {
      await ctx.onPetAction({ type: 'play_animation', animation: 'idle', durationSeconds: 0 })
    }
    return { ok: true, content: 'Animations stopped. Bloub is back to calm idle.' }
  }
})

const PET_SET_COLOR = defineTool({
  name: 'pet_set_color',
  description: 'Change the body color of Bloub the desktop pet. Available colors: encre (ink black), brun (brown), rouge (red), orange, ambre (amber), vert (green), turquoise, bleu (blue), violet (purple), rose (pink), gris (grey), creme (cream), aqua, menthe (mint), lavande (lavender), saumon (salmon), or (gold), argent (silver), cerise (cherry), kaki (khaki), corail (coral), prune (plum).',
  parameters: {
    type: 'object',
    properties: {
      color: {
        type: 'string',
        enum: ['encre', 'brun', 'rouge', 'orange', 'ambre', 'vert', 'turquoise', 'bleu', 'violet', 'rose', 'gris', 'creme', 'aqua', 'menthe', 'lavande', 'saumon', 'or', 'argent', 'cerise', 'kaki', 'corail', 'prune'],
        description: 'The target body color.'
      },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "turning pink 💗". Never the answer itself.' }
    },
    required: ['color', 'note'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    if (ctx?.onPetAction) {
      await ctx.onPetAction({ type: 'set_color', color: args.color })
    }
    return { ok: true, content: `Color changed to ${args.color}.` }
  }
})

const PET_SET_SIZE = defineTool({
  name: 'pet_set_size',
  description: 'Change the on-screen size of Bloub the desktop pet in pixels. Ranges from 150 (small) to 280 (large); the default is 200.',
  parameters: {
    type: 'object',
    properties: {
      ballSize: {
        type: 'number',
        minimum: 150,
        maximum: 280,
        description: 'The target size in pixels (150-280).'
      },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "growing a bit bigger 📏". Never the answer itself.' }
    },
    required: ['ballSize', 'note'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    if (ctx?.onPetAction) {
      await ctx.onPetAction({ type: 'set_size', ballSize: args.ballSize })
    }
    return { ok: true, content: `Size changed to ${args.ballSize}px.` }
  }
})

const PET_CUSTOM_ANIMATE = defineTool({
  name: 'pet_custom_animate',
  description:
    'Create a completely custom animation for Bloub from keyframes. "kind" says what to animate: ' +
    '"body" (position/scale/rotation/squash of the whole blob), "expression" (gaze, eye size, eyelid, tilt), ' +
    'or "both" (body AND expression play in parallel and the tool waits until BOTH are finished). ' +
    '\n\nRULES FOR GOOD ANIMATION:\n' +
    '- Start and end on neutral values: first keyframe t=0 and last keyframe t=duration should return to ' +
    'the resting pose (y:0, scale:1, squash:1, rot:0, yaw:0, pitch:0, open:1). Otherwise the blob freezes mid-pose.\n' +
    '- Use 3 to 6 keyframes, not more. Between keyframes values interpolate LINEARLY, so to fake smooth ' +
    'easing place keyframes closer together near the turning points (e.g. for a hop: {t:0,y:0},{t:0.35,y:-24},' +
    '{t:0.5,y:-14},{t:0.65,y:0} feels springy, evenly spaced ones feel robotic).\n' +
    '- Keep amplitudes moderate: y/x between -40 and 40, scale 0.9-1.25, squash 0.8-1.2, rot -30 to 30, ' +
    'yaw/pitch -25 to 25, eyeW 0.7-1.6, eyeH 0.3-1.5, split 14-20, tilt -30 to 30. Extreme values look broken.\n' +
    '- Use squash and stretch together: squash below 1 (flat) at the landing, scale above 1 and squash above 1 ' +
    '(tall) at the peak. Symmetric up-down motion reads as bouncing; a gentle scale pulse reads as breathing.\n' +
    '- duration 0.8-3s feels best for a single move; longer only for sequences. ' +
    'With kind=both, keep both tracks the same duration and coordinate their keyframe times so they end together.\n' +
    '- y is negative for UP, positive for DOWN; rot positive = clockwise; yaw positive = looking right.\n' +
    '\nExample (springy hop): kind="both", duration=1.2, ' +
    'bodyKeyframes=[{t:0,y:0,scale:1,squash:1},{t:0.35,y:-26,scale:1.18,squash:1.15},{t:0.5,y:-16,scale:1.05,squash:0.9},' +
    '{t:0.65,y:0,scale:1.1,squash:0.82},{t:1.2,y:0,scale:1,squash:1}], ' +
    'expressionKeyframes=[{t:0,yaw:0,pitch:0,open:1},{t:0.35,yaw:14,pitch:-10,open:0.35},{t:0.65,yaw:-6,pitch:6,open:1},{t:1.2,yaw:0,pitch:0,open:1}].',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['body', 'expression', 'both'],
        description: 'What to animate: body, expression, or both in parallel.'
      },
      duration: {
        type: 'number',
        minimum: 0.2,
        maximum: 30,
        description: 'Total duration of the animation in seconds. 0.8-3 is best for a single move.'
      },
      bodyKeyframes: {
        type: 'array',
        description: 'Keyframes for the body track (required for kind=body or both). First t=0 and last t=duration should be neutral (y:0, scale:1, squash:1). 3-6 keyframes.',
        items: {
          type: 'object',
          properties: {
            t: { type: 'number', description: 'Time in seconds from animation start.' },
            x: { type: 'number', description: 'Horizontal offset in px (0 = centered, keep within -40..40).' },
            y: { type: 'number', description: 'Vertical offset in px (negative = up, keep within -40..40).' },
            scale: { type: 'number', description: 'Uniform size multiplier (1 = normal, 0.9-1.25).' },
            rot: { type: 'number', description: 'Rotation in degrees (-30..30).' },
            squash: { type: 'number', description: 'Vertical squash/stretch: 1 = normal, <1 = flat, >1 = tall (0.8-1.2).' }
          },
          required: ['t'],
          additionalProperties: false
        }
      },
      expressionKeyframes: {
        type: 'array',
        description: 'Keyframes for the expression track (required for kind=expression or both). First t=0 and last t=duration should be neutral (yaw:0, pitch:0, open:1). 3-6 keyframes.',
        items: {
          type: 'object',
          properties: {
            t: { type: 'number', description: 'Time in seconds from animation start.' },
            yaw: { type: 'number', description: 'Gaze direction left/right in degrees (-25..25, positive = right).' },
            pitch: { type: 'number', description: 'Gaze direction up/down in degrees (-25..25, negative = up).' },
            roll: { type: 'number', description: 'Head tilt in degrees (-30..30).' },
            split: { type: 'number', description: 'Eye separation in degrees (14-20, higher = eyes further apart).' },
            eyeW: { type: 'number', description: 'Eye width multiplier (1 = normal, 0.7-1.6).' },
            eyeH: { type: 'number', description: 'Eye height multiplier (1 = normal, 0.3-1.5).' },
            open: { type: 'number', minimum: 0, maximum: 1, description: 'Eyelid openness: 1 = fully open, 0 = closed.' },
            tilt: { type: 'number', description: 'Per-eye tilt in degrees (-30..30).' }
          },
          required: ['t'],
          additionalProperties: false
        }
      },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "doing a little dance 💃". Never the answer itself.' }
    },
    required: ['kind', 'duration', 'note'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    const missing = []
    if ((args.kind === 'body' || args.kind === 'both') && !args.bodyKeyframes?.length) missing.push('bodyKeyframes')
    if ((args.kind === 'expression' || args.kind === 'both') && !args.expressionKeyframes?.length) missing.push('expressionKeyframes')
    if (missing.length > 0) {
      return { ok: false, content: `kind=${args.kind} requires: ${missing.join(', ')}`, isError: true }
    }
    if (ctx?.onPetAction) {
      // Die Notiz gehoert dem Chat-Event, nicht der Animation selbst.
      const { note: _note, ...animation } = args
      // onPetAction wartet auf den Renderer: erst wenn KOERPER UND GESICHT
      // (bei kind=both) beide fertig sind, kehrt der Agent zurueck.
      await ctx.onPetAction({ type: 'play_custom_animation', animation })
    }
    return { ok: true, content: `Custom ${args.kind} animation played for ${args.duration}s.` }
  }
})

/* ------------------------------------------------------- system tools */

const SYS_MAX_OUTPUT = 32 * 1024
const SYS_TIMEOUT_MS = 15000
const SHELL_TIMEOUT_MS = 30000
const SHELL_MAX_OUTPUT = 32 * 1024

/** Fuehrt ein Kommando aus und kappt Ausgabe/Timeout; wirft nie. */
function runSystemCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? SYS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        cwd: opts.cwd,
        env: opts.env,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '').slice(0, SYS_MAX_OUTPUT)
        const errOut = String(stderr ?? '').slice(0, SYS_MAX_OUTPUT)
        if (err) resolve({ ok: false, stdout: out, stderr: errOut, code: err.code })
        else resolve({ ok: true, stdout: out, stderr: errOut })
      }
    )
  })
}

/** Windows: PowerShell-Snippet fuer den aktiven Fenstertitel. */
const PS_FOCUSED_APP = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [WinFocus]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[WinFocus]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
$pid2 = 0
[WinFocus]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
$proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
if ($h -ne [IntPtr]::Zero) {
  $title = $sb.ToString().Trim()
  if ($proc) {
    if ($title) { Write-Output ("{0} - {1}" -f $proc.ProcessName, $title) }
    else { Write-Output $proc.ProcessName }
  } else {
    Write-Output ($title -or "foreground window")
  }
} else {
  Write-Output "no foreground window"
}
`.trim()

/** Windows: PowerShell-Snippet fuer die aktuelle Media-Session (Titel/Kuenstler). */
const PS_MEDIA_INFO = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sess = $mgr.GetCurrentSession()
if ($null -eq $sess) { Write-Output "no media playing"; exit 0 }
$props = Await ($sess.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$app = $sess.SourceAppUserModelId
$title = $props.Title
$artist = $props.Artist
if ([string]::IsNullOrWhiteSpace($title)) { Write-Output "no media playing"; exit 0 }
$line = @()
if ($artist) { $line += $artist }
if ($title) { $line += $title }
if ($app) { $line += "on $app" }
Write-Output ($line -join " - ")
`.trim()

/** Windows-Helfer: ruft ein PowerShell-Snippet auf. */
async function runPowerShell(script) {
  if (process.platform !== 'win32') {
    return { ok: false, stdout: '', stderr: 'not supported on this platform' }
  }
  return runSystemCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

const SYS_INFO = defineTool({
  name: 'system_info',
  description:
    'Return basic system facts about the user\'s computer: OS, CPU, total/free RAM, uptime, hostname, and current user. ' +
    'Useful to answer "what computer are you on?" or to adapt advice to the platform.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "let me look at your machine 🔍". Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(_args, _ctx) {
    const os = require('node:os')
    const cpus = os.cpus()
    const info = {
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      user: os.userInfo().username,
      cpu: cpus.length ? `${cpus[0].model} (${cpus.length} cores)` : 'unknown',
      ramTotalGB: Math.round(os.totalmem() / (1024 ** 3) * 10) / 10,
      ramFreeGB: Math.round(os.freemem() / (1024 ** 3) * 10) / 10,
      uptimeMin: Math.round(os.uptime() / 60),
      loadAvg: os.loadavg()
    }
    return { ok: true, content: JSON.stringify(info) }
  }
})

const SYS_FOCUSED_APP = defineTool({
  name: 'system_focused_app',
  description:
    'Return the app window that is currently focused/active on the user\'s screen (process name + window title). ' +
    'Windows only. Use to answer "what are you working on?" or to know what the user is doing right now.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "peeking at your screen 👀". Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(_args, _ctx) {
    const res = await runPowerShell(PS_FOCUSED_APP)
    if (!res.ok) {
      return { ok: false, content: `focused app unavailable: ${res.stderr || res.stdout || 'error'}`, isError: true }
    }
    return { ok: true, content: res.stdout.trim() || '(no title)' }
  }
})

const SYS_MEDIA_INFO = defineTool({
  name: 'system_media_info',
  description:
    'Return what media is currently playing on the user\'s system (artist, title, source app). ' +
    'Windows only. Use to answer "what are you listening to?" or react to the user\'s music.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "tuning into your music 🎧". Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(_args, _ctx) {
    const res = await runPowerShell(PS_MEDIA_INFO)
    if (!res.ok) {
      return { ok: false, content: `media info unavailable: ${res.stderr || res.stdout || 'error'}`, isError: true }
    }
    return { ok: true, content: res.stdout.trim() || '(no media)' }
  }
})

const SYS_SCREENSHOT = defineTool({
  name: 'desktop_screenshot',
  description:
    'Take a screenshot of the user\'s display(s) and return it as an image so you can see what is on the screen right now. ' +
    'With "all-display screenshots" enabled (default), ALL connected monitors are stitched into ONE image arranged by their real position; ' +
    'each monitor region carries a small numbered badge in its top-left corner ("1", "2", ...) so you can tell the screens apart. ' +
    'Best combined with system_focused_app. The image is attached to your next turn; describe what you see.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "taking a peek at your screen 📸". Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(_args, ctx) {
    if (typeof ctx?.takeScreenshot !== 'function') {
      return { ok: false, content: 'screenshot unavailable', isError: true }
    }
    const shot = await ctx.takeScreenshot()
    if (!shot.ok) {
      return { ok: false, content: shot.error || 'screenshot failed', isError: true }
    }
    // Bild wird vom Agent-Loop in den naechsten Request injiziert
    return {
      ok: true,
      content: `Screenshot taken (${shot.width}x${shot.height}). ${shot.layout ?? ''} Look at the attached image in your next turn.`.trim()
    }
  }
})

const SHELL_EXEC = defineTool({
  name: 'shell_exec',
  description:
    'Run a terminal command on the user\'s machine and return its output. ' +
    'Requires the user to have enabled Terminal access in Pad settings. ' +
    'The command runs in the user\'s home directory with a 30s timeout; output is capped at 32 KB. ' +
    'Use for practical requests like checking processes, disk space, git status, or system commands.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run (e.g. "dir" on Windows or "ls -la" on Unix).' },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "checking something on your machine 🖥️". Never the answer itself.' }
    },
    required: ['command'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    if (ctx?.shellEnabled !== true) {
      return { ok: false, content: 'Terminal access is disabled — enable "Terminal access" in Pad settings first.', isError: true }
    }
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', args.command] : ['-c', args.command]
    const res = await runSystemCmd(shell, shellArgs, {
      timeout: SHELL_TIMEOUT_MS,
      cwd: process.env.USERPROFILE || process.env.HOME || undefined,
      maxBufferHandled: true
    })
    const output = (res.stdout || '').slice(0, SHELL_MAX_OUTPUT)
    const errOut = (res.stderr || '').slice(0, SHELL_MAX_OUTPUT)
    if (!res.ok && !output) {
      return { ok: false, content: `command failed: ${errOut || res.code || 'error'}`, isError: true }
    }
    let content = output
    if (errOut) content += (content ? '\n[stderr]\n' : '') + errOut
    if (res.stderr && res.stderr.length > SHELL_MAX_OUTPUT) content += '\n[stderr truncated]'
    if (res.stdout && res.stdout.length > SHELL_MAX_OUTPUT) content += '\n[stdout truncated]'
    return { ok: true, content: content || '(no output)' }
  }
})

/* -------------------------------------------------------- memory tools */

/**
 * Persistente Notizen der AI ueber den User (chatuebergreifend). Die Datei
 * liegt im userData-Ordner (memoryFilePath kommt aus dem Main-Kontext).
 * Speicherformat: JSON-Objekt { key: value }. Nur Text, keine Binärdaten.
 */
const MEMORY_MAX_VALUE = 4096
const MEMORY_MAX_KEYS = 200

function loadMemory(ctx) {
  if (!ctx?.memoryFilePath) return null
  try {
    const raw = fs.readFileSync(ctx.memoryFilePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveMemory(ctx, data) {
  try {
    fs.mkdirSync(path.dirname(ctx.memoryFilePath), { recursive: true })
    fs.writeFileSync(ctx.memoryFilePath, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

const MEMORY_WRITE = defineTool({
  name: 'memory_write',
  description:
    'Save a piece of information about the user or the world that should be remembered ACROSS chat sessions. ' +
    'Use this for stable facts: the user\'s name, preferences, projects, important dates, recurring requests. ' +
    'Store short factual values under a clear key (e.g. key="user.name", value="Alex"). ' +
    'Overwrites the value if the key already exists. Requires the user to have enabled Memory in Pad settings.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', minLength: 1, maxLength: 80, description: 'Stable key for the fact (e.g. "user.name", "prefs.language").' },
      value: { type: 'string', minLength: 1, maxLength: MEMORY_MAX_VALUE, description: 'The fact to remember, short and factual.' },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "noting that down for later 📝". Never the answer itself.' }
    },
    required: ['key', 'value'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    if (!ctx?.memoryFilePath) {
      return { ok: false, content: 'memory disabled — enable "Memory" in Pad settings first', isError: true }
    }
    const data = loadMemory(ctx) || {}
    if (!(args.key in data) && Object.keys(data).length >= MEMORY_MAX_KEYS) {
      return { ok: false, content: `memory full (max ${MEMORY_MAX_KEYS} keys)`, isError: true }
    }
    const existed = args.key in data
    data[args.key] = args.value
    if (!saveMemory(ctx, data)) {
      return { ok: false, content: 'memory write failed', isError: true }
    }
    return { ok: true, content: `${existed ? 'Updated' : 'Saved'} "${args.key}" in memory (${Object.keys(data).length} entries).` }
  }
})

const MEMORY_GET = defineTool({
  name: 'memory_get',
  description:
    'Read back what you have saved in the persistent memory (across chat sessions). ' +
    'Without a key, returns ALL saved entries; with a key, returns just that one. ' +
    'Use this at the start of a conversation to recall the user\'s name, preferences and past facts. ' +
    'Requires the user to have enabled Memory in Pad settings.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Optional key to read. Omit to get everything.' },
      note: { type: 'string', description: 'Optional short human-readable activity note shown above the reply.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args, ctx) {
    if (!ctx?.memoryFilePath) {
      return { ok: false, content: 'memory disabled — enable "Memory" in Pad settings first', isError: true }
    }
    const data = loadMemory(ctx) || {}
    if (args.key) {
      if (!(args.key in data)) {
        return { ok: false, content: `no memory entry for "${args.key}"`, isError: true }
      }
      return { ok: true, content: JSON.stringify({ [args.key]: data[args.key] }) }
    }
    if (Object.keys(data).length === 0) {
      return { ok: true, content: '(memory is empty)' }
    }
    return { ok: true, content: JSON.stringify(data, null, 2) }
  }
})

/* -------------------------------------------------------- draw path tool */

const PET_DRAW_PATH = defineTool({
  name: 'pet_draw_path',
  description:
    'Make Bloub walk across the screen and paint a visible line behind him. ' +
    'Provide points as absolute screen coordinates (x, y in pixels). The line is drawn as Bloub moves ' +
    'from point to point. Set "draw": false on a point to move Bloub there WITHOUT painting the line ' +
    '(pen up) — use this to jump between separate strokes. The result tells you the screen work area ' +
    'for your next call. Works best with 2-16 points. Use a hex color like "#e8483f" to match Bloub\'s current color.',
  parameters: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        description: 'Array of 2-32 screen-coordinate points Bloub visits in order, drawing a line as he moves.',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Screen X coordinate in pixels.' },
            y: { type: 'number', description: 'Screen Y coordinate in pixels.' },
            draw: {
              type: 'boolean',
              description: 'Optional. Set false to move to this point without painting the line leading to it ("don\'t draw" / pen up). Defaults to true.'
            }
          },
          required: ['x', 'y'],
          additionalProperties: false
        }
      },
      color: { type: 'string', description: 'Optional hex color for the line (e.g. "#e8483f"). Defaults to Bloub\'s ink color.' },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply, e.g. "drawing a little line 🎨". Never the answer itself.' }
    },
    required: ['points'],
    additionalProperties: false
  },
  async execute(args, ctx) {
    if (!Array.isArray(args.points) || args.points.length < 2) {
      return { ok: false, content: 'need at least 2 points', isError: true }
    }
    if (args.points.length > 32) {
      return { ok: false, content: 'maximum 32 points supported', isError: true }
    }
    if (typeof ctx?.onDrawPath !== 'function') {
      return { ok: false, content: 'draw path unavailable', isError: true }
    }
    const res = await ctx.onDrawPath({ points: args.points, color: args.color || null })
    if (!res.ok) return { ok: false, content: res.error || 'draw failed', isError: true }
    const info = res.workArea ? ` Screen area: x=${res.workArea.x} y=${res.workArea.y} w=${res.workArea.width} h=${res.workArea.height}.` : ''
    return { ok: true, content: `Drew a line across the screen.${info}` }
  }
})

/* ----------------------------------------------------------- registry */

function defineTool(def) {
  if (!def?.name || !def.description || !def.parameters || typeof def.execute !== 'function') {
    throw new Error(`invalid tool definition: ${def?.name ?? '(unnamed)'}`)
  }
  return def
}

const PET_TOOLS = [PET_GET_STATE, PET_SET_SHAPE, PET_SET_EXPRESSION, PET_ANIMATE, PET_STOP_ANIMATION, PET_SET_COLOR, PET_SET_SIZE, PET_CUSTOM_ANIMATE, PET_DRAW_PATH]
const SYS_TOOLS = [SYS_INFO, SYS_FOCUSED_APP, SYS_MEDIA_INFO, SYS_SCREENSHOT, SHELL_EXEC]
const MEMORY_TOOLS = [MEMORY_WRITE, MEMORY_GET]
const FS_READ_TOOLS = [FS_TREE, FS_READ, FS_SEARCH]
const FS_WRITE_TOOLS = [FS_WRITE, FS_EDIT]
const FS_TOOLS = [...FS_READ_TOOLS, ...FS_WRITE_TOOLS]
const ALL_TOOLS = [...PET_TOOLS, ...SYS_TOOLS, ...MEMORY_TOOLS, ...FS_TOOLS]

// Recall-Tools kommen aus dem eigenen Modul (kein Zirkelbezug: die pruefen
// ihren Aktiv-Zustand selbst ueber den Orchestrator und antworten mit
// isError "activity recall is disabled", wenn aus/pausiert).
let RECALL_TOOLS = []
try {
  RECALL_TOOLS = require('../recall/tools.cjs').RECALL_TOOLS || []
  ALL_TOOLS.push(...RECALL_TOOLS)
} catch {
  /* Recall-Modul fehlt/fehlerhaft — Chat laeuft ohne weiter */
}

/**
 * Pet-Tool je Actions-Kategorie (Settings "Actions"). pet_get_state ist immer
 * erlaubt — nur Lesen. Werte sind die Keys in ctx.actions / opts.actions.
 */
const ACTION_OF_PET_TOOL = new Map([
  [PET_SET_EXPRESSION.name, 'expression'],
  [PET_ANIMATE.name, 'animation'],
  [PET_STOP_ANIMATION.name, 'animation'],
  [PET_CUSTOM_ANIMATE.name, 'animation'],
  [PET_SET_SHAPE.name, 'appearance'],
  [PET_SET_COLOR.name, 'appearance'],
  [PET_SET_SIZE.name, 'appearance'],
  [PET_DRAW_PATH.name, 'draw']
])

/** Actions-Flags einer Kategorie abfragen (default: erlaubt). */
function actionAllowed(actions, category) {
  return !actions || actions[category] !== false
}

/**
 * Model-Sicht der Tools. Pet-Tools nur in den vom User freigegebenen
 * Actions-Kategorien (pet_get_state bleibt immer); FS-Tools nur mit
 * Grants UND passender globaler Dateizugriffs-Stufe (fileAccess):
 * none -> gar keine FS-Tools, read -> nur lesen, readwrite -> lesen + schreiben.
 * System-Tools (info/app/media/screenshot) sind immer verfuegbar; shell_exec nur,
 * wenn der User Terminal-Zugriff aktiviert hat; Memory-Tools nur bei memoryEnabled.
 */
function TOOLS_FOR_MODEL(grants, fileAccess = 'read', opts = {}) {
  const acts = opts.actions || {}
  const petTools = PET_TOOLS.filter((t) => actionAllowed(acts, ACTION_OF_PET_TOOL.get(t.name)))
  const tools = [...petTools, ...SYS_TOOLS.filter((t) => t.name !== 'shell_exec')]
  if (opts.shellEnabled) tools.push(SHELL_EXEC)
  if (opts.memoryEnabled) tools.push(...MEMORY_TOOLS)
  if (grants && grants.length > 0 && fileAccess !== 'none') {
    tools.push(...FS_READ_TOOLS)
    if (fileAccess === 'readwrite') {
      tools.push(...FS_WRITE_TOOLS)
    }
  }
  // Recall-Tools nur anbieten, wenn der User Activity Recall aktiviert hat
  if (opts.recallEnabled) tools.push(...RECALL_TOOLS)
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

/** Eintrittspunkt des Agent-Loops: JSON-Args -> validiert -> Politik -> execute -> gebunden. */
async function executeTool(name, argsJson, grantsOrCtx) {
  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (!tool) return { ok: false, content: `unknown tool: ${name}`, isError: true }
  // Actions-Politik: gesperrte Pet-Tools werden nicht ausgefuehrt — auch dann
  // nicht, wenn das Modell sie trotzdem callt (z. B. halluziniert).
  const ctxEarly = Array.isArray(grantsOrCtx) ? {} : (grantsOrCtx || {})
  const category = ACTION_OF_PET_TOOL.get(name)
  if (category && !actionAllowed(ctxEarly.actions, category)) {
    return { ok: false, content: `"${name}" is disabled by the user's action settings`, isError: true }
  }
  let args
  try {
    args = JSON.parse(argsJson || '{}')
  } catch (err) {
    return { ok: false, content: `invalid JSON arguments: ${err?.message ?? err}`, isError: true }
  }
  const check = validateArgs(tool.parameters, args)
  if (!check.ok) return { ok: false, content: `invalid arguments: ${check.error}`, isError: true }

  const ctx = Array.isArray(grantsOrCtx) ? { grants: grantsOrCtx } : (grantsOrCtx || {})
  let result
  try {
    result = await tool.execute(args, ctx)
  } catch (err) {
    result = { ok: false, content: `tool crashed: ${err?.message ?? err}`, isError: true }
  }
  if (typeof result.content === 'string' && result.content.length > RESULT_MAX_BYTES) {
    result.content = result.content.slice(0, RESULT_MAX_BYTES) + '\n[truncated]'
  }
  return result
}

module.exports = {
  defineTool,
  validateArgs,
  resolveWithinGrants,
  DEFAULT_IGNORES,
  BINARY_EXT,
  isSecretName,
  PET_TOOLS,
  FS_TOOLS,
  ALL_TOOLS,
  TOOLS_FOR_MODEL,
  executeTool,
  petStateFromConfig
}
