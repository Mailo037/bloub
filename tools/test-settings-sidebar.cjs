// Run with: pnpm exec electron tools/test-settings-sidebar.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
// Exercise the actual sidebar module and search wiring without starting the pet or providers.
const sidebarSource = fs.readFileSync(path.join(root, 'src/settings-sidebar.ts'), 'utf8').replace('export function', 'function')
const settingsSource = fs.readFileSync(path.join(root, 'src/settings.ts'), 'utf8')
const searchSource = settingsSource.slice(settingsSource.indexOf('function wellSearchText('), settingsSource.indexOf('/* Nur EINMAL aufrufen:'))
const fixture = ts.transpileModule(`(() => {
  ${sidebarSource}
  let searchOpen = false
  let currentSearchTab = 'connections'
  function switchTab(tab) { currentSearchTab = tab }
  const searchToggleBtn = document.getElementById('search-toggle')
  const searchBar = document.getElementById('search-bar')
  const searchInput = document.getElementById('search-input')
  const searchStatus = document.getElementById('search-status')
  ${searchSource}
  setupSearch()
})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true } })
  // Source HTML gives us real markup/styles; only replace its application bootstrap.
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['file://*/*.ts'] }, (_details, callback) => callback({ cancel: true }))
  const evaluate = code => win.webContents.executeJavaScript(code)
  const load = async () => {
    await win.loadFile(path.join(root, 'src/settings.html'))
    await evaluate(fixture)
  }
  const state = () => evaluate(`({
    width: document.getElementById('sidebar').getBoundingClientRect().width,
    expanded: document.getElementById('sidebar-toggle').getAttribute('aria-expanded'),
    label: document.getElementById('sidebar-toggle').getAttribute('aria-label'),
    searchVisible: document.getElementById('search-input').getClientRects().length > 0,
    focused: document.activeElement.id,
    filtered: document.querySelectorAll('.search-hidden').length,
    query: document.getElementById('search-input').value
  })`)
  const click = id => evaluate(`document.getElementById('${id}').click()`)
  try {
    await win.loadFile(path.join(root, 'src/settings.html'))
    await evaluate("localStorage.removeItem('bloub.settings.sidebarCollapsed')")
    await evaluate(fixture)
    assert.equal((await state()).width, 220)
    await click('sidebar-toggle')
    assert.equal((await state()).width, 56)
    assert.equal((await state()).expanded, 'false')
    assert.equal((await state()).label, 'Expand sidebar')
    assert.equal((await state()).searchVisible, false)
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('#tabs button')).every(b => b.title && b.getAttribute('aria-label') === b.title && b.getBoundingClientRect().width > 0)`), true)
    await load()
    assert.equal((await state()).width, 56, 'Collapsed preference survives reload')
    await click('search-toggle')
    assert.equal((await state()).width, 220)
    assert.equal((await state()).focused, 'search-input')
    await evaluate(`document.getElementById('search-input').value = 'no-matching-setting'; document.getElementById('search-input').dispatchEvent(new Event('input'))`)
    assert.ok((await state()).filtered > 0)
    await click('sidebar-toggle')
    assert.equal((await state()).query, '')
    assert.equal((await state()).filtered, 0, 'Collapse clears invisible filtering')
    assert.equal((await state()).focused, 'sidebar-toggle')
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
    assert.equal((await state()).width, 220)
    assert.equal((await state()).focused, 'search-input')
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    assert.equal((await state()).searchVisible, true, 'Escape leaves expanded search reachable')
    await load()
    assert.equal((await state()).width, 220, 'Expanded preference survives reload')
    win.setSize(480, 600)
    await click('sidebar-toggle')
    assert.equal((await state()).width, 56)
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('sidebar-toggle')).getPropertyValue('-webkit-app-region')`), 'no-drag')
    console.log('PASS: sidebar layout, toggle, accessible labels, persistence, search, Ctrl+K, Escape and compact window')
  } finally {
    await evaluate("localStorage.removeItem('bloub.settings.sidebarCollapsed')")
    win.destroy()
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
