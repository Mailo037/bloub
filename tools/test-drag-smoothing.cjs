// Drag smoke: requires a running Bloub instance with a remote debugging port
// (BLOUB_CDP_PORT, default 9222). It drives real pointer events, verifies that
// the pet moves, deforms while it is dragged, and springs back after release.
const http = require('node:http')

const port = Number(process.env.BLOUB_CDP_PORT || 9222)
const endpoint = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`${endpoint}${path}`, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function waitForPet(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await getJson('/json')
      const pet = targets.find((target) => target.url.includes('index.html'))
      if (pet) return pet
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`pet target not found (${lastError?.message || 'no debugger response'})`)
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = reject
  })
}

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 2 ** 31)
    const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 3_000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timeout)
      ws.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result?.exceptionDetails) throw new Error(`page evaluation failed: ${result.exceptionDetails.text}`)
  return result?.result?.value
}

async function waitForPetUi(ws, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(ws, "document.readyState === 'complete' && !!document.getElementById('bot')")) return
    } catch {
      /* Navigation kann die DevTools-Verbindung kurz unterbrechen. */
    }
    await sleep(150)
  }
  throw new Error('pet UI did not become ready')
}

async function main() {
  const target = await waitForPet()
  const ws = await connect(target)
  try {
    await waitForPetUi(ws)
    const start = await evaluate(ws, `JSON.stringify((() => {
      const bot = document.getElementById('bot')
      const bounds = bot.getBoundingClientRect()
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, screenX: window.screenX }
    })())`).then(JSON.parse)

    await send(ws, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1
    })
    for (let step = 1; step <= 36; step++) {
      await send(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: start.x + step * 3, y: start.y + Math.round(Math.sin(step / 5) * 8), button: 'left', buttons: 1
      })
    }
    await sleep(80)

    const during = await evaluate(ws, `JSON.stringify({
      dragging: document.getElementById('bot').classList.contains('dragging'),
      transform: document.getElementById('drag-wrap').style.transform,
      screenX: window.screenX
    })`).then(JSON.parse)
    if (!during.dragging) throw new Error('drag state was not entered')
    if (!during.transform) throw new Error('drag follow transform was not applied')
    if (during.screenX - start.screenX < 60) throw new Error('native pet window did not follow the pointer')

    await send(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: start.x + 108, y: start.y, button: 'left', buttons: 0, clickCount: 1
    })
    await sleep(1_000)

    const after = await evaluate(ws, `JSON.stringify({
      dragging: document.getElementById('bot').classList.contains('dragging'),
      transform: document.getElementById('drag-wrap').style.transform
    })`).then(JSON.parse)
    if (after.dragging) throw new Error('drag state did not end')
    if (after.transform) throw new Error('drag follow did not settle')
    console.log(`DRAG SMOOTHING OK (moved ${during.screenX - start.screenX}px)`)
  } finally {
    ws.close()
  }
}

main().catch((error) => {
  console.error('DRAG SMOOTHING FAIL:', error.message)
  process.exit(1)
})
