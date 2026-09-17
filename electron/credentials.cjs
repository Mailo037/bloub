// Main-process only: renderer config is never an authority for credentials.
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const PROVIDER_FIELDS = { openai: 'transcriptionKeyEnc', gemini: 'apiKeyEnc' }
const PRIVATE_FIELDS = new Set(['apiKeyEnc', 'transcriptionKeyEnc', 'apiKeyEndpoint', 'apiKey', 'transcriptionKey', '__proto__', 'constructor', 'prototype'])
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

function trustedProvider(endpoint) {
  if (typeof endpoint !== 'string') return null
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null
    const p = url.pathname.replace(/\/$/, '')
    if (url.hostname === 'api.openai.com' && p === '/v1') return 'openai'
    if (url.hostname === 'generativelanguage.googleapis.com' && ['/v1', '/v1beta', '/v1beta/openai', '/v1/openai'].includes(p)) return 'gemini'
  } catch { /* Not a trusted provider endpoint. */ }
  return null
}

function publicConfig(value) {
  if (Array.isArray(value)) return value.map(publicConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELDS.has(key)).map(([key, child]) => [key, publicConfig(child)]))
}

function mergeRendererConfig(current, partial) {
  const clean = publicConfig(partial)
  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) return current
  const next = { ...current, ...clean }
  for (const section of ['chat', 'audio', 'recall']) {
    const patch = clean[section]
    next[section] = { ...current[section], ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) }
  }
  // Bind an unmigrated legacy key before changing its endpoint, including when
  // startup migration could not be persisted. It must never follow a URL edit.
  if (current.chat?.apiKeyEnc && !current.chat.apiKeyEndpoint) next.chat.apiKeyEndpoint = current.chat.baseUrl
  if (next.audio.liveProvider === 'openai') next.audio.voiceEnabled = false
  return next
}

// Write/flush/rename in the same directory: a failed write cannot truncate the
// last working config. Caller publishes the candidate in memory only on success.
function writeConfigAtomic(file, candidate, io = fs) {
  const temp = `${file}.${randomUUID()}.tmp`
  let fd
  try {
    fd = io.openSync(temp, 'wx', 0o600)
    io.writeFileSync(fd, JSON.stringify(candidate, null, 2), 'utf8')
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = undefined
    io.renameSync(temp, file)
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd) } catch {} }
    try { io.unlinkSync(temp) } catch {}
  }
}

function createCredentialStore({ getConfig, setConfig, safeStorage, persist }) {
  const supported = provider => typeof provider === 'string' && Object.hasOwn(PROVIDER_FIELDS, provider)
  function secureAvailable() {
    try {
      return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    } catch { return false }
  }
  function decrypt(cipher) {
    if (typeof cipher !== 'string' || !cipher || !secureAvailable()) return ''
    try { return safeStorage.decryptString(Buffer.from(cipher, 'base64')).trim() } catch { return '' }
  }
  function legacyProvider(cfg) { return trustedProvider(cfg.chat?.apiKeyEndpoint || cfg.chat?.baseUrl) }
  function getProviderKey(provider) {
    if (!supported(provider)) return ''
    const cfg = getConfig()
    const shared = cfg.audio?.[PROVIDER_FIELDS[provider]]
    // Do not resurrect an obsolete key when an existing central key is corrupt.
    if (shared) return decrypt(shared)
    return legacyProvider(cfg) === provider ? decrypt(cfg.chat?.apiKeyEnc) : ''
  }
  function getChatKey() {
    const cfg = getConfig()
    const provider = trustedProvider(cfg.chat?.baseUrl)
    if (provider) return getProviderKey(provider)
    const binding = cfg.chat?.apiKeyEndpoint || cfg.chat?.baseUrl
    return binding === cfg.chat?.baseUrl && !trustedProvider(binding) ? decrypt(cfg.chat?.apiKeyEnc) : ''
  }
  function commit(candidate) {
    try {
      if (persist(candidate) === false) throw new Error('save failed')
      setConfig(candidate)
      return { ok: true }
    } catch {
      return { ok: false, error: 'Could not save credentials. Your previous key was kept; check local storage and retry.' }
    }
  }
  function save(provider, key, custom = false) {
    if (!custom && !supported(provider)) return { ok: false, error: 'Unsupported provider.' }
    if (typeof key !== 'string' || !key.trim()) return { ok: false, error: 'Enter a non-empty API key. Empty saves do not remove saved keys.' }
    const plain = key.trim()
    if (plain.length > 8192 || /[\r\n\x00]/.test(plain)) return { ok: false, error: 'Invalid API key.' }
    if (!secureAvailable()) return { ok: false, error: 'Secure OS credential storage is unavailable. No key was saved.' }
    let encrypted
    try { encrypted = safeStorage.encryptString(plain).toString('base64') } catch {
      return { ok: false, error: 'Could not encrypt the API key. Your previous key was kept.' }
    }
    const cfg = getConfig()
    const next = { ...cfg, chat: { ...cfg.chat }, audio: { ...cfg.audio } }
    if (custom) {
      next.chat.apiKeyEnc = encrypted
      next.chat.apiKeyEndpoint = cfg.chat?.baseUrl
    } else {
      next.audio[PROVIDER_FIELDS[provider]] = encrypted
      if (legacyProvider(cfg) === provider) { next.chat.apiKeyEnc = ''; delete next.chat.apiKeyEndpoint }
    }
    return commit(next)
  }
  function migrate() {
    const cfg = getConfig()
    if (!cfg.chat?.apiKeyEnc) return { ok: true }
    const provider = legacyProvider(cfg)
    const next = { ...cfg, chat: { ...cfg.chat }, audio: { ...cfg.audio } }
    if (provider) {
      if (!next.audio[PROVIDER_FIELDS[provider]]) next.audio[PROVIDER_FIELDS[provider]] = cfg.chat.apiKeyEnc
      next.chat.apiKeyEnc = ''
      delete next.chat.apiKeyEndpoint
    } else {
      if (cfg.chat.apiKeyEndpoint) return { ok: true }
      next.chat.apiKeyEndpoint = cfg.chat.baseUrl
    }
    return commit(next)
  }
  return {
    getProviderKey, getChatKey, migrate,
    setProviderKey: (provider, key) => save(provider, key),
    setChatKey: key => { const provider = trustedProvider(getConfig().chat?.baseUrl); return save(provider, key, !provider) },
    providerStatus: provider => ({ hasKey: !!getProviderKey(provider) }),
    chatStatus: () => ({ hasKey: !!getChatKey() })
  }
}

module.exports = { createCredentialStore, trustedProvider, publicConfig, mergeRendererConfig, writeConfigAtomic, GEMINI_BASE_URL }
