# Implementation Prompt — Bloub Pad Activity Recall

Copy everything below the line into a fresh agent session. Self-contained: it describes the app, the prerequisite features it builds on, the full Activity Recall spec, constraints, build order, and delegation guidance.

---

You are implementing **Activity Recall** for **bloub-pet**, working in the repository at the current working directory. Read this entire brief before writing code.

## 0. Context

bloub-pet is a Windows desktop-pet Electron app: a transparent always-on-top SVG ball (`app/electron/main.cjs` CommonJS main process, vanilla TypeScript renderer in `app/src/`, Vite 6, no runtime npm dependencies beyond Electron, `contextIsolation: true`, all native access through IPC). Read `docs/ai-chat-design.md` for the architecture and `docs/implementation-prompt.md` for the companion feature this builds on.

**Prerequisite — you may assume these exist** (they are phases 1–5 of `docs/implementation-prompt.md`). Verify by reading the code; if any are missing, STOP and report instead of building them yourself unless told otherwise:

1. A config system at `userData/bloub-pet.config.json` with a `chat` section, saved via debounced `saveConfig()`.
2. A tool-calling agent loop in `app/electron/chat/` with a `defineTool`-style registry: `{ name, description, parameters (JSON Schema), execute(args, ctx) } → { ok, content, isError? }`, schema validation before execute, bounded results, 6-hop cap.
3. An OpenAI-compatible (+ Anthropic) provider adapter layer streaming tokens to a chat window under the ball.
4. Hidden conversation history as append-only JSONL in userData.
5. Settings window with a Chat section (`app/src/settings.ts`).

Activity Recall adds: **the bloub records what the user does on their PC — terminal commands, app usage, and optionally browser actions — into a local indexed store, so the AI can answer "what did I do / what did I run / how do I reverse this" via tools.**

## 1. Core principle

**Capture structured events at action time from source taps. No screenshots, no OCR, no vision models, no global keylogger.** Every producer writes the same normalized event shape into one store; indexing is plain search technology, no AI in the loop; the AI only ever accesses the store through bounded tools.

Normalized event:

```jsonc
{
  "ts": 1730000000000,          // ms epoch
  "source": "shell" | "app" | "browser" | "clipboard",
  "app": "WindowsTerminal",     // process name or browser host
  "title": "pwsh — bloub-pet",  // window title / page title if known
  "kind": "command" | "focus" | "action",
  "text": "...",                // command line / action summary
  "detail": { },                // source-specific: exitCode, cwd, url, fields…
}
```

## 2. Producers

### 2.1 Shell tap (build first — highest value)

Structured command capture, NOT keystrokes:

- **PowerShell:** inject a profile hook (via the user's Documents PowerShell profile, installed by the settings toggle with an obvious "install/remove" button) that emits each command after execution: command line, cwd, exit code, duration. Use `PSReadLine`'s `Get-PSReadLineOption`/history or a `prompt`-function wrapper writing OSC 633-style sequences on stdout that Windows Terminal surfaces in its title, OR simplest robust route: wrap via `Set-PSReadLineKeyHandler -Key Enter` capturing accepted lines plus a `$LASTEXITCODE` check on next prompt. Pick ONE approach, document its limits honestly in code comments.
- **bash/git-bash:** same idea via `PROMPT_COMMAND`/`precmd` writing to a spool file (`$BLoub_SPOOL` env var set by the app when launched from it) — one JSONL line per command.
- Spool files land in `userData/recall-spool/`; the app tails them every ~2 s, parses, normalizes, deletes consumed lines.
- Never record raw keystrokes mid-editing — only accepted/executed commands.

### 2.2 App-focus tap

Poll `GetForegroundWindow()` every 2 s from the main process (call `user32` via a tiny hand-written FFI or shell out to PowerShell once and cache — NO new npm deps; prefer `Get-Process` piping or a vendored `.node` addon only if trivially avoidable — simplest: `powershell -NoProfile -Command` polling is too heavy, so implement a small helper: use `GetForegroundWindow` + `GetWindowTextW` + `GetWindowThreadProcessId` through Electron's `powerMonitor`? No — use Node's `ffi` alternatives are banned; instead spawn ONE long-lived hidden PowerShell process running a polling loop that prints JSON lines on stdout, and read them from main. Document why.) Emit a `focus` event whenever the foreground app/title changes (dedupe identical consecutive pairs). This yields the app-usage timeline cheaply.

### 2.3 Browser capture — two modes, extension auto-install is FORBIDDEN

Default mode is **none** (titles only, from 2.2 — Chrome titles still arrive via focus events). Two opt-in upgrades in settings under "Browser link":

- **Assisted extension install (recommended):** the app ships an unpacked MV3 extension folder (`app/vendor/bloub-link/`) with a service worker + content script. When the user enables the toggle, the app copies the folder to userData, opens `chrome://extensions`, and shows a step-by-step overlay (enable Developer Mode → Load unpacked → select folder). After install, the extension connects to the running app over `http://127.0.0.1:<port>/recall` (port written to a well-known file; token handshake stored in `chrome.storage.local`). The content script listens ONLY for submit-type interactions: `submit` events, clicks on `[type=submit]` / common send-button selectors (`button` containing text matching /^(post|send|reply|tweet|publish|comment)$/i), Ctrl+Enter/Enter-in-contenteditable. On such an event it snapshots the enclosing form/container's visible labeled inputs (label text + value, truncated to 500 chars/field, max 20 fields), skipping `<input type=password>` and anything whose `autocomplete` attribute suggests credentials or payment. It records YOUR outbound actions only — never scrape timelines, DMs, inbox content, or continuously monitor typing.
- **Supervised relaunch:** offer "restart Chrome under Bloub supervision" which relaunches Chrome with `--remote-debugging-port=<port>` (and manages a shortcut doing the same), then attach CDP from main via WebSocket (hand-roll the minimal CDP client over `ws`? ws is a dep — hand-roll frames is overkill; instead use Node's built-in `http`+`crypto` for the WS handshake, ~80 lines, acceptable) and evaluate JS injecting the SAME submit-snapshot logic. Same redaction rules.

NEVER write registry keys (`ExtensionInstallForcelist` etc.), NEVER use `--load-extension`, NEVER install without explicit user clicks inside Chrome's own UI.

### 2.4 Clipboard tap (opt-in, default OFF)

Clipboard viewer listening for text updates, ring buffer of last 200 entries, 10 KB cap each, skipped entirely when a password manager window has focus. Lowest priority — build last if time remains.

## 3. Storage & indexing

- Raw events append to `userData/recall/events.jsonl` (same durability rules as chat history: flush per line, torn tail ignored).
- Hourly (and on app start, and on demand) a batch indexer folds unconsumed events into **SQLite with FTS5** at `userData/recall/index.db`. No npm sqlite driver allowed? Then vendor `better-sqlite3`'s prebuilt binary is a DEPENDENCY — banned. Instead: **do not use SQLite**; implement the index as a plain inverted index: `index/<yyyymmddhh>.jsonl.gz` shards + an in-memory term→(shard,line) map rebuilt lazily on first query per session, capped at ~200k terms with LRU eviction. Honest, dependency-free, adequate for personal scale (~100k events/month). Revisit SQLite only if the user later approves a native dep.
- Retention: events older than `recall.retentionDays` (default 14) purged during indexing. Everything encrypted at rest is NOT required for v1 IF stored under userData with ACLs default — but DO encrypt fields flagged sensitive (nothing yet) using `safeStorage`; note the upgrade path in comments.
- Pause switch: tray menu item "Pause recall" + hotkey (default `Ctrl+Alt+P`); while paused no producer writes. Auto-pause when a foreground window title matches /password|login|bank|incognito|inprivate/i (best-effort, documented).

## 4. AI tools (register into the existing tool loop)

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `timeline_search` | `query`, `from?`, `to?`, `limit≤50` | FTS over events (text+title+app), time-window filters, newest-first |
| `terminal_history` | `query?`, `from?`, `to?`, `limit≤100` | commands only, with cwd + exit code |
| `browser_actions` | `query?`, `site?`, `from?`, `to?`, `limit≤50` | kind=action browser events (URL, submitted-field summaries) |
| `timeline_context` | `last="2h"` (default) | compact chronological digest: per-app minutes + notable actions — for "what was I doing" questions |

All results bounded (harness rule): max rows, max cell length, truncation notes. If Recall is disabled/paused, tools return `isError: "activity recall is disabled"` — never silently empty. System prompt gains a short section telling the model these tools exist and that timestamps are local time.

## 5. Settings & UX

New "Recall" section in settings:
- Master toggle (OFF by default) with plain-language warning of exactly what gets recorded and where it's stored.
- Per-producer toggles: shell (with "install/uninstall profile hooks" button showing current status), clipboard (default off), Browser link (mode chooser: off / guided extension / supervised relaunch, with install walkthrough).
- Retention days number field. "Pause now" indicator mirroring tray state. Storage usage display + "Purge everything" button.
- The pet plays a small `notify` one-shot when recall toggles change.

## 6. Build order

1. Event store + normalizer + retention purger (no producers yet).
2. Shell taps (PowerShell first, bash second) + spool tailer.
3. App-focus poller + dedupe.
4. Indexer (hourly + on-demand) + inverted-index query engine.
5. AI tools + system-prompt section + settings section.
6. Browser link: assisted extension (service worker ↔ localhost protocol first, content-script snapshot second, redaction tests third).
7. Supervised-relaunch CDP mode. 8. Clipboard tap. 9. Pause switch polish + password-title auto-pause.

## 7. Delegation & verification

- Delegate to subagents: the bash tap (given the spool-file contract verbatim), the inverted-index engine (pure logic, given the event schema), the MV3 extension (given the localhost protocol spec and redaction rules), and the CDP client. They cannot see this conversation — include the relevant sections verbatim.
- Keep in your own head: main-process wiring, producer lifecycle, settings IPC, tool registration.
- After every phase: `pnpm run build` clean; existing pet behavior unchanged; write a throwaway script to push synthetic events through store→index→tools and show real query answers before claiming the pipeline works.
- For shell taps, actually open a terminal, run known commands, and verify they appear in the store with correct cwd/exit code.

## 8. Hard constraints

- **No new npm dependencies** (Electron only). Hand-roll WS/FFI-free approaches as specified above.
- **No global keyboard hooks. Ever.** Commands come from shell taps, not keys.
- **No screenshots, no OCR, no screen recording.**
- Extension: outbound-actions-only, secret-field redaction, incognito excluded (do not request the `"tabs"` permission broadly if `"activeTab"`+`"storage"` suffice — minimize permissions).
- Recall OFF by default; nothing recorded before explicit consent.
- All data local-only; never included in prompts except via bounded tool results.
- Existing chat/pet behavior must not regress.

## 9. Definition of done

With Recall enabled end-to-end: open a terminal, run `git commit` with a deliberate mistake, wait, then ask the bloub "what did I just do in the terminal and how do I undo it" — the AI calls `terminal_history`, finds the exact command with cwd and exit code, and proposes the reversal. Separately: post a tweet (or submit any web form) with Browser link enabled, ask "what did I post at 14:30", and get the captured field text back via `browser_actions`. Tray pause freezes recording instantly. Purge removes everything. Report per phase what was verified by actually running the app.
