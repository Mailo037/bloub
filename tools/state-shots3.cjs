// Neue Zustaende fotografieren, waehrend CDP-Mausbewegungen den Schlaf fernhalten.
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
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.result?.value
  const wiggle = async () => {
    // Maus ueber den Ball bewegen — holt den Bloub aus dem Tiefschlaf
    for (const [x, y] of [[280, 280], [300, 300], [320, 310], [300, 290]]) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await new Promise((r) => setTimeout(r, 40))
    }
  }

  await wiggle()
  await evalJs(`window.bloubPet && document.hasFocus()` )
  const states = ['wake', 'aha', 'ohno', 'nod', 'shake', 'talk', 'idle']
  for (const s of states) {
    await wiggle()
    await evalJs(`window.__bloubDebug.play(${JSON.stringify(s)})`)
    // waehrend der Animation wachhalten
    const until = Date.now() + 1200
    while (Date.now() < until) { await wiggle(); await new Promise((r) => setTimeout(r, 150)) }
    await wiggle()
    const st = await evalJs(`window.__bloubDebug.state()`)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`tools/state-shots/new-${s}.png`, Buffer.from(shot.data, 'base64'))
    console.log('shot', s, 'state:', st)
  }
  ws.close()
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
