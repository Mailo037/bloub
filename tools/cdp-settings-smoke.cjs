// Settings-Smoke: oeffnet das Fenster, prueft Custom-Select/Switches und tippt
// in das Base-URL-Feld. Nicht Bestandteil der App.
const http = require('node:http')
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d=''; res.on('data', c => d+=c); res.on('end', () => resolve(JSON.parse(d))) }).on('error', reject)
  })
}
async function main() {
  let targets = null
  for (let i = 0; i < 20 && !targets; i++) {
    try { targets = await get('http://127.0.0.1:9222/json') } catch { await new Promise(r => setTimeout(r, 500)) }
  }
  const pet = targets.find((t) => t.url.includes('index.html'))
  if (!pet) throw new Error('pet target missing')
  const ws = new WebSocket(pet.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) } }
  const send = (method, params = {}) => new Promise((r) => { id++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r?.result?.value
  }

  // Settings oeffnen — nur wenn nicht schon offen (toggle wuerde sonst schliessen)
  targets = await get('http://127.0.0.1:9222/json')
  if (!targets.some((t) => t.url.includes('settings.html'))) {
    await evalJs(`window.bloubPet.toggleSettings()`)
    await new Promise((r) => setTimeout(r, 2500))
  }
  targets = await get('http://127.0.0.1:9222/json')
  const settings = targets.find((t) => t.url.includes('settings.html'))
  console.log('settings target:', settings ? 'FOUND' : 'MISSING')
  if (!settings) process.exit(1)

  const ws2 = new WebSocket(settings.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej })
  let id2 = 0
  const p2 = new Map()
  ws2.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && p2.has(msg.id)) { p2.get(msg.id)(msg.result); p2.delete(msg.id) } }
  const evalSet = async (expr) => {
    const r = await send2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error('settings eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r?.result?.value
  }
  function send2(method, params = {}) { return new Promise((r) => { id2++; p2.set(id2, r); ws2.send(JSON.stringify({ id: id2, method, params })) }) }

  console.log('custom select rendered:', await evalSet(`!!document.querySelector('#chat-protocol .k-select')`))
  console.log('switches rendered:', await evalSet(`document.querySelectorAll('.k-switch').length`))
  console.log('select label:', await evalSet(`document.querySelector('#chat-protocol .k-select-trigger span')?.textContent`))

  // Tippen ins Base-URL-Feld simulieren
  await evalSet(`
    (() => {
      const inp = document.getElementById('chat-baseurl')
      inp.focus()
      inp.value = 'https://api.groq.com/openai/v1'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.blur()
      document.body.click()
    })()
  `)
  await new Promise((r) => setTimeout(r, 1200))
  console.log('baseurl kept after blur:', await evalSet(`document.getElementById('chat-baseurl').value`))

  // Config wirklich aktualisiert?
  console.log('config baseUrl:', await evalSet(`window.bloubPet.getConfig().then(c => c.chat.baseUrl)`))
  console.log('protocol guess applied:', await evalSet(`document.querySelector('#chat-protocol .k-select-trigger span')?.textContent`))

  ws.close(); ws2.close()
  console.log('SETTINGS SMOKE OK')
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
