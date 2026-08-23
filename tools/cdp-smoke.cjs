// CDP smoke: Doppelklick auf den Ball -> Dock sichtbar -> Nachricht senden ->
// Antwortbereich reagiert. Das Dock lebt im Pet-Fenster (kein chat.html mehr).
const http = require('node:http')

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(JSON.parse(d)))
    }).on('error', reject)
  })
}

async function main() {
  let targets = null
  for (let i = 0; i < 20 && !targets; i++) {
    try {
      targets = await get('http://127.0.0.1:9222/json')
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (!targets) throw new Error('debug port not reachable')
  const pet = targets.find((t) => t.url.includes('index.html'))
  if (!pet) throw new Error('pet window target not found')

  const ws = new WebSocket(pet.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result ?? msg.error)
      pending.delete(msg.id)
    }
  }
  function send(method, params = {}) {
    return new Promise((resolve) => {
      id++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r?.result?.value
  }

  const geo = await evalJs(`JSON.stringify((() => { const b = document.getElementById('bot').getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + b.height/2 } })())`).then(JSON.parse)

  // Dock per Doppelklick oeffnen
  for (const [type, count] of [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]) {
    await send('Input.dispatchMouseEvent', { type, x: geo.x, y: geo.y, button: 'left', clickCount: count })
    await new Promise((r) => setTimeout(r, 60))
  }
  await new Promise((r) => setTimeout(r, 800))
  console.log('dock visible after dblclick:', await evalJs(`!document.getElementById('chat-dock').classList.contains('hidden')`))
  console.log('input present:', await evalJs(`!!document.getElementById('chat-input')`))
  console.log('no native arrows (scrollbar hidden):', await evalJs(`getComputedStyle(document.getElementById('chat-input')).overflow === 'hidden'`))

  // Senden (ohne API-Key -> sichtbarer Fehlerpfad)
  await evalJs(`
    (() => {
      const input = document.getElementById('chat-input')
      input.value = 'smoke test ping'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
    })()
  `)
  await new Promise((r) => setTimeout(r, 4000))
  console.log('sent chip text:', await evalJs(`document.querySelector('#chip-row .chip')?.textContent ?? null`))
  console.log('reply visible:', await evalJs(`!document.getElementById('reply').classList.contains('hidden')`))
  console.log('reply centered:', await evalJs(`getComputedStyle(document.getElementById('reply-scroll')).textAlign`))
  console.log('reply body:', await evalJs(`document.getElementById('reply-body').textContent.slice(0, 200)`))

  // Esc versteckt das Dock wieder
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise((r) => setTimeout(r, 400))
  console.log('dock hidden after Esc:', await evalJs(`document.getElementById('chat-dock').classList.contains('hidden')`))

  ws.close()
  console.log('SMOKE OK')
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e.message)
  process.exit(1)
})
