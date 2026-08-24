// Visual QA for the settings and right-click menu. Requires a running Bloub
// instance with a remote debugging port (BLOUB_CDP_PORT, default 9222).
const fs = require('node:fs')
const http = require('node:http')

const port = Number(process.env.BLOUB_CDP_PORT || 9222)
const endpoint = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`${endpoint}/json`, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

async function waitForTarget(partialUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const target = (await getTargets()).find((entry) => entry.url.includes(partialUrl))
      if (target) return target
    } catch {
      /* app is still starting */
    }
    await sleep(200)
  }
  throw new Error(`${partialUrl} target not found`)
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

async function waitForUi(ws, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(ws, expression)) return
    } catch {
      /* the first page navigation can race the DevTools target */
    }
    await sleep(150)
  }
  throw new Error('settings UI not ready')
}

async function saveScreenshot(ws, outputPath) {
  const result = await send(ws, 'Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(outputPath, Buffer.from(result.data, 'base64'))
}

async function main() {
  const pet = await waitForTarget('index.html')
  const petWs = await connect(pet)
  try {
    const openTargets = await getTargets()
    if (!openTargets.some((target) => target.url.includes('settings.html'))) {
      await evaluate(petWs, 'window.bloubPet.toggleSettings()')
    }
    const settings = await waitForTarget('settings.html')
    const settingsWs = await connect(settings)
    try {
      await waitForUi(settingsWs, "document.readyState === 'complete' && !!document.getElementById('card')")
      await saveScreenshot(settingsWs, 'tools/settings-revamp.png')
      console.log('saved tools/settings-revamp.png')
      for (const [tab, file] of [['chat', 'settings-chat-revamp.png'], ['audio', 'settings-voice-revamp.png'], ['pet', 'settings-pet-revamp.png'], ['recall', 'settings-recall-revamp.png']]) {
        const visible = await evaluate(settingsWs, `(() => {
          document.querySelector('[data-tab="${tab}"]').click()
          return !document.getElementById('pane-${tab}').classList.contains('hidden') && !!document.querySelector('#pane-${tab} .pane-intro')
        })()`)
        if (!visible) throw new Error(`${tab} settings page did not render its page structure`)
        if (tab === 'chat') {
          const grantActions = await evaluate(settingsWs, `(() => {
            document.getElementById('grant-list').scrollIntoView({ block: 'center' })
            return [...document.querySelectorAll('.grant-action')].map((button) => button.textContent.trim())
          })()`)
          if (grantActions.length && (!grantActions.some((label) => label.includes('Sensitive files')) || !grantActions.some((label) => label.includes('Remove')))) {
            throw new Error('granted-folder actions are not labelled clearly')
          }
          await sleep(80)
          await saveScreenshot(settingsWs, 'tools/settings-chat-grants-revamp.png')
          console.log('saved tools/settings-chat-grants-revamp.png')
        }
        if (tab === 'pet') {
          const driveControl = await evaluate(settingsWs, `(() => ({
            action: document.getElementById('drive-access-btn')?.textContent?.trim(),
            status: document.getElementById('drive-access-status')?.textContent?.trim(),
            terminal: document.getElementById('terminal-access-status')?.textContent?.trim()
          }))()`)
          if (!driveControl.action || !driveControl.status || !driveControl.terminal) {
            throw new Error('drive and terminal actions are not explained in the pet settings')
          }
          await evaluate(settingsWs, "document.getElementById('scroll').scrollTo({ top: 0 })")
          await sleep(80)
          await saveScreenshot(settingsWs, 'tools/settings-pet-overview-revamp.png')
          console.log('saved tools/settings-pet-overview-revamp.png')
          await evaluate(settingsWs, "document.getElementById('drive-access-btn').scrollIntoView({ block: 'center' })")
          await sleep(80)
          await saveScreenshot(settingsWs, 'tools/settings-pet-access-revamp.png')
          console.log('saved tools/settings-pet-access-revamp.png')
        }
        await sleep(80)
        await saveScreenshot(settingsWs, `tools/${file}`)
        console.log(`saved tools/${file}`)
      }
      const searchResult = await evaluate(settingsWs, `(() => {
        document.getElementById('search-toggle').click()
        const input = document.getElementById('search-input')
        input.value = 'hotkey'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return {
          hits: document.querySelectorAll('.well.search-hit').length,
          status: document.getElementById('search-status').textContent,
          chatVisible: !document.getElementById('pane-chat').classList.contains('hidden')
        }
      })()`)
      if (searchResult.hits < 1 || !searchResult.chatVisible) throw new Error('settings search did not reveal its matching section')
      await evaluate(settingsWs, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      const searchClosed = await evaluate(settingsWs, "document.getElementById('search-bar').classList.contains('hidden') && !document.getElementById('card').classList.contains('closing')")
      if (!searchClosed) throw new Error('Escape did not close only the settings search')
      console.log(`settings search OK (${searchResult.hits} hits)`)
    } finally {
      settingsWs.close()
    }

    await evaluate(petWs, `(() => {
      const bot = document.getElementById('bot')
      const rect = bot.getBoundingClientRect()
      bot.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }))
      return !document.getElementById('pet-menu').classList.contains('hidden')
    })()`)
    await sleep(120)
    await saveScreenshot(petWs, 'tools/pet-menu-revamp.png')
    console.log('saved tools/pet-menu-revamp.png')
  } finally {
    petWs.close()
  }
}

main().catch((error) => {
  console.error('VISUAL QA FAIL:', error.message)
  process.exit(1)
})
