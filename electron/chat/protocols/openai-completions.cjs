// Adapter: OpenAI Chat-Completions (/chat/completions) — deckt OpenAI, Groq,
// OpenRouter, Together, LM Studio, Ollama /v1, llama.cpp, DeepSeek ab.
// Referenz-Implementierung des Adapter-Vertrags (siehe provider.cjs).
//
// Normalisiert:  { system, messages, tools, maxTokens }
//   message: { role:'user', content }        content: string | parts[]
//            { role:'assistant', content, toolCalls?: [{id,name,argsJson}] }
//            { role:'tool', toolCallId, name, content }
//   part:    { type:'text', text } | { type:'image', mime, data }   (data = base64)
// Events: { type:'token', text } | { type:'tool_call', id, name, argsJson }
//       | { type:'done', usage? }

function authHeaders(cfg) {
  const h = {}
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`
  return h
}

function contentToWire(content) {
  if (typeof content === 'string') return content
  // Vision: Text- und Bild-Parts als content-Array
  const parts = []
  for (const p of content) {
    if (p.type === 'text') parts.push({ type: 'text', text: p.text })
    else if (p.type === 'image')
      parts.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } })
  }
  return parts
}

function toolsToWire(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

function buildRequest(req, cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const messages = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: contentToWire(m.content) })
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content ?? null }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsJson }
        }))
      }
      messages.push(msg)
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    }
  }
  const body = { model: cfg.model, messages, stream: true, stream_options: { include_usage: true } }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.tools?.length) body.tools = toolsToWire(req.tools)
  return { url: `${base}/chat/completions`, headers: authHeaders(cfg), body }
}

function pingRequest(cfg) {
  return {
    url: `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    headers: authHeaders(cfg),
    // max_tokens 16: manche Endpoints (z.B. llama.cpp) lehnen Werte <= 2 ab
    body: { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false }
  }
}

/**
 * Konsumiert SSE-Data-Payloads (bereits zu data:-Feldern zusammengefasst) und
 * liefert normalisierte Events. Tool-Call-Delta-Argumente werden akkumuliert.
 */
async function* parseStream(sse) {
  const toolAcc = new Map() // index -> { id, name, args }
  let usage = null
  for await (const data of sse) {
    if (data === '[DONE]') break
    let ev
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    if (ev.usage) usage = ev.usage
    const choice = ev.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (delta.content) yield { type: 'token', text: delta.content }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0
        let acc = toolAcc.get(i)
        if (!acc) {
          acc = { id: tc.id || `call_${i}`, name: '', args: '' }
          toolAcc.set(i, acc)
        }
        if (tc.id) acc.id = tc.id
        if (tc.function?.name) acc.name += tc.function.name
        if (tc.function?.arguments) acc.args += tc.function.arguments
      }
    }
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
      for (const [i, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: 'tool_call', id: acc.id, name: acc.name, argsJson: acc.args || '{}' }
      }
      toolAcc.clear()
    }
  }
  for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: 'tool_call', id: acc.id, name: acc.name, argsJson: acc.args || '{}' }
  }
  yield { type: 'done', usage: usage ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens } : undefined }
}

module.exports = { buildRequest, pingRequest, parseStream }
