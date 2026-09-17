// Reproducer: dock-composer messages must appear in the standalone chat window
// with their streamed reply — both when the window is already open and when it
// is opened mid-turn. Run: pnpm exec electron tools/test-pet-composer-repro.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-dock-repro-'))
app.setPath('userData', userData)
const history = require('../electron/chat/history.cjs')
const turns = []
require('../electron/chat/agent.cjs').createChat = () => ({
  // Mimic the real agent: persist the user record when the turn starts.
  runTurn: (parts, emit, chatId) => new Promise(resolve => {
    history.appendRecord(userData, { role: 'user', parts }, chatId)
    turns.push({ emit: ev => emit({ ...ev, chatId }), resolve, chatId, parts })
  }),
  runAutopilot: async () => {},
  abort: () => {}, isBusy: () => false, hasPendingTail: () => false, supportsVision: () => false
})
require('../electron/main.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, label, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return } catch { /* page may still be loading */ }
    await delay(50)
  }
  throw new Error(`Timed out: ${label}`)
}
async function run() {
  await app.whenReady()
  let pet, chat
  await waitFor(() => (pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))), 'pet window')
  await waitFor(() => pet.webContents.executeJavaScript('!!document.querySelector("#chat-input")'), 'dock composer')
  const sendDock = text => pet.webContents.executeJavaScript(`(() => { const i = document.querySelector('#chat-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').click() })()`)
  const openChat = async () => {
    await waitFor(() => pet.webContents.executeJavaScript('!!document.querySelector("#pet-open-chat")'), 'pet open-chat button')
    await pet.webContents.executeJavaScript('document.querySelector("#pet-open-chat").click()')
    await waitFor(() => (chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/chat.html') && w.isVisible())), 'visible chat window')
    return chat
  }

  // Scenario A: chat window already open when the dock message is sent.
  await openChat()
  await chat.webContents.executeJavaScript(`(() => { window.__probe = []; window.bloubPet.onChatEvent(ev => window.__probe.push(ev)); return true })()`)
  await sendDock('hello from the dock')
  await waitFor(() => turns.length === 1, 'first dock turn')
  const first = turns[0]
  assert.ok(/^chat-/.test(first.chatId), `dock turn must reuse the startup chat, got ${first.chatId}`)
  console.log('PASS dock message reached main in the startup chat', first.chatId)
  await delay(800)
  const probe = await chat.webContents.executeJavaScript(`JSON.stringify({ events: (window.__probe || []).map(e => ({ type: e.type, chatId: e.chatId, text: (e.text || e.chipText || '').slice(0, 40) })), bubbles: document.querySelectorAll('.message-row').length, activeTitle: document.getElementById('current-chat-title')?.textContent })`)
  console.log('[probe]', probe)
  await waitFor(() => chat.webContents.executeJavaScript(`document.querySelector('#messages-container').innerText.includes('hello from the dock')`), 'dock message bubble in open chat window')
  console.log('PASS dock message appears in the already-open chat window')
  first.emit({ type: 'token', text: 'dock reply one' })
  await waitFor(() => chat.webContents.executeJavaScript(`document.querySelector('.assistant-content')?.innerText.includes('dock reply one')`), 'reply in open chat window')
  first.emit({ type: 'done', truncated: false })
  first.resolve()
  console.log('PASS reply streams into the open chat window')

  // Scenario B: window closed, send from the dock, open mid-turn.
  await chat.webContents.executeJavaScript(`document.querySelector('#win-close').click()`)
  await delay(300)
  await sendDock('second dock message')
  await waitFor(() => turns.length === 2, 'second dock turn')
  const second = turns[1]
  assert.equal(second.chatId, first.chatId, 'second dock message must reuse the same chat')
  console.log('PASS follow-up dock message stays in the same chat (no new chat created)')
  second.emit({ type: 'token', text: 'dock reply two' })
  // Decisive check: the window is still HIDDEN here. If IPC still reaches the
  // renderer, its DOM already contains the reply before we reopen anything.
  await waitFor(() => chat.webContents.executeJavaScript(`[...document.querySelectorAll('.assistant-content')].some(e => e.innerText.includes('dock reply two'))`), 'reply rendered while window hidden')
  console.log('PASS reply rendered in hidden chat window (IPC delivered while hidden)')
  const reopened = await openChat()
  await waitFor(() => reopened.webContents.executeJavaScript(`document.querySelector('#messages-container').innerText.includes('second dock message')`), 'user bubble after reopening mid-turn')
  await waitFor(() => reopened.webContents.executeJavaScript(`[...document.querySelectorAll('.assistant-content')].some(e => e.innerText.includes('dock reply two'))`), 'reply visible in reopened window')
  second.emit({ type: 'done', truncated: false })
  second.resolve()
  console.log('PASS reopened chat window shows dock message and streamed reply')
  const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'chats', `${first.chatId}.json`), 'utf8'))
  assert.equal(persisted.records.filter(r => r.role === 'user').length, 2)
  console.log('PASS both dock messages persisted in the same chat on disk')
  app.exit(0)
}
run().then(() => app.exit(0)).catch(e => { console.error('REPRO FAIL:', e?.stack || e); app.exit(1) })
