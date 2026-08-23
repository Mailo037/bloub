// bloub-link Popup: Verbindungs-UI. "Connect" holt Token+Port vom lokalen
// Bloub-Endpunkt (nur chrome-extension:// Origins werden bedient) und legt
// beides in chrome.storage.local ab.

const DEFAULT_PORT = 8765
const statusEl = document.getElementById('status')
const portInput = document.getElementById('port')

function setStatus(text) {
  statusEl.textContent = text
}

async function loadConfig() {
  chrome.storage.local.get(['port', 'token'], ({ port, token }) => {
    portInput.value = String(port ?? DEFAULT_PORT)
    setStatus(token ? '✓ connected to Bloub' : 'not connected')
  })
}

document.getElementById('connect').addEventListener('click', () => {
  const port = (parseInt(portInput.value, 10) || DEFAULT_PORT)
  portInput.value = String(port)
  setStatus('connecting…')
  fetch(`http://127.0.0.1:${port}/recall/hello`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data) => {
      if (!data || !data.token) throw new Error('unexpected response')
      chrome.storage.local.set({ port, token: data.token }, () => setStatus('✓ connected to Bloub'))
    })
    .catch((err) => {
      setStatus(`✗ ${err.message} — is Bloub running with Browser link enabled?`)
    })
})

document.getElementById('disconnect').addEventListener('click', () => {
  chrome.storage.local.remove(['token'], () => setStatus('disconnected'))
})

void loadConfig()
