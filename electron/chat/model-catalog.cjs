const pi = () => import('@mariozechner/pi-ai')
async function resolve(cfg) {
  const lib = await pi()
  const providers = cfg.protocol === 'anthropic-messages' ? ['anthropic'] : lib.getProviders().filter(p => p !== 'anthropic')
  const matches = providers.flatMap(p => lib.getModels(p)).filter(m => m.id === cfg.model && (m.api === cfg.protocol || (cfg.protocol === 'openai-completions' && m.provider === 'openai')))
  return matches.find(m => cfg.baseUrl?.startsWith(m.baseUrl)) || matches.find(m => m.provider === 'openai') || matches[0]
}
async function catalog(cfg) {
  const lib = await pi()
  const current = await resolve(cfg)
  const provider = current?.provider || (cfg.protocol === 'anthropic-messages' ? 'anthropic' : cfg.baseUrl?.includes('api.openai.com') ? 'openai' : null)
  const models = provider ? lib.getModels(provider).filter(m => m.api === cfg.protocol || (provider === 'openai' && cfg.protocol === 'openai-completions')) : []
  const rows = models.map(m => ({ id: m.id, name: m.name, levels: m.reasoning ? lib.getSupportedThinkingLevels(m) : [] }))
  if (!rows.some(m => m.id === cfg.model)) rows.unshift({ id: cfg.model, name: cfg.model, levels: current?.reasoning ? lib.getSupportedThinkingLevels(current) : [] })
  return rows
}
async function stream(cfg, req, signal, emit) {
  const known = await resolve(cfg)
  if (!known || !cfg.reasoningLevel) return false
  const lib = await pi()
  const model = { ...known, api: cfg.protocol, baseUrl: cfg.baseUrl }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  const messages = req.messages.map(m => {
    if (m.role === 'user') return { role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map(p => p.type === 'image' ? { type: 'image', data: p.data, mimeType: p.mime } : p), timestamp: Date.now() }
    if (m.role === 'tool') return { role: 'toolResult', toolCallId: m.toolCallId, toolName: m.name || 'tool', content: [{ type: 'text', text: m.content }], isError: false, timestamp: Date.now() }
    return { role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls || []).map(t => ({ type: 'toolCall', id: t.id, name: t.name, arguments: JSON.parse(t.argsJson || '{}') }))], api: model.api, provider: model.provider, model: model.id, usage, stopReason: m.toolCalls?.length ? 'toolUse' : 'stop', timestamp: Date.now() }
  })
  const level = lib.clampThinkingLevel(model, cfg.reasoningLevel)
  for await (const e of lib.streamSimple(model, { systemPrompt: req.system, messages, tools: req.tools }, { apiKey: cfg.apiKey, signal, reasoning: level === 'off' ? undefined : level, maxTokens: req.maxTokens })) {
    if (e.type === 'text_delta') emit({ type: 'token', text: e.delta })
    if (e.type === 'toolcall_end') emit({ type: 'tool_call', id: e.toolCall.id, name: e.toolCall.name, argsJson: JSON.stringify(e.toolCall.arguments) })
    if (e.type === 'done') emit({ type: 'done', usage: e.message.usage })
    if (e.type === 'error' && !signal?.aborted) emit({ type: 'error', message: e.error.errorMessage || 'Model request failed' })
  }
  return true
}
async function describeChoices(rows) {
  try {
    const lib = await pi()
    return rows.map(row => {
      const provider = row.provider === 'gemini' ? 'google' : row.provider === 'openai' ? 'openai' : null
      const model = provider ? lib.getModels(provider).find(m => m.id === row.id) : null
      return { ...row, name: model?.name || row.id, levels: model?.reasoning ? lib.getSupportedThinkingLevels(model) : [] }
    })
  } catch { return rows }
}
module.exports = { catalog, resolve, stream, describeChoices }
