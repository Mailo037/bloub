import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, 'src')

export default defineConfig({
  root: src,
  base: './',
  build: {
    outDir: resolve(here, 'dist-renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(src, 'index.html'),
        settings: resolve(src, 'settings.html')
      }
    }
  }
})
