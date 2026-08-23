// bloub-link Content-Script.
// Zeichnet NUR deine Outbound-Aktionen auf (Absenden von Formularen,
// Klicks auf Senden/Posten-Buttons, Ctrl+Enter/Enter in Contenteditable)
// und schickt sie an den Service Worker. KEINE Timeline-/DM-/Inbox-Scans,
// KEIN kontinuierliches Tastatur-Monitoring (nur die zwei Submit-Kombis),
// KEINE Passwort-/Zahlungsfeld-Erfassung.

(() => {
  if (window.__bloubLinkInstalled) return
  window.__bloubLinkInstalled = true

  const SEND_TEXT_RE = /^(post|send|reply|tweet|publish|comment)$/i
  // autocomplete-Tokens, die auf Credentials oder Zahlung hindeuten
  const SKIP_AUTOCOMPLETE_RE = /(cc-|current-password|new-password|one-time-code)/i
  const MAX_FIELDS = 20
  const MAX_VALUE = 500
  const DEBOUNCE_MS = 1500

  function truncate(s, n) {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, n) : s
  }

  /** Label eines Felds: label[for] > aria-label > placeholder > name. */
  function labelFor(el) {
    if (!el || !el.getAttribute) return ''
    const id = el.getAttribute('id')
    if (id) {
      const lb = document.querySelector(`label[for="${CSS.escape(id)}"]`)
      if (lb && lb.textContent) return lb.textContent.trim()
    }
    const fallback =
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name')
    return fallback ? String(fallback).trim() : ''
  }

  /** Passwoerter, hidden inputs und Zahlungs-/Credential-Felder nie erfassen. */
  function isSkippable(el) {
    if (!el || !el.getAttribute) return true
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') return true
    if (SKIP_AUTOCOMPLETE_RE.test(el.getAttribute('autocomplete') || '')) return true
    return false
  }

  /** Sichtbar beschriftete Felder des Containers einsammeln (gekappt). */
  function snapshotContainer(rootEl) {
    const fields = []
    if (!rootEl || !rootEl.querySelectorAll) return fields
    const els = rootEl.querySelectorAll(
      'input, textarea, select, [contenteditable="true"]'
    )
    for (const el of els) {
      if (fields.length >= MAX_FIELDS) break
      if (isSkippable(el)) continue
      const value = String(el.value != null ? el.value : el.textContent || '')
      if (!value.trim()) continue // leere Felder interessieren nicht
      fields.push({ label: truncate(labelFor(el), 120), value: truncate(value, MAX_VALUE) })
    }
    return fields.slice(0, MAX_FIELDS)
  }

  let lastFire = 0
  function fire(trigger, container) {
    const now = Date.now()
    if (now - lastFire < DEBOUNCE_MS) return // max 1 Event / 1,5 s pro Seite
    lastFire = now
    const payload = {
      url: location.href,
      host: location.host,
      title: document.title,
      trigger,
      fields: snapshotContainer(container || document.body)
    }
    try {
      chrome.runtime.sendMessage({ type: 'bloub-event', payload }, () => void chrome.runtime.lastError)
    } catch {
      /* Extension-Kontext weg (Reload) — ignorieren */
    }
  }

  function visibleText(btn) {
    return ((btn && (btn.textContent || btn.value)) || '').trim()
  }

  document.addEventListener(
    'submit',
    (ev) => {
      fire('submit', ev.target instanceof HTMLFormElement ? ev.target : null)
    },
    true
  )

  document.addEventListener(
    'click',
    (ev) => {
      let t = ev.target
      while (t && t !== document.body) {
        const tag = (t.tagName || '').toLowerCase()
        const isSubmitInput = tag === 'input' && (t.getAttribute('type') || '').toLowerCase() === 'submit'
        if ((isSubmitInput || tag === 'button') && SEND_TEXT_RE.test(visibleText(t))) {
          const form = t.closest && t.closest('form')
          fire('click', form || (t.closest && t.closest('div')) || document.body)
          return
        }
        t = t.parentElement
      }
    },
    true
  )

  // Ctrl+Enter ueberall in editierbaren Feldern; Enter in Contenteditable
  document.addEventListener(
    'keydown',
    (ev) => {
      const target = ev.target
      if (!target) return
      const editable =
        target.isContentEditable ||
        target.tagName === 'TEXTAREA' ||
        (target.tagName === 'INPUT' && (target.type || '') !== 'password')
      if (!editable) return
      if (ev.key !== 'Enter') return
      // Passwort-Felder sind oben schon ausgeschlossen; kein Keylogging:
      // wir lesen hier NICHTS vom Feldinhalt, sondern nur den Container.
      if (ev.ctrlKey || target.isContentEditable) {
        const box = target.closest && target.closest('[contenteditable="true"]')
        fire('keyboard', (box && box.parentElement) || document.body)
      }
    },
    true
  )
})()
