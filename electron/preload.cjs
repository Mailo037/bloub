const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bloubPet', {
  // pet window
  moveBy: (dx, dy) => ipcRenderer.send('pet:moveBy', dx, dy),
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),
  setIgnore: (ignore) => ipcRenderer.send('pet:setIgnore', ignore),
  toggleSettings: () => ipcRenderer.send('ui:toggle-settings'),
  closeSettings: () => ipcRenderer.send('ui:close-settings'),
  resizeSettings: (x, y, width, height) =>
    ipcRenderer.send('ui:resize-settings', x, y, width, height),
  // shared
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, config) => cb(config)),
  onSettingsVisible: (cb) => ipcRenderer.on('settings:visibility', (_e, visible) => cb(visible)),
  onQuitRequested: (cb) => ipcRenderer.on('pet:quit-requested', () => cb()),
  confirmQuit: () => ipcRenderer.send('pet:quit-confirm'),
  quit: () => ipcRenderer.send('pet:quit'),
  // pet: chat summon + drop target
  toggleChat: () => ipcRenderer.send('pet:request-chat-toggle'),
  attachPaths: (paths) => ipcRenderer.invoke('chat:attach', paths),
  onPlayState: (cb) => ipcRenderer.on('pet:play-state', (_e, id, duration) => cb(id, duration)),
  onAnimationHold: (cb) => ipcRenderer.on('pet:anim-hold', (_e, hold) => cb(hold)),
  onChatVisibility: (cb) => ipcRenderer.on('ui:chat-visibility', (_e, visible) => cb(visible)),
  onCustomAnim: (cb) => ipcRenderer.on('pet:custom-anim', (_e, spec) => cb(spec)),
  notifyCustomAnimDone: (id) => ipcRenderer.send('pet:custom-anim-done', id),
  // globaler Cursor ueber alle Monitore (Main pollt screen.getCursorScreenPoint)
  onGlobalCursor: (cb) => ipcRenderer.on('pet:global-cursor', (_e, p) => cb(p)),
  pathForFile: (file) => {
    const { webUtils } = require('electron')
    return webUtils.getPathForFile(file)
  },
  // chat window
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  showChat: () => ipcRenderer.send('ui:show-chat'),
  abortChat: () => ipcRenderer.send('chat:abort'),
  hideChat: () => ipcRenderer.send('ui:hide-chat'),
  onChatEvent: (cb) => ipcRenderer.on('chat:event', (_e, ev) => cb(ev)),
  testProvider: () => ipcRenderer.invoke('chat:test-provider'),
  clearMemory: () => ipcRenderer.invoke('chat:clear-memory'),
  getApiKeyStatus: () => ipcRenderer.invoke('chat:get-api-key-status'),
  setApiKey: (key) => ipcRenderer.invoke('chat:set-api-key', key),
  setHotkey: (combo) => ipcRenderer.invoke('hotkey:set', combo),
  testHotkey: (combo) => ipcRenderer.invoke('hotkey:test', combo),
  setGrantSecrets: (path, allowSecrets) => ipcRenderer.invoke('grants:set-secrets', path, allowSecrets),
  removeGrant: (path) => ipcRenderer.invoke('grants:remove', path),
  // activity recall
  recallGetStatus: () => ipcRenderer.invoke('recall:get-status'),
  recallSetConfig: (partial) => ipcRenderer.invoke('recall:set-config', partial),
  recallShellInstall: () => ipcRenderer.invoke('recall:shell-install'),
  recallShellRemove: () => ipcRenderer.invoke('recall:shell-remove'),
  recallIndexNow: () => ipcRenderer.invoke('recall:index-now'),
  recallPurge: () => ipcRenderer.invoke('recall:purge'),
  recallTogglePause: () => ipcRenderer.invoke('recall:toggle-pause'),
  recallExtensionFolder: () => ipcRenderer.invoke('recall:extension-folder'),
  // about & updates
  getAppSpecs: () => ipcRenderer.invoke('app:get-specs'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  installUpdate: (target) => ipcRenderer.invoke('app:install-update', target),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onUpdateProgress: (cb) => ipcRenderer.on('app:update-progress', (_e, progress) => cb(progress))
})

