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
  quit: () => ipcRenderer.send('pet:quit')
})
