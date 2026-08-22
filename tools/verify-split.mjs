// Verifiziert die getrennten Fenster: Pet laedt, Settings-Fenster oeffnet per
// Edit-Klick und enthaelt die Pillen; Config-Broadcast aktualisiert das Pet.
const port = process.argv[2] || '9223'

async function withPage(match, fn) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const pages = targets.filter((t) => t.type === 'page')
  const page = pages.find((t) => match(t.url))
  if (!page) throw new Error(`no page matching ${match} among:\n${pages.map((p) => p.url).join('\n')}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  return async (expression) => {
    const myId = ++id
    const result = await new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id === myId) resolve(msg.result)
      }
      ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
    return result.result?.value
  }
}

const pet = await withPage((u) => u.includes('index.html'), null)
await pet(`1`)
console.log('pet page reachable')

// Settings via IPC-Klick im Pet oeffnen
await pet(`document.getElementById('edit').click()`)
await new Promise((r) => setTimeout(r, 1200))

const settings = await withPage((u) => u.includes('settings.html'), null)
const info = await settings(
  `JSON.stringify({
     exprPills: document.querySelectorAll('#expr-pills .pill').length,
     shapePills: document.querySelectorAll('#shape-pills .pill').length,
     swatches: document.querySelectorAll('#color-row .swatch').length,
     selectedExpr: document.querySelector('#expr-pills .pill.selected')?.dataset.id,
     title: document.querySelector('h1')?.textContent,
     hasUppercaseHeadings: [...document.querySelectorAll('h2')].some(h => h.textContent !== h.textContent.toLowerCase())
   })`
)
console.log('settings window:', info)

// Config-Broadcast: Expression im Settings aendern, Pet muss mitziehen
await settings(`document.querySelector('#expr-pills .pill[data-id="heureux"]').click()`)
await new Promise((r) => setTimeout(r, 800))
const petState = await pet(
  `(async () => { const cfg = await window.bloubPet.getConfig(); return JSON.stringify(cfg) })()`
)
console.log('config after change:', petState)

// Settings wieder schliessen
await settings(`document.getElementById('close').click()`)
await new Promise((r) => setTimeout(r, 600))
const vis = await pet(`document.body.classList.contains('settings-open')`)
console.log('settings-open flag after close:', vis)
