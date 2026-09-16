// Run after pnpm run build: pnpm exec electron tools/test-settings-layout.cjs
// Isolated renderer: no real preload, credentials, config writes or network calls.
const { app, BrowserWindow, contextBridge } = require('electron')
if (process.type === 'renderer') {
  contextBridge.exposeInMainWorld('bloubPet', {
    getConfig: async () => ({ ballSize: 200, expression: 'neutre', shape: 'cercle', color: 'blue', chat: { verbosity: 'balanced', grants: [] }, audio: {}, recall: {} }),
    onConfigChanged: () => {},
    updateConfig: async () => {},
  })
} else {
  const assert = require('node:assert/strict')
  const path = require('node:path')
  const fs = require('node:fs')
  app.setPath('userData', path.join(app.getPath('temp'), 'bloub-settings-layout-test'))
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 900, height: 900, show: false, webPreferences: { preload: __filename, sandbox: false, contextIsolation: true } })
    const errors = []
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message) })
    await win.loadFile(path.join(__dirname, '../dist-renderer/settings.html'))
    const result = await win.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const ids = [...document.querySelectorAll('[id]')].map(el => el.id)
      const grouped = ['memory-toggle-slot', 'terminal-toggle-slot', 'drive-toggle-slot', 'recall-master-slot', 'recall-browser-slot'].every(id => {
        const group = document.getElementById(id)?.closest('.setting-group')
        return group && group.querySelector('p') && getComputedStyle(group.querySelector('p')).borderTopWidth === '0px'
      })
      const verbosity = document.getElementById('chat-verbosity-slot')
      const button = verbosity.querySelector('button')
      document.querySelector('[data-tab="chat"]').click()
      button.click()
      const dropdownOpens = button.getAttribute('aria-expanded') === 'true'
      button.click()
      const workspace = document.getElementById('grant-list').closest('.workspace-preference')
      return { duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i), grouped,
        verbosityGrouped: !!verbosity.closest('.preference-row')?.querySelector('.hint'),
        workspaceGrouped: !!workspace?.querySelector('.hint'),
        emptyGrants: !!workspace?.querySelector('.grant-empty'), dropdownOpens,
        switches: document.querySelectorAll('.k-switch').length }
    })()`)
    assert.deepEqual(result.duplicateIds, [])
    for (const key of ['grouped', 'verbosityGrouped', 'workspaceGrouped', 'emptyGrants', 'dropdownOpens']) assert.equal(result[key], true, key)
    assert(result.switches > 10)
    assert.deepEqual(errors, [], 'renderer errors')
    const screenshot = path.join(app.getPath('temp'), 'bloub-settings-grouped.png')
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
    for (const width of [680, 590]) {
      win.setSize(width, 900)
      const fits = await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => { const el = document.getElementById('pane-chat'); resolve(el.scrollWidth <= el.clientWidth) }))`)
      assert(fits, `chat content overflows at ${width}px`)
    }
    console.log('SETTINGS LAYOUT PASS', JSON.stringify(result), '\nScreenshot:', screenshot)
    app.exit(0)
  }).catch(error => { console.error(error); app.exit(1) })
}
