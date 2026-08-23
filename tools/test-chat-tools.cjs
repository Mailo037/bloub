// Smoke-Test fuer chat/tools.cjs: baut ein Fake-Projekt im Temp-Verzeichnis und
// prueft Baum/Lesen/Suche plus Pfadpolitik. Exit 1 bei irgendeinem FAIL.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tools = require('../electron/chat/tools.cjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bloub-tools-'))
const grantPath = root
fs.mkdirSync(path.join(root, 'src'), { recursive: true })
fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true })
fs.writeFileSync(path.join(root, 'src', 'main.js'), Array.from({ length: 30 }, (_, i) => `line ${i + 1} needle${i % 5}`).join('\n'))
fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export const answer = 42\n')
fs.writeFileSync(path.join(root, 'README.md'), '# hello\nneedle here too\n')
fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'x.js'), 'needle in junk\n')
fs.writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=abc\n')
fs.writeFileSync(path.join(root, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${extra ? ` :: ${extra}` : ''}`)
  }
}

const grants = [{ path: grantPath, allowSecrets: false, grantedAt: Date.now() }]
const ctx = { grants }

async function main() {
  // fs_tree: junk ignoriert, png ignoriert
  const tree = await tools.executeTool('fs_tree', JSON.stringify({ path: grantPath }), grants)
  check('tree ok', tree.ok && !tree.isError, tree.content)
  check('tree ignores node_modules', !tree.content.includes('junk'))
  check('tree ignores binary ext', !tree.content.includes('logo.png'))
  check('tree lists src/', tree.content.includes('src/'))

  // fs_read: Zeilennummern + offset/limit
  const read = await tools.executeTool('fs_read', JSON.stringify({ path: 'src/main.js', offset: 5, limit: 3 }), grants)
  check('read ok', read.ok, read.content)
  check('read offset line numbers', read.content.includes('     5| line 5') && read.content.includes('     7| line 7'), read.content)
  const readBig = await tools.executeTool('fs_read', JSON.stringify({ path: 'src/main.js', limit: 5000 }), grants)
  check('read limit capped at 2000', !readBig.content.split('\n').slice(2000).some((l) => /^\s+\d+\|/.test(l)))

  // fs_search
  const search = await tools.executeTool('fs_search', JSON.stringify({ path: grantPath, pattern: 'needle' }), grants)
  check('search ok', search.ok, search.content)
  check('search finds src + README', search.content.includes('src/main.js') && search.content.includes('README.md'))
  check('search ignores junk', !search.content.includes('junk'))
  const searchInc = await tools.executeTool('fs_search', JSON.stringify({ path: grantPath, pattern: 'needle', include: '*.md' }), grants)
  check('search include filter', searchInc.content.includes('README.md') && !searchInc.content.includes('main.js'))
  const badRe = await tools.executeTool('fs_search', JSON.stringify({ path: grantPath, pattern: '([unclosed' }), grants)
  check('search invalid regex is error', badRe.isError === true)

  // Pfadpolitik
  const outside = await tools.executeTool('fs_read', JSON.stringify({ path: 'C:\\Windows\\win.ini' }), grants)
  check('outside grant refused', outside.isError === true && outside.content.includes('path outside granted folders'))
  const escape = await tools.executeTool('fs_read', JSON.stringify({ path: path.join(grantPath, '..', 'x.txt') }), grants)
  check('.. escape refused', escape.isError === true)
  const rel = await tools.executeTool('fs_read', JSON.stringify({ path: 'src/util.ts' }), grants)
  check('relative path resolves against grant', rel.ok && rel.content.includes('42'))

  // Geheimnisse
  const envDenied = await tools.executeTool('fs_read', JSON.stringify({ path: '.env' }), grants)
  check('.env refused without shield', envDenied.isError === true && envDenied.content.includes('secret file refused'))
  const grantsOpen = [{ path: grantPath, allowSecrets: true, grantedAt: Date.now() }]
  const envAllowed = await tools.executeTool('fs_read', JSON.stringify({ path: '.env' }), grantsOpen)
  check('.env readable with shield', envAllowed.ok && envAllowed.content.includes('SECRET_TOKEN'))
  const envSearch = await tools.executeTool('fs_search', JSON.stringify({ path: grantPath, pattern: 'SECRET' }), grants)
  check('search skips secrets', !envSearch.content.includes('.env'))

  // Validierung vor execute
  const badArgs = await tools.executeTool('fs_read', JSON.stringify({ path: 'src/main.js', extra: 1 }), grants)
  check('unexpected property rejected', badArgs.isError === true && badArgs.content.includes('unexpected property'))
  const badJson = await tools.executeTool('fs_read', '{nope', grants)
  check('invalid json rejected', badJson.isError === true)
  // Pet Tools
  let petActionFired = null
  const petCtx = {
    grants,
    onPetAction: async (action) => {
      petActionFired = action
    }
  }
  const shapeRes = await tools.executeTool('pet_set_shape', JSON.stringify({ shape: 'cloud', note: 'reshaping ☁️' }), petCtx)
  check('pet_set_shape ok', shapeRes.ok && petActionFired?.type === 'set_shape' && petActionFired?.shape === 'nuage')

  const exprRes = await tools.executeTool('pet_set_expression', JSON.stringify({ expression: 'excited', note: 'so excited!' }), petCtx)
  check('pet_set_expression ok', exprRes.ok && petActionFired?.type === 'set_expression' && petActionFired?.expression === 'excite')

  const animRes = await tools.executeTool('pet_animate', JSON.stringify({ animation: 'bounce', durationSeconds: 5, note: 'boing boing' }), petCtx)
  check('pet_animate ok', animRes.ok && petActionFired?.type === 'play_animation' && petActionFired?.animation === 'bounce' && petActionFired?.durationSeconds === 5)

  const stopRes = await tools.executeTool('pet_stop_animation', JSON.stringify({ note: 'calming down 🌙' }), petCtx)
  check('pet_stop_animation ok', stopRes.ok && petActionFired?.type === 'play_animation' && petActionFired?.animation === 'idle')

  const colorRes = await tools.executeTool('pet_set_color', JSON.stringify({ color: 'rose', note: 'turning pink 💗' }), petCtx)
  check('pet_set_color ok', colorRes.ok && petActionFired?.type === 'set_color' && petActionFired?.color === 'rose')

  const sizeRes = await tools.executeTool('pet_set_size', JSON.stringify({ ballSize: 240, note: 'growing 📏' }), petCtx)
  check('pet_set_size ok', sizeRes.ok && petActionFired?.type === 'set_size' && petActionFired?.ballSize === 240)

  // note ist Pflicht bei Pet-Tools — fehlt sie, wird vor execute abgelehnt
  const noNote = await tools.executeTool('pet_set_shape', JSON.stringify({ shape: 'circle' }), petCtx)
  check('pet tool requires note', noNote.isError === true && noNote.content.includes('missing "note"'))

  // Validierung der neuen Tools vor execute
  const badColor = await tools.executeTool('pet_set_color', JSON.stringify({ color: 'neon', note: 'x' }), petCtx)
  check('pet_set_color enum enforced', badColor.isError === true && badColor.content.includes('must be one of'))
  const badSize = await tools.executeTool('pet_set_size', JSON.stringify({ ballSize: 999, note: 'x' }), petCtx)
  check('pet_set_size maximum enforced', badSize.isError === true && badSize.content.includes('> maximum'))

  // pet_custom_animate
  const customBody = await tools.executeTool(
    'pet_custom_animate',
    JSON.stringify({ kind: 'body', duration: 2, note: 'little dance 💃', bodyKeyframes: [{ t: 0, y: 0 }, { t: 1, y: -10 }, { t: 2, y: 0 }] }),
    petCtx
  )
  check('pet_custom_animate body ok', customBody.ok && petActionFired?.type === 'play_custom_animation' && petActionFired?.animation?.kind === 'body' && petActionFired?.animation?.bodyKeyframes?.length === 3)
  check('pet_custom_animate strips note from payload', petActionFired?.animation?.note === undefined)

  const customBoth = await tools.executeTool(
    'pet_custom_animate',
    JSON.stringify({
      kind: 'both',
      duration: 1.5,
      note: 'full performance ✨',
      bodyKeyframes: [{ t: 0, scale: 1 }, { t: 1.5, scale: 1.2 }],
      expressionKeyframes: [{ t: 0, yaw: 0 }, { t: 1.5, yaw: 15, open: 0.4 }]
    }),
    petCtx
  )
  check('pet_custom_animate both ok', customBoth.ok && petActionFired?.animation?.kind === 'both' && petActionFired?.animation?.expressionKeyframes?.length === 2)

  const customMissing = await tools.executeTool('pet_custom_animate', JSON.stringify({ kind: 'expression', duration: 1, note: 'x' }), petCtx)
  check('pet_custom_animate requires expression keyframes', customMissing.isError === true && customMissing.content.includes('expressionKeyframes'))

  const customBadKind = await tools.executeTool('pet_custom_animate', JSON.stringify({ kind: 'dance', duration: 1, note: 'x' }), petCtx)
  check('pet_custom_animate kind enum enforced', customBadKind.isError === true)

  // TOOLS_FOR_MODEL
  check('tools listed with grants read', tools.TOOLS_FOR_MODEL(grants, 'read').length === 16)
  check('tools listed with grants read + shell', tools.TOOLS_FOR_MODEL(grants, 'read', { shellEnabled: true }).length === 17)
  check('tools listed with grants read + memory', tools.TOOLS_FOR_MODEL(grants, 'read', { memoryEnabled: true }).length === 18)
  check('tools listed with grants read + both', tools.TOOLS_FOR_MODEL(grants, 'read', { shellEnabled: true, memoryEnabled: true }).length === 19)
  check('tools listed with grants readwrite + both', tools.TOOLS_FOR_MODEL(grants, 'readwrite', { shellEnabled: true, memoryEnabled: true }).length === 21)
  check('tools listed with grants none', tools.TOOLS_FOR_MODEL(grants, 'none').length === 13)
  check('pet tools listed without grants', tools.TOOLS_FOR_MODEL([]).length === 13)
  check('pet tools without grants + memory', tools.TOOLS_FOR_MODEL([], 'read', { memoryEnabled: true }).length === 15)
  check('pet tools without grants + shell', tools.TOOLS_FOR_MODEL([], 'read', { shellEnabled: true }).length === 14)

  // Write-Tools: fs_write + fs_edit
  const rwCtx = { grants, fileAccess: 'readwrite' }
  const writeRes = await tools.executeTool('fs_write', JSON.stringify({ path: 'src/new.txt', content: 'hello world\n' }), rwCtx)
  check('fs_write ok with readwrite', writeRes.ok && fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8') === 'hello world\n')

  const editRes = await tools.executeTool('fs_edit', JSON.stringify({ path: 'src/new.txt', old: 'world', new: 'bloub' }), rwCtx)
  check('fs_edit ok', editRes.ok && fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8') === 'hello bloub\n')

  const editMissing = await tools.executeTool('fs_edit', JSON.stringify({ path: 'src/new.txt', old: 'nope', new: 'x' }), rwCtx)
  check('fs_edit old not found', editMissing.isError === true && editMissing.content.includes('not found'))

  const writeDenied = await tools.executeTool('fs_write', JSON.stringify({ path: 'src/new.txt', content: 'x' }), { grants, fileAccess: 'read' })
  check('fs_write denied with read', writeDenied.isError === true && writeDenied.content.includes('write access disabled'))

  const writeNone = await tools.executeTool('fs_write', JSON.stringify({ path: 'src/new.txt', content: 'x' }), { grants, fileAccess: 'none' })
  check('fs_write denied with none', writeNone.isError === true)

  const writeOutside = await tools.executeTool('fs_write', JSON.stringify({ path: '..\\evil.txt', content: 'x' }), rwCtx)
  check('fs_write outside grant refused', writeOutside.isError === true && writeOutside.content.includes('path outside granted folders'))

  // System-Tools
  const sysInfo = await tools.executeTool('system_info', '{}', { grants })
  check('system_info ok', sysInfo.ok)
  if (sysInfo.ok) {
    const parsed = JSON.parse(sysInfo.content)
    check('system_info has platform', typeof parsed.platform === 'string' && parsed.platform.length > 0)
    check('system_info has hostname', typeof parsed.hostname === 'string')
  }

  const shotNoCtx = await tools.executeTool('desktop_screenshot', '{}', { grants })
  check('screenshot without takeScreenshot returns error', shotNoCtx.isError === true && shotNoCtx.content === 'screenshot unavailable')

  let shotCalled = false
  const shotCtx = {
    grants,
    takeScreenshot: async () => { shotCalled = true; return { ok: true, mime: 'image/png', data: 'fake', width: 100, height: 100 } }
  }
  const shotOk = await tools.executeTool('desktop_screenshot', '{}', shotCtx)
  check('screenshot with takeScreenshot ok', shotOk.ok && shotCalled)
  check('screenshot mentions image', shotOk.content.includes('Screenshot'))

  const shellNoPerm = await tools.executeTool('shell_exec', JSON.stringify({ command: 'echo hi' }), { grants })
  check('shell_exec denied without shellEnabled', shellNoPerm.isError === true && shellNoPerm.content.includes('Terminal access is disabled'))

  const shellOkTest = await tools.executeTool('shell_exec', JSON.stringify({ command: process.platform === 'win32' ? 'echo hi' : 'echo hi' }), { grants, shellEnabled: true })
  if (shellOkTest.ok) {
    check('shell_exec ok', shellOkTest.content.includes('hi'))
  } else {
    // Manche Umgebungen (Sandbox) erlauben kein execFile mit pipe
    console.log(`SKIP shell_exec execution (${shellOkTest.content?.slice(0, 60)})`)
  }

  // Memory-Tools
  const memPath = path.join(root, 'memory.json')
  const memCtx = { grants, memoryFilePath: memPath }
  const memDenied = await tools.executeTool('memory_write', JSON.stringify({ key: 'a', value: 'b' }), { grants })
  check('memory_write disabled without memoryFilePath', memDenied.isError === true && memDenied.content.includes('memory disabled'))

  const memWrite = await tools.executeTool('memory_write', JSON.stringify({ key: 'user.name', value: 'Alex' }), memCtx)
  check('memory_write ok', memWrite.ok && memWrite.content.includes('user.name'))
  check('memory file created', fs.existsSync(memPath))

  const memWriteUpdate = await tools.executeTool('memory_write', JSON.stringify({ key: 'user.name', value: 'Alexandra' }), memCtx)
  check('memory_write updates existing', memWriteUpdate.ok && memWriteUpdate.content.includes('Updated'))

  const memGetKey = await tools.executeTool('memory_get', JSON.stringify({ key: 'user.name' }), memCtx)
  check('memory_get by key', memGetKey.ok && memGetKey.content.includes('Alexandra'))

  const memGetAll = await tools.executeTool('memory_get', '{}', memCtx)
  check('memory_get all', memGetAll.ok && memGetAll.content.includes('user.name'))

  const memGetMissing = await tools.executeTool('memory_get', JSON.stringify({ key: 'nope' }), memCtx)
  check('memory_get missing key', memGetMissing.isError === true && memGetMissing.content.includes('no memory entry'))

  // Root-Grant (C:\) — resolveWithinGrants darf nicht an doppeltem sep scheitern
  if (process.platform === 'win32') {
    const rootGrants = [{ path: 'C:\\', allowSecrets: true, isRoot: true }]
    const rootGrantsCtx = { grants: rootGrants, fileAccess: 'read' }
    // Der Temp-Ordner liegt auf C:, also muss eine Datei darin lesbar sein
    const rootOk = await tools.executeTool('fs_read', JSON.stringify({ path: path.join(root, 'src', 'main.js') }), rootGrantsCtx)
    check('root grant reads file on C:', rootOk.ok)
  } else {
    console.log('SKIP root grant test (not Windows)')
  }

  // pet_draw_path
  const drawNoCtx = await tools.executeTool('pet_draw_path', JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }), {})
  check('pet_draw_path without onDrawPath', drawNoCtx.isError === true && drawNoCtx.content === 'draw path unavailable')

  let drawCalled = null
  const drawCtx = {
    grants,
    onDrawPath: async (payload) => {
      drawCalled = payload
      return { ok: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    }
  }
  const drawRes = await tools.executeTool('pet_draw_path', JSON.stringify({ points: [{ x: 100, y: 100 }, { x: 300, y: 200 }, { x: 500, y: 100 }], color: '#e8483f' }), drawCtx)
  check('pet_draw_path ok', drawRes.ok && drawCalled?.points?.length === 3 && drawCalled?.color === '#e8483f')
  check('pet_draw_path reports work area', drawRes.content.includes('1920'))

  const drawOne = await tools.executeTool('pet_draw_path', JSON.stringify({ points: [{ x: 0, y: 0 }] }), drawCtx)
  check('pet_draw_path needs 2 points', drawOne.isError === true && drawOne.content.includes('at least 2 points'))

  // pet_get_state
  const stateRes = await tools.executeTool('pet_get_state', '{}', petCtx)
  check('pet_get_state without getPetState returns error', stateRes.isError === true && stateRes.content === 'pet state unavailable')
  const stateCtx = {
    ...petCtx,
    getPetState: () => tools.petStateFromConfig({ shape: 'cercle', color: 'encre', expression: 'neutre', ballSize: 200 })
  }
  const stateRes2 = await tools.executeTool('pet_get_state', '{}', stateCtx)
  check('pet_get_state ok', stateRes2.ok)
  if (stateRes2.ok) {
    const parsed = JSON.parse(stateRes2.content)
    check('pet_get_state shape', parsed.shape === 'circle')
    check('pet_get_state color', parsed.color === 'encre')
    check('pet_get_state expression', parsed.expression === 'neutral')
    check('pet_get_state ballSize', parsed.ballSize === 200)
  }

  // Symlink-Escape (Windows braucht oft Admin -> skip falls nicht moeglich)
  const outsideFile = path.join(path.dirname(root), 'bloub-tools-outside.txt')
  fs.writeFileSync(outsideFile, 'outside secret\n')
  try {
    const link = path.join(root, 'escape-link')
    fs.symlinkSync(outsideFile, link, 'file')
    const viaLink = await tools.executeTool('fs_read', JSON.stringify({ path: 'escape-link' }), grants)
    check('symlink escape refused', viaLink.isError === true)
  } catch {
    console.log('SKIP symlink escape (not permitted on this system)')
  }

  fs.rmSync(root, { recursive: true, force: true })
  try {
    fs.rmSync(outsideFile, { force: true })
  } catch {
    /* ignore */
  }
  if (failures > 0) {
    console.log(`${failures} FAILURES`)
    process.exit(1)
  }
  console.log('ALL PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
