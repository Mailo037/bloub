# Implementation Prompt — Bloub Pad AI Chat & Voice Companion

Copy everything below the line into a fresh agent session. It is self-contained: it describes the existing app, the full feature spec, the constraints, the build order, and how to delegate.

---

You are implementing a major feature for **bloub-pet**, a small Electron desktop-pet app, working in the repository at the current working directory. Read this entire brief before writing code. The design rationale lives in `docs/ai-chat-design.md` — read it too, it is the source of truth; this prompt is the execution order.

## 0. What bloub-pet is today

A Windows desktop pet ("Bloub Pad"): a transparent, frameless, always-on-top ball rendered as animated SVG that idles, blinks, follows the cursor with its gaze, and can be dragged around. Stack — respect it, do not modernize it:

- **Electron 35**, plain JavaScript in the main process (`app/electron/main.cjs`, `app/electron/preload.cjs` — `.cjs`, CommonJS).
- **Vanilla TypeScript renderer**, no framework, no React, bundled by **Vite 6** (`app/src/*.ts`, `app/src/index.html`, `app/src/settings.html`). Build with `vite build` → `dist-renderer/`; `pnpm run dev` runs `tools/dev.mjs`.
- **No runtime dependencies** beyond Electron itself. Keep it that way. Anything you add must be hand-rolled or vendored under `app/vendor/` (the bot animation engine already lives there).
- Renderer windows run with `contextIsolation: true`, `nodeIntegration: false`. All native access goes through the preload bridge (`getBridge()` in `app/src/shared.ts`) and `ipcMain` handlers in `main.cjs`.
- The pet window is `focusable: false`, `transparent: true`, click-through via `win.setIgnoreMouseEvents(ignore, { forward: true })` outside the ball.
- Config is a single JSON at `app.getPath('userData')/bloub-pet.config.json`, loaded into `config`, saved debounced by `saveConfig()`, broadcast to windows via `broadcastConfig()`. Extend this — do not invent a second config system.
- The ball has a **state machine** (`app/vendor/bot/`): one-shot states (`wink`, `thinking`, `comet`, `orbit`, …) played via `playOnce(id)` with `busyUntil` timing, expressions (`EXPRESSION_BY_ID`), shapes/skins, gaze tracking. New animations are added here following the existing state definitions.

## 1. What you are building

Turn the bloub into a summonable AI companion with this exact UX:

### 1.1 Summoning

- Global hotkey **Win+Alt+X** via `globalShortcut.register('Super+Alt+X', ...)` in `app.whenReady()`. If registration returns `false`, silently fall back to `Ctrl+Alt+B` and show a one-time tray notification explaining the swap. Unregister everything on quit.
- Double-clicking the ball also toggles the chat (zero-risk fallback).
- Summoning shows the **chat window** docked under the ball; dismissing (Esc, focus loss, or toggling again) hides it.

### 1.2 Chat window (`chatWin`)

A third transparent frameless `BrowserWindow`, modeled on the existing `showSettings()` code path, but **`focusable: true`** (the pet and settings windows are not). Details:

- Created lazily, shown/hidden afterwards. Position: below the ball from `winX/winY + ballR + margin`, clamped to the work area (reuse the `clampToWorkArea` logic pattern).
- Auto-resizing height: input row (~56 px) plus reply area, capped at ~40 % of the work area height, then internal scroll.
- Layout: rounded input bar with an auto-growing single-line input (Enter sends, Shift+Enter newline) and a **round send button** on the right.
- **Send → the input row collapses away.** The user's message shrinks into a small dim chip above the reply area (so they remember what they asked — never shown as scrollback).
- Attachments render as small chips (icon + name + size) between input and send button; click removes.
- **Esc** or focus-loss hides the window. An in-flight stream is NOT aborted — it continues into history; the next summon shows "…" if something arrived.
- While chatWin is visible the pet window stays `focusable: false` — no changes needed.

### 1.3 Reply rendering — the glimmer

The reply appears **below the bloub**, not in a chat panel:

- **Thinking:** the ball plays its existing `thinking` state (three dots); the reply area shows shimmering **ghost text** — a gradient sweep via CSS `background: linear-gradient(...)`, `background-clip: text`, animated `background-position`. GPU-composited, no JS per-frame work.
- **Streaming:** tokens replace the ghost text and keep glimmering while arriving.
- **Done:** one final sweep, then the text settles to solid ink color; the ball plays a completion one-shot (`wink` or `notify`).
- The finished reply stays visible until dismissed (Esc / click-away / next send). Clicking it slides the input row back for a follow-up.
- Markdown-lite only: bold, italic, inline code, fenced code blocks. Escape everything else — never inject provider output as HTML.
- Tool activity appears as a one-line status inside the shimmering ghost text (e.g. "reading `src/pet.ts` …") — transient, never history.
- Long replies scroll; auto-scroll while streaming unless the user scrolled up.

### 1.4 Input: paste and drag

- **Paste** listener on the input: `text/plain` → inline text attachment; clipboard images → image attachment chip.
- **Drag onto the ball**: the ball itself is the only drop target (the rest of the pet window is click-through — this matches the "feed the bloub" UX). On `dragover`, the bloub leans toward the cursor / opens its mouth expression. On `drop`, get paths via `webUtils.getPathForFile` (Electron 35, renderer has no Node), send over IPC (`chat:attach`), and play a new one-shot **`absorb`** state — a ~0.8 s vortex/suck-in animation added to the vendor bot state list following the existing one-shot shape (like `comet`/`orbit`).
- Accepted: text-ish files (`.txt .md` code, `.json`, `.csv`, …) read as text at send time (size-capped); images (`.png .jpg .webp .gif`) sent as vision content if the model supports it, otherwise the chip says "needs vision model"; **folders** become workspace grants (§1.6); PDFs are out of scope — chip says "unsupported (yet)".

### 1.5 Provider layer — user-configurable endpoint + protocol

The user enters a **Base URL** (free text) and picks the **API protocol** from a dropdown:

- `openai-completions` — OpenAI, Groq, OpenRouter, Together, LM Studio, Ollama `/v1`, llama.cpp, DeepSeek (the default)
- `openai-responses` — OpenAI's newer `/v1/responses` API
- `anthropic-messages` — Anthropic `/v1/messages`

Implement as **adapters**, one file per protocol under `app/electron/chat/protocols/`, each with exactly two functions:

```js
// buildRequest(normalizedRequest, providerConfig) → { url, headers, body }
// parseStream(sseAsyncIterable) → AsyncIterable of normalized events
//   { type: 'token', text } | { type: 'tool_call', id, name, argsJson }
//   | { type: 'done', usage? } | { type: 'error', message }
```

The agent loop only ever sees the normalized shape. Protocol differences stay inside adapters: auth (`Authorization: Bearer` vs `x-api-key` + `anthropic-version`), tool-call encoding (OpenAI `tool_calls` vs Anthropic `tool_use` blocks), vision blocks (OpenAI `image_url` vs Anthropic `image` source), SSE event shapes. Tool schemas are declared once in plain JSON Schema; each adapter translates (the two OpenAI flavors and Anthropic's `input_schema` are near-identical).

Config keys added to the existing config JSON (all under `chat`): `baseUrl` (default `https://api.openai.com/v1`), `protocol`, `model`, `apiKeyEnc` (encrypted with Electron `safeStorage` — **never plaintext on disk**), `maxHistoryTurns` (default 40), `voiceAlways` (default false), `chatHotkey` (default `Super+Alt+X`).

Streaming: tokens forwarded over IPC (`chat:token`) to chatWin. Abort: `chat:abort` IPC → `AbortController` kills the fetch; partial output is kept in history marked `truncated`. Errors render in the reply area in red with the provider's message verbatim.

### 1.6 Tool-calling loop with folder grants

Steal the architecture of the DeepSeek Harness (do NOT import its packages — they are cordis-based and far too heavy; reimplement the patterns in ~200 lines):

**Tool definition** — every tool is `{ name, description, parameters (JSON Schema), execute(args, ctx) }`. Validate args against the schema BEFORE execute; invalid args never reach `execute`. Results are `{ ok, content, isError? }`. Bound every result before it enters context: line windows, max line length, byte caps; oversized output is truncated with an explicit "[truncated, use offset]" hint.

**Tools (v1, filesystem only):**

| Tool | Behavior |
|------|----------|
| `fs_tree` | names-only listing of a granted folder, max depth 12, max 500 entries, default-ignores `.git`, `node_modules`, `dist`, `build`, `.pnpm-store`, `__pycache__`, binary extensions |
| `fs_read` | line-numbered read with `offset`/`limit`, default/max 2000 lines, 256 KB per call |
| `fs_search` | regex content search within a grant, max 250 matches |

**Path policy:** dropping a folder creates a **workspace grant** `{ path, grantedAt }` (stored in config, shown as a chip with a tiny shield toggle). Every tool path argument must resolve inside an existing grant, else `isError: "path outside granted folders"`. No grants → tools are not even sent to the model. **Secret refusal:** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*` return an error unless that grant's "allow secrets" shield was explicitly enabled (never default).

**The loop:** user message → provider stream → if text, render + persist; if `tool_calls`, execute sequentially, append tool results as messages, call the provider again. Hard cap **6 hops**; hitting the cap appends a system note "tool budget exhausted — answer now". Log every call (§1.7) even though the UI never shows history.

### 1.7 Hidden conversation memory

- Append-only **JSONL** at `userData/chat-history.jsonl`, one record per message (`role`, `content`, `attachments`, `toolCalls`, `ts`). Append + flush per message; ignore a torn last line on load.
- Each send: load last `maxHistoryTurns` records as provider messages; when over budget, prune tool call/result pairs first.
- **"Clear memory"** button in settings: archive the JSONL to `chat-history.archived-<ts>.jsonl`, then start fresh. Nothing silently destroyed.

### 1.8 Settings additions

New "Chat" section in the existing settings window (`app/src/settings.ts` / `settings.html` / `settings.css`):

- Base URL (text field), API protocol (dropdown, the three options), model name, API key (password field).
- **Test button**: sends a 1-token ping through the *selected* adapter, shows ✓/✗ with the provider's error verbatim — catches wrong protocol/URL/key in one click.
- Sensible protocol guesses when a known host is typed (`api.anthropic.com` → `anthropic-messages`, `localhost:*`/`127.0.0.1:*` → `openai-completions`) — the dropdown always wins over the guess.
- Hotkey field with live "test registration" status and fallback notice.
- Toggles: always answer with voice, tool use on/off. Button: Clear memory.

### 1.9 Voice mode (build LAST, after everything else works)

- **STT (push-to-talk):** hotkey again while chatWin is open, or a mic button → record via renderer `getUserMedia` → PCM chunks to main → **whisper.cpp** (`base`/`small` GGML, CPU) as a child process → transcript into the input bar for confirm-or-send.
- **TTS:** reply → **Piper** (~30 MB/voice) or **Kokoro-82M** (~330 MB, better) → WAV → renderer playback. While speaking, the ball plays a new `talk` state (mouth pulse driven by audio amplitude). Model files live in `userData/models/`; a settings button downloads them showing sizes first.
- `voiceAlways` setting auto-speaks every reply; a small speaker icon in the reply mutes per-reply.

## 2. Build order — implement in these phases, verify each before moving on

1. **Core loop:** provider adapters + chatWin + typed send + streaming glimmer reply + JSONL history + clear memory. This proves the whole pipe with zero extras.
2. **Hotkey:** Win+Alt+X with fallback + tray notice + settings field.
3. **Attachments:** paste + drag files/images onto the ball, `absorb` animation, chips, vision routing.
4. **Tools:** folder grants + the three fs tools + path policy + the hop-capped loop.
5. **Voice:** whisper push-to-talk, TTS, `talk` animation.

## 3. How to work — delegation and verification

- **Use subagents for parallelizable, self-contained pieces.** Good candidates: the three protocol adapters (each is independent given the adapter interface — write the interface + one reference adapter yourself first, then delegate the other two with the interface and the normalized event spec verbatim); the fs tools + path policy (pure logic, unit-testable without Electron); the markdown-lite renderer; the `absorb` and `talk` animation states in the vendor bot engine. Give each subagent the relevant section of this brief plus the exact file paths and existing code patterns to imitate — they cannot see this conversation.
- **Never delegate** the main-process wiring (`main.cjs` IPC, window management), the config schema, or phase sequencing — those pieces interlock and you must hold them in one head.
- **Integrate subagent output yourself**, then verify: `pnpm run build` must pass, and `pnpm start` must show the pet unchanged when chat is untouched.
- After each phase, do a manual smoke pass in the running app (you can launch it; describe what to click if you cannot automate it). Do not claim a phase is done without the build passing AND the feature demonstrably working.
- TypeScript renderer changes must compile with the existing `tsconfig.json` — no new compiler options, no `any`-escaliers.
- Keep the code style of the surrounding files: CommonJS in `.cjs`, ESM imports in renderer TS, terse comments in the existing tone (German comments appear in `main.cjs` — match the file's existing language).

## 4. Hard constraints

- **No new npm dependencies.** Everything hand-rolled or vendored. (Phase 5's whisper.cpp/Piper are child processes with downloaded binaries, not npm packages.)
- **No plaintext API keys on disk**, ever — `safeStorage` only.
- **Never render provider or file content as raw HTML.**
- **Never let a tool touch a path outside a grant.** Deny by default, including symlinks that escape.
- The pet's existing behavior must not regress: idle animations, dragging, gaze, settings window, tray, single-instance lock all keep working.
- Windows-only is fine (that's the target platform), but use Electron APIs, not native modules.

## 5. Definition of done

All five phases merged, `pnpm run build` clean, and this end-to-end scenario works: press Win+Alt+X → input bar appears under the ball → type "summarize this folder" with a folder dragged onto the bloub → absorb animation plays → thinking dots → ghost text glimmers while tools list and read files inside the grant → reply streams in glimmering and settles solid → ball winks → history exists in JSONL but is invisible in the UI → Clear memory archives it. Voice mode additionally: hold-to-talk transcribes, reply speaks through the local TTS voice while the ball's mouth pulses.

Report per phase: what was built, which subagents produced what, build status, and what you verified by running the app.
