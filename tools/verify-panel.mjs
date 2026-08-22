// Verifiziert per CDP, dass das Einstellungs-Panel auf einen Edit-Klick öffnet.
const port = process.argv[2] || '9223'

async function evalOnPage(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === 1) resolve(msg.result)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
  ws.close()
  return result.result?.value
}

const before = await evalOnPage(`document.body.classList.contains('panel-open')`)
await evalOnPage(`document.getElementById('edit').click()`)
await new Promise((r) => setTimeout(r, 600))
const after = await evalOnPage(
  `JSON.stringify({
     open: document.body.classList.contains('panel-open'),
     exprPills: document.querySelectorAll('#expr-pills .pill').length,
     selectedExpr: document.querySelector('#expr-pills .pill.selected')?.dataset.id,
     panelRect: (() => { const r = document.getElementById('panel').getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom) } })()
   })`
)
console.log(`panel open before click: ${before}`)
console.log(`after click: ${after}`)
