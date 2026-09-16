// Run with: pnpm exec electron tools/test-pet-toolbar.cjs
// Uses an isolated profile; never sends messages or requests microphone access.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const realProfile = process.argv.includes('--real-profile')
const profile = realProfile ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-toolbar-'))
if (profile) app.setPath('userData', profile)
app.on('quit', () => { if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* Windows may still hold Chromium cache files. */ } } })
require('../electron/main.cjs')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) {
    const result = await fn()
    if (result) return result
    await delay(100)
  }
  throw new Error('Timed out: ' + label)
}
async function run() {
  await app.whenReady()
  const pet = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')), 'pet window')
  await waitFor(() => pet.webContents.executeJavaScript('!!document.querySelector("#pet-open-chat")'), 'toolbar mounted')
  await pet.webContents.executeJavaScript('document.querySelector("#pet-open-chat").click()')
  const chat = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/chat.html') && w.isVisible()), 'chat opens from toolbar')
  console.log('PASS toolbar opens standalone chat')
  await waitFor(() => chat.webContents.executeJavaScript('!!document.querySelector("#btn-show-all-chats")'), 'chat UI loaded')
  await chat.webContents.executeJavaScript('document.querySelector("#btn-show-all-chats").click()')
  assert.equal(await chat.webContents.executeJavaScript('document.querySelector("#history-drawer").classList.contains("hidden")'), false)
  console.log('PASS all chats drawer opens')
  chat.close()
  assert.equal(chat.isVisible(), false)
  await pet.webContents.executeJavaScript('document.querySelector("#pet-open-chat").click()')
  await waitFor(() => chat.isVisible(), 'hidden chat reopens')
  assert.equal(BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/chat.html')).length, 1)
  chat.minimize()
  await pet.webContents.executeJavaScript('document.querySelector("#pet-open-chat").click()')
  await waitFor(() => !chat.isMinimized() && chat.isVisible(), 'minimized chat restores')
  console.log('PASS hidden and minimized chat reopen without duplicates')

  const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-toolbar-shots-'))
  fs.writeFileSync(path.join(shots, 'chat.png'), (await chat.webContents.capturePage()).toPNG())
  await chat.webContents.executeJavaScript('document.querySelector("#close-history-btn").click()')
  await waitFor(() => chat.webContents.executeJavaScript('!!document.querySelector(".effort-trigger-label")'), 'model label loaded')
  for (const width of [380, 460, 832]) {
    chat.setSize(width, 680)
    const layout = await chat.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.effort-trigger');
      const label = trigger.querySelector('.effort-trigger-label');
      label.textContent = 'deepseek-v4-flash-vision-exp';
      const t = trigger.getBoundingClientRect(), l = label.getBoundingClientRect(), s = trigger.querySelector('svg').getBoundingClientRect();
      return { ellipsis: getComputedStyle(label).textOverflow, clipped: label.scrollWidth > label.clientWidth, contained: l.left >= t.left && s.right <= t.right && l.right <= s.left };
    })()`)
    assert.deepEqual(layout, { ellipsis: 'ellipsis', clipped: true, contained: true })
    await delay(150)
    fs.writeFileSync(path.join(shots, `model-${width}.png`), (await chat.webContents.capturePage()).toPNG())
  }
  console.log('PASS long model name truncates without hiding chevron at 380px, 460px and 832px')
  // Long single-line draft: compact beside tools until wrap, then stack.
  const composerClip = () => chat.webContents.executeJavaScript(`(() => { const r = document.querySelector('.composer-pill').getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x) - 6), y: Math.max(0, Math.floor(r.y) - 6), width: Math.ceil(r.width) + 12, height: Math.ceil(r.height) + 12 } })()`)
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#standalone-input');
    input.value = '1'.repeat(120);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(200)
  const wrapped = await chat.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector('.composer-pill');
    const input = document.querySelector('#standalone-input');
    const p = pill.getBoundingClientRect(), i = input.getBoundingClientRect(), a = document.querySelector('.composer-actions').getBoundingClientRect();
    return {
      flexWrap: getComputedStyle(pill).flexWrap,
      inputAboveActions: i.bottom <= a.top + 1,
      contained: i.left >= p.left + 4 && i.right <= p.right - 4 && a.right <= p.right - 2,
      rows: Math.round((i.height - 10) / 20)
    };
  })()`)
  assert.deepEqual(wrapped, { flexWrap: 'wrap', inputAboveActions: true, contained: true, rows: wrapped.rows })
  assert.equal(wrapped.rows >= 2, true, 'draft wraps to multiple lines')
  fs.writeFileSync(path.join(shots, 'composer-wrap.png'), (await chat.webContents.capturePage(await composerClip())).toPNG())
  console.log('composer-wrap.png:', path.join(shots, 'composer-wrap.png'))
  console.log('PASS multiline draft renders above the tool row')
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#standalone-input');
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(200)
  const single = await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#standalone-input');
    const i = input.getBoundingClientRect(), a = document.querySelector('.composer-actions').getBoundingClientRect();
    return { sameRow: Math.abs(i.top - a.top) < 12, oneTextRow: Math.round((i.height - 10) / 20) === 1 };
  })()`)
  assert.equal(single.sameRow, true)
  assert.equal(single.oneTextRow, true)
  console.log('PASS empty draft keeps one text row with tools underneath')
  // Radius: reduced a few pixels; height: compact until the draft text reaches
  // the model pill, then stack.
  const pillState = () => chat.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector('.composer-pill');
    const input = document.querySelector('#standalone-input');
    const actions = document.querySelector('.composer-actions');
    const p = pill.getBoundingClientRect(), i = input.getBoundingClientRect(), a = actions.getBoundingClientRect();
    return { radius: getComputedStyle(pill).borderRadius, tall: pill.classList.contains('composer-tall'), singleRow: Math.abs(i.top - a.top) < 12, textRow: Math.round((i.height - 10) / 20) };
  })()`)
  chat.setSize(832, 680)
  const empty = await pillState()
  assert.equal(empty.radius, '20px')
  assert.equal(empty.tall, false)
  assert.equal(empty.singleRow, true)
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#standalone-input');
    input.value = 'abcdefgh '; // wide glyphs, still one short row
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const short = await pillState()
  assert.equal(short.tall, false)
  assert.equal(short.singleRow, true)
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#standalone-input');
    input.value = 'x'.repeat(200);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const long = await pillState()
  assert.equal(long.tall, true)
  assert.equal(long.singleRow, false)
  assert.equal(long.textRow >= 2, true)
  // Ground truth: assert flex layout of every visible pill child.
  const layout = await chat.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector('.composer-pill');
    const i = document.querySelector('#standalone-input').getBoundingClientRect();
    const parts = Array.from(pill.children).map(el => ({ id: el.id || el.className, order: getComputedStyle(el).order, display: getComputedStyle(el).display, top: Math.round(el.getBoundingClientRect().top) }));
    const at = document.querySelector('#composer-attach-btn').getBoundingClientRect();
    const ms = document.querySelector('.effort-trigger').getBoundingClientRect();
    return { pillClass: pill.className, inputBottom: Math.round(i.bottom), parts, plusTop: Math.round(at.top), modelTop: Math.round(ms.top), plusRight: Math.round(at.right), modelLeft: Math.round(ms.left) };
  })()`)
  console.log('TALL ground truth:', JSON.stringify(layout))
  assert.equal(Math.abs(layout.plusTop - layout.modelTop) < 4 && layout.plusRight < layout.modelLeft, true, JSON.stringify(layout))
  // Real Chromium text insertion, one character at a time, including every
  // length near the boundary. Count FINAL states, not temporary measurements.
  const cw = chat.webContents
  cw.debugger.attach('1.3')
  for (const width of [380, 460, 832]) {
    chat.setSize(width, 680)
    await delay(150)
    await cw.executeJavaScript(`(() => {
      const input = document.querySelector('#standalone-input');
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    })()`)
    const snapshot = () => cw.executeJavaScript(`(() => {
      const input = document.querySelector('#standalone-input'), pill = input.closest('.composer-pill');
      const r = input.getBoundingClientRect(), p = pill.getBoundingClientRect();
      const a = document.querySelector('#composer-attach-btn').getBoundingClientRect();
      const tools = document.querySelector('.composer-actions').getBoundingClientRect();
      return { tall: pill.classList.contains('composer-tall'), height: r.height, width: p.width,
        length: input.value.length, caret: input.selectionStart, focus: document.activeElement === input,
        toolsRight: Math.abs(tools.right - (p.right - 9)) < 2,
        plusBelow: a.top >= r.bottom, toolsBelow: tools.top >= r.bottom,
        noOverflow: input.scrollHeight <= input.clientHeight + 1 };
    })()`)
    const base = await snapshot()
    const states = [base.tall]
    let boundary = 0
    for (let n = 1; n <= 100; n++) {
      await cw.debugger.sendCommand('Input.insertText', { text: 'a' })
      await delay(20)
      const state = await snapshot()
      assert.equal(state.length, n)
      assert.equal(state.caret, n)
      assert.equal(state.focus, true)
      assert.equal(state.width, base.width)
      assert.equal(state.toolsRight, true)
      assert.equal(state.noOverflow, true)
      if (state.tall) {
        assert.equal(state.plusBelow && state.toolsBelow, true)
        if (!boundary) boundary = n
      }
      states.push(state.tall)
      if (n === boundary && boundary) {
        await delay(150)
        fs.writeFileSync(path.join(shots, `threshold-${width}.png`), (await cw.capturePage(await composerClip())).toPNG())
        assert.equal(state.height, 30, 'just-crossed boundary uses one full-width text row')
      }
    }
    console.log('Transitions', width, states.map((s, i) => i === 0 || s !== states[i - 1] ? { length: i, tall: s } : null).filter(Boolean))
    assert.equal(states.filter((s, i) => i && s !== states[i - 1]).length, 1, `typing flips once at ${width}px`)
    for (let n = 99; n >= 0; n--) {
      await cw.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await cw.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      const state = await snapshot()
      assert.equal(state.length, n)
      assert.equal(state.tall, states[n], `same state on deletion at length ${n}, width ${width}`)
    }
    console.log(`PASS typing/deleting 100 characters at ${width}px; stack boundary ${boundary}`)
  }
  cw.debugger.detach()
  console.log('PASS pill grows only past the tool row, radius 20px')
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#standalone-input');
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  assert.equal((await pillState()).tall, false)
  chat.setSize(460, 680)
  chat.hide()
  // Hold the dock expanded for screenshots, independently of the real cursor.
  await pet.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('#chat-dock');
    const expand = () => { if (dock.classList.contains('pet-compact')) dock.classList.remove('pet-compact'); document.querySelector('.pet-dock-content').inert = false };
    new MutationObserver(expand).observe(dock, { attributes: true, attributeFilter: ['class'] });
    expand(); document.activeElement?.blur();
  })()`)
  await delay(400)
  const bounds = await pet.webContents.executeJavaScript(`(() => { const r = document.querySelector('#pet-chat-toolbar').getBoundingClientRect(); return { x: Math.floor(r.x) - 8, y: Math.floor(r.y) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 } })()`)
  fs.writeFileSync(path.join(shots, 'idle.png'), (await pet.webContents.capturePage(bounds)).toPNG())
  const wc = pet.webContents
  await wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('DOM.enable')
  await wc.debugger.sendCommand('CSS.enable')
  const { root } = await wc.debugger.sendCommand('DOM.getDocument')
  const opacity = () => wc.executeJavaScript(`Array.from(document.querySelectorAll('.pet-toolbar-divider'), el => getComputedStyle(el).opacity)`)
  assert.deepEqual(await opacity(), ['1', '1'])
  for (const [selector, expected] of [['#pet-compose', ['0', '1']], ['#pet-open-chat', ['0', '0']], ['#mic-hold', ['1', '0']]]) {
    const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
    await wc.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
    const actual = await opacity()
    console.log('Hover opacity:', selector, actual)
    assert.deepEqual(actual, expected, selector + ' hides adjacent dividers')
    await delay(150) // Allow Chromium to paint the forced pseudo-state before capture.
    fs.writeFileSync(path.join(shots, selector.slice(1) + '-hover.png'), (await wc.capturePage(bounds)).toPNG())
    await wc.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  }
  assert.deepEqual(await opacity(), ['1', '1'])
  wc.debugger.detach()
  console.log('PASS both dividers and each hover state')
  console.log('Screenshots:', shots)
}
run().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
