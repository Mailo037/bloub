// Activity Recall — Bash/Git-Bash-Tap (Phase 2b).
// Installiert einen PROMPT_COMMAND-Block in die ~/.bashrc, der NACH jeder
// ausgefuehrten Kommandozeile eine JSONL-Zeile in den Spool schreibt.
// Ehrliche Limits (dokumentiert): nur interaktive bash; Befehle in
// Subshells/Scripts werden nicht erfasst; $? ist immer die letzte Pipeline-
// Stufe; mehrzeilige Befehle werden mit U+2424 zu einer Zeile verbunden;
// kein Keylogger — nur akzeptierte/ausgefuehrte Zeilen.

const fs = require('node:fs')
const path = require('node:path')

const MARK_BEGIN = '# >>> bloub recall hook >>>'
const MARK_END = '# <<< bloub recall hook <<<'

/**
 * Erzeugt den Hook-Block. spoolDir POSIX-artig einbetten; $BLOUB_SPOOL darf
 * zur Laufzeit ueberschreiben, BLOUB_RECALL_OFF=1 schaltet komplett ab.
 */
function hookBlock(spoolDir) {
  const esc = String(spoolDir).replace(/"/g, '\\"')
  return [
    MARK_BEGIN,
    'if [ -z "$BLB_RECALL_ACTIVE" ] && [ -z "$BLOUB_RECALL_OFF" ]; then',
    '  export BLB_RECALL_ACTIVE=1',
    `  BLOUB_SPOOL="\${BLOUB_SPOOL:-${esc}}"`,
    '  mkdir -p "$BLOUB_SPOOL" 2>/dev/null',
    '  BLB_SPOOL_FILE="$BLOUB_SPOOL/bash-$$-$(date +%s 2>/dev/null || echo 0).jsonl"',
    '  BLB_LAST_HISTCMD=""',
    '  __bloub_recall_precmd() {',
    '    local __exit=$? # ERSTES Statement: $? unberuehrt lassen',
    '    local __hist __num __cmd __cwd __dur',
    '    __hist=$(HISTTIMEFORMAT= history 1 2>/dev/null)',
    '    [ -z "$__hist" ] && return 0',
    // history padet die Nummer mit Leerzeichen — erst fuehrenden Whitespace strippen,
    // sonst bleibt die Nummer leer und der Dedupe-Vergleich springt immer an.
    '    __hist="${__hist#"${__hist%%[![:space:]]*}"}"',
    '    __num=${__hist%%[[:space:]]*}',
    '    if [ "$__num" != "$BLB_LAST_HISTCMD" ]; then',
    '      BLB_LAST_HISTCMD="$__num"',
    '      __cmd="${__hist#* }"          # Nummer abtrennen',
    '      __cmd="${__cmd#* }"           # Zeitstempel-Feld abtrennen',
    '      __cmd=${__cmd//$\'\\r\'}',
    "      __cmd=${__cmd//$'\\n'/$(printf '\\u2424')} # Mehrzeilig -> U+2424",
    '      [ -z "$__cmd" ] && return 0',
    '      __cwd=$PWD',
    '      __dur=""',
    // ts: bash-Builtin statt date-%N (%N ist auf manchen Systemen unzuverlaessig)
    "      printf -v __bloub_ts '%(%s)T' -1 2>/dev/null || __bloub_ts=$(date +%s)",
    '      __bloub_ts="${__bloub_ts}000"',
    '      if command -v python3 >/dev/null 2>&1; then',
    // Achtung: json.dumps liefert die Anfuehrungszeichen MIT — im Format
    // daher KEINE zusaetzlichen Quotes um %s fuer cmd/cwd setzen.
    '        printf \'{"v":1,"host":"bash","pid":%s,"ts":%s,"cmd":%s,"cwd":%s,"exit":%s,"durMs":null}\\n\' \\',
    '          "$$" "$__bloub_ts" \\',
    '          "$(python3 -c \'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))\' "$__cmd" 2>/dev/null)" \\',
    '          "$(python3 -c \'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))\' "$__cwd" 2>/dev/null)" \\',
    '          "$__exit" >> "$BLB_SPOOL_FILE" 2>/dev/null',
    '      else',
    '        # Fallback ohne python3: rohes Escaping (Anfuehrungszeichen verdoppeln)',
    '        __cmd_esc=${__cmd//\\"/\\\\\\"}',
    '        __cwd_esc=${__cwd//\\"/\\\\\\"}',
    '        printf \'{"v":1,"host":"bash","pid":%s,"ts":%s,"cmd":"%s","cwd":"%s","exit":%s,"durMs":null}\\n\' \\',
    '          "$$" "$__bloub_ts" "$__cmd_esc" "$__cwd_esc" "$__exit" \\',
    '          >> "$BLB_SPOOL_FILE" 2>/dev/null',
    '      fi',
    '    fi',
    '    return 0',
    '  }',
    '  # Vorhandenes PROMPT_COMMAND verketten statt ueberschreiben',
    '  if [ -n "$PROMPT_COMMAND" ]; then',
    '    case "$PROMPT_COMMAND" in',
    '      *__bloub_recall_precmd*) ;;',
    '      *) PROMPT_COMMAND="__bloub_recall_precmd;$PROMPT_COMMAND" ;;',
    '    esac',
    '  else',
    '    PROMPT_COMMAND="__bloub_recall_precmd"',
    '  fi',
    'fi',
    MARK_END,
    ''
  ].join('\n')
}

function readRc(homeDir, file) {
  try {
    return fs.readFileSync(path.join(homeDir, file), 'utf8')
  } catch {
    return ''
  }
}

function hasMarker(text) {
  return text.includes(MARK_BEGIN)
}

/** Installiert idempotent in .bashrc. */
function installHook(spoolDir, homeDir) {
  const file = path.join(homeDir, '.bashrc')
  const results = { ok: true, changed: false, file }
  try {
    let content = readRc(homeDir, '.bashrc')
    if (hasMarker(content)) {
      const begin = content.indexOf(MARK_BEGIN)
      const end = content.indexOf(MARK_END)
      if (begin !== -1 && end !== -1) {
        content = content.slice(0, begin) + hookBlock(spoolDir) + content.slice(end + MARK_END.length + 1)
        fs.writeFileSync(file, content, 'utf8')
        results.changed = true
      }
      return results
    }
    fs.appendFileSync(file, (content && !content.endsWith('\n') ? '\n' : '') + hookBlock(spoolDir), 'utf8')
    results.changed = true
  } catch (err) {
    results.ok = false
    results.error = String(err?.message ?? err)
  }
  return results
}

/** Entfernt den Block wieder (idempotent). */
function removeHook(homeDir) {
  const file = path.join(homeDir, '.bashrc')
  const content = readRc(homeDir, '.bashrc')
  if (!hasMarker(content)) return { ok: true, changed: false, file }
  const begin = content.indexOf(MARK_BEGIN)
  const end = content.indexOf(MARK_END)
  if (begin === -1 || end === -1) return { ok: false, changed: false, error: 'marker truncated', file }
  try {
    fs.writeFileSync(file, content.slice(0, begin) + content.slice(end + MARK_END.length), 'utf8')
    return { ok: true, changed: true, file }
  } catch (err) {
    return { ok: false, changed: false, error: String(err?.message ?? err), file }
  }
}

function hookStatus(homeDir) {
  const file = path.join(homeDir, '.bashrc')
  return { installed: hasMarker(readRc(homeDir, '.bashrc')), file }
}

module.exports = { MARK_BEGIN, MARK_END, hookBlock, installHook, removeHook, hookStatus }
