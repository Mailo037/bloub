import fs from 'node:fs'

const port = process.argv[2] || '9223'

async function withPage(match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && match(t.url))
  if (!page) throw new Error('no page: ' + match)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  return (expression, awaitPromise = false) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id === myId) resolve(msg.result?.result?.value)
      }
      ws.send(
        JSON.stringify({
          id: myId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise }
        })
      )
    })
}

const pet = await withPage((u) => u.includes('index.html'))
const info = await pet(
  `(async () => {
    return JSON.stringify({
      config: await window.bloubPet.getConfig(),
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      bodyClientWidth: document.body.clientWidth,
      bodyClientHeight: document.body.clientHeight
    })
  })()`,
  true
)
console.log('PET WINDOW INFO:', info)



