// Persistentes Konversations-Gedächtnis mit separaten Multi-Chats:
// - Startet beim App-Start einen frischen Chat
// - Behält bestehende Chats und migriert die alte chat-history.jsonl verlustfrei
// - Auto-Titling (max. 5 Wörter) nach der ersten User-Nachricht mit lokalem Fallback
// - In-flight Deduplizierung und Schutz vor Überschreiben manueller Titel
// - Pfad-Traversal-Schutz auf allen Chat-IDs
// - Cache sauber nach userData gescopt
const fs = require('node:fs')
const path = require('node:path')
const provider = require('./provider.cjs')

// userData -> { activeChatId: string | null, chats: Map<string, Chat> }
const stores = new Map()
const inFlightTitling = new Set()

function getStore(userData) {
  const key = path.resolve(userData)
  if (!stores.has(key)) {
    stores.set(key, { activeChatId: null, chats: new Map() })
  }
  return stores.get(key)
}

function historyFile(userData) {
  return path.join(userData, 'chat-history.jsonl')
}

function chatsDir(userData) {
  return path.join(userData, 'chats')
}

function migrationMarkerFile(userData) {
  return path.join(chatsDir(userData), '.legacy-migrated')
}

function isValidChatId(id) {
  return typeof id === 'string' &&
    id.length > 0 &&
    id.length < 128 &&
    /^[a-zA-Z0-9_-]+$/.test(id) &&
    path.basename(id) === id
}

function generateChatId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Atomares Speichern einer Chat-Datei. Wirft bei I/O-Fehlern. */
function saveChat(userData, chat) {
  if (!chat || !isValidChatId(chat.id)) {
    throw new Error(`invalid chat id for save: ${chat?.id}`)
  }
  const store = getStore(userData)
  store.chats.set(chat.id, chat)
  // Empty sessions are in-memory drafts, including renamed/archived drafts.
  if (!Array.isArray(chat.records) || chat.records.length === 0) return

  const dir = chatsDir(userData)
  fs.mkdirSync(dir, { recursive: true })

  const target = path.join(dir, `${chat.id}.json`)
  const tmp = path.join(dir, `${chat.id}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(chat, null, 2), 'utf8')
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** Lädt oder migriert Legacy-History aus chat-history.jsonl falls vorhanden. */
function migrateLegacyHistory(userData) {
  const dir = chatsDir(userData)
  fs.mkdirSync(dir, { recursive: true })

  const marker = migrationMarkerFile(userData)
  if (fs.existsSync(marker)) {
    return null // bereits migriert
  }

  const legacyPath = historyFile(userData)
  if (!fs.existsSync(legacyPath)) {
    // Nichts zu migrieren, Marker setzen
    try {
      fs.writeFileSync(marker, Date.now().toString(), 'utf8')
    } catch {
      /* ignore */
    }
    return null
  }

  try {
    const raw = fs.readFileSync(legacyPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    const records = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line))
      } catch {
        /* einzelne unvollständige Zeile ignorieren */
      }
    }

    if (records.length === 0) {
      fs.writeFileSync(marker, Date.now().toString(), 'utf8')
      return null
    }

    let title = 'Legacy Chat'
    const firstUser = records.find((r) => r.role === 'user')
    if (firstUser) {
      const text = Array.isArray(firstUser.parts)
        ? firstUser.parts.find((p) => p.type === 'text')?.text
        : firstUser.content
      if (text) {
        title = provider.localFallbackTitle(text)
      }
    }

    const firstTs = records[0]?.ts || Date.now()
    const lastTs = records[records.length - 1]?.ts || Date.now()
    const legacyChat = {
      id: `chat-migrated-${firstTs}`,
      title,
      manualTitle: false,
      autoTitled: true,
      createdAt: firstTs,
      updatedAt: lastTs,
      archived: false,
      records
    }

    // saveChat MUSS erfolgreich sein, bevor wir umbenennen oder Marker setzen!
    saveChat(userData, legacyChat)

    const migratedBackup = path.join(userData, 'chat-history.migrated.jsonl')
    try {
      fs.renameSync(legacyPath, migratedBackup)
    } catch {
      /* rename best effort */
    }

    try {
      fs.writeFileSync(marker, Date.now().toString(), 'utf8')
    } catch {
      /* ignore */
    }

    return legacyChat
  } catch (err) {
    console.error('[history] failed to migrate legacy history:', err)
    return null
  }
}

/** Lädt einen einzelnen Chat aus dem Store-Cache oder von der Festplatte. */
function getChat(userData, id) {
  if (!isValidChatId(id)) return null
  const store = getStore(userData)
  if (store.chats.has(id)) return store.chats.get(id)

  const filePath = path.join(chatsDir(userData), `${id}.json`)
  try {
    if (!fs.existsSync(filePath)) return null
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    store.chats.set(id, data)
    return data
  } catch (err) {
    console.error(`[history] failed to load chat ${id}:`, err)
    return null
  }
}

/** Erzeugt einen neuen Chat-Session-Eintrag. */
function createChat(userData, title = 'New Chat') {
  const now = Date.now()
  const chat = {
    id: generateChatId(),
    title,
    manualTitle: false,
    autoTitled: false,
    createdAt: now,
    updatedAt: now,
    archived: false,
    records: []
  }
  saveChat(userData, chat)
  setActiveChat(userData, chat.id)
  return chat
}

/** Setzt den aktiven Chat für diesen userData-Bereich. */
function setActiveChat(userData, id) {
  if (!isValidChatId(id)) return null
  const store = getStore(userData)
  store.activeChatId = id
  return getChat(userData, id)
}

/** Liefert die ID des aktiven Chats für diesen userData-Bereich. */
function getActiveChatId(userData) {
  if (!userData) {
    // Fallback auf den ersten aktiven Store falls userData nicht übergeben
    for (const s of stores.values()) {
      if (s.activeChatId) return s.activeChatId
    }
    return null
  }
  return getStore(userData).activeChatId
}

/** Liefert das aktive Chat-Objekt oder erzeugt eines, falls keines existiert. */
function getActiveChat(userData) {
  const store = getStore(userData)
  if (store.activeChatId) {
    const existing = getChat(userData, store.activeChatId)
    if (existing) return existing
  }
  return createChat(userData)
}

/** Initialisiert das Chat-System: Setzt Store zurück, migriert Altlasten und startet IMMER einen frischen Chat beim Start. */
function init(userData) {
  const store = getStore(userData)
  store.activeChatId = null
  store.chats.clear()

  const dir = chatsDir(userData)
  fs.mkdirSync(dir, { recursive: true })
  migrateLegacyHistory(userData)

  // Startet frischen Chat beim Start
  const freshChat = createChat(userData, 'New Chat')
  store.activeChatId = freshChat.id
  return freshChat
}

/** Listet alle Chats als Metadaten-Übersicht, sortiert nach updatedAt absteigend. */
function listChats(userData, options = {}) {
  const { includeArchived = false } = options
  const dir = chatsDir(userData)
  if (!fs.existsSync(dir)) return []

  const list = []
  try {
    const files = fs.readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'active-chat.json' || file.includes('.tmp.') || file.startsWith('.')) {
        continue
      }
      const id = file.replace(/\.json$/, '')
      if (!isValidChatId(id)) continue
      const chat = getChat(userData, id)
      if (!chat || !Array.isArray(chat.records) || chat.records.length === 0) continue
      if (!includeArchived && chat.archived) continue

      let lastMessage = ''
      if (Array.isArray(chat.records) && chat.records.length > 0) {
        const last = chat.records[chat.records.length - 1]
        if (typeof last.content === 'string') {
          lastMessage = last.content.slice(0, 100)
        } else if (Array.isArray(last.parts)) {
          const t = last.parts.find((p) => p.type === 'text')?.text
          if (t) lastMessage = t.slice(0, 100)
        }
      }

      list.push({
        id: chat.id,
        title: chat.title || 'Untitled Chat',
        manualTitle: !!chat.manualTitle,
        autoTitled: !!chat.autoTitled,
        createdAt: chat.createdAt || 0,
        updatedAt: chat.updatedAt || chat.createdAt || 0,
        archived: !!chat.archived,
        messageCount: Array.isArray(chat.records) ? chat.records.length : 0,
        lastMessage,
        lastSnippet: lastMessage
      })
    }
  } catch (err) {
    console.error('[history] failed to list chats:', err)
  }

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return list
}

/**
 * Hängt einen Record an einen bestimmten Chat an (oder an den aktiven Chat).
 * Schreibt bewusst NICHT mehr in chat-history.jsonl!
 */
function appendRecord(userData, record, targetChatId) {
  let id = targetChatId
  if (id !== undefined && !isValidChatId(id)) {
    throw new Error(`invalid targetChatId: ${id}`)
  }
  if (!id) {
    id = getActiveChatId(userData)
  }

  let chat = id ? getChat(userData, id) : null
  if (!chat) {
    if (targetChatId) {
      // Wenn eine explizite ID angegeben wurde, die noch nicht existiert,
      // legen wir diesen Chat mit genau dieser ID an
      chat = {
        id: targetChatId,
        title: 'New Chat',
        manualTitle: false,
        autoTitled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: false,
        records: []
      }
    } else {
      chat = createChat(userData)
    }
  }

  const rec = { ...record, ts: record.ts || Date.now() }
  if (!Array.isArray(chat.records)) chat.records = []
  chat.records.push(rec)
  chat.updatedAt = Date.now()
  saveChat(userData, chat)
}

/** Lädt die letzten maxRecords Records für einen Chat (oder den aktiven Chat). */
function loadRecords(userData, maxRecords, targetChatId) {
  if (targetChatId !== undefined) {
    // Wenn explizite ID angegeben, DARF NIE auf einen anderen Chat zurückgefallen werden!
    if (!isValidChatId(targetChatId)) return []
    const chat = getChat(userData, targetChatId)
    if (!chat || !Array.isArray(chat.records)) return []
    return maxRecords && maxRecords > 0 ? chat.records.slice(-maxRecords) : chat.records
  }

  // Kein targetChatId angegeben -> aktiver Chat
  const activeId = getActiveChatId(userData)
  if (!activeId) return []
  const chat = getChat(userData, activeId)
  if (!chat || !Array.isArray(chat.records)) return []
  return maxRecords && maxRecords > 0 ? chat.records.slice(-maxRecords) : chat.records
}

/** Benennt einen Chat um. Setzt manualTitle = true falls durch User ausgelöst. */
function renameChat(userData, id, title, isManual = true) {
  if (!isValidChatId(id)) return false
  const chat = getChat(userData, id)
  if (!chat) return false
  chat.title = (title || '').trim() || 'Untitled'
  if (isManual) {
    chat.manualTitle = true
  }
  chat.updatedAt = Date.now()
  saveChat(userData, chat)
  return true
}

/** Archiviert oder dearchiviert einen Chat. */
function archiveChat(userData, id, archived = true) {
  if (!isValidChatId(id)) return false
  const chat = getChat(userData, id)
  if (!chat) return false
  chat.archived = !!archived
  chat.updatedAt = Date.now()
  saveChat(userData, chat)

  const store = getStore(userData)
  if (store.activeChatId === id && archived) {
    const remaining = listChats(userData, { includeArchived: false })
    if (remaining.length > 0) {
      setActiveChat(userData, remaining[0].id)
    } else {
      createChat(userData)
    }
  }
  return true
}

/** Löscht einen Chat dauerhaft. */
function deleteChat(userData, id) {
  if (!isValidChatId(id)) return false
  const store = getStore(userData)
  store.chats.delete(id)
  const target = path.join(chatsDir(userData), `${id}.json`)
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target)
    }
  } catch (err) {
    console.error(`[history] failed to delete chat ${id}:`, err)
    return false
  }

  if (store.activeChatId === id) {
    const remaining = listChats(userData, { includeArchived: false })
    if (remaining.length > 0) {
      setActiveChat(userData, remaining[0].id)
    } else {
      createChat(userData)
    }
  }
  return true
}

/** Durchsucht Titel und Nachrichten aller unarchivierten Chats. */
function searchChats(userData, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return listChats(userData, { includeArchived: false })

  const dir = chatsDir(userData)
  if (!fs.existsSync(dir)) return []

  const results = []
  const files = fs.readdirSync(dir)
  for (const file of files) {
    if (!file.endsWith('.json') || file === 'active-chat.json' || file.includes('.tmp.') || file.startsWith('.')) continue
    const id = file.replace(/\.json$/, '')
    if (!isValidChatId(id)) continue
    const chat = getChat(userData, id)
    if (!chat || chat.archived || !Array.isArray(chat.records) || chat.records.length === 0) continue

    let matches = 0
    let snippet = ''

    if (chat.title && chat.title.toLowerCase().includes(q)) {
      matches++
      snippet = `Title: ${chat.title}`
    }

    if (Array.isArray(chat.records)) {
      for (const r of chat.records) {
        let text = ''
        if (typeof r.content === 'string') text = r.content
        else if (Array.isArray(r.parts)) {
          text = r.parts.map((p) => p.text || '').join(' ')
        }

        if (text && text.toLowerCase().includes(q)) {
          matches++
          if (!snippet) {
            const idx = text.toLowerCase().indexOf(q)
            const start = Math.max(0, idx - 30)
            const end = Math.min(text.length, idx + q.length + 50)
            snippet = (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
          }
        }
      }
    }

    if (matches > 0) {
      results.push({
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt || chat.createdAt,
        createdAt: chat.createdAt,
        messageCount: Array.isArray(chat.records) ? chat.records.length : 0,
        matches,
        snippet
      })
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}

/**
 * Erzeugt einen Auto-Titel nach der ersten User-Nachricht (maximal 5 Wörter).
 * - Dedupliziert parallele Titling-Anfragen für denselben Chat.
 * - Re-prüft manualTitle nach dem Await, damit parallele User-Umbenennungen geschützt bleiben.
 * - Fällt bei Fehlern zuverlässig auf einen lokalen Fallback zurück.
 */
async function generateAndSetTitle(userData, chatId, cfg, force = false) {
  if (!isValidChatId(chatId)) return null
  const chat = getChat(userData, chatId)
  if (!chat) return null
  if (chat.manualTitle && !force) return chat.title

  // In-Flight-Deduplizierung
  const lockKey = `${path.resolve(userData)}:${chatId}`
  if (inFlightTitling.has(lockKey)) {
    return chat.title
  }
  inFlightTitling.add(lockKey)

  try {
    let firstUserText = ''
    if (Array.isArray(chat.records)) {
      for (const r of chat.records) {
        if (r.role === 'user') {
          if (Array.isArray(r.parts)) {
            const t = r.parts.find((p) => p.type === 'text')?.text
            if (t && t.trim()) {
              firstUserText = t.trim()
              break
            }
          }
          if (typeof r.content === 'string' && r.content.trim()) {
            firstUserText = r.content.trim()
            break
          }
        }
      }
    }

    if (!firstUserText) return chat.title

    let newTitle = null
    if (cfg && cfg.baseUrl) {
      try {
        newTitle = await provider.requestTitle(cfg, firstUserText)
      } catch {
        newTitle = null
      }
    }

    // Lokaler Fallback bei Provider-Ausfall
    if (!newTitle) {
      newTitle = provider.localFallbackTitle(firstUserText)
    }

    // WICHTIG: Nach dem Await erneut prüfen, ob der User den Chat inzwischen manuell umbenannt hat!
    const freshChat = getChat(userData, chatId)
    if (!freshChat) return null
    if (freshChat.manualTitle && !force) {
      // Nicht überschreiben! User hat während des Requests umbenannt.
      return freshChat.title
    }

    freshChat.title = newTitle
    freshChat.autoTitled = true
    freshChat.updatedAt = Date.now()
    saveChat(userData, freshChat)
    return newTitle
  } finally {
    inFlightTitling.delete(lockKey)
  }
}

/** Archiviert die History des aktiven Chats und startet einen frischen Chat. */
function archiveAndClear(userData) {
  const store = getStore(userData)
  if (store.activeChatId) {
    archiveChat(userData, store.activeChatId, true)
  }
  const fresh = createChat(userData, 'New Chat')
  return fresh.id
}

function close(userData) {
  if (userData) {
    const key = path.resolve(userData)
    const s = stores.get(key)
    if (s) {
      s.activeChatId = null
      s.chats.clear()
      stores.delete(key)
    }
  } else {
    for (const s of stores.values()) {
      s.activeChatId = null
      s.chats.clear()
    }
    stores.clear()
  }
}

module.exports = {
  init,
  createChat,
  getChat,
  getActiveChat,
  getActiveChatId,
  setActiveChat,
  listChats,
  appendRecord,
  loadRecords,
  renameChat,
  archiveChat,
  deleteChat,
  searchChats,
  generateAndSetTitle,
  archiveAndClear,
  migrateLegacyHistory,
  close,
  historyFile,
  chatsDir,
  isValidChatId
}
