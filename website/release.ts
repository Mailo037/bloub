/**
 * Release-Daten der Landing Page. Nichts davon ist hartkodiert: Version,
 * Datum und Download-Links kommen immer aus dem neuesten GitHub-Release.
 *
 * Das Modul ist DOM-frei, damit es zweimal laeuft: im Browser bei jedem
 * Seitenaufruf (`main.ts`) und beim Build in `vite.config.ts`, das die Werte
 * schon ins HTML schreibt (Seite stimmt auch ohne JS bzw. bei API-Rate-Limit).
 */

export const REPO = 'Mailo037/bloub'
export const REPO_URL = `https://github.com/${REPO}`
export const LATEST_URL = `${REPO_URL}/releases/latest`
export const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface Release {
  version: string
  published: string | null
  page: string | null
  installer: ReleaseAsset | null
  portable: ReleaseAsset | null
  zip: ReleaseAsset | null
}

/** `null` = laedt noch, `'failed'` = API nicht erreichbar. */
export type ReleaseState = Release | 'failed' | null

interface GithubAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

interface GithubRelease {
  tag_name?: unknown
  published_at?: unknown
  html_url?: unknown
  assets?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export function parseRelease(json: GithubRelease): Release {
  const assets = (Array.isArray(json.assets) ? (json.assets as GithubAsset[]) : [])
    .map((a) => ({ name: str(a.name), url: str(a.browser_download_url), size: Number(a.size) || 0 }))
    .filter((a): a is ReleaseAsset => !!a.name && !!a.url)
  const exe = assets.filter((a) => /\.exe$/i.test(a.name))
  return {
    version: (str(json.tag_name) ?? '').replace(/^v/i, ''),
    published: str(json.published_at),
    page: str(json.html_url),
    installer: exe.find((a) => /setup/i.test(a.name)) ?? null,
    portable: exe.find((a) => !/setup/i.test(a.name)) ?? null,
    zip: assets.find((a) => /\.zip$/i.test(a.name)) ?? null
  }
}

export async function fetchRelease(opts: { token?: string; timeoutMs?: number } = {}): Promise<Release> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(API_URL, {
    headers,
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  return parseRelease((await res.json()) as GithubRelease)
}

/** Grobe Pruefung fuer Daten aus localStorage oder dem eingebetteten Seed. */
export function isRelease(v: unknown): v is Release {
  const r = v as Release | null
  return !!r && typeof r === 'object' && typeof r.version === 'string' && 'installer' in r
}

export const formatSize = (bytes: number) =>
  bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.round(bytes / 1e3)} KB`

/** UTC, damit Build und Browser dasselbe Datum zeigen. */
const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export interface ReleaseView {
  text: Record<'version' | 'sub' | 'installer' | 'portable' | 'zip', string>
  href: Record<'installer' | 'portable' | 'zip', string>
}

/**
 * Alles, was die Seite vom Release anzeigt. Die Werte fuer `null` (laedt)
 * stehen 1:1 auch als Startwerte in `index.html`.
 */
export function releaseView(state: ReleaseState): ReleaseView {
  const rel = state && state !== 'failed' ? state : null
  const fallbackUrl = rel?.page || LATEST_URL
  const meta = (a: ReleaseAsset | null) =>
    a ? `${a.name} · ${formatSize(a.size)}` : state === null ? 'Loading…' : 'See latest release'
  const date = rel?.published ? formatDate(rel.published) : ''
  return {
    text: {
      version: rel?.version ? `v${rel.version}` : 'Latest',
      sub: rel?.version
        ? `Version ${rel.version} for Windows x64${date ? ` · released ${date}` : ''}. Pick whichever build suits you.`
        : 'The latest release for Windows x64. Pick whichever build suits you.',
      installer: meta(rel?.installer ?? null),
      portable: meta(rel?.portable ?? null),
      zip: meta(rel?.zip ?? null)
    },
    href: {
      installer: rel?.installer?.url ?? fallbackUrl,
      portable: rel?.portable?.url ?? fallbackUrl,
      zip: rel?.zip?.url ?? fallbackUrl
    }
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Build-Variante von `applyReleaseToDom` in `main.ts`: setzt dieselben
 * `data-release-text` / `data-release-href` Stellen direkt im HTML-String.
 */
export function applyReleaseToHtml(html: string, view: ReleaseView): string {
  const text = view.text as Record<string, string>
  const href = view.href as Record<string, string>
  return html
    .replace(
      /(<([a-z0-9]+)\b[^>]*\bdata-release-text="(\w+)"[^>]*>)[^<]*(<\/\2>)/g,
      (all, open: string, _tag: string, key: string, close: string) =>
        key in text ? `${open}${escapeHtml(text[key]!)}${close}` : all
    )
    .replace(/<a\b[^>]*\bdata-release-href="(\w+)"[^>]*>/g, (tag, key: string) =>
      key in href ? tag.replace(/\shref="[^"]*"/, ` href="${escapeHtml(href[key]!)}"`) : tag
    )
}
