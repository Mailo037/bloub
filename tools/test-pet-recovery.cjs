// Resilience smoke: requires a running Bloub instance with a remote debugging
// port (BLOUB_CDP_PORT, default 9222). It crashes the pet renderer deliberately
// and verifies that the recovery handler reloads the actual pet UI.
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

async function petUiIsReady() {
  const target = await waitForPet(1_000)
  const ws = await connect(target)
  try {
    const result = await send(ws, 'Runtime.evaluate', {
      expression: "document.readyState === 'complete' && !!document.getElementById('bot')",
      returnByValue: true
    })
    return result?.result?.value === true
  } finally {
    ws.close()
  }
}

async function waitForRecoveredUi(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (await petUiIsReady()) return
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`pet UI did not recover (${lastError?.message || 'renderer stayed unavailable'})`)
}

async function main() {
  const target = await waitForPet()
  const ws = await connect(target)
  console.log('pet target found; deliberately crashing its renderer…')
  try {
    await send(ws, 'Page.crash')
  } catch (error) {
    // Chromium beantwortet Page.crash je nach Build entweder gar nicht, mit
    // "Target crashed" oder schliesst sofort den DevTools-Socket — alles drei
    // bedeutet, dass der absichtlich ausgeloeste Crash angekommen ist.
    if (!/closed|timed out|target crashed/i.test(error.message)) throw error
  } finally {
    ws.close()
  }
  await waitForRecoveredUi()
  console.log('PET RECOVERY OK')
}

main().catch((error) => {
  console.error('PET RECOVERY FAIL:', error.message)
  process.exit(1)
})
