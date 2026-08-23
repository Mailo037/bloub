// Reproduziert einen echten Chat-Turn und macht waehrenddessen Screenshots.
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
  const snap = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`tools/state-shots/${name}.png`, Buffer.from(shot.data, 'base64'))
    console.log('shot', name)
  }

  // Chat-Dock sichtbar machen + echte Nachricht senden
  await evalJs(`window.bloubPet.showChat()`)
  await new Promise((r) => setTimeout(r, 400))
  await evalJs(`window.bloubPet.sendChat({ text: 'Bitte sag nur kurz hallo und nichts anderes.', attachmentIds: [] })`)
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 1200))
    await snap(`turn-${String(i).padStart(2, '0')}`)
    const st = await evalJs(`window.__bloubDebug ? window.__bloubDebug.state() : 'n/a'`)
    console.log('state:', st)
  }
  ws.close()
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
