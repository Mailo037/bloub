// Adapter: OpenAI Responses API (/responses) — das neuere Wire-Format mit
// input-Items statt messages und function_call/function_call_output als
// eigenen Items.
//
// Vertrag siehe openai-completions.cjs (Referenz).

function authHeaders(cfg) {
  const h = {}
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`
  return h
}

function userContentToWire(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }]
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'input_text', text: p.text }
      : { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` }
  )
}

function buildRequest(req, cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const input = []
  for (const m of req.messages) {
    if (m.role === 'user') {
      input.push({ type: 'message', role: 'user', content: userContentToWire(m.content) })
    } else if (m.role === 'assistant') {
      // Text zuerst, dann die Function-Calls als eigene Items
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }]
        })
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.argsJson })
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
    }
  }
  const body = { model: cfg.model, stream: true, max_output_tokens: req.maxTokens || 1024 }
  if (req.system) body.instructions = req.system
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }
  return { url: `${base}/responses`, headers: authHeaders(cfg), body: { ...body, input } }
}

function pingRequest(cfg) {
  return {
    url: `${cfg.baseUrl.replace(/\/+$/, '')}/responses`,
    headers: authHeaders(cfg),
    body: { model: cfg.model, input: 'ping', max_output_tokens: 16, stream: false }
  }
}

async function* parseStream(sse) {
  let pending = null // { id, name, args }
  let usage = null
  for await (const data of sse) {
    if (data === '[DONE]') break
    let ev
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    switch (ev.type) {
      case 'response.output_text.delta':
        if (ev.delta) yield { type: 'token', text: ev.delta }
        break
      case 'response.output_item.added':
        if (ev.item?.type === 'function_call') {
          pending = { id: ev.item.call_id || ev.item.id || `call_${pendingCount++}`, name: ev.item.name ?? '', args: ev.item.arguments ?? '' }
        }
        break
      case 'response.function_call_arguments.delta':
        if (pending && ev.delta) pending.args += ev.delta
        break
      case 'response.output_item.done':
        if (ev.item?.type === 'function_call') {
          yield {
            type: 'tool_call',
            id: ev.item.call_id || ev.item.id || pending?.id || 'call_0',
            name: ev.item.name ?? pending?.name ?? '',
            argsJson: ev.item.arguments ?? pending?.args ?? '{}'
          }
          pending = null
        }
        break
      case 'response.completed':
      case 'response.incomplete':
        if (ev.response?.usage) {
          usage = { prompt: ev.response.usage.input_tokens, completion: ev.response.usage.output_tokens }
        }
        break
      case 'error':
      case 'response.failed':
        yield { type: 'error', message: ev.error?.message ?? ev.response?.status_details?.error?.message ?? 'provider error' }
        return
    }
  }
  yield { type: 'done', usage }
}

let pendingCount = 0

module.exports = { buildRequest, pingRequest, parseStream }
