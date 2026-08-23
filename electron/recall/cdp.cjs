// Activity Recall — Supervised-Relaunch CDP-Client (Phase 7).
//
// WARUM Hand-Roll: die `ws`-Bibliothek waere eine neue npm-Abhaengigkeit und
// ist damit verboten. Der benoetigte Teil von RFC 6455 ist klein:
// Client-Handshake (Sec-WebSocket-Key/Accept), maskierte Text-Frames,
// Ping/Pong, Close, Continuation-Frames. ~120 Zeilen mit node:http+crypto.

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/* ------------------------------------------------------- chrome finden */

function candidatePaths() {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const lad = process.env['LocalAppData'] ?? ''
  return [
    process.env.BLOUB_CHROME_PATH,
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    `${lad}\\Google\\Chrome\\Application\\chrome.exe`,
    // Edge ist auf Windows immer da und spricht dasselbe CDP
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`
  ].filter(Boolean)
}

function findChromeExecutable() {
  for (const exe of candidatePaths()) {
    try {
      if (fs.existsSync(exe)) {
        return { exe, browser: exe.includes('msedge') ? 'edge' : 'chrome' }
      }
    } catch {
      /* continue */
    }
  }
  return null
}

/** Argumente fuer den Supervised-Relaunch (auch fuer Shortcut-Bau genutzt). */
function relaunchArgs(port) {
  return [`--remote-debugging-port=${port}`]
}

/**
 * Startet den Browser mit Debugging-Port. Ehrliches Limit (dokumentiert):
 * Chrome ignoriert den Port, wenn bereits eine Instanz des Profils laeuft —
 * der Aufrufer muss diesen Fehlerfall dem User erklaeren ("erst Chrome
 * schliessen"). Edge/Chrome teilen sich dieses Verhalten.
 */
function launchSupervised({ exe, port }) {
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, relaunchArgs(port), { detached: false, stdio: 'ignore' })
      child.on('error', (err) => resolve({ ok: false, error: String(err?.message ?? err) }))
      // Kurz warten: falls der Prozess sofort stirbt, melden wir es.
      let settled = false
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve({ ok: true, pid: child.pid })
        }
      }, 1500)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          resolve({ ok: false, error: `browser exited immediately (code ${code})` })
        }
      })
    } catch (err) {
      resolve({ ok: false, error: String(err?.message ?? err) })
    }
  })
}

/* --------------------------------------------------- WebSocket-Minimal */

/** Ein Text-Frame kodieren (client -> server: IMMER maskiert). */
function encodeFrame(opcode, payload) {
  const mask = crypto.randomBytes(4)
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.handlers = new Map() // method -> Set<fn>
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.closed = false
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#emitClosed())
    socket.on('error', () => this.#emitClosed())
  }

  #emitClosed() {
    if (this.closed) return
    this.closed = true
    for (const { reject } of this.pending.values()) {
      reject(new Error('cdp connection closed'))
    }
    this.pending.clear()
  }

  /** Rohbytes in Frames zerlegen und routen. */
  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const buf = this.buffer
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < offset + 2) return
        len = buf.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (buf.length < offset + 8) return
        len = Number(buf.readBigUInt64BE(offset))
        offset += 8
      }
      const maskKey = masked ? buf.subarray(offset, offset + 4) : null
      if (masked) offset += 4
      if (buf.length < offset + len) return
      const payload = Buffer.from(buf.subarray(offset, offset + len))
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
      this.buffer = buf.subarray(offset + len)

      switch (opcode) {
        case 0x0: // Continuation
          this.fragments.push(payload)
          if (fin) {
            const full = Buffer.concat(this.fragments)
            this.fragments = []
            this.#dispatch(this.fragmentOpcode || 0x1, full)
          }
          break
        case 0x8: // Close
          try {
            this.socket.end(encodeFrame(0x8, Buffer.alloc(0)))
          } catch {
            /* ignore */
          }
          this.socket.destroy()
          this.#emitClosed()
          return
        case 0x9: // Ping -> Pong
          this.socket.write(encodeFrame(0xa, payload))
          break
        case 0xa: // Pong: ignore
          break
        default: // 0x1 text, 0x2 binary
          if (!fin) {
            this.fragmentOpcode = opcode
            this.fragments = [payload]
          } else {
            this.#dispatch(opcode, payload)
          }
      }
    }
  }

  #dispatch(opcode, payload) {
    if (opcode !== 0x1) return
    let msg
    try {
      msg = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      clearTimeout(timer)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else resolve(msg.result)
    } else if (msg.method) {
      for (const fn of this.handlers.get(msg.method) ?? []) {
        try {
          fn(msg.params)
        } catch {
          /* handler-Fehler toeten nicht die Verbindung */
        }
      }
    }
  }

  /** CDP-Kommando senden (Promise auf result, 10 s Timeout). */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('cdp connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp timeout: ${method}`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ id, method, params }), 'utf8')))
    })
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method).add(handler)
    return () => this.handlers.get(method)?.delete(handler)
  }

  close() {
    try {
      this.socket.end(encodeFrame(0x8, Buffer.alloc(0)))
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
    }, 500)
  }

  /** Verbindet zum ersten Seiten-Target eines Debugging-Ports. */
  static async connect(httpPort) {
    const targets = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: httpPort, path: '/json/list' }, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(body))
            } catch (err) {
              reject(err)
            }
          })
        })
        .on('error', reject)
    })
    const page = targets.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
    if (!page?.webSocketDebuggerUrl) throw new Error('no debuggable page target found')
    const url = new URL(page.webSocketDebuggerUrl)

    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const req = http.request({
        host: '127.0.0.1',
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13'
        }
      })
      req.on('upgrade', (res, socket) => {
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
        if (res.headers['sec-websocket-accept'] !== expected) {
          socket.destroy()
          reject(new Error('bad websocket accept header'))
          return
        }
        socket.setNoDelay(true)
        resolve(new CdpClient(socket))
      })
      req.on('response', (res) => {
        reject(new Error(`upgrade refused (HTTP ${res.statusCode})`))
      })
      req.on('error', reject)
      req.end()
    })
  }
}

/* ------------------------------------- Snapshot-Script (Seiten-Injektion) */

/**
 * JavaScript-String, der in der SEITE laeuft (Runtime.evaluate) und
 * identisches Verhalten zur bloub-link Extension hat: NUR outbound actions,
 * Redaction von Passwort/Zahlungsfeldern, 20 Felder / 500 Zeichen / 1,5 s
 * Debounce. Ergebnis geht an window.__bloubRecall (vom Injector definiert).
 */
function buildSnapshotScript() {
  return `
(function () {
  if (window.__bloubRecallInstalled) return;
  window.__bloubRecallInstalled = true;
  var SUBMIT_TEXT_RE = /^(post|send|reply|tweet|publish|comment)$/i;
  var SKIP_AUTOCOMPLETE_RE = /(cc-|current-password|new-password|one-time-code)/i;
  function labelFor(el, doc) {
    if (!el) return '';
    var id = el.getAttribute && el.getAttribute('id');
    if (id) {
      var lb = doc.querySelector('label[for="' + id + '"]');
      if (lb && lb.textContent) return lb.textContent.trim();
    }
    var aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name'));
    return aria ? String(aria).trim() : '';
  }
  function isSkippable(el) {
    if (!el || !el.getAttribute) return true;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    var ac = el.getAttribute('autocomplete') || '';
    if (SKIP_AUTOCOMPLETE_RE.test(ac)) return true;
    return false;
  }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  function snapshotContainer(rootEl, doc) {
    var fields = [];
    var els = rootEl.querySelectorAll ? rootEl.querySelectorAll('input, textarea, select, [contenteditable="true"]') : [];
    for (var i = 0; i < els.length && fields.length < 20; i++) {
      var el = els[i];
      if (isSkippable(el)) continue;
      var value = el.value != null ? el.value : (el.textContent || '');
      value = String(value);
      if (!value.trim()) continue;
      fields.push({ label: truncate(labelFor(el, doc), 120), value: truncate(value, 500) });
    }
    return fields.slice(0, 20);
  }
  var lastFire = 0;
  function fire(trigger, container, doc) {
    var now = Date.now();
    if (now - lastFire < 1500) return; // Debounce 1500 ms
    lastFire = now;
    var fields = snapshotContainer(container || doc.body, doc);
    try {
      window.__bloubRecall({
        url: doc.location.href, host: doc.location.host,
        title: doc.title, trigger: trigger, fields: fields
      });
    } catch (e) {}
  }
  function visibleText(btn) {
    return (btn.textContent || btn.value || '').trim();
  }
  document.addEventListener('submit', function (ev) {
    fire('submit', ev.target, document);
  }, true);
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== document.body) {
      var tag = (t.tagName || '').toLowerCase();
      var isSubmitInput = tag === 'input' && (t.getAttribute('type') || '').toLowerCase() === 'submit';
      var isButton = tag === 'button';
      if ((isSubmitInput || isButton) && (SUBMIT_TEXT_RE.test(visibleText(t)) || isSubmitInput)) {
        var form = t.closest && t.closest('form');
        fire('click', form || (t.closest && t.closest('div')) || document.body, document);
        return;
      }
      t = t.parentElement || null;
    }
  }, true);
  document.addEventListener('keydown', function (ev) {
    var editable = ev.target && (ev.target.isContentEditable ||
      /^(TEXTAREA)$/.test(ev.target.tagName || '') ||
      (/^(INPUT)$/.test(ev.target.tagName || '') && ev.target.type !== 'password'));
    if (!editable) return;
    var isEnter = ev.key === 'Enter';
    var combo = isEnter && (ev.ctrlKey || (ev.key === 'Enter' && !ev.shiftKey && ev.target.isContentEditable));
    if (isEnter && (ev.ctrlKey || (ev.target.isContentEditable && !ev.shiftKey))) {
      var c = ev.target.closest && ev.target.closest('[contenteditable="true"]');
      fire('keyboard', (c && c.parentElement) || document.body, document);
    }
  }, true);
})();`.trim()
}

/**
 * Bequemlichkeit: verbinden, Binding einrichten, Snapshot injizieren und
 * bei jedem Seitenladen neu injizieren. onPage(payload) bekommt Events.
 * Wir nutzen Runtime.addBinding (sauberer Kanal statt console-Tricks).
 */
async function attachAndWatch({ httpPort, onPage }) {
  const client = await CdpClient.connect(httpPort)
  const deliver = (payloadJson) => {
    try {
      const payload = JSON.parse(payloadJson)
      if (typeof onPage === 'function') onPage(payload)
    } catch {
      /* ignore */
    }
  }
  await client.send('Runtime.addBinding', { name: 'bloubRecallSink' })
  client.on('Runtime.bindingCalled', (params) => {
    if (params.name === 'bloubRecallSink') deliver(params.payload)
  })
  async function injectReceiverAndSnapshot() {
    try {
      await client.send('Runtime.evaluate', {
        expression: 'window.__bloubRecall = function (p) { try { bloubRecallSink(JSON.stringify(p)); } catch (e) {} }; "ok"',
        returnByValue: true
      })
      await client.send('Runtime.evaluate', { expression: buildSnapshotScript(), returnByValue: true })
    } catch {
      /* Seite kann gerade weg sein — beim naechsten loadEventFired erneut */
    }
  }
  await client.send('Page.enable')
  await injectReceiverAndSnapshot()
  client.on('Page.loadEventFired', () => {
    injectReceiverAndSnapshot()
  })
  return client
}

module.exports = {
  findChromeExecutable,
  launchSupervised,
  relaunchArgs,
  buildSnapshotScript,
  attachAndWatch,
  CdpClient
}
