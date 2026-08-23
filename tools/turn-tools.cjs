// Reproduziert einen Tool-Call-Turn (wie beim User) und macht schnelle Serien-Screenshots.
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
  let shotIdx = 0
  const snap = async () => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const name = `tc-${String(shotIdx++).padStart(3, '0')}`
    fs.writeFileSync(`tools/state-shots/${name}.png`, Buffer.from(shot.data, 'base64'))
    return name
  }

  await evalJs(`window.bloubPet.showChat()`)
  await new Promise((r) => setTimeout(r, 300))
  await evalJs(`window.bloubPet.sendChat({ text: 'Pruefe bitte mit einem Tool, ob openpyxl installiert ist.', attachmentIds: [] })`)
  const endAt = Date.now() + 45000
  while (Date.now() < endAt) {
    await snap()
    await new Promise((r) => setTimeout(r, 450))
  }
  console.log('done', shotIdx, 'shots')
  ws.close()
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
