// Isolated Electron integration test: real IPC/UI, fake agent (no API calls).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-activity-')))
let turn
require('../electron/chat/agent.cjs').createChat = () => ({
  runTurn: (_parts, emit, chatId) => new Promise(resolve => { turn = { emit: ev => emit({ ...ev, chatId }), resolve } }),
  abort: () => { turn.emit({ type: 'done', truncated: false }); turn.resolve() },
  isBusy: () => false, hasPendingTail: () => false, supportsVision: () => false
})
require('../electron/main.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50) }
  throw new Error('Timed out')
}
async function run() {
  await app.whenReady()
  let pet, chat
  await waitFor(() => (pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))))
  await waitFor(() => pet.webContents.executeJavaScript('!!document.querySelector("#pet-open-chat")'))
  await pet.webContents.executeJavaScript('document.querySelector("#pet-open-chat").click()')
  await waitFor(() => (chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/chat.html') && w.isVisible())))
  await delay(300)
  const evaluate = js => chat.webContents.executeJavaScript(js)
  const visible = () => evaluate('!!document.querySelector(".chat-working:not(.hidden)")')
  async function send() {
    turn = null
    await evaluate(`(() => { const i = document.querySelector('#standalone-input'); i.value = 'test'; i.dispatchEvent(new Event('input')); document.querySelector('#standalone-send-btn').click() })()`)
    await waitFor(() => turn)
    await waitFor(visible)
  }
  await send()
  const screenshot = path.join(os.tmpdir(), 'bloub-chat-working.png')
  fs.writeFileSync(screenshot, (await chat.webContents.capturePage()).toPNG())
  turn.emit({ type: 'token', text: 'Antwort' })
  await waitFor(async () => !await visible())
  turn.emit({ type: 'tools' })
  await waitFor(visible)
  turn.emit({ type: 'clear' })
  await waitFor(visible)
  turn.emit({ type: 'error', message: 'credit insufficient balance (test)' })
  turn.resolve()
  await waitFor(async () => !await visible())
  assert.match(await evaluate('document.querySelector("#messages-container").textContent'), /credit insufficient balance/)
  assert.equal(await pet.webContents.executeJavaScript('document.querySelector("#reply").classList.contains("hidden")'), true)
  assert.equal(await pet.webContents.executeJavaScript('document.querySelector("#reply-body").textContent.includes("credit insufficient balance")'), false)
  console.log('PASS waiting, streaming, tools, error; error only in chat window')
  await send()
  await evaluate('document.querySelector("#standalone-send-btn").click()')
  await waitFor(async () => !await visible())
  console.log('PASS abort removes activity indicator')
  await send()
  turn.emit({ type: 'done', truncated: false }); turn.resolve()
  await waitFor(async () => !await visible())
  console.log('PASS completion removes activity indicator')
  console.log('Screenshot:', screenshot)
}
run().then(() => app.exit(0)).catch(e => { console.error(e); app.exit(1) })
