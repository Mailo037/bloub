const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
class FakeSocket extends EventEmitter {
  static OPEN = 1
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; FakeSocket.last = this }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
}
const scope = { require: () => FakeSocket, module: { exports: {} }, setTimeout, clearTimeout }
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/chat/live-voice.cjs'), 'utf8'), scope)
const { connectVoice } = scope.module.exports
assert.throws(() => connectVoice({ provider: 'openai' }), /OpenAI API key/)
for (const provider of ['openai', 'gemini']) {
  const events = []
  const session = connectVoice({ provider, apiKey: 'test-secret', emit: event => events.push(event) })
  const ws = FakeSocket.last
  assert(!ws.url.includes('test-secret'))
  session.audio('AAAA'); assert.equal(ws.sent.length, 0)
  ws.emit('open')
  if (provider === 'openai') {
    assert.equal(ws.sent[0].session.model, 'gpt-live-1')
    assert.equal(ws.sent[0].session.audio.format.rate, 24000)
    ws.emit('message', Buffer.from('{"type":"session.started"}'))
    ws.emit('message', Buffer.from('{"type":"session.output_audio.delta","delta":"AAAA"}'))
  } else {
    assert.equal(ws.sent[0].setup.model, 'models/gemini-3.1-flash-live-preview')
    ws.emit('message', Buffer.from('{"setupComplete":{}}'))
    ws.emit('message', Buffer.from('{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"data":"AAAA","mimeType":"audio/pcm;rate=24000"}}]}}}'))
    ws.emit('message', Buffer.from('{"serverContent":{"interrupted":true}}'))
    assert(events.some(e => e.type === 'interrupted'))
  }
  assert(events.some(e => e.type === 'ready'))
  assert(events.some(e => e.type === 'audio' && e.sampleRate === 24000))
  session.audio('AAAA')
  assert(provider === 'openai' ? ws.sent[1].type === 'session.input_audio.append' : ws.sent[1].realtimeInput.audio.mimeType === 'audio/pcm;rate=16000')
  session.close()
  if (provider === 'openai') { assert.equal(ws.sent.at(-1).type, 'session.close'); ws.emit('message', Buffer.from('{"type":"session.closed"}')) }
  assert(events.some(e => e.type === 'closed'))
}
console.log('Both live voice protocols: startup gating, PCM audio, interruption and close passed.')
