// Isolated Electron integration test for the chat window experience:
// welcome state, rich markdown, activity steps, friendly errors + retry,
// pasted image attachments, chat list grouping/rename/delete.
// Fake agent (no API calls); run with: npx electron tools/test-chat-experience.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-experience-'))
app.setPath('userData', userData)
const history = require('../electron/chat/history.cjs')
const turns = []
require('../electron/chat/agent.cjs').createChat = () => ({
  runTurn: (parts, emit, chatId) => new Promise(resolve => {
    history.appendRecord(userData, { role: 'user', parts }, chatId)
    turns.push({ parts, chatId, emit: ev => emit({ ...ev, chatId }), resolve })
  }),
  abort: () => {},
  isBusy: () => false, hasPendingTail: () => false, supportsVision: () => true
})
require('../electron/main.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, label = 'condition') {
  for (let i = 0; i < 120; i++) { if (await fn()) return; await delay(50) }
  throw new Error(`Timed out waiting for ${label}`)
}
const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-chat-shots-'))

async function run() {
  await app.whenReady()
  let pet, chat
  await waitFor(() => (pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))), 'pet window')
  await waitFor(() => pet.webContents.executeJavaScript('!!document.querySelector("#pet-open-chat")'), 'pet toolbar')
  await pet.webContents.executeJavaScript('document.querySelector("#pet-open-chat").click()')
  await waitFor(() => (chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/chat.html') && w.isVisible())), 'chat window')
  chat.setSize(520, 720)
  await delay(400)
  const evaluate = js => chat.webContents.executeJavaScript(js)
  const shot = async name => {
    // Let entrance animations finish and force a fresh frame before capturing.
    await delay(450)
    chat.webContents.invalidate()
    await delay(100)
    fs.writeFileSync(path.join(shots, `${name}.png`), (await chat.webContents.capturePage()).toPNG())
  }

  // Welcome state: greeting, suggestions, setup hint (no key configured in a fresh profile)
  await waitFor(() => evaluate('document.querySelectorAll(".suggestion").length === 4'), 'suggestions')
  await waitFor(() => evaluate('!document.querySelector("#setup-callout").classList.contains("hidden")'), 'setup callout')
  assert.equal(await evaluate('document.querySelector("#recent-chats-box").classList.contains("hidden")'), true)
  await shot('01-welcome')
  console.log('PASS welcome state with suggestions and setup callout')

  // Suggestion that fills the composer instead of sending
  await evaluate('[...document.querySelectorAll(".suggestion")].find(b => b.textContent === "Summarize a text").click()')
  assert.match(await evaluate('document.querySelector("#standalone-input").value'), /^Summarize this/)
  assert.equal(turns.length, 0)
  console.log('PASS fill-in suggestion does not send')

  // Pasted image (no file path) becomes an attachment chip with preview
  await evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8
    c.getContext('2d').fillStyle = '#3b82f6'; c.getContext('2d').fillRect(0, 0, 8, 8)
    const blob = await new Promise(r => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
    document.querySelector('#standalone-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(() => evaluate('document.querySelectorAll("#attachment-tray .attach-chip").length === 1'), 'attachment chip')
  assert.equal(await evaluate('!!document.querySelector("#attachment-tray .attach-thumb")'), true)

  // Attaching from the chat window only returns chips — it never starts an "inspect" turn
  const notes = path.join(userData, 'notes.txt')
  fs.writeFileSync(notes, 'hello notes')
  const attached = await evaluate(`window.bloubPet.attachPaths(${JSON.stringify([notes])}, { inspect: false })`)
  assert.equal(attached.chips[0].name, 'notes.txt')
  assert.ok(attached.chips[0].id)
  await delay(600)
  assert.equal(turns.length, 0, 'composer attachments never start a turn on their own')
  console.log('PASS chat-window attachments do not trigger an automatic reply')

  // Send: Enter while generating must not abort
  await evaluate(`(() => { const i = document.querySelector('#standalone-input'); i.value = 'Explain markdown please'; i.dispatchEvent(new Event('input')); document.querySelector('#standalone-send-btn').click() })()`)
  await waitFor(() => turns.length === 1, 'first turn')
  assert.ok(turns[0].parts.some(p => p.type === 'image'), 'pasted image reaches the model')
  assert.equal(await evaluate('document.querySelectorAll("#attachment-tray .attach-chip").length'), 0)
  assert.equal(await evaluate('!!document.querySelector(".message-row.user .user-image")'), true)
  await evaluate(`document.querySelector('#standalone-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  assert.equal(await evaluate('document.querySelector("#standalone-send-btn").title'), 'Stop generating')
  console.log('PASS pasted image attaches, sends, and Enter does not abort a running answer')

  const t1 = turns[0]
  t1.emit({ type: 'tools' })
  t1.emit({ type: 'note', text: 'Reading the docs 📚' })
  await waitFor(() => evaluate('document.querySelector(".chat-working-text").textContent === "Reading the docs 📚"'), 'note in working indicator')
  t1.emit({ type: 'note', text: '⚠ file not found' })
  t1.emit({ type: 'clear' })
  const answer = [
    '## Markdown basics',
    'Here are **three** things, see [the guide](https://example.com/guide):',
    '1. Lists',
    '2. Tables',
    '   - nested item',
    '3. Code',
    '',
    '| Syntax | Result |',
    '|---|:---:|',
    '| `**b**` | **b** |',
    '',
    '> Tip: keep it short.',
    '',
    '```js',
    'console.log("hi")',
    '```'
  ].join('\n')
  for (const chunk of answer.match(/[\s\S]{1,40}/g)) t1.emit({ type: 'token', text: chunk })
  history.appendRecord(userData, { role: 'assistant', content: answer }, t1.chatId)
  t1.emit({ type: 'done', truncated: false }); t1.resolve()
  await waitFor(() => evaluate('document.querySelector("#standalone-send-btn").title === "Send"'), 'turn done')
  const md = JSON.parse(await evaluate(`JSON.stringify({
    h: !!document.querySelector('.assistant-content h4.md-h2'),
    ol: document.querySelectorAll('.assistant-content ol > li').length,
    nested: !!document.querySelector('.assistant-content ol li ul li'),
    table: document.querySelectorAll('.assistant-content table td').length,
    quote: !!document.querySelector('.assistant-content blockquote'),
    code: document.querySelector('.assistant-content .md-code-lang')?.textContent,
    link: document.querySelector('.assistant-content a.md-link')?.getAttribute('href'),
    steps: document.querySelectorAll('.activity-list li').length,
    warn: document.querySelectorAll('.activity-list li.warn').length,
    summary: document.querySelector('.activity-summary').textContent,
    open: document.querySelector('.activity').open,
    regen: !!document.querySelector('.message-row.assistant .message-retry')
  })`))
  assert.deepEqual(md, { h: true, ol: 3, nested: true, table: 2, quote: true, code: 'js', link: 'https://example.com/guide', steps: 2, warn: 1, summary: '2 steps', open: false, regen: true })
  await shot('02-markdown-answer')
  console.log('PASS rich markdown, collapsed activity steps and regenerate action')

  // Code copy button copies only the code
  await evaluate(`window.__copied = []; Object.defineProperty(navigator.clipboard, 'writeText', { value: async text => { window.__copied.push(text) } })`)
  await evaluate('document.querySelector(".md-code-copy").click()')
  await waitFor(async () => (await evaluate('window.__copied.at(-1)')) === 'console.log("hi")', 'code copy')
  console.log('PASS code block copy')

  // Error -> friendly card -> Retry re-runs the same message
  await evaluate(`(() => { const i = document.querySelector('#standalone-input'); i.value = 'second question'; i.dispatchEvent(new Event('input')); document.querySelector('#standalone-send-btn').click() })()`)
  await waitFor(() => turns.length === 2, 'second turn')
  turns[1].emit({ type: 'error', message: '401 · Incorrect API key provided: sk-test' })
  turns[1].resolve()
  await waitFor(() => evaluate('!!document.querySelector(".error-notice")'), 'error card')
  const err = JSON.parse(await evaluate(`JSON.stringify({
    title: document.querySelector('.error-notice strong').textContent,
    detail: document.querySelector('.error-notice code').textContent,
    buttons: [...document.querySelectorAll('.error-notice .error-btn')].map(b => b.textContent)
  })`))
  assert.deepEqual(err, { title: 'The API key was rejected', detail: '401 · Incorrect API key provided: sk-test', buttons: ['Retry', 'Open Connections'] })
  await shot('03-error-card')
  await evaluate('document.querySelector(".error-notice .error-btn.primary").click()')
  await waitFor(() => turns.length === 3, 'retry turn')
  assert.equal(turns[2].parts[0].text, 'second question')
  const userRows = await evaluate('[...document.querySelectorAll(".message-row.user .user-bubble")].map(b => b.textContent)')
  assert.deepEqual(userRows, ['Explain markdown please', 'second question'])
  const stored = history.getChat(userData, turns[2].chatId).records.filter(r => r.role === 'user').map(r => r.parts.find(p => p.type === 'text').text)
  assert.deepEqual(stored, ['Explain markdown please', 'second question'], 'retry replaces the failed turn instead of duplicating it')
  turns[2].emit({ type: 'token', text: 'Works now.' })
  history.appendRecord(userData, { role: 'assistant', content: 'Works now.' }, turns[2].chatId)
  turns[2].emit({ type: 'done', truncated: false }); turns[2].resolve()
  await waitFor(() => evaluate('!document.querySelector(".error-notice")'), 'error card replaced')
  console.log('PASS friendly error card and retry without duplicate history')

  // Reload from disk renders the same conversation (history replay)
  await evaluate(`document.querySelector('#toggle-history-btn').click()`)
  await waitFor(() => evaluate('document.querySelectorAll(".history-item").length >= 1'), 'history items')
  assert.equal(await evaluate('document.querySelector(".history-group").textContent'), 'Today')
  await shot('04-chat-list')
  await evaluate('document.querySelector(".history-item-content").click()')
  await waitFor(() => evaluate('document.querySelectorAll(".message-row.assistant").length === 2'), 'replayed rows')
  assert.equal(await evaluate('!!document.querySelector(".message-row.user .user-image")'), true, 'image thumbnail from history')
  console.log('PASS chat list grouping and history replay with image thumbnails')

  // Rename through the list, then delete with confirmation
  await evaluate(`document.querySelector('#toggle-history-btn').click()`)
  await waitFor(() => evaluate('!!document.querySelector(".history-item .more")'), 'more button')
  await evaluate(`document.querySelector('.history-item .more').click()`)
  await evaluate(`document.querySelector('.history-action-menu .rename').click()`)
  await evaluate(`(() => { const f = document.querySelector('.history-rename'); f.value = 'Renamed chat'; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
  await waitFor(() => evaluate('document.querySelector(".history-item-title")?.textContent === "Renamed chat"'), 'renamed in list')
  assert.equal(await evaluate('document.querySelector(".chat-title-text").textContent'), 'Renamed chat')
  await evaluate(`document.querySelector('.history-item .more').click()`)
  await evaluate(`document.querySelector('.history-action-menu .delete').click()`)
  await waitFor(() => evaluate('!!document.querySelector(".k-dialog")'), 'confirm dialog')
  await shot('05-delete-confirm')
  await evaluate(`document.querySelector('.k-dialog .k-btn.danger').click()`)
  await waitFor(() => evaluate('!document.querySelector("#empty-state").classList.contains("hidden")'), 'empty state after delete')
  assert.equal(fs.existsSync(path.join(userData, 'chats', `${turns[0].chatId}.json`)), false)
  console.log('PASS rename in list and delete with confirmation')
  console.log('Screenshots:', shots)
}
run().then(() => app.exit(0)).catch(e => { console.error(e); app.exit(1) })
