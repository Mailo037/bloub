/**
 * Gemeinsame Text-Helfer fuer Chatfenster und Pet-Dock: verstaendliche
 * Fehlermeldungen, Aktivitaets-Labels fuer Tool-Calls und das Zerlegen
 * gespeicherter User-Records (Text, angehaengte Dateien, Bilder).
 */
import type { ChatRecord } from './shared'

export interface FriendlyError {
  /** Kurze, verstaendliche Ueberschrift */
  title: string
  /** Was der Nutzer jetzt tun kann */
  hint: string
  /** Original-Meldung des Providers (fuer Details) */
  detail: string
  /** Fehler laesst sich in den Einstellungen beheben (Key, Modell, URL) */
  fixInSettings: boolean
}

const ERROR_RULES: Array<{ re: RegExp; title: string; hint: string; settings?: boolean }> = [
  {
    re: /no api key|api key (is )?(missing|not set|required)|missing (an )?api key|key not configured/i,
    title: 'No API key set',
    hint: 'Add a key for your provider in Settings → Connections.',
    settings: true
  },
  {
    re: /insufficient|quota|billing|credit|payment required|\b402\b/i,
    title: 'Out of credits or quota',
    hint: "Check your plan or billing page at the provider, then try again."
  },
  {
    re: /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.{0,12}(api[ -]?key|x-api-key|token)|incorrect api key|authentication|permission denied/i,
    title: 'The API key was rejected',
    hint: 'Check the key in Settings → Connections — it may be wrong, expired or for another provider.',
    settings: true
  },
  {
    re: /\b429\b|rate.?limit|too many requests/i,
    title: 'Rate limit reached',
    hint: 'The provider is limiting requests. Wait a moment, then retry.'
  },
  {
    re: /\b404\b|model.{0,40}(not found|does not exist|not exist|unknown|unsupported)|unknown model|no such model/i,
    title: 'Model not found',
    hint: 'Pick another model or check the model ID in Settings → Connections.',
    settings: true
  },
  {
    re: /context.{0,20}(length|window)|too long|maximum.{0,20}tokens|too many tokens/i,
    title: 'This chat is too long for the model',
    hint: 'Start a new chat or switch to a model with a larger context window.'
  },
  {
    re: /unknown protocol|invalid url|failed to parse url|base ?url/i,
    title: 'The connection settings look wrong',
    hint: 'Check the Base URL and wire protocol in Settings → Connections.',
    settings: true
  },
  {
    re: /enotfound|econnrefused|econnreset|etimedout|eai_again|fetch failed|network|getaddrinfo|socket hang up|connection failed/i,
    title: "Can't reach the provider",
    hint: 'Check your internet connection — or, for a local model, that its server is running.'
  },
  {
    re: /\b5\d\d\b|overloaded|server error|bad gateway|service unavailable|internal error|stream failed|interrupted/i,
    title: 'The provider is having trouble',
    hint: 'This is usually temporary. Try again in a moment.'
  }
]

export function friendlyError(message: string | undefined): FriendlyError {
  const detail = (message || '').trim() || 'Unknown error'
  for (const rule of ERROR_RULES) {
    if (rule.re.test(detail)) return { title: rule.title, hint: rule.hint, detail, fixInSettings: !!rule.settings }
  }
  return { title: 'Something went wrong', hint: 'Try again. If it keeps happening, check Settings → Connections.', detail, fixInSettings: false }
}

/* ------------------------------------------------------ aktivitaeten */

const TOOL_LABELS: Record<string, string> = {
  fs_tree: 'Looked through a folder',
  fs_read: 'Read a file',
  fs_search: 'Searched files',
  fs_write: 'Wrote a file',
  fs_edit: 'Edited a file',
  pet_get_state: 'Checked how I look',
  pet_set_shape: 'Changed my shape',
  pet_set_expression: 'Changed my expression',
  pet_animate: 'Played an animation',
  pet_stop_animation: 'Stopped animating',
  pet_set_color: 'Changed my color',
  pet_set_size: 'Changed my size',
  pet_custom_animate: 'Played a custom animation',
  system_info: 'Checked system info',
  system_focused_app: 'Checked the active app',
  system_media_info: 'Checked what is playing',
  desktop_screenshot: 'Took a screenshot',
  shell_exec: 'Ran a terminal command',
  memory_write: 'Saved something to memory',
  memory_get: 'Looked something up in memory',
  pet_draw_path: 'Drew on the screen',
  chat_set_title: 'Renamed this chat',
  timeline_search: 'Searched your activity',
  terminal_history: 'Checked terminal history',
  browser_actions: 'Checked browser activity',
  timeline_context: 'Recalled recent activity'
}

/** Menschenlesbare Zeile fuer einen Tool-Call: die Notiz der AI, sonst ein Label. */
export function activityLabel(name: string, argsJson?: string): string {
  try {
    const args = JSON.parse(argsJson || '{}') as { note?: unknown }
    if (typeof args.note === 'string' && args.note.trim()) return args.note.trim()
  } catch {
    /* unparsebare Args -> Label */
  }
  return TOOL_LABELS[name] ?? `Used ${name.replace(/_/g, ' ')}`
}

/* ------------------------------------------------- gespeicherte records */

export function isSystemNote(rec: ChatRecord): boolean {
  if (rec.role !== 'user') return false
  const text = rec.parts?.length === 1 ? rec.parts[0]?.text ?? '' : ''
  return /^\(system note:/.test(text)
}

export interface UserMessageView {
  text: string
  files: string[]
  images: Array<{ mime: string; data: string }>
}

const ATTACHED_FILE_RE = /^\s*\[attached file: ([^\]]+)\]/
const ATTACHED_IMAGE_RE = /^\s*\[attached image: ([^\]—]+?)\s*(—|\])/

/** User-Record in Text, angehaengte Dateinamen und Bilder zerlegen (statt Dateiinhalt anzuzeigen). */
export function userMessageView(rec: ChatRecord): UserMessageView {
  const view: UserMessageView = { text: '', files: [], images: [] }
  if (!Array.isArray(rec.parts)) {
    view.text = rec.content ?? ''
    return view
  }
  const texts: string[] = []
  for (const part of rec.parts) {
    if (part.type === 'image' && part.data) {
      view.images.push({ mime: part.mime || 'image/png', data: part.data })
      continue
    }
    const text = part.text ?? ''
    const file = ATTACHED_FILE_RE.exec(text)
    const image = ATTACHED_IMAGE_RE.exec(text)
    if (file) view.files.push(file[1]!.trim())
    else if (image) view.files.push(image[1]!.trim())
    else if (text.trim() && text.trim() !== '(empty message)') texts.push(text.trim())
  }
  view.text = texts.join('\n\n')
  return view
}

export function formatBytes(n: number | undefined): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
