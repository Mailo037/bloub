# Bloub Pad — AI Chat & Voice Companion (Design)

Status: design, not yet implemented.
Owner: bloub-pet.

## 1. What we're building

The bloub becomes a summonable AI companion:

- **Win+Alt+X** (global hotkey) pops a small rounded **input bar** directly under the ball.
- Type and send, **paste** (text/images), or **drag files / images / folders onto the bloub** — an absorb/vortex animation plays while the bloub "eats" them.
- On send: the input hides, the `thinking` state plays (three dots), and the reply **appears below the bloub** — text that glimmers while it streams, then settles solid.
- Optional **voice mode** (settings): replies are spoken via local TTS; push-to-talk input via local STT.
- **No visible chat history** — but the model retains full conversation memory (persisted on disk). "Clear memory" lives in settings.

## 2. Windows & lifecycle

Three renderer windows, all transparent/frameless (pattern already proven by `settingsWin`):

| Window    | Focusable | Purpose                                        |
|-----------|-----------|------------------------------------------------|
| `win`     | no        | The ball (unchanged)                           |
| `settingsWin` | no    | Settings (extended, see §8)                    |
| `chatWin` | **yes**   | Input bar + reply bubble, docked under the ball |

### chatWin behavior

- Created lazily on first summon; shown/hidden afterwards.
- Positioned from `winX/winY + ballR + margin`, clamped to the work area (reuse `clampToWorkArea` logic).
- Auto-resizes to content: input row (~56 px) + reply bubble (grows, max ~40 % of work area height, then scrolls).
- **Send → the input hides.** The typed text collapses into the bubble as your message chip and the input row slides away; the reply then appears **below the bloub** (see §7). Pressing the hotkey again — or clicking the reply — brings the input back for a follow-up.
- **Esc** or focus-loss hides everything (abort in-flight stream? no — stream continues into history; next summon shows "…").
- While `chatWin` is visible, the pet window keeps `focusable: false` — no changes needed there.

### Hotkey

- `globalShortcut.register('Super+Alt+X', toggleChat)` in `app.whenReady()`.
- If registration returns `false` (combo already owned): fall back to `Ctrl+Alt+B`, and show a one-time tray balloon explaining the swap.
- Config keys: `chatHotkey` (default `Super+Alt+X`), re-registered on change from settings.
- Always unregister on quit (`globalShortcut.unregisterAll()` in `will-quit`).
- Double-clicking the ball also toggles chat (zero-risk fallback, matches the pet metaphor).

## 3. Input: typing, pasting, dragging

### Typed input
Single-line auto-growing `<input>`/`<textarea>`, Enter sends, Shift+Enter newline.

### Paste
`paste` listener on the input: `text/plain` → inline text; `text/uri-list` / image clipboard items → image attachment. Attachments render as small chips between input and send button; click a chip to remove it.

### Drag onto the bloub
- Drop target is the **ball itself** (the pet window is click-through elsewhere — this constraint matches the "feed the bloub" UX).
- `dragover` on the ball: bloub leans toward cursor / opens "mouth" expression (existing gaze/expression infra).
- On `drop`: read `e.dataTransfer.files` → paths via `webUtils.getPathForFile` (Electron 35; renderer has no Node). Send paths over IPC (`chat:attach`).
- Play a new **`absorb`** state: one-shot vortex/suck-in animation added to the vendor bot state list (same shape as `comet`/`orbit` one-shots), ~0.8 s, then back to idle.
- Attachment chip appears in chatWin with icon + name (+ size). Click to remove.

Accepted drop types:
- **Text-ish files** (`.txt .md .code .json .csv …`): read as text at send time, size-capped.
- **Images** (`.png .jpg .webp .gif`): sent as vision content blocks if the active provider/model supports it; otherwise the chip shows "needs vision model".
- **Folders**: become a **workspace grant** — not inlined (see §5).
- **PDF**: out of scope v1; chip shows "unsupported (yet)".

## 4. Provider layer (main process)

The user picks **any base URL** and the **wire protocol** that endpoint speaks (like the DSH model settings):

| Protocol              | Covers                                                        |
|-----------------------|---------------------------------------------------------------|
| `openai-completions`  | OpenAI, Groq, OpenRouter, Together, LM Studio, Ollama `/v1`, llama.cpp, DeepSeek — the de-facto standard |
| `openai-responses`    | OpenAI's newer Responses API (`/v1/responses`)                |
| `anthropic-messages`  | Anthropic (`/v1/messages`)                                     |

### Adapter interface

```ts
// app/main/chat/protocols/<name>.cjs — one file per protocol
interface ChatAdapter {
  // Normalized request: messages + tools in our internal shape → protocol wire format
  buildRequest(req: NormalizedRequest, cfg: ProviderConfig): { url, headers, body }
  // Consumes the SSE stream, emits normalized events
  parseStream(sse: AsyncIterable<string>): AsyncIterable<NormalizedEvent>
}
type NormalizedEvent =
  | { type: 'token', text: string }
  | { type: 'tool_call', id: string, name: string, argsJson: string }   // accumulated
  | { type: 'done', usage?: TokenUsage }
  | { type: 'error', message: string }
```

- The agent loop (§5) only ever sees `NormalizedRequest`/`NormalizedEvent` — protocol differences (auth header `Authorization: Bearer` vs `x-api-key` + `anthropic-version`; `tool_calls` vs `tool_use` blocks; SSE event shapes) stay inside the adapters.
- Tool schemas are declared once in our JSON-Schema shape; `anthropic-messages` and both OpenAI flavors each get a small translator (input_schema vs function.parameters — near-identical).
- Vision content blocks likewise normalized once (OpenAI `image_url` vs Anthropic `image` source blocks).

Config (in `bloub-pet.config.json`):
```jsonc
{
  "chat": {
    "baseUrl": "https://api.openai.com/v1",   // user-entered, any endpoint
    "protocol": "openai-completions",         // openai-completions | openai-responses | anthropic-messages
    "model": "gpt-4o-mini",
    "apiKeyEnc": "<safeStorage-encrypted>",   // never plaintext
    "maxHistoryTurns": 40,                    // context window guard
    "voiceAlways": false
  }
}
```

- API key encrypted with Electron `safeStorage` before touching disk.
- Streaming: each adapter's `parseStream` emits normalized events; tokens forward over IPC (`chat:token`) to chatWin; `tool_call` events dispatch to the tool loop (§5).
- Abort: closing chatWin or pressing Esc mid-stream sends `chat:abort`; the `AbortController` kills the fetch; partial output is kept in history marked `truncated`.
- Errors land in the bubble in red, with the provider's message (rate limit, bad key, model not found).
- Settings "Test" button (§8) pings with the *selected protocol's* cheapest request, so a wrong protocol choice is caught immediately with a clear message.

## 5. Tool-calling loop — patterns stolen from deepseek-harness

We don't import harness packages (cordis-based, too heavy for bloub-pet); we steal the **architecture**:

### Tool definition (harness `defineTool` pattern)

```ts
// app/main/chat/tools.ts (main process)
interface ToolDef<A> {
  name: string
  description: string                    // model-facing, one paragraph max
  parameters: JSONSchema                 // validated before execution
  execute(args: A, ctx: ToolCtx): Promise<ToolResult>
}
```

- Every tool: schema-validate args → execute → return `{ ok, content, isError? }`. Invalid args never reach `execute`.
- Tool results are **bounded** before entering context (harness `read` caps: line windows, max line length, max bytes; oversized output spills to a temp file with a "read with offset" hint).

### The loop (harness agent-loop pattern, simplified)

```
user message ──► provider stream ──► text? ──► bubble + history
                                    └─► tool_calls? ──► batch: independent calls
                                          run in PARALLEL (Promise.all),
                                          state-mutating ones (memory_write,
                                          pet_draw_path) stay sequential
                                          ──► append tool results as messages
                                          ──► call provider again (max N hops, e.g. 6)
```

- Parallel tool batching: models often emit several tool calls in one turn; running
  them concurrently cuts a multi-tool hop from `t1 + t2 + t3` to `max(t1, t2, t3)`.
  Notes/activity captions are still rendered in model order before execution, and
  tool results are persisted in original call order, so history stays deterministic.

- `maxToolHops` guard prevents runaway loops; hitting it appends a system note "tool budget exhausted — answer now".
- Each tool call is logged (see §7) even though the UI never shows history.

### Tools v1 (filesystem, scoped to granted workspaces)

| Tool        | What it does                                                        | Harness inspiration      |
|-------------|---------------------------------------------------------------------|--------------------------|
| `fs_tree`   | Names-only listing of a granted folder (depth-capped)                | `glob`/workspace listing |
| `fs_read`   | Line-numbered read with `offset`/`limit` (default/max caps)          | `read` (tool-fs)         |
| `fs_search` | Regex content search within a grant, capped matches                  | `grep`                   |

### Path policy (harness fs-sandbox pattern)

- Drops of folders create a **workspace grant** for the session: `{ path, grantedAt }` stored in config, listed in the bubble as a chip.
- Every tool path argument resolves against grants only: outside any grant → `isError: "path outside granted folders"`. No grant → tools aren't even sent to the model.
- Default ignore during traversal: `.git`, `node_modules`, `dist`, `build`, `.pnpm-store`, `__pycache__`, binary extensions.
- **Secret refusal**: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*` return an error unless the grant was created with "allow secrets" (never default). The bubble chip for a folder gets a tiny shield toggle for this.
- Caps: max depth 12, max files per `fs_tree` 500, max read 2000 lines / 256 KB per call, max search matches 250.

## 6. Conversation memory (hidden)

- Append-only **JSONL** at `userData/chat-history.jsonl` — one record per message (`role`, `content`, `attachments`, `toolCalls`, `ts`) (harness session-persistence-jsonl pattern).
- On each send, load last `maxHistoryTurns` records → provider messages; tool call/result pairs count as turns but are pruned first when over budget (harness compaction "prune tool results first" pattern).
- "Clear memory" button in settings: archives the JSONL to `chat-history.archived-<ts>.jsonl` (nothing is silently destroyed) and starts fresh.
- Crash-safe: append + flush per message; a torn last line is ignored on load.

## 7. Reply rendering & animations

**The reply lives under the bloub, not in a chat panel.** After send, the input row collapses and a borderless reply bubble fades in directly beneath the ball:

- **Thinking:** three dots *and* the reply area shows a soft **glimmer** — a shimmering gradient sweep across ghost text (CSS: `background: linear-gradient(...)`, `background-clip: text`, animated `background-position`; cheap, GPU-composited, fits the acrylic look).
- **Streaming:** tokens replace the ghost text and keep glimmering while they arrive — the whole bubble reads as "the bloub is speaking this".
- **Done:** the glimmer settles — one last sweep, then the text solidifies to normal ink color. The ball plays a completion one-shot (`wink`/`notify` depending on sentiment).
- The bubble stays until dismissed (Esc / click-away / new send); clicking it reopens the input row underneath for a follow-up.
- Your sent message shows as a small dim chip above the reply (so you remember what you asked), never as scrollback.

Other rendering details:
- Reply text renders with markdown-lite (bold/italic/code blocks only — no heavy MD lib; escape everything else).
- Tool activity shows as a one-line status inside the glimmering ghost text ("reading `src/pet.ts` …") — transient, not history.
- Long replies: bubble max-height ~40 % of work area, then scrolls; auto-scroll while streaming unless the user scrolls up.
- Voice mode: see §9.

## 8. Settings additions

New "Chat" section in `settingsWin`:
- Provider: **Base URL** (free text), **API protocol** dropdown (`openai-completions` / `openai-responses` / `anthropic-messages`), model name, API key (password field). "Test" button sends a 1-token ping through the *selected* adapter and shows ✓/✗ with the provider's error verbatim — catches wrong protocol/URL/key in one click.
- Sensible defaults when the user types a known host: `api.openai.com` → `openai-completions`, `api.anthropic.com` → `anthropic-messages`, `localhost:*`/`127.0.0.1:*` → `openai-completions` (LM Studio/Ollama/llama.cpp). The dropdown always wins over the guess.
- Hotkey: current combo, "Test registration" button, fallback notice.
- Toggles: always answer with voice, tool use on/off, allow secrets per-grant reminder.
- Button: Clear memory.

## 9. Voice mode (phase 2, local-only)

- **STT**: hold-to-talk — press the hotkey again while chatWin is open (or a mic button) → record via renderer `getUserMedia`, send PCM chunks to main → **whisper.cpp** (`base`/`small` GGML, CPU) → transcript into the input bar for confirm-or-send.
- **TTS**: reply text → **Piper** voice (~20–60 MB) or **Kokoro-82M** (~330 MB, better quality) → WAV streamed to renderer → play. While speaking, the bloub plays a new `talk` state (mouth pulse synced by amplitude).
- Both engines run as child processes in main; model files live in `userData/models/` with a "download models" button in settings (shows sizes before download).
- `voiceAlways` setting: every reply auto-speaks; a small speaker icon in the bubble mutes per-reply.

## 10. File layout (planned)

```
app/
  electron/
    main.cjs              // + hotkey, chatWin, IPC wiring
    chat/
      provider.cjs        // OpenAI-compatible streaming client
      tools.cjs           // defineTool registry + fs tools + path policy
      history.cjs         // JSONL load/append/clear
      agent.cjs           // the tool-calling loop
  src/
    chat.html / chat.css / chat.ts   // chatWin renderer
    pet.ts                // + drop handling, absorb/talk states
    settings.ts           // + chat settings section
docs/
  ai-chat-design.md       // this file
```

## 11. Build order

1. **Core loop** — provider client + chatWin + typed send + streaming reply + hidden JSONL history + clear memory. (Proves the whole pipe with zero extras.)
2. **Hotkey** — Super+Alt+X with fallback + tray notice + settings field.
3. **Attachments** — paste + drag files/images onto ball, absorb anim, chips, vision routing.
4. **Tools** — folder grants + `fs_tree`/`fs_read`/`fs_search` + path policy + tool loop with hop cap.
5. **Voice** — whisper.cpp push-to-talk, Piper/Kokoro TTS, talk animation.

## 12. Hard constraints (addenda)

- **Custom UI only — never native widgets.** No native `confirm()`/`alert()`, no native `<select>` dropdowns, no browser chrome of any kind. Everything lives in the hand-rolled UI kit at `app/src/ui/kit.ts` / `kit.css` (`createSelect`, `createSwitch`, `confirmDialog`) — take those template objects and use them in any window. Rationale: the pet and (formerly) settings windows are non-focusable transparent windows where native widgets misbehave or simply don't render, and native chrome can't be themed.
- **Theme colors change in exactly one place:** `app/src/ui/theme.css`. It holds the Astryx-style design tokens (surfaces, borders, text, accent, danger, radii) hand-rolled to respect the zero-dependency rule — Astryx itself requires React 19 + StyleX and is therefore NOT imported; only the token approach is copied. All windows map their local CSS variables onto these tokens.

## 13. Open questions

- Which provider/model will be the daily driver? (Affects which adapter gets real-world testing first; vision support still varies per model.)
- Should tool status lines be shown at all, or fully invisible like history?
- Kokoro vs Piper as the default TTS once phase 5 starts (size vs quality)?
