// Activity Recall — Browser-Link-Server (Phase 6).
// Kleiner HTTP-Endpunkt NUR auf 127.0.0.1, mit dem die bloub-link Extension
// (MV3) und der CDP-Supervised-Modus Events liefern.
//
// Protokoll:
//   GET  /recall/hello   -> nur fuer Origins chrome-extension://… : liefert
//                           { name, token } + CORS-Header fuer genau diesen
//                           Extension-Origin. Damit landet der Token im
//                           chrome.storage.local (Handshake).
//   POST /recall/event   -> Header x-bloub-token; Body { events:[…] } oder
//                           ein einzelnes Event-Objekt.
//   GET  /recall/status  -> ?token=… : { ok, paused }
//   GET  /recall/setup   -> kleine HTML-Anleitungsseite (Load-unpacked-Flow)
//
// Der Port steht in <userData>/recall/link.json (well-known file), Token
// wird pro Server-Start neu gewuerfelt und dort mit abgelegt.

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const orchestrator = require('./orchestrator.cjs')

const DEFAULT_PORT = 8765

const SETUP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bloub link</title>
<style>body{font-family:system-ui;background:#1b1d23;color:#e8e8ee;max-width:560px;margin:40px auto;padding:0 20px}
ol{line-height:1.7}code{background:#2a2d36;padding:2px 6px;border-radius:4px}</style></head><body>
<h1>🔗 Connect bloub-link to Bloub</h1>
<ol>
<li>In Chrome, open <code>chrome://extensions</code></li>
<li>Enable <b>Developer mode</b> (top right)</li>
<li>Click <b>Load unpacked</b> and select the folder shown in the Bloub settings ("Browser link")</li>
<li>Click the bloub-link extension icon and press <b>Connect</b></li>
<li>Done — your outbound posts/sends are now recorded locally by Bloub.</li>
</ol>
<p style="opacity:.7">Nothing leaves this machine. Passwords and payment fields are never captured.</p>
</body></html>`

let server = null
let currentInfo = null // { port, token }

function writeLinkFile(userData) {
  try {
    fs.mkdirSync(path.join(userData, 'recall'), { recursive: true })
    fs.writeFileSync(
      path.join(userData, 'recall', 'link.json'),
      JSON.stringify({ port: currentInfo.port, token: currentInfo.token }),
      'utf8'
    )
  } catch {
    /* best effort */
  }
}

function corsFor(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-bloub-token'
  }
}

/** Startet den Server. Rueckgabe: { port, token, stop() }. */
function startBrowserLink({ userData, preferredPort = DEFAULT_PORT }) {
  stopBrowserLink()
  const token = crypto.randomBytes(16).toString('hex')
  let eventsAccepted = 0

  server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${currentInfo?.port ?? preferredPort}`)
      const origin = String(req.headers.origin ?? '')

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsFor(origin))
        res.end()
        return
      }

      if (url.pathname === '/recall/setup' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(SETUP_HTML)
        return
      }

      if (url.pathname === '/recall/hello' && req.method === 'GET') {
        // Handshake NUR fuer echte Extension-Origins — normale Webseiten
        // kriegen weder Token noch CORS-Erlaubnis.
        if (!origin.startsWith('chrome-extension://')) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'extension origin required' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', ...corsFor(origin) })
        res.end(JSON.stringify({ name: 'bloub-pet', token }))
        return
      }

      if (url.pathname === '/recall/event' && req.method === 'POST') {
        if (!currentInfo || req.headers['x-bloub-token'] !== currentInfo.token) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad token' }))
          return
        }
        let body = ''
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 512 * 1024) req.destroy() // harte Body-Grenze
          else body += c
        })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}')
            const list = Array.isArray(parsed.events) ? parsed.events : [parsed]
            let accepted = 0
            for (const p of list.slice(0, 10)) {
              if (orchestrator.ingestBrowserEvent(p)) accepted++
            }
            eventsAccepted += accepted
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, accepted }))
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
          }
        })
        return
      }

      if (url.pathname === '/recall/status' && req.method === 'GET') {
        if (url.searchParams.get('token') !== currentInfo?.token) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, paused: !orchestrator.isActive(), accepted: eventsAccepted }))
        return
      }

      res.writeHead(404)
      res.end()
    } catch {
      try {
        res.writeHead(500)
        res.end()
      } catch {
        /* ignore */
      }
    }
  })

  return new Promise((resolve) => {
    const tryListen = (port) => {
      const onError = (err) => {
        if (err?.code === 'EADDRINUSE' && port !== 0) {
          // Belegter Standard-Port -> freien Port nehmen und in link.json
          // vermerken (die Extension-Popup-Eingabe erlaubt Manualeintrag).
          server.removeListener('error', onError)
          tryListen(0)
        } else {
          resolve({ ok: false, error: err?.message ?? String(err) })
        }
      }
      server.on('error', onError)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        currentInfo = { port: address.port, token }
        writeLinkFile(userData)
        resolve({
          ok: true,
          port: address.port,
          token,
          stop: stopBrowserLink,
          get info() {
            return currentInfo
          }
        })
      })
    }
    tryListen(preferredPort)
  })
}

function stopBrowserLink() {
  if (!server) return
  try {
    server.close()
  } catch {
    /* ignore */
  }
  server = null
  currentInfo = null
}

function getLinkInfo() {
  return currentInfo
}

module.exports = { startBrowserLink, stopBrowserLink, getLinkInfo, DEFAULT_PORT }
