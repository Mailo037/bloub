// Faehrt alle Pet-Zustaende durch und macht je einen Screenshot.
const http = require('node:http')
const fs = require('node:fs')
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))) }).on('error', reject)
  })
}
async function main() {
  const targets = await get('http://127.0.0.1:9223/json')
  const pet = targets.find((t) => t.url.includes('index.html'))
  if (!pet) throw new Error('pet target missing')
  const ws = new WebSocket(pet.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) } }
  const send = (method, params = {}) => new Promise((r) => { id++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true })
    return res?.result?.result?.value
  }

  const states = ['idle', 'thinking', 'wink', 'wide', 'notify', 'exclaim', 'alert', 'talk', 'sleep', 'egg', 'lookaround', 'excited', 'focus', 'sideeye', 'stare', 'scan', 'dizzy', 'peek', 'burst', 'comet', 'orbit', 'play', 'absorb', 'swirl']
  fs.mkdirSync('tools/state-shots', { recursive: true })
  for (const s of states) {
    await evalJs(`window.__bloubDebug && window.__bloubDebug.play(${JSON.stringify(s)})`)
    // Mitte der Animation abwarten
    await new Promise((r) => setTimeout(r, 1300))
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`tools/state-shots/${s}.png`, Buffer.from(shot.data, 'base64'))
    console.log('shot', s)
  }
  await evalJs(`window.__bloubDebug.play('idle')`)
  ws.close()
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
