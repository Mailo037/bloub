// Macht einen Screenshot des Pet-Fensters (Selbstkontrolle des Stylings).
const http = require('node:http')
const fs = require('node:fs')
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d=''; res.on('data', c => d+=c); res.on('end', () => resolve(JSON.parse(d))) }).on('error', reject)
  })
}
async function main() {
  const targets = await get('http://127.0.0.1:9222/json')
  const pet = targets.find((t) => t.url.includes('index.html'))
  if (!pet) throw new Error('pet target missing')
  const ws = new WebSocket(pet.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) } }
  const send = (method, params = {}) => new Promise((r) => { id++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })

  // Dock oeffnen und eine Testfrage als Chip setzen
  await send('Runtime.evaluate', { expression: `window.bloubPet.toggleChat()` })
  await new Promise((r) => setTimeout(r, 600))
  await send('Runtime.evaluate', { expression: `
    (() => {
      const root = document.getElementById('chat-dock')
      root.classList.remove('hidden')
      const row = document.getElementById('chip-row')
      const c = document.createElement('span')
      c.className = 'chip'
      c.textContent = 'test'
      row.appendChild(c)
      const body = document.getElementById('reply-body')
      body.classList.add('glimmer')
      body.textContent = 'The bloub is thinking about your question …'
      document.getElementById('reply').classList.remove('hidden')
    })()
  ` })
  await new Promise((r) => setTimeout(r, 400))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('tools/dock-preview.png', Buffer.from(shot.data, 'base64'))
  console.log('saved tools/dock-preview.png')
  // Zustand zuruecksetzen
  await send('Runtime.evaluate', { expression: `window.bloubPet.hideChat()` })
  ws.close()
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
