// Real Electron renderer + production preload/store, isolated temporary config.
// pnpm run build && pnpm exec electron tools/test-settings-credentials.cjs
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createCredentialStore, writeConfigAtomic, publicConfig, mergeRendererConfig } = require('../electron/credentials.cjs')
const savedModels = require('../electron/chat/saved-models.cjs')
ipcMain.handle('chat:edit-models', (_e, action, id) => {
  try { config.chat = savedModels.editModels(config.chat, action, id); writeConfigAtomic(file, config); publish(); return { ok: true } }
  catch (error) { return { ok: false, error: error.message } }
})
ipcMain.handle('chat:models', () => savedModels.choices(config.chat, p => store.providerStatus(p).hasKey))
ipcMain.handle('chat:select-model', (_e, key, level) => {
  const row = savedModels.choices(config.chat, p => store.providerStatus(p).hasKey).find(m => m.key === key)
  if (!row) return { ok: false }
  const before = config.chat
  config = mergeRendererConfig(config, { chat: { baseUrl: row.baseUrl, protocol: row.protocol, model: row.id, reasoningLevel: level } })
  config.chat.modelProfiles = savedModels.rememberTransition(before, config.chat)
  writeConfigAtomic(file, config); publish(); return { ok: true }
})
ipcMain.handle('recall:get-status', () => null)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-key-test-'))
app.setPath('userData', dir)
const file = path.join(dir, 'config.json')
const dummy = 'dummy-integration-credential-not-a-real-key'
let config = { ballSize: 200, expression: 'neutre', shape: 'cercle', color: 'encre', chat: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', protocol: 'openai-completions', verbosity: 'balanced', grants: [] }, audio: { liveProvider: 'openai', transcriptionProvider: 'openai' } }
let failSave = false
const store = createCredentialStore({ getConfig: () => config, setConfig: c => { config = c }, safeStorage, persist: c => { if (failSave) throw new Error('simulated disk failure'); writeConfigAtomic(file, c) } })
let win
const publish = () => win?.webContents.send('config:changed', publicConfig(config))
ipcMain.handle('config:get', () => publicConfig(config))
ipcMain.handle('config:set', (_e, p) => { const before = config.chat; config = mergeRendererConfig(config, p); config.chat.modelProfiles = savedModels.rememberTransition(before, config.chat); writeConfigAtomic(file, config); publish() })
ipcMain.handle('provider:set-api-key', (_e, provider, key) => { const result = store.setProviderKey(provider, key); publish(); return result })
ipcMain.handle('provider:key-status', (_e, provider) => store.providerStatus(provider))
ipcMain.handle('chat:get-api-key-status', () => store.chatStatus())
ipcMain.handle('audio:has-key', () => store.providerStatus('gemini'))
ipcMain.handle('chat:set-api-key', (_e, key) => store.setChatKey(key))
ipcMain.handle('audio:dictations', () => [])
ipcMain.handle('app:get-specs', () => ({}))
const evaluate = expr => win.webContents.executeJavaScript(expr)
async function until(expr, message) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(expr)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}
async function saveDummy(value) {
  await evaluate(`(() => { const input = document.getElementById('openai-apikey'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('openai-key-save').click() })()`)
}
app.whenReady().then(async () => {
  assert(safeStorage.isEncryptionAvailable(), 'Real OS encryption must be available')
  win = new BrowserWindow({ show: false, width: 960, height: 900, webPreferences: { preload: path.join(__dirname, '../electron/preload.cjs') } })
  await win.loadFile(path.join(__dirname, '../dist-renderer/settings.html'))
  await until(`!!document.querySelector('#chat-verbosity-slot button')`, 'Settings did not initialize')
  if (process.argv.includes('--bridge-only')) {
    const result = await evaluate(`window.bloubPet.setApiKey(${JSON.stringify(dummy)})`)
    assert.equal(result.ok, true, 'Legacy bridge save')
    const shared = await evaluate(`window.bloubPet.setProviderApiKey('openai', ${JSON.stringify(dummy)})`)
    assert.equal(shared.ok, true, 'Shared provider bridge save')
    assert.equal(store.getChatKey(), dummy)
    assert(!fs.readFileSync(file, 'utf8').includes(dummy))
    console.log('PASS production preload: chat:set-api-key and provider:set-api-key -> real OS-encrypted store')
    win.destroy()
    app.exit(0)
    return
  }
  await saveDummy(dummy)
  await until(`document.getElementById('openai-key-status').textContent.includes('Saved')`, 'Save button did not report persisted key')
  let disk = fs.readFileSync(file, 'utf8')
  assert(!disk.includes(dummy), 'Plaintext key on disk')
  assert.equal(safeStorage.decryptString(Buffer.from(JSON.parse(disk).audio.transcriptionKeyEnc, 'base64')), dummy)
  assert.equal(store.getChatKey(), dummy)
  assert.equal(store.getProviderKey('openai'), dummy)
  config = JSON.parse(disk) // drop in-memory state; reconstruct from file
  await win.loadFile(path.join(__dirname, '../dist-renderer/settings.html'))
  await until(`document.getElementById('openai-apikey').placeholder.includes('Saved')`, 'Saved status was not restored after reload')
  assert.equal(await evaluate(`document.getElementById('openai-apikey').value`), '')
  assert.equal(await evaluate(`document.querySelectorAll('#transcription-key, #live-openai-key').length`), 0)
  assert(!JSON.stringify(await evaluate('window.bloubPet.getConfig()')).includes('KeyEnc'))
  // Stale config updates cannot erase the just-saved key.
  await evaluate(`window.bloubPet.updateConfig({audio:{transcriptionKeyEnc:''},chat:{apiKeyEnc:''}})`)
  assert.equal(store.getChatKey(), dummy)
  // Add through Settings UI, switch providers, and reload from disk.
  await evaluate(`(() => { document.getElementById('chat-model-add').value = 'second-openai'; document.getElementById('chat-model-add-btn').click() })()`)
  await until(`document.getElementById('chat-saved-models').textContent.includes('second-openai')`, 'Added model missing')
  await evaluate(`(() => { document.getElementById('chat-model-add').value = 'shared-model-id'; document.getElementById('chat-model-add-btn').click() })()`)
  await until(`document.getElementById('chat-saved-models').textContent.includes('shared-model-id')`, 'OpenAI shared model missing')
  await evaluate(`window.bloubPet.setProviderApiKey('gemini', 'dummy-gemini')`)
  await evaluate(`(() => { document.querySelector('#chat-provider-slot button').click(); [...document.querySelectorAll('#chat-provider-slot [role=option]')].find(e => e.textContent.includes('Gemini')).click() })()`)
  await until(`document.getElementById('chat-model').value === 'gemini-2.5-flash'`, 'Gemini switch failed')
  await evaluate(`(() => { document.getElementById('chat-model-add').value = 'second-gemini'; document.getElementById('chat-model-add-btn').click() })()`)
  await until(`document.getElementById('chat-saved-models').textContent.includes('second-gemini')`, 'Gemini addition failed')
  await evaluate(`(() => { document.getElementById('chat-model-add').value = 'shared-model-id'; document.getElementById('chat-model-add-btn').click() })()`)
  await until(`document.getElementById('chat-saved-models').textContent.includes('shared-model-id')`, 'Gemini shared model missing')
  await evaluate(`(() => { document.querySelector('#chat-provider-slot button').click(); [...document.querySelectorAll('#chat-provider-slot [role=option]')].find(e => e.textContent.includes('OpenAI')).click() })()`)
  await until(`document.getElementById('chat-saved-models').textContent.includes('second-openai')`, 'OpenAI models lost on return')
  config = JSON.parse(fs.readFileSync(file, 'utf8'))
  await win.loadFile(path.join(__dirname, '../dist-renderer/settings.html'))
  await until(`document.getElementById('chat-saved-models').textContent.includes('second-openai')`, 'Models lost on restart')
  const choices = await evaluate('window.bloubPet.listChatModels()')
  assert(choices.some(m => m.id === 'second-gemini'))
  assert(choices.some(m => m.id === 'second-openai'))
  console.log('PASS Settings add models -> provider switch -> return -> disk reload -> chat catalog')
  // Run the actual selector module inside the Electron renderer, with production preload.
  const selectorJs = require('typescript').transpileModule(fs.readFileSync(path.join(__dirname, '../src/model-selector.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2022 } }).outputText
  await evaluate(`(() => { const root = document.createElement('div'); root.id = 'model-selector-slot'; document.body.append(root); const exports = {}; const require = () => ({ chevron: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg') }); ${selectorJs}; exports.initModelSelector(window.bloubPet) })()`)
  await until(`!!document.querySelector('#model-selector-slot .effort-trigger-label')`, 'Selector not loaded')
  await evaluate(`document.querySelector('#model-selector-slot > button').click()`)
  await until(`document.querySelector('#model-selector-slot').textContent.includes('second-gemini')`, 'Gemini absent in chat menu')
  await evaluate(`Array.from(document.querySelectorAll('#model-selector-slot .model-option')).find(e => e.textContent.includes('second-gemini')).click()`)
  await until(`document.querySelector('#model-selector-slot .effort-trigger-label').textContent.includes('second-gemini')`, 'Chat selection did not update')
  assert.equal(config.chat.model, 'second-gemini')
  assert(config.chat.baseUrl.includes('generativelanguage.googleapis.com'))
  assert.equal(store.getChatKey(), 'dummy-gemini')
  for (const provider of ['OpenAI', 'Gemini']) {
    await evaluate(`Array.from(document.querySelectorAll('#model-selector-slot .model-option')).find(e => e.title === ${JSON.stringify(provider + ' · shared-model-id')}).click()`)
    await until(`!!Array.from(document.querySelectorAll('#model-selector-slot .model-option')).find(e => e.title === ${JSON.stringify(provider + ' · shared-model-id')} && e.textContent.includes('✓'))`, 'Wrong duplicate model selected')
    assert.equal(config.chat.model, 'shared-model-id')
    assert.equal(store.getChatKey(), provider === 'OpenAI' ? dummy : 'dummy-gemini')
  }
  console.log('PASS actual chat selector: grouped providers, model switching and duplicate IDs choose matching endpoint/key')
  // Restore OpenAI for the failed-save check below.
  await evaluate(`window.bloubPet.selectChatModel(${JSON.stringify(choices.find(m => m.id === 'second-openai').key)}, '')`)
  failSave = true
  await saveDummy('dummy-replacement-never-persisted')
  await until(`document.getElementById('openai-key-status').textContent.includes('Could not save')`, 'Persistence failure not reported')
  assert.equal(await evaluate(`document.getElementById('openai-apikey').value`), 'dummy-replacement-never-persisted')
  assert.equal(store.getProviderKey('openai'), dummy)
  console.log('PASS UI save -> OS-encrypted disk -> reload -> shared chat/voice key; failed save preserves old key and draft')
  // Visual check through the same real renderer+preload+store path.
  const shotDir = path.join(__dirname, 'shots')
  fs.mkdirSync(shotDir, { recursive: true })
  await evaluate(`document.querySelector('[data-tab="connections"]').click()`)
  const shotConnections = path.join(shotDir, 'connections.png')
  fs.writeFileSync(shotConnections, (await win.webContents.capturePage()).toPNG())
  const openSelect = await evaluate(`(() => { const b = document.querySelector('#chat-provider-slot button'); b.click(); return b.getAttribute('aria-expanded') })()`)
  fs.writeFileSync(path.join(dir, 'provider-open.png'), (await win.webContents.capturePage()).toPNG())
  await evaluate(`document.querySelector('#chat-provider-slot button').click()`)
  await evaluate(`document.querySelector('[data-tab="audio"]').click()`)
  const shotVoice = path.join(dir, 'voice.png')
  fs.writeFileSync(shotVoice, (await win.webContents.capturePage()).toPNG())
  console.log('Screenshots:', shotConnections, shotVoice, '| chat provider menu aria-expanded:', openSelect)
  win.destroy()
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* temp dir cleanup is best effort */ }
  app.exit(0)
}).catch(error => { console.error('CREDENTIAL INTEGRATION FAIL:', error.message); app.exit(1) })
