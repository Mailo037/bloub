const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const file = dir => path.join(dir, 'dictations.json')
function list(dir) {
  try {
    const entries = JSON.parse(fs.readFileSync(file(dir), 'utf8'))
    return Array.isArray(entries) ? entries.filter(e => typeof e.text === 'string').slice(0, 20) : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
function write(dir, entries) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file(dir) + '.tmp', JSON.stringify(entries), 'utf8')
  fs.renameSync(file(dir) + '.tmp', file(dir))
}
function audioPath(dir, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid recording id')
  return path.join(dir, 'dictation-audio', id)
}
function save(dir, text, audio, mime = 'audio/webm') {
  if (!text?.trim() && !audio?.length) return
  const entry = { id: randomUUID(), text: (text || '').trim(), createdAt: Date.now(), mime, hasAudio: !!audio?.length }
  if (entry.hasAudio) {
    fs.mkdirSync(path.join(dir, 'dictation-audio'), { recursive: true })
    fs.writeFileSync(audioPath(dir, entry.id), audio)
  }
  const entries = [entry, ...list(dir)]
  write(dir, entries.slice(0, 20))
  for (const old of entries.slice(20)) if (old.hasAudio) fs.rmSync(audioPath(dir, old.id), { force: true })
  return entry
}
function remove(dir, id) {
  const entries = list(dir)
  const entry = entries.find(e => e.id === id)
  if (!entry) return false
  write(dir, entries.filter(e => e.id !== id))
  if (entry.hasAudio) fs.rmSync(audioPath(dir, id), { force: true })
  return true
}
function audio(dir, id) {
  const entry = list(dir).find(e => e.id === id)
  if (!entry?.hasAudio) throw new Error('Recording unavailable')
  return { entry, data: fs.readFileSync(audioPath(dir, id)) }
}
function setText(dir, id, text) {
  const entries = list(dir)
  const entry = entries.find(e => e.id === id)
  if (!entry) return false
  entry.text = text.trim()
  write(dir, entries)
  return true
}
module.exports = { list, save, remove, audio, setText }
