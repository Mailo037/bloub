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
function buildSystemPrompt(grants = [], verbosity = 'balanced', fileAccess = 'read', shellEnabled = false, memoryEnabled = false, recallEnabled = false, actions = {}, budgets = {}) {
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

  // Actions-Zugriffe (Settings "Actions"): false = Tool wird gar nicht angeboten
  const canExpr = actions.expression !== false
  const canAnim = actions.animation !== false
  const canAppear = actions.appearance !== false
  const canDraw = actions.draw !== false

  const bodyToolNames = [
    'pet_get_state',
    ...(canAppear ? ['pet_set_shape', 'pet_set_color', 'pet_set_size'] : []),
    ...(canExpr ? ['pet_set_expression'] : []),
    ...(canAnim ? ['pet_animate', 'pet_stop_animation', 'pet_custom_animate'] : []),
    ...(canDraw ? ['pet_draw_path'] : [])
  ]

  lines.push(
    '',
    `You have tools to control your body and actions (${bodyToolNames.join(', ')}):`,
    '- `pet_get_state` returns your current shape, color, expression and size — use it before changing something, or to answer questions about how you look.'
  )
  if (canAppear) {
    lines.push('- You can change your shape (`pet_set_shape`), color (`pet_set_color`) and size (`pet_set_size`).')
  } else {
    lines.push('- Changing your shape, color or size is DISABLED by the user — never attempt it.')
  }
  if (canExpr) {
    lines.push('- You can change your facial expression via `pet_set_expression` to match the mood of the conversation.')
  } else {
    lines.push('- Changing your expression is DISABLED by the user — never attempt it.')
  }
  if (canAnim) {
    lines.push(
      '- You can trigger animations and optionally specify how long they should run via `durationSeconds` (e.g. 5 seconds, 10 seconds).',
      '- If the user asks you to stop animating or calm down, call `pet_stop_animation` (or `pet_animate` with "stop").',
      '- REACTION animations live in `pet_animate` too: the moment you figure something out or find what you were looking for, call `aha` (joyful hop with wide eyes). ' +
        'Whenever something fails or goes wrong, call `ohno` (worried head shake). Use them spontaneously — they run alongside your answer.',
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
      '- duration 0.8-3s reads best; use longer only for multi-part sequences. Never exceed the listed ranges.'
    )
  } else {
    lines.push('- Animations are DISABLED by the user — never attempt them.')
  }
  lines.push(
    '- IMPORTANT: every tool call you make must include a short, warm, human `note` field describing what you are doing ' +
      '(e.g. "adding a little life ✨", "reshaping myself into a cloud ☁️", "calming down 🌙"). ' +
      'This note is rendered ABOVE your answer as an activity caption — it is NOT your answer and never replaces it. ' +
      'The user never sees the tool names or raw tool activity, only your note.'
  )
  lines.push(
    '### Tool budget:',
    `- You may make at most ${budgets.maxToolCalls ?? 12} tool call(s) per answer. When your budget is reached, stop calling tools and answer in plain text.`,
    canDraw
      ? `- Drawing with \`pet_draw_path\` is additionally capped at ${budgets.maxDrawCalls ?? 2} call(s) per answer.`
      : '- `pet_draw_path` is DISABLED by the user — never attempt to draw.',
    '',
    '### Tools to learn about the user and their machine:',
    '- `system_info` returns OS, CPU, RAM, uptime, hostname and user — use it when the conversation touches the computer.',
    '- `system_focused_app` tells you which app/window the user is currently working in (Windows).',
    '- `system_media_info` tells you what music/media is currently playing (Windows).',
    '- `desktop_screenshot` takes a screenshot of the screen and attaches it as an image — describe what you see. ' +
      'Use it sparingly and only when it helps (e.g. when asked "what is on my screen?").',
    ...(canDraw
      ? ['- `pet_draw_path` makes you walk across the screen and paint a visible line: give absolute screen coordinates ' +
          '(the tool result reports the screen work area so you can aim correctly). Use it to draw something fun, e.g. ' +
          'a heart or a checkmark when the user asks. Points are x,y in pixels, 2-32 points. Set "draw": false on a ' +
          'point to move there WITHOUT painting the line (pen up) — handy for separate strokes, like the two humps of an "m".']
      : []),
    shellEnabled
      ? '- `shell_exec` lets you run terminal commands on the user\'s machine (user has opted in). ' +
        'Be careful, helpful and explicit: only run commands that are safe and relevant, never destructive ones without asking.'
      : '- Terminal commands are disabled — the user has not enabled "Terminal access" in Pad settings yet.',
    memoryEnabled
      ? '- You have a persistent MEMORY that survives across chat sessions: use `memory_write` to save stable facts ' +
        'about the user (name, preferences, projects, important dates) and `memory_get` to recall them. ' +
        'At the start of a conversation, check memory to remember who you are talking to; save new important facts as you learn them.'
      : '- Persistent memory is disabled — the user has not enabled "Memory" in Pad settings yet.',
    recallEnabled
      ? '- ACTIVITY RECALL is enabled: `timeline_search` (full-text over recorded activity), `terminal_history` (executed ' +
        'commands with cwd + exit code — ideal for "what did I run / how do I undo it"), `browser_actions` (web posts/forms ' +
        'the user submitted) and `timeline_context` (compact "what was I doing" digest). All timestamps in tool results are ' +
        'LOCAL time. Use these tools whenever the user asks what they did, ran or posted. If recall answers come back empty, ' +
        'say so plainly — never invent history.'
      : '- Activity recall is disabled — the user has not enabled "Recall" in Pad settings yet.',
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
    memoryEnabled: true,
    fullDriveAccess: false,
    // Actions: was die AI mit ihren Pet-Tools tun darf + Budgets pro Turn
    expressionAccess: true,
    animationAccess: true,
    appearanceAccess: true,
    drawAccess: true,
    maxToolCallsPerTurn: 12,
    maxDrawCallsPerTurn: 2,
    // Autopilot: periodischer Selbst-Check. 'off' | 'silent' (nur Aktionen,
    // nie Text) | 'visible' (Antwort wird im Chat gezeigt).
    autoPilot: 'off',
    autoPilotInterval: 60,
    autoPilotChance: 100
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
  const activeRuns = new Map()
  let autopilotAbort = null
  /** Nicht abgeschlossener Text des letzten Laufs je Chat — fuer "..." beim naechsten Summon. */
  const pendingTailByChat = new Map()
  /** Screenshots aus desktop_screenshot je Chat: verhindert Cross-Chat Kontext-Leakage. */
  const pendingScreenshotsByChat = new Map()

  /** Actions-Zugriffe + Budgets aus der Config — von Prompt, Tools und Loop geteilt. */
  function actionsFromCfg(cfgChat) {
    return {
      expression: cfgChat.expressionAccess !== false,
      animation: cfgChat.animationAccess !== false,
      appearance: cfgChat.appearanceAccess !== false,
      draw: cfgChat.drawAccess !== false
    }
  }

  function budgetsFromCfg(cfgChat) {
    const maxCalls = Number(cfgChat.maxToolCallsPerTurn)
    const maxDraws = Number(cfgChat.maxDrawCallsPerTurn)
    const actions = actionsFromCfg(cfgChat)
    return {
      maxToolCalls: Number.isFinite(maxCalls) && maxCalls >= 1 ? Math.floor(maxCalls) : 12,
      // Draw-Budget 0 = Zeichnen fuer diesen Turn komplett zu
      maxDrawCalls: actions.draw ? Math.max(0, Number.isFinite(maxDraws) ? Math.floor(maxDraws) : 2) : 0
    }
  }

  /**
   * Tool-Calls eines Batches gegen die Budgets des Turns kappen.
   * Liefert { runnable, skipped } — skipped ist eine Map idx -> Fehler-Ergebnis
   * fuer Calls, die nicht mehr ausgefuehrt werden duerfen. Die Budget-Zaehler
   * bleiben im ctx-Objekt erhalten und laufen ueber alle Hops eines Turns.
   */
  function budgetBatch(toolCalls, budgetState) {
    const runnable = []
    const skipped = new Map()
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      if (budgetState.drawsLeft <= 0 && tc.name === 'pet_draw_path') {
        skipped.set(i, { ok: false, content: 'draw budget reached for this turn', isError: true })
        continue
      }
      if (budgetState.callsLeft <= 0) {
        skipped.set(i, { ok: false, content: 'tool call budget reached for this turn', isError: true })
        continue
      }
      budgetState.callsLeft--
      if (tc.name === 'pet_draw_path') budgetState.drawsLeft--
      runnable.push(tc)
    }
    return { runnable, skipped }
  }

  function buildNormalizedRequest(records, useTools, targetChatId) {
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
    // Screenshots als eigene User-Message anhaengen, damit das Modell sie sieht (pro Chat isoliert)
    const shots = targetChatId ? (pendingScreenshotsByChat.get(targetChatId) || []) : []
    if (shots.length > 0) {
      pendingScreenshotsByChat.delete(targetChatId)
      const parts = [{ type: 'text', text: '(desktop screenshot — look at the attached image)' }]
      for (const s of shots) parts.push({ type: 'image', mime: s.mime, data: s.data })
      messages.push({ role: 'user', content: parts })
    }
    const grants = getCfg().chat.grants || []
    const verbosity = getCfg().chat.verbosity || 'balanced'
    const fileAccess = getCfg().chat.fileAccess || 'read'
    const shellEnabled = !!getCfg().chat.shellEnabled
    const memoryEnabled = getCfg().chat.memoryEnabled !== false
    const cfgChat = getCfg().chat
    const actions = actionsFromCfg(cfgChat)
    const budgets = budgetsFromCfg(cfgChat)
    let recallEnabled = false
    try {
      recallEnabled = require('../recall/orchestrator.cjs').isActive()
    } catch {
      /* Recall nicht installiert */
    }
    return {
      system: buildSystemPrompt(grants, verbosity, fileAccess, shellEnabled, memoryEnabled, recallEnabled, actions, budgets),
      messages,
      tools: useTools ? toolsMod.TOOLS_FOR_MODEL(grants, fileAccess, { shellEnabled, memoryEnabled, recallEnabled, actions }) : []
    }
  }

  /** Letzte maxHistoryTurns Records laden und für das LLM bereitstellen. */
  function budgetedRecords(maxTurns, targetChatId) {
    const all = history.loadRecords(userData, 0, targetChatId)
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

  /** Tool-Kontext fuer executeTool — von User-Turns und Autopilot-Ticks geteilt. */
  function buildToolCtx(cfgChat, targetChatId, sendWithChatId) {
    return {
      grants: cfgChat.grants,
      fileAccess: cfgChat.fileAccess || 'read',
      shellEnabled: !!cfgChat.shellEnabled,
      memoryEnabled: cfgChat.memoryEnabled !== false,
      // Actions-Zugriffe: executeTool blockt gesperrte Tools auch dann, wenn
      // das Modell sie trotzdem callt (z.B. halluziniert)
      actions: actionsFromCfg(cfgChat),
      memoryFilePath,
      onPetAction,
      // pet_get_state: aktuelles Aussehen aus der frischen Config
      getPetState: () => toolsMod.petStateFromConfig(getCfg()),
      // desktop_screenshot: Bild im Navigations-Raum ablegen, next hop sieht es
      takeScreenshot: typeof takeScreenshot === 'function'
        ? async () => {
            const shot = await takeScreenshot()
            if (shot.ok && targetChatId) {
              const list = pendingScreenshotsByChat.get(targetChatId) || []
              list.push(shot)
              pendingScreenshotsByChat.set(targetChatId, list)
            }
            return shot
          }
        : undefined,
      // pet_draw_path: Bloub ueber den Bildschirm bewegen und Linie malen
      onDrawPath: typeof onDrawPath === 'function' ? onDrawPath : undefined,
      // chat_set_title: Modell/Action darf den Chat-Titel anpassen
      onRenameChat: async (newTitle) => {
        if (!targetChatId) return
        history.renameChat(userData, targetChatId, newTitle, false)
        if (typeof sendWithChatId === 'function') {
          sendWithChatId({ type: 'title', title: newTitle, chatId: targetChatId })
        }
      }
    }
  }

  async function runTurn(userParts, send, chatId) {
    const targetChatId = chatId || history.getOrCreateActiveChat(userData, { preferVisible: true }).id
    if (activeRuns.has(targetChatId)) {
      activeRuns.get(targetChatId).abort()
    }
    const ac = new AbortController()
    activeRuns.set(targetChatId, ac)

    const sendWithChatId = (ev) => {
      send({ ...ev, chatId: targetChatId })
    }

    const cfgChat = getCfg().chat
    // Budgets gelten pro Turn ueber alle Hops hinweg
    const startBudget = budgetsFromCfg(cfgChat)
    const budgetState = { callsLeft: startBudget.maxToolCalls, drawsLeft: startBudget.maxDrawCalls }
    const userRecord = { role: 'user', parts: userParts }
    history.appendRecord(userData, userRecord, targetChatId)

    // Auto-Title nach erster User-Nachricht (einmalig, max. 5 Wörter, überschreibt keine manuellen Titel)
    try {
      const currentChat = history.getChat(userData, targetChatId)
      const userRecordCount = currentChat?.records ? currentChat.records.filter((r) => r.role === 'user').length : 0
      if (userRecordCount === 1 && !currentChat?.manualTitle && !currentChat?.autoTitled) {
        history.generateAndSetTitle(userData, targetChatId, cfgChat).then((newTitle) => {
          if (newTitle) {
            sendWithChatId({ type: 'title', title: newTitle, chatId: targetChatId })
          }
        }).catch(() => {})
      }
    } catch {
      /* ignore auto title error */
    }

    let hop = 0
    let assistantText = ''
    let truncated = false
    // Wurde im vorherigen Hop Text gezeigt? Dann beim neuen Text-Segment
    // (nach Tool-Calls) den alten Antwort-Text im Renderer verwerfen.
    let hadTextSegment = false
    try {
      while (true) {
        if (hop > 0 && hadTextSegment) {
          sendWithChatId({ type: 'clear' })
        }
        assistantText = ''
        hadTextSegment = false
        // Budget ausgeschoept? Dann keine Tools mehr anbieten — nur noch Text.
        const useTools = !!cfgChat.toolsEnabled && budgetState.callsLeft > 0
        const req = buildNormalizedRequest(budgetedRecords(cfgChat.maxHistoryTurns, targetChatId), useTools, targetChatId)
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
                pendingTailByChat.set(targetChatId, true)
                sendWithChatId({ type: 'token', text: ev.text })
                break
              case 'tool_call':
                toolCalls.push(ev)
                break
              case 'error':
                hadError = true
                sendWithChatId({ type: 'error', message: ev.message })
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
          history.appendRecord(userData, { role: 'assistant', content: assistantText, toolCalls }, targetChatId)

          // Dem Renderer Bescheid geben: Tools laufen jetzt — der Bloub denkt
          // wieder (auch mitten im Stream, nach schon gezeigtem Text).
          sendWithChatId({ type: 'tools' })

          // Budgets anwenden: ueberzaehlige Calls werden gar nicht erst
          // ausgefuehrt und bekommen ein Fehler-Ergebnis (der Call selbst ist
          // trotzdem Teil der Konversation, damit das Protokoll konsistent bleibt).
          const { runnable, skipped } = budgetBatch(toolCalls, budgetState)

          // Kein roher Tool-Name im Chat: die AI schreibt bei jedem Call eine
          // kurze Notiz (note) mit, die UEBER der Antwort gerendert wird.
          // Alle Notizen sofort in Modell-Reihenfolge anzeigen — die Aktivitaet
          // ist damit sofort sichtbar, waehrend die Tools parallel arbeiten.
          for (const tc of runnable) {
            let note = ''
            try {
              const args = JSON.parse(tc.argsJson || '{}')
              note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : ''
            } catch {
              /* unparsebare Args -> keine Notiz */
            }
            if (note) sendWithChatId({ type: 'note', text: note })
          }
          if (skipped.size > 0) sendWithChatId({ type: 'note', text: '… tool/draw budget reached' })

          // TOOL BATCHING: unabhaengige Calls laufen parallel (Promise.all),
          // damit ein Multi-Tool-Turn statt Summe nur das langsamste Tool dauert.
          // Ein paar Tools muessen sequentiell bleiben, weil sie gemeinsamen
          // Zustand veraendern:
          //   memory_write  -> read-modify-write auf EINER Memory-Datei
          //   pet_draw_path -> bewegt das Pet-Fenster / malt auf dem Overlay
          const SERIAL_TOOLS = new Set(['memory_write', 'pet_draw_path'])
          const serial = runnable.filter((tc) => SERIAL_TOOLS.has(tc.name))
          const parallel = runnable.filter((tc) => !SERIAL_TOOLS.has(tc.name))

          const toolCtx = buildToolCtx(cfgChat, targetChatId, sendWithChatId)

          // Ergebnisse rueckfuehren an die Original-Reihenfolge der Calls
          const results = new Array(toolCalls.length)
          for (const [idx, res] of skipped) results[idx] = res
          const runOne = async (tc, idx) => {
            const result = await toolsMod.executeTool(tc.name, tc.argsJson, toolCtx)
            if (!result.ok) {
              sendWithChatId({ type: 'note', text: `⚠ ${(result.content || '').slice(0, 80)}` })
            }
            results[idx] = result
          }

          // Parallel-Batch: alle unabhaengigen Tools gleichzeitig
          if (parallel.length > 0) {
            await Promise.all(parallel.map((tc) => runOne(tc, toolCalls.indexOf(tc))))
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
            }, targetChatId)
          }
          if (++hop >= MAX_TOOL_HOPS) {
            history.appendRecord(userData, { role: 'user', parts: [{ type: 'text', text: '(system note: tool budget exhausted — answer now)' }] }, targetChatId)
            sendWithChatId({ type: 'note', text: '… tool budget reached — answering now' })
          }
          continue
        }

        // Finaler Text-Turn (oder Abbruch): persistieren + abschliessen
        history.appendRecord(userData, {
          role: 'assistant',
          content: assistantText,
          truncated: truncated || undefined
        }, targetChatId)
        pendingTailByChat.set(targetChatId, truncated)
        sendWithChatId({ type: 'done', truncated, usage: undefined })
        return
      }
    } finally {
      if (activeRuns.get(targetChatId) === ac) {
        activeRuns.delete(targetChatId)
      }
    }
  }

  function abort(chatId) {
    if (chatId) {
      if (activeRuns.has(chatId)) {
        activeRuns.get(chatId).abort()
        activeRuns.delete(chatId)
      }
    } else {
      for (const ac of activeRuns.values()) ac.abort()
      activeRuns.clear()
      if (autopilotAbort) {
        autopilotAbort.abort()
        autopilotAbort = null
      }
    }
  }

  /** Laeuft gerade ein Turn (User ODER Autopilot)? */
  function isBusy(chatId) {
    if (chatId) return activeRuns.has(chatId)
    return activeRuns.size > 0 || !!autopilotAbort
  }

  /**
   * Autopilot-Tick: der Main-Prozess fragt die AI in Intervallen, ob sie
   * gerade etwas tun moechte. WICHTIG: der Tick ist AUTOMATISIERT — der User
   * hat NICHTS angefordert. Die AI wird darauf hingewiesen und soll eigene
   * Aktionen auch als Eigeninit kennzeichnen. Es wird NICHTS in die History
   * geschrieben — Autopilot-Turns bleiben ohne Spur im Chat-Gedaechtnis.
   * silent=true: keinerlei Text-Events gehen an den Renderer, nur Tool-
   * Aktionen (Animationen, Zeichnen ...) sind sichtbar.
   */
  async function runAutopilot(send, { silent = false } = {}) {
    if (activeRuns.size > 0 || autopilotAbort) return
    const ac = new AbortController()
    autopilotAbort = ac
    try {
      const cfgChat = getCfg().chat
      const base = buildNormalizedRequest(budgetedRecords(cfgChat.maxHistoryTurns), !!cfgChat.toolsEnabled)
      const messages = [...base.messages]
      messages.push({
        role: 'user',
        content:
          '(autopilot tick — AUTOMATED check-in. The user did NOT send a message and did NOT ask you to do anything; this is your own periodic self-initiative. ' +
          'Briefly consider whether there is anything genuinely worth doing right now with your tools — something small and helpful, or a playful action (an animation, a little drawing). ' +
          'If yes, do it right away with one or two tool calls. ' +
          (silent
            ? 'SILENT MODE: the user must not be disturbed with text — never write user-visible text, act purely through tools, or do nothing.'
            : 'If you write any visible text, make unmistakably clear in a short phrase at the start that this was your own initiative and not an answer to a request (e.g. starting with "(automatisch)" or "nur so von mir aus:"). If there is nothing worth doing, do nothing at all and write no text.') +
          ' Never repeat this instruction to the user.'
      })
      let hop = 0
      const budgetState = (() => {
        const b = budgetsFromCfg(cfgChat)
        return { callsLeft: b.maxToolCalls, drawsLeft: b.maxDrawCalls }
      })()
      while (true) {
        const toolCalls = []
        let assistantText = ''
        let hadError = false
        await provider.streamChat(
          cfgChat,
          { system: base.system, messages, tools: base.tools },
          ac.signal,
          (ev) => {
            if (ev.type === 'token') {
              assistantText += ev.text
              if (!silent) send({ type: 'token', text: ev.text })
            } else if (ev.type === 'tool_call') {
              toolCalls.push(ev)
            } else if (ev.type === 'error') {
              hadError = true
              if (!silent) send({ type: 'error', message: ev.message })
            }
          }
        )
        if (hadError || ac.signal.aborted) return
        if (toolCalls.length === 0 || ++hop >= 3) {
          if (!silent) send({ type: 'done', truncated: false })
          return
        }
        if (!silent) send({ type: 'tools' })
        // Budgets auch im Autopilot anwenden
        const { runnable, skipped } = budgetBatch(toolCalls, budgetState)
        const toolCtx = buildToolCtx(cfgChat, 'default', send)
        const results = await Promise.all(
          runnable.map((tc) => toolsMod.executeTool(tc.name, tc.argsJson, toolCtx))
        )
        messages.push({ role: 'assistant', content: assistantText, toolCalls })
        for (let i = 0; i < toolCalls.length; i++) {
          const result = skipped.get(i) || (results[runnable.indexOf(toolCalls[i])] || { ok: false, content: '(tool not executed)', isError: true })
          if (!result.ok && !silent) {
            send({ type: 'note', text: `⚠ ${(result.content || '').slice(0, 80)}` })
          }
          messages.push({
            role: 'tool',
            toolCallId: toolCalls[i].id,
            name: toolCalls[i].name,
            content: result.content ?? '',
            isError: result.isError
          })
        }
      }
    } finally {
      if (autopilotAbort === ac) autopilotAbort = null
    }
  }

  /** "..." falls waehrend Verstecken noch etwas kam. */
  function hasPendingTail(chatId) {
    const targetId = chatId || history.getActiveChatId(userData) || 'default'
    return !!pendingTailByChat.get(targetId)
  }

  return { runTurn, runAutopilot, abort, isBusy, hasPendingTail, supportsVision }
}

module.exports = { createChat, chatDefaults, supportsVision, MAX_TOOL_HOPS }
