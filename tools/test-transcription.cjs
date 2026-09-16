const assert = require('node:assert/strict')
const { transcribe } = require('../electron/chat/transcription.cjs')

async function main() {
  const originalFetch = global.fetch
  const requests = []
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), ...init })
    return { ok: true, json: async () => ({ text: ' Guten Tag. ' }) }
  }
  try {
    const audio = { audioBuffer: Buffer.from('test audio'), mime: 'audio/webm' }
    assert.equal((await transcribe(audio)).ok, false)
    assert.equal(requests.length, 0)
    assert.deepEqual(await transcribe({ ...audio, apiKey: 'test-key' }), { ok: true, text: 'Guten Tag.' })
    assert.equal(requests[0].url, 'https://api.openai.com/v1/audio/transcriptions')
    assert.equal(requests[0].body.get('model'), 'gpt-4o-mini-transcribe')
    assert.equal(requests[0].headers.Authorization, 'Bearer test-key')
    assert.equal(await requests[0].body.get('file').text(), 'test audio')
    assert.equal((await transcribe({ ...audio, provider: 'whisper-local', apiKey: 'must-not-leak' })).ok, true)
    assert.equal(requests[1].url, 'http://127.0.0.1:8080/inference')
    assert.deepEqual(requests[1].headers, {})
    assert.equal(requests[1].body.get('language'), 'auto')
    assert.equal(requests[1].body.get('model'), null)
    assert.equal((await transcribe({ ...audio, provider: 'whisper-local', localUrl: 'https://example.com/inference' })).ok, false)
    assert.equal(requests.length, 2)
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid key' } }) })
    assert.equal((await transcribe({ ...audio, apiKey: 'invalid' })).error, 'Invalid key')
    global.fetch = async () => { throw new TypeError('fetch failed') }
    assert.match((await transcribe({ ...audio, provider: 'whisper-local' })).error, /Whisper ist nicht erreichbar/)
    console.log('Transcription request routing, payload, credential separation and error handling passed.')
  } finally { global.fetch = originalFetch }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
