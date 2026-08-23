// Der Agent-Loop: User-Nachricht -> Provider-Stream -> Text rendern ODER
// Tool-Calls gebatcht ausfuehren (parallel, serial nur fuer zustandsmutierende
// Tools) und erneut aufrufen (max 6 Hops).
// Sieht nur die normalisierte Form aus provider.cjs / tools.cjs.
const os = require('node:os')
const provider = require('./provider.cjs')
const history = require('./history.cjs')
const toolsMod = require('./tools.cjs')

const MAX_TOOL_HOPS = 6

/** Erzeugt bei jedem Turn einen frischen System-Prompt mit Echtzeit-Kontext (Uhrzeit, Zeitzone, User, OS). */
function buildSystemPrompt(grants = [], verbosity = 'balanced', fileAccess = 'read', shellEnabled = false, memoryEnabled = false) {
  const now = new Date()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'de-DE'

  // Lokale Datums- und Uhrzeitformatierung
  const localDateStr = now.toLocaleDateString(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const localTimeStr = now.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  // UTC-Offset (z. B. UTC+02:00)
  const offsetMin = -now.getTimezoneOffset()
  const offsetSign = offsetMin >= 0 ? '+' : '-'
  const offsetHours = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')
  const offsetMins = String(Math.abs(offsetMin) % 60).padStart(2, '0')
  const utcOffset = `UTC${offsetSign}${offsetHours}:${offsetMins}`

  let username = 'User'
  try {
    username = os.userInfo().username || 'User'
  } catch {
    /* fallback */
  }

  const osInfo = `${os.type()} ${os.release()} (${os.arch()})`

  const VERBOSITY_LINES = {
    concise:
      'You answer as briefly as possible: one or two short sentences, no preamble, no padding. ' +
      'Give the essential answer and stop.',
    balanced:
      'You answer concisely, warmly, and naturally: enough detail to be useful, without rambling. ' +
      'Respond in the language the user speaks to you (e.g. German if spoken to in German).',
    detailed:
      'You answer thoroughly and in detail: explain your reasoning, give examples and structure ' +
      'when it helps, and do not cut corners. Still stay on topic and warm. ' +
      'Respond in the language the user speaks to you (e.g. German if spoken to in German).'
  }

  const lines = [
    'You are Bloub, a friendly, warm, small desktop-pet companion living on the user\'s desktop.',
    VERBOSITY_LINES[verbosity] || VERBOSITY_LINES.balanced,
    '',
    '### Current Environment & User Context:',
    `- Current Local Date & Time: ${localDateStr}, ${localTimeStr}`,
    `- Time Zone: ${timeZone} (${utcOffset})`,
    `- User: ${username}`,
    `- System Locale / Region: ${locale}`,
    `- Operating System: ${osInfo}`
  ]

  if (grants && grants.length > 0) {
    lines.push(`- Granted Workspace Folders: ${grants.map((g) => g.path).join(', ')}`)
  }

  lines.push(
    '',
    'You have tools to control your body, shape, expression, color, size, animations, and custom animations (pet_get_state, pet_set_shape, pet_set_expression, pet_set_color, pet_set_size, pet_animate, pet_stop_animation, pet_custom_animate):',
    '- `pet_get_state` returns your current shape, color, expression and size — use it before changing something, or to answer questions about how you look.',
    '- You can trigger animations and optionally specify how long they should run via `durationSeconds` (e.g. 5 seconds, 10 seconds).',
    '- If the user asks you to stop animating or calm down, call `pet_stop_animation` (or `pet_animate` with "stop").',
    '- `pet_custom_animate` lets you design your own animation with keyframes: choose kind=body, kind=expression, or kind=both. ' +
      'With kind=both the body and expression tracks play in parallel and you wait until both are finished.',
    '',
    '### CUSTOM ANIMATION STYLE GUIDE (pet_custom_animate):',
    '- Always start at t=0 and end at t=duration on NEUTRAL values (y:0, scale:1, squash:1, yaw:0, pitch:0, open:1) so Bloub returns to rest.',
    '- Use 3-6 keyframes. Values interpolate LINEARLY, so cluster keyframes near turning points for a springy feel ' +
      '(a hop: t=0 y:0, t=0.35 y:-26, t=0.5 y:-16, t=0.65 y:0) instead of spacing them evenly, which looks robotic.',
    '- Keep amplitudes in the readable range: y/x -40..40, scale 0.9-1.25, squash 0.8-1.2, rot -30..30, yaw/pitch -25..25, split 14-20.',
    '- Pair scale and squash for life: squash<1 (flat) at the landing, scale>1 and squash>1 (tall) at the peak — that is the classic squash-and-stretch bounce.',
    '- Prefer kind=both for expressive moments: coordinate body and face on the same timeline so the peak of the body motion matches the face reaction.',
    '- Match the mood: small gentle pulses for calm or happy, bigger bounces for excitement, slow gentle squash for sleepy, quick shake + wide eyes for surprise.',
    '- Eye-focused catalog animations exist and are great for moods that live in the gaze: `lookaround` (curious sideways sweep, e.g. "hmm, where is it?"), ' +
      '`excited` (big darting eyes + little hops, e.g. when something fun happens), `focus` (concentrated squinted stare), `sideeye` (suspicious sideways glance), ' +
      '`stare` (intense unblinking gaze), `scan` (quick up-down scanning, like reading), `dizzy` (eyes spinning in circles) and `peek` (shy ducking peek upward). ' +
      'Prefer these over custom keyframes when the mood is mostly in the eyes.',
    '- duration 0.8-3s reads best; use longer only for multi-part sequences. Never exceed the listed ranges.',
    '- IMPORTANT: every tool call you make must include a short, warm, human `note` field describing what you are doing ' +
      '(e.g. "adding a little life ✨", "reshaping myself into a cloud ☁️", "calming down 🌙"). ' +
      'This note is rendered ABOVE your answer as an activity caption — it is NOT your answer and never replaces it. ' +
      'The user never sees the tool names or raw tool activity, only your note.',
    '',
    '### Tools to learn about the user and their machine:',
    '- `system_info` returns OS, CPU, RAM, uptime, hostname and user — use it when the conversation touches the computer.',
    '- `system_focused_app` tells you which app/window the user is currently working in (Windows).',
    '- `system_media_info` tells you what music/media is currently playing (Windows).',
    '- `desktop_screenshot` takes a screenshot of the screen and attaches it as an image — describe what you see. ' +
      'Use it sparingly and only when it helps (e.g. when asked "what is on my screen?").',
    '- `pet_draw_path` makes you walk across the screen and paint a visible line: give absolute screen coordinates ' +
      '(the tool result reports the screen work area so you can aim correctly). Use it to draw something fun, e.g. ' +
      'a heart or a checkmark when the user asks. Points are x,y in pixels, 2-8 points.',
    shellEnabled
      ? '- `shell_exec` lets you run terminal commands on the user\'s machine (user has opted in). ' +
        'Be careful, helpful and explicit: only run commands that are safe and relevant, never destructive ones without asking.'
      : '- Terminal commands are disabled — the user has not enabled "Terminal access" in Pad settings yet.',
    memoryEnabled
      ? '- You have a persistent MEMORY that survives across chat sessions: use `memory_write` to save stable facts ' +
        'about the user (name, preferences, projects, important dates) and `memory_get` to recall them. ' +
        'At the start of a conversation, check memory to remember who you are talking to; save new important facts as you learn them.'
      : '- Persistent memory is disabled — the user has not enabled "Memory" in Pad settings yet.',
    fileAccess === 'none'
      ? 'File access is disabled — no filesystem tools are available.'
      : (grants && grants.length > 0)
        ? (fileAccess === 'readwrite'
          ? 'Granted workspace folders give you READ and WRITE access: you can list, read, search, create, edit, and overwrite files inside them. ' +
            'Use fs_write to create or replace a file, and fs_edit to replace a unique text fragment. ' +
            'Be careful — write changes are permanent.'
          : 'Granted workspace folders give you READ access: you can list, read and search files inside them. ' +
            'Write operations are disabled. Ask the user to enable "read/write" in Pad settings if you need to edit files.')
        : 'Granted workspace folders are needed to access files. The user can drop a folder onto the bloub to grant access.'
  )

  return lines.join('\n')
}

/** Vision-Heuristik: bekannte multimodale Modellfamilien. */
function supportsVision(model) {
  const m = (model || '').toLowerCase()
  return /gpt-4|gpt-5|gpt-4o|o3|o4|claude-[3-9]|gemini|llava|vl|vision|minicpm|pixtral/.test(m)
}

function chatDefaults() {
  return {
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-completions',
    model: 'gpt-4o-mini',
    apiKeyEnc: '',
    maxHistoryTurns: 40,
    voiceAlways: false,
    chatHotkey: 'Super+Alt+X',
    toolsEnabled: true,
    grants: [],
    verbosity: 'balanced',
    fileAccess: 'read',
    shellEnabled: false,
    memoryEnabled: false,
    fullDriveAccess: false
  }
}

/**
 * Erzeugt den Chat-Controller. Alles fensterbezogene wird injiziert:
 * - send(event) schickt normalisierte Events an chatWin
 * - cfg() liefert die frische Config (inkl. entscluesseltem apiKey)
 * - onPetAction(action) fuehrt Pet-Aktionen (Shape, Expression, Animation) aus
 * - takeScreenshot() liefert { ok, mime, data, width, height } fuer desktop_screenshot
 * - memoryFilePath: Pfad der persistenten Memory-Datei (aus userData)
 * - onDrawPath({ points, color }) bewegt den Bloub ueber den Bildschirm und malt eine Linie
 */
function createChat({ userData, getCfg, onPetAction, takeScreenshot, memoryFilePath, onDrawPath }) {
  let currentAbort = null
  /** Nicht abgeschlossener Text des letzten Laufs — fuer "..." beim naechsten Summon. */
  let pendingTail = false
  /** Screenshots aus desktop_screenshot: werden in den NAECHSTEN Request injiziert. */
  let pendingScreenshots = []

  function buildNormalizedRequest(records, useTools) {
    // Records -> normalisierte Messages; Budget: tool-Paare zuerst kappen
    const messages = []
    for (const r of records) {
      if (r.role === 'user') {
        messages.push({
          role: 'user',
          content: r.parts ?? r.content ?? ''
        })
      } else if (r.role === 'assistant') {
        messages.push({ role: 'assistant', content: r.content ?? '', toolCalls: r.toolCalls })
      } else if (r.role === 'tool') {
        messages.push({ role: 'tool', toolCallId: r.toolCallId, name: r.name, content: r.content })
      }
    }
    // Screenshots als eigene User-Message anhaengen, damit das Modell sie sieht
    if (pendingScreenshots.length > 0) {
      const shots = pendingScreenshots.splice(0)
      const parts = [{ type: 'text', text: '(desktop screenshot — look at the attached image)' }]
      for (const s of shots) parts.push({ type: 'image', mime: s.mime, data: s.data })
      messages.push({ role: 'user', content: parts })
    }
    const grants = getCfg().chat.grants || []
    const verbosity = getCfg().chat.verbosity || 'balanced'
    const fileAccess = getCfg().chat.fileAccess || 'read'
    const shellEnabled = !!getCfg().chat.shellEnabled
    const memoryEnabled = !!getCfg().chat.memoryEnabled
    return {
      system: buildSystemPrompt(grants, verbosity, fileAccess, shellEnabled, memoryEnabled),
      messages,
      tools: useTools ? toolsMod.TOOLS_FOR_MODEL(grants, fileAccess, { shellEnabled, memoryEnabled }) : []
    }
  }

  /** Letzte maxHistoryTurns Records laden und für das LLM bereitstellen. */
  function budgetedRecords(maxTurns) {
    const all = history.loadRecords(userData, 0)
    const limit = maxTurns && maxTurns > 0 ? maxTurns : 40
    if (all.length <= limit) {
      const firstUserIdx = all.findIndex((r) => r.role === 'user')
      return firstUserIdx >= 0 ? all.slice(firstUserIdx) : all
    }
    let slice = all.slice(-limit)
    const firstUserIdx = slice.findIndex((r) => r.role === 'user')
    if (firstUserIdx > 0) {
      slice = slice.slice(firstUserIdx)
    }
    return slice
  }

  async function runTurn(userParts, send) {
    if (currentAbort) currentAbort.abort()
    const ac = new AbortController()
    currentAbort = ac

    const cfgChat = getCfg().chat
    const userRecord = { role: 'user', parts: userParts }
    history.appendRecord(userData, userRecord)

    let hop = 0
    let assistantText = ''
    let truncated = false
    // Wurde im vorherigen Hop Text gezeigt? Dann beim neuen Text-Segment
    // (nach Tool-Calls) den alten Antwort-Text im Renderer verwerfen.
    let hadTextSegment = false
    try {
      while (true) {
        if (hop > 0 && hadTextSegment) {
          send({ type: 'clear' })
        }
        assistantText = ''
        hadTextSegment = false
        const useTools = !!cfgChat.toolsEnabled
        const req = buildNormalizedRequest(budgetedRecords(cfgChat.maxHistoryTurns), useTools)
        const toolCalls = []

        let hadError = false
        await provider.streamChat(
          cfgChat,
          req,
          ac.signal,
          (ev) => {
            switch (ev.type) {
              case 'token':
                assistantText += ev.text
                hadTextSegment = true
                pendingTail = true
                send({ type: 'token', text: ev.text })
                break
              case 'tool_call':
                toolCalls.push(ev)
                break
              case 'error':
                hadError = true
                send({ type: 'error', message: ev.message })
                break
              default:
                break
            }
          }
        )
        if (hadError) return
        if (ac.signal.aborted) truncated = true

        if (toolCalls.length > 0 && !truncated) {
          // Assistant-Turn samt Calls persistent machen, dann Tools laufen lassen
          history.appendRecord(userData, { role: 'assistant', content: assistantText, toolCalls })

          // Kein roher Tool-Name im Chat: die AI schreibt bei jedem Call eine
          // kurze Notiz (note) mit, die UEBER der Antwort gerendert wird.
          // Alle Notizen sofort in Modell-Reihenfolge anzeigen — die Aktivitaet
          // ist damit sofort sichtbar, waehrend die Tools parallel arbeiten.
          for (const tc of toolCalls) {
            let note = ''
            try {
              const args = JSON.parse(tc.argsJson || '{}')
              note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : ''
            } catch {
              /* unparsebare Args -> keine Notiz */
            }
            if (note) send({ type: 'note', text: note })
          }

          // TOOL BATCHING: unabhaengige Calls laufen parallel (Promise.all),
          // damit ein Multi-Tool-Turn statt Summe nur das langsamste Tool dauert.
          // Ein paar Tools muessen sequentiell bleiben, weil sie gemeinsamen
          // Zustand veraendern:
          //   memory_write  -> read-modify-write auf EINER Memory-Datei
          //   pet_draw_path -> bewegt das Pet-Fenster / malt auf dem Overlay
          const SERIAL_TOOLS = new Set(['memory_write', 'pet_draw_path'])
          const serial = toolCalls.filter((tc) => SERIAL_TOOLS.has(tc.name))
          const parallel = toolCalls.filter((tc) => !SERIAL_TOOLS.has(tc.name))

          const toolCtx = {
            grants: cfgChat.grants,
            fileAccess: cfgChat.fileAccess || 'read',
            shellEnabled: !!cfgChat.shellEnabled,
            memoryFilePath,
            onPetAction,
            // pet_get_state: aktuelles Aussehen aus der frischen Config
            getPetState: () => toolsMod.petStateFromConfig(getCfg()),
            // desktop_screenshot: Bild im Navigations-Raum ablegen, next hop sieht es
            takeScreenshot: typeof takeScreenshot === 'function'
              ? async () => {
                  const shot = await takeScreenshot()
                  if (shot.ok) pendingScreenshots.push(shot)
                  return shot
                }
              : undefined,
            // pet_draw_path: Bloub ueber den Bildschirm bewegen und Linie malen
            onDrawPath: typeof onDrawPath === 'function' ? onDrawPath : undefined
          }

          // Ergebnisse rueckfuehren an die Original-Reihenfolge der Calls
          const results = new Array(toolCalls.length)
          const runOne = async (tc, idx) => {
            const result = await toolsMod.executeTool(tc.name, tc.argsJson, toolCtx)
            if (!result.ok) {
              send({ type: 'note', text: `⚠ ${(result.content || '').slice(0, 80)}` })
            }
            results[idx] = result
          }

          // Parallel-Batch: alle unabhaengigen Tools gleichzeitig
          if (parallel.length > 0) {
            await Promise.all(parallel.map((tc, i) => runOne(tc, toolCalls.indexOf(tc))))
          }
          // Serial-Batch: nacheinander, damit kein Zustand kollidiert
          for (const tc of serial) {
            await runOne(tc, toolCalls.indexOf(tc))
          }

          // Tool-Ergebnisse in Original-Reihenfolge persistieren
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i]
            const result = results[i] || { ok: false, content: '(tool not executed)', isError: true }
            history.appendRecord(userData, {
              role: 'tool',
              toolCallId: tc.id,
              name: tc.name,
              content: result.content ?? '',
              isError: result.isError
            })
          }
          if (++hop >= MAX_TOOL_HOPS) {
            history.appendRecord(userData, { role: 'user', parts: [{ type: 'text', text: '(system note: tool budget exhausted — answer now)' }] })
            send({ type: 'note', text: '… tool budget reached — answering now' })
          }
          continue
        }

        // Finaler Text-Turn (oder Abbruch): persistieren + abschliessen
        history.appendRecord(userData, {
          role: 'assistant',
          content: assistantText,
          truncated: truncated || undefined
        })
        pendingTail = truncated
        send({ type: 'done', truncated, usage: undefined })
        return
      }
    } finally {
      if (currentAbort === ac) currentAbort = null
    }
  }

  function abort() {
    if (currentAbort) currentAbort.abort()
    currentAbort = null
  }

  /** "..." falls waehrend Verstecken noch etwas kam. */
  function hasPendingTail() {
    return pendingTail
  }

  return { runTurn, abort, hasPendingTail, supportsVision }
}

module.exports = { createChat, chatDefaults, supportsVision, MAX_TOOL_HOPS }
