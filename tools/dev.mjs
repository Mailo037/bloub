// Startet Vite-Devserver und Electron zusammen. STRG+C beendet beide.
import { spawn } from 'node:child_process'

const vite = spawn('pnpm', ['exec', 'vite', '--port', '5199', '--strictPort'], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

const electron = spawn(
  'pnpm',
  ['exec', 'electron', '.'],
  {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, BLOUB_PET_DEV_URL: 'http://localhost:5199' }
  }
)

electron.on('exit', () => {
  vite.kill()
  process.exit(0)
})
