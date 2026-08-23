// Wegwerf-Smoke-Test der drei Adapter (kein Bestandteil der App).
async function* gen(items) {
  for (const i of items) yield i
}
const base = 'C:/Users/kasto/Documents/bloub-pet/app/electron/chat/protocols/'
const oc = require(base + 'openai-completions.cjs')
const or_ = require(base + 'openai-responses.cjs')
const am = require(base + 'anthropic-messages.cjs')

async function collect(adapter, payloads) {
  const evs = []
  for await (const e of adapter.parseStream(gen(payloads))) evs.push(e)
  return evs
}

async function main() {
  let evs = await collect(oc, [
    JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'fs_read', arguments: '' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
    JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    '[DONE]'
  ])
  console.log('openai-completions:', JSON.stringify(evs))

  evs = await collect(or_, [
    JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' }),
    JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'cc1', name: 'fs_read', arguments: '' } }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', delta: '{"path":"a"}' }),
    JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'cc1', name: 'fs_read', arguments: '{"path":"a"}' } }),
    JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3 } } })
  ])
  console.log('openai-responses:', JSON.stringify(evs))

  evs = await collect(am, [
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11 } } }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hey' } }),
    JSON.stringify({ type: 'content_block_stop', index: 0 }),
    JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'fs_tree' } }),
    JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":".' } }),
    JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '/src"}' } }),
    JSON.stringify({ type: 'content_block_stop', index: 1 }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })
  ])
  console.log('anthropic:', JSON.stringify(evs))

  const req = {
    system: 'sys',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mime: 'image/png', data: 'AAA' }] },
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 't1', name: 'fs_read', argsJson: '{"path":"x"}' }] },
      { role: 'tool', toolCallId: 't1', name: 'fs_read', content: 'file data' },
      { role: 'user', content: 'plain' }
    ],
    tools: [{ name: 'fs_read', description: 'd', parameters: { type: 'object' } }],
    maxTokens: 500
  }
  const cfg = { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'K' }
  for (const [name, a] of [['oc', oc], ['or', or_], ['am', am]]) {
    const r = a.buildRequest(req, cfg)
    console.log(name, 'url=', r.url)
    console.log(name, 'headers=', JSON.stringify(r.headers))
    console.log(name, 'body=', JSON.stringify(r.body).slice(0, 900))
    const ping = a.pingRequest(cfg)
    console.log(name, 'ping=', JSON.stringify(ping).slice(0, 200))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
