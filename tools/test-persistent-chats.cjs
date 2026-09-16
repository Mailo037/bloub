const fs = require('fs')
const path = require('path')
const os = require('os')
const assert = require('assert')

const history = require('../electron/chat/history.cjs')
const tools = require('../electron/chat/tools.cjs')
const provider = require('../electron/chat/provider.cjs')
const { chatDefaults } = require('../electron/chat/agent.cjs')

let passes = 0
let failures = 0

function check(label, cond, extra) {
  if (cond) {
    passes++
    console.log(`PASS ${label}`)
  } else {
    failures++
    console.error(`FAIL ${label}`, extra !== undefined ? extra : '')
  }
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-test-chat-'))

  try {
    // 1. Path traversal protection
    console.log('\n--- 1. Path Traversal Protection ---')
    check('isValidChatId accepts valid id', history.isValidChatId('chat-123_abc'))
    check('isValidChatId rejects ../', !history.isValidChatId('../evil'))
    check('isValidChatId rejects ..\\\\', !history.isValidChatId('..\\evil'))
    check('isValidChatId rejects slashes', !history.isValidChatId('foo/bar'))
    check('isValidChatId rejects backslashes', !history.isValidChatId('foo\\bar'))
    check('isValidChatId rejects empty', !history.isValidChatId(''))
    check('isValidChatId rejects dots', !history.isValidChatId('...'))

    // Attempt traversal operations
    const invalidRead = history.getChat(tmpDir, '../secret')
    check('getChat rejects traversal and returns null', invalidRead === null)

    const invalidDelete = history.deleteChat(tmpDir, '../../etc/passwd')
    check('deleteChat rejects traversal and returns false', invalidDelete === false)

    const invalidRecords = history.loadRecords(tmpDir, 0, '../other')
    check('loadRecords returns empty for invalid chat id without falling back', Array.isArray(invalidRecords) && invalidRecords.length === 0)

    // 2. Legacy Migration & Compatibility Write Removal
    console.log('\n--- 2. Legacy Migration & Isolation ---')
    const legacyFile = path.join(tmpDir, 'chat-history.jsonl')
    const legacyRecords = [
      { role: 'user', content: 'Hello from legacy' },
      { role: 'assistant', content: 'Legacy response' }
    ]
    fs.writeFileSync(legacyFile, legacyRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

    // Init should migrate legacy history
    history.init(tmpDir)
    check('Migration marker created', fs.existsSync(path.join(tmpDir, 'chats', '.legacy-migrated')))
    check('Legacy file renamed to migrated', fs.existsSync(path.join(tmpDir, 'chat-history.migrated.jsonl')))
    check('Original legacy file removed', !fs.existsSync(legacyFile))

    const chatsAfterMigration = history.listChats(tmpDir)
    check(
      'Only migrated session listed; fresh draft hidden',
      chatsAfterMigration.length === 1 &&
      chatsAfterMigration.some((c) => c.title === 'Hello from legacy' || c.title.includes('Migrated'))
    )

    // Verify appendRecord does NOT recreate legacy chat-history.jsonl
    const activeId = history.getActiveChatId(tmpDir)
    history.appendRecord(tmpDir, { role: 'user', parts: [{ type: 'text', text: 'New message' }] }, activeId)
    check('appendRecord does not recreate chat-history.jsonl', !fs.existsSync(legacyFile))

    // Re-running migrateLegacyHistory does not re-import
    history.migrateLegacyHistory(tmpDir)
    check('No duplicate migration', history.listChats(tmpDir).length === 2)

    // 3. Multi-chat Session Creation and Isolation
    console.log('\n--- 3. Multi-chat Session Management ---')
    const chat2 = history.createChat(tmpDir, 'Second Project Discussion')
    check('Second chat created', chat2 && chat2.id && chat2.title === 'Second Project Discussion')
    check('Empty second chat stays out of history', history.listChats(tmpDir).length === 2)
    check('Empty second chat has no file', !fs.existsSync(path.join(tmpDir, 'chats', chat2.id + '.json')))

    // Append to chat2
    history.appendRecord(tmpDir, { role: 'user', parts: [{ type: 'text', text: 'Secret in chat 2' }] }, chat2.id)
    history.appendRecord(tmpDir, { role: 'assistant', content: 'Reply in chat 2' }, chat2.id)
    check('Second chat persisted after first message', fs.existsSync(path.join(tmpDir, 'chats', chat2.id + '.json')))
    check('Three nonempty chats listed', history.listChats(tmpDir).length === 3)
    const draft = history.createChat(tmpDir, 'Unused draft')
    history.renameChat(tmpDir, draft.id, 'Renamed unused draft')
    check('Renaming draft does not persist it', !fs.existsSync(path.join(tmpDir, 'chats', draft.id + '.json')))
    check('Draft absent from search', history.searchChats(tmpDir, 'unused draft').length === 0)
    history.close(tmpDir)
    history.init(tmpDir)
    check('Unused draft disappears after restart', history.getChat(tmpDir, draft.id) === null)
    check('Written chat survives restart', history.getChat(tmpDir, chat2.id)?.records.length === 2)

    const recsChat1 = history.loadRecords(tmpDir, 0, activeId)
    const recsChat2 = history.loadRecords(tmpDir, 0, chat2.id)
    check('Chat 1 records isolated from Chat 2', !recsChat1.some((r) => (r.content || '').includes('chat 2')))
    check('Chat 2 has its own records', recsChat2.some((r) => (r.content || '').includes('Reply in chat 2')))

    // Search across chats
    const searchRes = history.searchChats(tmpDir, 'Secret')
    check('Search finds match in chat 2', searchRes.length === 1 && searchRes[0].id === chat2.id)

    // 4. Auto-titling & Manual Rename Protection
    console.log('\n--- 4. Auto-Titling & Rename Protection ---')
    check('cleanTitle strips quotes and periods', provider.cleanTitle('"Short Clean Title."') === 'Short Clean Title')
    check('localFallbackTitle caps to 5 words', provider.localFallbackTitle('one two three four five six seven') === 'one two three four five')

    // Test in-flight title deduplication & deferred provider rename race
    const chat3 = history.createChat(tmpDir, 'Auto Title Target')
    history.appendRecord(tmpDir, { role: 'user', parts: [{ type: 'text', text: 'First user message about quantum physics' }] }, chat3.id)

    let resolveProvider
    const deferred = new Promise((r) => { resolveProvider = r })
    const origRequestTitle = provider.requestTitle
    provider.requestTitle = () => deferred

    try {
      const mockCfg = { baseUrl: 'http://127.0.0.1:99999', apiKey: '' }
      const titlePromise = history.generateAndSetTitle(tmpDir, chat3.id, mockCfg)

      // In-flight manual rename while provider request is pending
      history.renameChat(tmpDir, chat3.id, 'Manual Chosen Title', true)
      check('Manual title set in-flight', history.getChat(tmpDir, chat3.id).manualTitle === true)

      // Resolve the provider afterwards
      resolveProvider('Provider Generated Title')
      await titlePromise

      const chat3After = history.getChat(tmpDir, chat3.id)
      check('Auto-title did not overwrite manual title during in-flight race', chat3After.title === 'Manual Chosen Title')
    } finally {
      provider.requestTitle = origRequestTitle
    }

    // 5. Conversational Memory Opt-Out
    console.log('\n--- 5. Conversational Memory Enforcement ---')
    const defaults = chatDefaults()
    check('Memory default is enabled (true)', defaults.memoryEnabled === true)

    const memFile = path.join(tmpDir, 'memory.json')
    // Test write with memoryEnabled: false explicitly
    const disabledWrite = await tools.executeTool('memory_write', JSON.stringify({ key: 'test', value: 'val' }), {
      memoryFilePath: memFile,
      memoryEnabled: false
    })
    check('memory_write denied when memoryEnabled: false', disabledWrite.isError === true && disabledWrite.content.includes('disabled'))

    const disabledGet = await tools.executeTool('memory_get', JSON.stringify({ key: 'test' }), {
      memoryFilePath: memFile,
      memoryEnabled: false
    })
    check('memory_get denied when memoryEnabled: false', disabledGet.isError === true && disabledGet.content.includes('disabled'))

    // Test write with memoryEnabled: true
    const enabledWrite = await tools.executeTool('memory_write', JSON.stringify({ key: 'project', value: 'Bloub Pet' }), {
      memoryFilePath: memFile,
      memoryEnabled: true
    })
    check('memory_write allowed when memoryEnabled: true', enabledWrite.ok === true)

    // 6. CHAT_SET_TITLE Tool
    console.log('\n--- 6. chat_set_title Tool Execution ---')
    let toolRenamed = ''
    const titleToolRes = await tools.executeTool('chat_set_title', JSON.stringify({ title: 'Refactored Architecture Overview Document For Review' }), {
      onRenameChat: async (t) => { toolRenamed = t }
    })
    check('chat_set_title executes successfully', titleToolRes.ok === true)
    check('chat_set_title strictly caps to 5 words', toolRenamed === 'Refactored Architecture Overview Document For')

  } finally {
    // Clean up
    history.close(tmpDir)
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }

  console.log(`\n========================================`)
  console.log(`Tests: ${passes} passed, ${failures} failed`)
  console.log(`========================================`)
  process.exit(failures > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('Test runner fatal error:', err)
  process.exit(1)
})
