// Non-secret provider/model preferences. Model IDs are scoped to an endpoint + protocol.
const { trustedProvider } = require('../credentials.cjs')
const PRESETS = [
  { baseUrl: 'https://api.openai.com/v1', protocol: 'openai-completions', model: 'gpt-4o-mini' },
  { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai-completions', model: 'gemini-2.5-flash' }
]
const protocols = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
function endpoint(value) {
  try {
    const u = new URL(value)
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return ''
    return u.href.replace(/\/$/, '')
  } catch { return '' }
}
function modelId(value) { return typeof value === 'string' && value.trim().length <= 200 && !/[\x00-\x1f]/.test(value) ? value.trim() : '' }
function profileKey(p) { return JSON.stringify([endpoint(p.baseUrl), p.protocol]) }
function choiceKey(p, id) { return JSON.stringify([endpoint(p.baseUrl), p.protocol, id]) }
function profiles(chat = {}) {
  const rows = []
  for (const p of Array.isArray(chat.modelProfiles) ? chat.modelProfiles.slice(0, 50) : []) {
    if (!p || !endpoint(p.baseUrl) || !protocols.has(p.protocol)) continue
    const models = [...new Set((Array.isArray(p.models) ? p.models : []).map(modelId).filter(Boolean))].slice(0, 100)
    if (!models.length) continue
    const row = { baseUrl: endpoint(p.baseUrl), protocol: p.protocol, models, model: models.includes(p.model) ? p.model : models[0] }
    const existing = rows.find(r => profileKey(r) === profileKey(row))
    if (existing) existing.models = [...new Set([...existing.models, ...models])].slice(0, 100)
    else rows.push(row)
  }
  return rows
}
function remember(chat, rows = profiles(chat)) {
  if (!chat || !endpoint(chat.baseUrl) || !protocols.has(chat.protocol) || !modelId(chat.model)) return rows
  const current = { baseUrl: endpoint(chat.baseUrl), protocol: chat.protocol, model: modelId(chat.model) }
  const row = rows.find(p => profileKey(p) === profileKey(current))
  if (row) { row.models = [...new Set([...row.models, current.model])].slice(-100); row.model = current.model }
  else if (rows.length < 50) rows.push({ ...current, models: [current.model] })
  return rows
}
function rememberTransition(before, after) {
  const rows = remember(before)
  return remember(after, rows)
}
function choices(chat, hasProviderKey) {
  const rows = remember(chat)
  for (const preset of PRESETS) {
    if (hasProviderKey(trustedProvider(preset.baseUrl)) && !rows.some(p => trustedProvider(p.baseUrl) === trustedProvider(preset.baseUrl))) remember(preset, rows)
  }
  return rows.flatMap(p => {
    const provider = trustedProvider(p.baseUrl)
    if (provider && !hasProviderKey(provider)) return []
    const providerName = provider === 'openai' ? 'OpenAI' : provider === 'gemini' ? 'Gemini' : `Custom · ${new URL(p.baseUrl).host}`
    return p.models.map(id => ({ key: choiceKey(p, id), id, name: id, provider: provider || 'custom', providerName, baseUrl: p.baseUrl, protocol: p.protocol, levels: [] }))
  })
}
function editModels(chat, action, id) {
  id = modelId(id)
  if (!id) throw new Error('Enter a model ID (1–200 characters).')
  const rows = remember(chat)
  const current = rows.find(p => profileKey(p) === profileKey(chat))
  if (!current) throw new Error('Configure a provider endpoint and current model first.')
  if (action === 'add') {
    if (!current.models.includes(id)) {
      if (current.models.length >= 100) throw new Error('You can save up to 100 models per endpoint.')
      current.models.push(id)
    }
  } else if (action === 'remove') {
    if (id === chat.model) throw new Error('Choose another active model before removing this one.')
    current.models = current.models.filter(m => m !== id)
  } else throw new Error('Unknown model action.')
  return { ...chat, modelProfiles: rows }
}
module.exports = { profiles, remember, rememberTransition, choices, choiceKey, editModels, PRESETS }
