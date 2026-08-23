// bloub-link Service Worker.
// Haelt { port, token } in chrome.storage.local und POSTet Events an den
// lokalen Bloub-Endpunkt. Ein Retry pro Event; danach verwerfen (Spool-
// Charakter, kein Queue-Rauschen).

const DEFAULT_PORT = 8765

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['port', 'token'], (cfg) => resolve(cfg || {}))
  })
}

async function postEvents(events) {
  const { port = DEFAULT_PORT, token } = await getConfig()
  if (!token) return false
  try {
    const res = await fetch(`http://127.0.0.1:${port}/recall/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bloub-token': token },
      body: JSON.stringify({ events })
    })
    return res.ok
  } catch {
    return false
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'bloub-event' && msg.payload) {
    // Ein Retry, dann weg — die lokale Aufzeichnung ist Best-Effort.
    postEvents([msg.payload]).then((ok) => {
      if (!ok) setTimeout(() => void postEvents([msg.payload]), 3000)
      sendResponse({ ok })
    })
    return true // async sendResponse
  }
  sendResponse({ ok: false })
})
