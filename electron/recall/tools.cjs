// Activity Recall — AI-Tools (Phase 5).
// Vier gebundene Tools fuer den bestehenden Agent-Loop (defineTool-Form).
// Regel: Wenn Recall aus/pausiert ist -> isError "activity recall is
// disabled", NIE still leere Ergebnisse. Alle Resultate sind begrenzt
// (Zeilen, Zellenlaenge, Truncation-Hinweis) — Harness-Bindungsregel.

const orchestrator = require('./orchestrator.cjs')

const MAX_ROWS_TIMELINE = 50
const MAX_ROWS_TERMINAL = 100
const MAX_CELL = 300

/** Zeit-Argument: ms-Epoche, ISO-String oder Relativdauer ("2h"). */
function parseTimeArg(v, base = Date.now()) {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  if (typeof v === 'string') {
    const s = v.trim()
    const rel = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i)
    if (rel) {
      const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase()]
      return Math.round(base - parseFloat(rel[1]) * mult)
    }
    const parsed = Date.parse(s)
    if (!Number.isNaN(parsed)) return parsed
    const n = Number(s)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return undefined
}

function localTime(ts) {
  return new Date(ts).toLocaleString('de-DE', { hour12: false })
}

function cell(v, max = MAX_CELL) {
  const s = String(v ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

function disabled() {
  return { ok: false, content: 'activity recall is disabled', isError: true }
}

function engine() {
  return orchestrator.getEngine()
}

/* ------------------------------------------------------- timeline_search */

const TIMELINE_SEARCH = {
  name: 'timeline_search',
  description:
    'Full-text search over the recorded activity history (terminal commands, app focus switches, browser actions). ' +
    'Time filters accept ms epoch OR ISO strings OR relative like "-2h". Newest first. ' +
    'Requires the user to have Activity Recall enabled in Pad settings.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms (AND semantics, prefix matching).' },
      from: { type: ['string', 'number'], description: 'Start of time window (ms epoch, ISO date, or relative like "-2h").' },
      to: { type: ['string', 'number'], description: 'End of time window.' },
      limit: { type: 'number', minimum: 1, maximum: MAX_ROWS_TIMELINE, description: `Max rows (default/max ${MAX_ROWS_TIMELINE}).` },
      note: { type: 'string', description: 'Short human-readable activity note shown above the reply (e.g. "searching your activity 🔎"). Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args) {
    if (!orchestrator.isActive()) return disabled()
    const eng = engine()
    if (!eng) return disabled()
    const res = eng.search({
      query: String(args.query ?? ''),
      from: parseTimeArg(args.from),
      to: parseTimeArg(args.to),
      limit: Math.min(MAX_ROWS_TIMELINE, Math.max(1, Math.floor(args.limit ?? 20)))
    })
    if (res.rows.length === 0) return { ok: true, content: '(no matching events)' }
    const lines = res.rows.map(
      (e) => `${localTime(e.ts)} [${e.source}/${e.kind}] ${cell(e.app)} — ${cell(e.title, 120)} | ${cell(e.text)}`
    )
    let out = lines.join('\n')
    if (res.truncated) out += `\n[more matches exist — narrow the query or raise limit up to ${MAX_ROWS_TIMELINE}]`
    return { ok: true, content: out }
  }
}

/* ------------------------------------------------------ terminal_history */

const TERMINAL_HISTORY = {
  name: 'terminal_history',
  description:
    'Search the user\'s recently EXECUTED terminal commands (PowerShell/bash), each with working directory and exit code. ' +
    'Use to answer "what did I run?", "how do I undo that git command?" etc. Newest first.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search terms within commands.' },
      from: { type: ['string', 'number'], description: 'Start of time window.' },
      to: { type: ['string', 'number'], description: 'End of time window.' },
      limit: { type: 'number', minimum: 1, maximum: MAX_ROWS_TERMINAL, description: `Max rows (default 20, max ${MAX_ROWS_TERMINAL}).` },
      note: { type: 'string', description: 'Short human-readable note shown above the reply (e.g. "checking your terminal history 💻"). Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args) {
    if (!orchestrator.isActive()) return disabled()
    const eng = engine()
    if (!eng) return disabled()
    const res = eng.search({
      query: String(args.query ?? ''),
      from: parseTimeArg(args.from),
      to: parseTimeArg(args.to),
      source: 'shell',
      kind: 'command',
      limit: Math.min(MAX_ROWS_TERMINAL, Math.max(1, Math.floor(args.limit ?? 20)))
    })
    if (res.rows.length === 0) return { ok: true, content: '(no matching terminal commands)' }
    const lines = res.rows.map((e) => {
      const exit = e.detail?.exitCode
      const exitStr = exit === null || exit === undefined ? '' : ` exit=${exit}`
      const cwd = e.detail?.cwd ? ` cwd=${cell(e.detail.cwd, 120)}` : ''
      return `${localTime(e.ts)} $ ${cell(e.text, 500)}${exitStr}${cwd}`
    })
    let out = lines.join('\n')
    if (res.truncated) out += `\n[more matches exist — narrow the query or raise limit up to ${MAX_ROWS_TERMINAL}]`
    return { ok: true, content: out }
  }
}

/* -------------------------------------------------------- browser_actions */

const BROWSER_ACTIONS = {
  name: 'browser_actions',
  description:
    'Show web actions YOU submitted while Browser link was enabled (posts, comments, form sends): site, page title, URL and a summary of the labeled fields you sent. ' +
    'Never captures passwords or payment fields. Newest first.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search terms within the field summaries.' },
      site: { type: 'string', description: 'Filter by site host substring, e.g. "twitter" or "x.com".' },
      from: { type: ['string', 'number'], description: 'Start of time window.' },
      to: { type: ['string', 'number'], description: 'End of time window.' },
      limit: { type: 'number', minimum: 1, maximum: MAX_ROWS_TIMELINE, description: `Max rows (default/max ${MAX_ROWS_TIMELINE}).` },
      note: { type: 'string', description: 'Short human-readable note shown above the reply (e.g. "looking at your recent posts 🌐"). Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args) {
    if (!orchestrator.isActive()) return disabled()
    const eng = engine()
    if (!eng) return disabled()
    const res = eng.search({
      query: String(args.query ?? ''),
      site: args.site ? String(args.site) : undefined,
      from: parseTimeArg(args.from),
      to: parseTimeArg(args.to),
      source: 'browser',
      kind: 'action',
      limit: Math.min(MAX_ROWS_TIMELINE, Math.max(1, Math.floor(args.limit ?? 20)))
    })
    if (res.rows.length === 0) return { ok: true, content: '(no matching browser actions)' }
    const lines = res.rows.map((e) => {
      const url = e.detail?.url ? cell(e.detail.url, 200) : ''
      return `${localTime(e.ts)} @ ${cell(e.app)} — "${cell(e.title, 150)}"${url ? ` (${url})` : ''}\n  ${cell(e.text, 800).replace(/\n/g, ' ')}`
    })
    let out = lines.join('\n')
    if (res.truncated) out += `\n[more matches exist — narrow the query]`
    return { ok: true, content: out }
  }
}

/* ------------------------------------------------------- timeline_context */

const TIMELINE_CONTEXT = {
  name: 'timeline_context',
  description:
    'Compact chronological digest of what happened on this PC recently: minutes per app plus notable actions (commands, posts). ' +
    'Use for "what was I doing?" questions. Default window: last 2 hours.',
  parameters: {
    type: 'object',
    properties: {
      last: { type: 'string', description: 'Window length, e.g. "30m", "2h" (default), "1d".' },
      note: { type: 'string', description: 'Short human-readable note shown above the reply (e.g. "recapping your session 🕰️"). Never the answer itself.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args) {
    if (!orchestrator.isActive()) return disabled()
    const now = Date.now()
    const from = parseTimeArg(String(args.last ?? '2h'), now)
    const userData = orchestrator.getUserData()
    if (!userData) return disabled()
    const storeMod = require('./store.cjs')
    const events = storeMod.loadEvents(userData, { from, to: now, limit: 5000 })
    if (events.length === 0) return { ok: true, content: `(nothing recorded in the last ${args.last || '2h'})` }

    // Minuten pro App: Fokus-Events gelten bis zum naechsten Event (max 10 min)
    const perApp = new Map()
    const CAP = 10 * 60_000
    for (let i = 0; i < events.length; i++) {
      const ev = events[i] // newest-first -> naechstes Event ist der Vorgaenger
      if (ev.kind !== 'focus' || !ev.app) continue
      const nextTs = i > 0 ? events[i - 1].ts : now
      const dur = Math.min(CAP, Math.max(0, nextTs - ev.ts))
      perApp.set(ev.app, (perApp.get(ev.app) ?? 0) + dur)
    }
    const appLines = [...perApp.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([app, ms]) => `- ${cell(app)}: ${Math.max(1, Math.round(ms / 60000))} min`)
      .join('\n')

    // Notable actions: Commands + Browser-Aktionen, chronologisch, gekappt.
    const notable = events
      .filter((e) => (e.kind === 'command' && e.source === 'shell') || (e.kind === 'action' && e.source === 'browser'))
      .reverse() // chronologisch
      .slice(-40)
      .map((e) => {
        const tag = e.source === 'shell' ? '$' : '@'
        return `${localTime(e.ts)} ${tag} ${cell(e.text, 160)}`
      })

    let out = `Last ${args.last || '2h'}:\n${appLines || '- (no focus data)'}\n\nNotable actions (oldest first):\n${notable.join('\n') || '(none)'}`
    if (events.length >= 5000) out += '\n[window contained many more events — digest capped]'
    return { ok: true, content: out }
  }
}

const RECALL_TOOLS = [TIMELINE_SEARCH, TERMINAL_HISTORY, BROWSER_ACTIONS, TIMELINE_CONTEXT]

module.exports = { RECALL_TOOLS, parseTimeArg }
