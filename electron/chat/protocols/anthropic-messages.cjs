// Adapter: Anthropic Messages API (/messages). Unterschiede zum OpenAI-Flavor:
// Auth via x-api-key + anthropic-version, max_tokens ist PFLICHT, Tool-Results
// sind tool_result-Bloecke INNERHALB einer User-Nachricht.

function authHeaders(cfg) {
  const h = { 'anthropic-version': '2023-06-01' }
  if (cfg.apiKey) h['x-api-key'] = cfg.apiKey
  return h
}

function userContentToWire(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
  )
}

/**
 * Baut die messages-Liste. Anthropic verlangt abwechselnd user/assistant;
 * Tool-Results (role:'tool') landen als tool_result-Bloecke in einer
 * User-Nachricht, notfalls mit synthetischem Assistant davor.
 */
function messagesToWire(messages) {
  const out = []
  const pushUser = (content) => {
    const last = out[out.length - 1]
    if (last?.role === 'user') last.content.push(...content)
    else out.push({ role: 'user', content })
  }
  for (const m of messages) {
    if (m.role === 'user') {
      pushUser(userContentToWire(m.content))
    } else if (m.role === 'assistant') {
      const content = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        let input = {}
        try {
          input = JSON.parse(tc.argsJson || '{}')
        } catch {
          /* Modell-Fehler -> leeres input, der Server meckert schon */
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(empty)' }] })
    } else if (m.role === 'tool') {
      // Synthetischer Assistant-Turn, falls die Results direkt auf einen User-Turn folgen
      const last = out[out.length - 1]
      if (!last || last.role !== 'assistant') out.push({ role: 'assistant', content: [{ type: 'text', text: '(tool use)' }] })
      pushUser([{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }])
    }
  }
  return out
}

function buildRequest(req, cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  // System darf String oder Blocks sein — wir schicken schlichten Text.
  const body = {
    model: cfg.model,
    max_tokens: req.maxTokens || 1024,
    stream: true,
    messages: messagesToWire(req.messages)
  }
  if (req.system) body.system = req.system
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }))
  }
  return { url: `${base}/messages`, headers: authHeaders(cfg), body }
}

function pingRequest(cfg) {
  return {
    url: `${cfg.baseUrl.replace(/\/+$/, '')}/messages`,
    headers: authHeaders(cfg),
    // 16 statt 1: manche Proxies lehnen winzige Werte ab
    body: { model: cfg.model, max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] }
  }
}

async function* parseStream(sse) {
  let openBlock = null // 'text' | { toolUse: { id, name, args } }
  let promptTokens
  let completionTokens
  for await (const data of sse) {
    if (data === '[DONE]') break
    let ev
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    switch (ev.type) {
      case 'message_start':
        promptTokens = ev.message?.usage?.input_tokens
        break
      case 'content_block_start': {
        const b = ev.content_block
        if (b?.type === 'tool_use') openBlock = { toolUse: { id: b.id, name: b.name, args: '' } }
        else if (b?.type === 'text') openBlock = 'text'
        else openBlock = null
        break
      }
      case 'content_block_delta': {
        const d = ev.delta
        if (d?.type === 'text_delta' && d.text && openBlock === 'text') yield { type: 'token', text: d.text }
        else if (d?.type === 'input_json_delta' && d.partial_json && openBlock?.toolUse) openBlock.toolUse.args += d.partial_json
        break
      }
      case 'content_block_stop':
        if (openBlock?.toolUse) {
          yield {
            type: 'tool_call',
            id: openBlock.toolUse.id,
            name: openBlock.toolUse.name,
            argsJson: openBlock.toolUse.args || '{}'
          }
        }
        openBlock = null
        break
      case 'message_delta':
        completionTokens = ev.usage?.output_tokens ?? completionTokens
        break
      case 'error':
        yield { type: 'error', message: ev.error?.message ?? 'provider error' }
        return
    }
  }
  yield {
    type: 'done',
    usage:
      promptTokens !== undefined || completionTokens !== undefined
        ? { prompt: promptTokens, completion: completionTokens }
        : undefined
  }
}

module.exports = { buildRequest, pingRequest, parseStream }
