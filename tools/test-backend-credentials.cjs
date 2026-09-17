// Offline regression suite. Fake safeStorage tokens are NOT real API keys.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createCredentialStore, trustedProvider, publicConfig, mergeRendererConfig, writeConfigAtomic, GEMINI_BASE_URL } = require('../electron/credentials.cjs')
const encrypt = value => Buffer.from(`test-encrypted:${value}`).toString('base64')
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`test-encrypted:${value}`),
  decryptString: value => {
    const text = value.toString()
    if (!text.startsWith('test-encrypted:')) throw new Error('corrupt')
    return text.slice('test-encrypted:'.length)
  }
}
const initial = (baseUrl = 'https://api.openai.com/v1') => ({ chat: { baseUrl, apiKeyEnc: '', grants: [], fullDriveAccess: false }, audio: { apiKeyEnc: '', transcriptionKeyEnc: '' }, recall: {} })
function fixture(cfg = initial(), overrides = {}) {
  let current = cfg, saved
  const store = createCredentialStore({ getConfig: () => current, setConfig: next => { current = next }, safeStorage, persist: next => { saved = JSON.parse(JSON.stringify(next)); return true }, ...overrides })
  return { store, get config() { return current }, get saved() { return saved }, replace: next => { current = next } }
}

test('only exact secure official API roots receive shared credentials', () => {
  for (const url of ['https://api.openai.com/v1', 'https://api.openai.com/v1/']) assert.equal(trustedProvider(url), 'openai')
  for (const url of [GEMINI_BASE_URL, `${GEMINI_BASE_URL}/openai`]) assert.equal(trustedProvider(url), 'gemini')
  for (const url of ['https://api.openai.com.evil.invalid/v1', 'https://evil.invalid/api.openai.com/v1', 'http://api.openai.com/v1', 'https://api.openai.com:8443/v1', 'https://user@api.openai.com/v1', 'https://api.openai.com/v1?redirect=x', 'https://api.openai.com/v1#x', 'https://api.openai.com/other', 'https://generativelanguage.googleapis.com.evil.invalid/v1beta', 'garbage', '', null]) assert.equal(trustedProvider(url), null, url)
})

test('one saved provider key supports chat/audio and survives reload', () => {
  const f = fixture()
  assert.deepEqual(f.store.setProviderKey('openai', ' fake-openai '), { ok: true })
  assert.equal(f.store.getChatKey(), 'fake-openai')
  assert.equal(f.store.getProviderKey('openai'), 'fake-openai')
  assert.equal(f.config.audio.transcriptionKeyEnc, encrypt('fake-openai'))
  assert.equal(f.store.getProviderKey('gemini'), '')
  const restart = fixture(f.saved)
  assert.equal(restart.store.getChatKey(), 'fake-openai')
  assert.deepEqual(restart.store.setProviderKey('gemini', 'fake-gemini'), { ok: true })
  restart.replace(mergeRendererConfig(restart.config, { chat: { baseUrl: `${GEMINI_BASE_URL}/openai` } }))
  assert.equal(restart.store.getChatKey(), 'fake-gemini')
  assert.equal(restart.store.getProviderKey('openai'), 'fake-openai')
})

test('official legacy keys migrate only into matching empty central slot', () => {
  for (const [url, provider, field] of [['https://api.openai.com/v1', 'openai', 'transcriptionKeyEnc'], [GEMINI_BASE_URL, 'gemini', 'apiKeyEnc']]) {
    const cfg = initial(url); cfg.chat.apiKeyEnc = encrypt('legacy')
    const f = fixture(cfg)
    assert.equal(f.store.getProviderKey(provider), 'legacy')
    assert.deepEqual(f.store.migrate(), { ok: true })
    assert.equal(f.config.audio[field], encrypt('legacy'))
    assert.equal(f.config.chat.apiKeyEnc, '')
    assert.equal(fixture(f.saved).store.getProviderKey(provider), 'legacy')
    const conflicting = initial(url); conflicting.chat.apiKeyEnc = encrypt('old'); conflicting.audio[field] = encrypt('central')
    const c = fixture(conflicting); c.store.migrate()
    assert.equal(c.store.getProviderKey(provider), 'central')
  }
})

test('custom legacy credential stays custom and endpoint-bound', () => {
  const cfg = initial('https://custom.invalid/v1'); cfg.chat.apiKeyEnc = encrypt('custom-only')
  const f = fixture(cfg)
  f.store.migrate()
  assert.equal(f.store.getChatKey(), 'custom-only')
  assert.equal(f.store.getProviderKey('openai'), '')
  assert.equal(f.store.getProviderKey('gemini'), '')
  f.store.setProviderKey('openai', 'official-only')
  assert.equal(f.store.getChatKey(), 'custom-only')
  f.replace(mergeRendererConfig(f.config, { chat: { baseUrl: 'https://different.invalid/v1' } }))
  assert.equal(f.store.getChatKey(), '')
  f.store.setChatKey('different-custom')
  assert.equal(f.store.getChatKey(), 'different-custom')
  assert.equal(f.store.getProviderKey('openai'), 'official-only')
  f.replace(mergeRendererConfig(f.config, { chat: { baseUrl: 'https://api.openai.com/v1' } }))
  assert.equal(f.store.getChatKey(), 'official-only')
})

test('failed legacy migration cannot make official key follow custom URL change', () => {
  const cfg = initial(); cfg.chat.apiKeyEnc = encrypt('legacy')
  const f = fixture(cfg, { persist: () => false })
  assert.equal(f.store.migrate().ok, false)
  assert.equal(f.store.getChatKey(), 'legacy')
  f.replace(mergeRendererConfig(f.config, { chat: { baseUrl: 'https://custom.invalid/v1' } }))
  assert.equal(f.store.getChatKey(), '')
  assert.equal(f.store.getProviderKey('openai'), 'legacy')
})

test('stale renderer config cannot overwrite or inject private credentials', () => {
  const f = fixture()
  f.store.setProviderKey('openai', 'new-openai'); f.store.setProviderKey('gemini', 'new-gemini')
  const merged = mergeRendererConfig(f.config, { chat: { apiKeyEnc: encrypt('stale'), apiKeyEndpoint: 'bad', apiKey: 'plaintext', model: 'test-model' }, audio: { apiKeyEnc: '', transcriptionKeyEnc: '', liveProvider: 'openai', voiceEnabled: true } })
  assert.equal(merged.audio.transcriptionKeyEnc, encrypt('new-openai'))
  assert.equal(merged.audio.apiKeyEnc, encrypt('new-gemini'))
  assert.equal(merged.chat.apiKeyEnc, '')
  assert.equal(merged.chat.apiKey, undefined)
  assert.equal(merged.chat.model, 'test-model')
  assert.equal(merged.audio.voiceEnabled, false)
  for (const patch of [null, [], { audio: null, chat: 'invalid' }]) assert.equal(mergeRendererConfig(f.config, patch).audio.apiKeyEnc, encrypt('new-gemini'))
  const exposed = JSON.stringify(publicConfig(merged))
  assert.ok(!exposed.includes('KeyEnc')); assert.ok(!exposed.includes('test-encrypted')); assert.ok(!exposed.includes('apiKeyEndpoint'))
})

test('blank, invalid and unknown provider saves never remove existing keys', () => {
  const f = fixture(); f.store.setProviderKey('openai', 'kept')
  for (const value of ['', '  ', null, undefined, 123, {}, 'bad\nkey']) {
    assert.equal(f.store.setProviderKey('openai', value).ok, false)
    assert.equal(f.store.getProviderKey('openai'), 'kept')
  }
  for (const provider of ['OpenAI', 'custom', '__proto__', 'constructor', null, {}, { toString: null }]) {
    assert.equal(f.store.setProviderKey(provider, 'fake').ok, false)
    assert.deepEqual(f.store.providerStatus(provider), { hasKey: false })
  }
})

test('unavailable or plaintext OS storage and encryption errors fail closed', () => {
  for (const storage of [{ ...safeStorage, isEncryptionAvailable: () => false }, { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }, { ...safeStorage, encryptString: () => { throw new Error('fake-sensitive-detail') } }]) {
    const cfg = initial(); cfg.audio.transcriptionKeyEnc = encrypt('kept')
    const f = fixture(cfg, { safeStorage: storage })
    const result = f.store.setProviderKey('openai', 'new')
    assert.equal(result.ok, false); assert.ok(!result.error.includes('fake-sensitive-detail'))
    assert.equal(f.config.audio.transcriptionKeyEnc, encrypt('kept'))
  }
})

test('corrupt encrypted keys are not reported usable or resurrected from legacy', () => {
  const cfg = initial(); cfg.audio.transcriptionKeyEnc = 'invalid'; cfg.chat.apiKeyEnc = encrypt('obsolete')
  const f = fixture(cfg)
  assert.deepEqual(f.store.providerStatus('openai'), { hasKey: false })
  assert.deepEqual(f.store.chatStatus(), { hasKey: false })
})

test('failed persistence keeps both in-memory key and previous disk value', () => {
  for (const persist of [() => false, () => { throw new Error('disk unavailable') }]) {
    const cfg = initial(); cfg.audio.transcriptionKeyEnc = encrypt('kept')
    const f = fixture(cfg, { persist })
    const result = f.store.setProviderKey('openai', 'replacement')
    assert.equal(result.ok, false); assert.equal(f.config, cfg); assert.equal(f.store.getProviderKey('openai'), 'kept')
  }
})

test('atomic persistence reloads complete JSON; rename failure leaves prior file and no temp', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-credentials-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  writeConfigAtomic(file, { value: 'original' })
  for (const operation of ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
    assert.throws(() => writeConfigAtomic(file, { value: 'new' }, { ...fs, [operation]: () => { throw new Error(`simulated ${operation} failure`) } }))
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 'original' })
    assert.deepEqual(fs.readdirSync(dir), ['config.json'])
  }
  writeConfigAtomic(file, { value: 'replacement' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 'replacement' })
})

function mainFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-main-credentials-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const handlers = new Map(), calls = [], timers = new Map()
  const electron = { safeStorage, app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), getPath: () => dir, setLoginItemSettings() {} }, Menu: { setApplicationMenu() {} }, ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) } }
  const audio = Object.fromEntries(['transcribe', 'textToSpeech', 'streamTextToSpeech', 'ping'].map(name => [name, args => { calls.push({ name, args }); return Promise.resolve({ ok: true, text: 'offline transcript', audio: Buffer.from('fake audio') }) }]))
  const context = vm.createContext({ Buffer, URL, console: { log() {}, warn() {}, error() {} }, process: { on() {}, env: {}, platform: 'win32' }, __dirname: path.resolve(__dirname, '../electron'), setTimeout: fn => { const id = {}; timers.set(id, fn); return id }, clearTimeout: id => timers.delete(id), setImmediate: fn => fn(), AbortController,
    require: name => {
      if (name === 'electron') return electron
      if (name === './credentials.cjs') return require('../electron/credentials.cjs')
      if (name === './chat/saved-models.cjs') return require('../electron/chat/saved-models.cjs')
      if (name === './chat/model-catalog.cjs') return { describeChoices: async rows => rows }
      if (name === './chat/gemini-audio.cjs') return audio
      if (name === './chat/transcription.cjs') return { transcribe: args => { calls.push({ name: 'cloudOrLocal', args }); return Promise.resolve({ ok: true, text: 'offline transcript' }) } }
      if (name === './chat/live-voice.cjs') return { connectVoice: args => { calls.push({ name: 'live', args }); return { close() {}, audio() {} } } }
      if (name.startsWith('node:')) return require(name)
      return {}
    }
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8'), context)
  context.seed = initial()
  vm.runInContext('config = seed', context)
  return { context, calls, timers, dir, invoke: (name, ...args) => handlers.get(name)({ sender: { id: 1, once() {}, removeListener() {}, isDestroyed: () => false, send() {} } }, ...args), config: () => vm.runInContext('config', context) }
}

test('main IPC aliases share persisted keys and return secret-free config', t => {
  const f = mainFixture(t)
  assert.equal(f.invoke('chat:set-api-key', 'fake-openai').ok, true)
  assert.equal(f.invoke('provider:key-status', 'openai').hasKey, true)
  assert.equal(f.invoke('audio:has-transcription-key').hasKey, true)
  assert.equal(f.invoke('audio:set-api-key', 'fake-gemini').ok, true)
  assert.equal(f.invoke('provider:key-status', 'gemini').hasKey, true)
  assert.equal(f.invoke('audio:has-key').hasKey, true)
  assert.equal(f.invoke('audio:set-transcription-key', '').ok, false)
  assert.equal(f.invoke('provider:set-api-key', 'openai', 'replacement').ok, true)
  const stale = { ...initial(), audio: { ...initial().audio, voice: 'Kore' } }
  const result = f.invoke('config:set', stale)
  assert.ok(!JSON.stringify(result).includes('KeyEnc'))
  assert.ok(!JSON.stringify(f.invoke('config:get')).includes('KeyEnc'))
  assert.equal(f.config().audio.transcriptionKeyEnc, encrypt('replacement'))
  for (const fn of [...f.timers.values()]) fn()
  const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'bloub-pet.config.json'), 'utf8'))
  assert.equal(stored.audio.transcriptionKeyEnc, encrypt('replacement'))
  assert.equal(stored.audio.apiKeyEnc, encrypt('fake-gemini'))
  assert.equal(stored.audio.voice, 'Kore')
})

test('main credential IPC reports real disk failure without publishing replacement', t => {
  const f = mainFixture(t)
  assert.equal(f.invoke('provider:set-api-key', 'openai', 'kept').ok, true)
  const diskFile = path.join(f.dir, 'bloub-pet.config.json')
  const original = fs.readFileSync(diskFile, 'utf8')
  f.context.unwritableTarget = path.join(f.dir, 'missing-parent', 'config.json')
  vm.runInContext('configPath = () => unwritableTarget', f.context)
  const result = f.invoke('provider:set-api-key', 'openai', 'replacement')
  assert.equal(result.ok, false)
  assert.match(result.error, /Could not save/)
  assert.equal(f.config().audio.transcriptionKeyEnc, encrypt('kept'))
  assert.equal(fs.readFileSync(diskFile, 'utf8'), original)
})

test('main routes Gemini/OpenAI/local STT and live keys without custom audio endpoint leaks', async t => {
  const f = mainFixture(t)
  f.invoke('provider:set-api-key', 'openai', 'fake-openai'); f.invoke('provider:set-api-key', 'gemini', 'fake-gemini')
  const data = Buffer.from('fake recording').toString('base64')
  for (const provider of ['gemini', 'openai', 'local']) {
    f.config().audio.transcriptionProvider = provider
    f.config().audio.baseUrl = 'https://custom.invalid/v1'
    await f.invoke('audio:transcribe', { data, mime: 'audio/webm', source: 'voice-chat' })
    const call = f.calls.at(-1)
    assert.equal(call.name, provider === 'gemini' ? 'transcribe' : 'cloudOrLocal')
    assert.equal(call.args.apiKey, provider === 'gemini' ? 'fake-gemini' : provider === 'openai' ? 'fake-openai' : '')
    if (provider === 'gemini') assert.equal(call.args.baseUrl, GEMINI_BASE_URL)
  }
  for (const provider of ['openai', 'gemini']) {
    f.config().audio.liveProvider = provider
    assert.equal(f.invoke('voice:start', `test-${provider}`).ok, true)
    const call = f.calls.at(-1)
    assert.equal(call.name, 'live'); assert.equal(call.args.apiKey, `fake-${provider}`)
  }
})

test('saved models from all configured providers survive switching, reload and select matching credentials', async t => {
  const f = mainFixture(t)
  f.config().chat.protocol = 'openai-completions'
  f.config().chat.model = 'same-id'
  f.invoke('provider:set-api-key', 'openai', 'fake-openai')
  f.invoke('provider:set-api-key', 'gemini', 'fake-gemini')
  assert.equal(f.invoke('chat:edit-models', 'add', 'second-openai').ok, true)
  assert.equal(f.invoke('chat:edit-models', 'add', 'second-openai').ok, true)
  f.invoke('config:set', { chat: { baseUrl: `${GEMINI_BASE_URL}/openai`, protocol: 'openai-completions', model: 'same-id' } })
  assert.equal(f.invoke('chat:edit-models', 'add', 'second-gemini').ok, true)
  f.invoke('config:set', { chat: { baseUrl: 'http://localhost:1234/v1', protocol: 'openai-completions', model: 'same-id' } })
  assert.equal(f.invoke('chat:set-api-key', 'fake-custom').ok, true)
  const rows = await f.invoke('chat:models')
  assert.equal(rows.filter(r => r.id === 'same-id').length, 3)
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length)
  assert.equal(rows.filter(r => r.id === 'second-openai').length, 1)
  for (const provider of ['openai', 'gemini', 'custom']) {
    const row = rows.find(r => r.provider === provider && r.id === 'same-id')
    assert.equal((await f.invoke('chat:select-model', row.key, 'invalid-level')).ok, true)
    assert.equal(f.config().chat.baseUrl, row.baseUrl)
    assert.equal(vm.runInContext('getApiKey()', f.context), `fake-${provider}`)
  }
  assert.equal((await f.invoke('chat:select-model', 'unknown', '')).ok, false)
  assert.equal(f.invoke('chat:edit-models', 'remove', 'same-id').ok, false)
  f.context.reloaded = JSON.parse(fs.readFileSync(path.join(f.dir, 'bloub-pet.config.json'), 'utf8'))
  vm.runInContext('config = reloaded', f.context)
  assert.equal((await f.invoke('chat:models')).length, rows.length)
})

test('main rejects Gemini TTS for OpenAI voice selection before calling provider', async t => {
  const f = mainFixture(t)
  f.invoke('provider:set-api-key', 'gemini', 'fake-gemini')
  f.config().audio.liveProvider = 'openai'
  for (const name of ['audio:speak', 'audio:speak-stream', 'audio:preview-voice']) assert.equal((await f.invoke(name, 'test')).ok, false)
  assert.equal(f.calls.length, 0)
  f.config().audio.liveProvider = 'gemini'
  f.config().audio.baseUrl = 'https://custom.invalid/v1'
  assert.equal((await f.invoke('audio:speak', 'hello')).ok, true)
  assert.equal(f.calls.at(-1).args.baseUrl, GEMINI_BASE_URL)
})
