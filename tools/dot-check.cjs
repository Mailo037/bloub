// CDP-Screenshot + Zustands-Inspektion des Pet-Fensters.
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
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return res?.result?.result?.value
  }

  const info = await evalJs(`JSON.stringify({ cfg: window.bloubPet ? 'bridge' : 'nobridge' })`)
  console.log('info:', info)

  // Zustand des SVG inspizieren: welche Elemente sind sichtbar wo?
  const dump = await evalJs(`(() => {
    const svg = document.getElementById('bot')
    const out = []
    for (const el of svg.querySelectorAll('*')) {
      if (el.tagName === 'linearGradient' || el.tagName === 'stop') continue
      const r = el.getBBox ? el.getBBox() : null
      out.push({
        tag: el.tagName,
        fill: el.getAttribute('fill'),
        stroke: el.getAttribute('stroke'),
        opacity: el.getAttribute('opacity'),
        vis: el.getAttribute('visibility'),
        x: r ? Math.round(r.x) : null,
        y: r ? Math.round(r.y) : null,
        w: r ? Math.round(r.width) : null,
        h: r ? Math.round(r.height) : null
      })
    }
    return JSON.stringify(out)
  })()`)
  console.log('SVG elements:', dump)

  await new Promise((r) => setTimeout(r, 500))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('tools/dot-check.png', Buffer.from(shot.data, 'base64'))
  console.log('saved tools/dot-check.png')
  ws.close()
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
