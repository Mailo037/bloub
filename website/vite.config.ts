import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { applyReleaseToHtml, fetchRelease, releaseView, type Release } from './release'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Schreibt das neueste GitHub-Release schon beim Build ins HTML (Version,
 * Datum, Links) und bettet es als Seed ein. Die Seite aktualisiert sich im
 * Browser trotzdem bei jedem Aufruf (main.ts); das hier ist nur der Startwert
 * fuer Besucher ohne JS oder wenn die API gerade limitiert. Schlaegt der Abruf
 * fehl, bleibt der Ladezustand stehen und der Build laeuft weiter.
 */
function releaseSeed(): Plugin {
  let release: Release | null = null
  return {
    name: 'bloub-release-seed',
    apply: 'build',
    async buildStart() {
      const token = process.env.GITHUB_TOKEN
      try {
        // Token nur gegen das Rate-Limit in CI; ein ungueltiger lokaler Token darf nicht blockieren
        release = await fetchRelease({ token, timeoutMs: 10000 }).catch((err) => {
          if (!token) throw err
          return fetchRelease({ timeoutMs: 10000 })
        })
        this.info(`latest release: v${release.version}`)
      } catch (err) {
        this.warn(`latest release not prefetched (${(err as Error).message}); the page loads it at runtime`)
      }
    },
    transformIndexHtml(html) {
      if (!release) return html
      return {
        html: applyReleaseToHtml(html, releaseView(release)),
        tags: [
          {
            tag: 'script',
            attrs: { id: 'release-seed', type: 'application/json' },
            children: JSON.stringify(release).replace(/</g, '\\u003c'),
            injectTo: 'head'
          }
        ]
      }
    }
  }
}

export default defineConfig({
  root: here,
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true
  },
  plugins: [releaseSeed()]
})
