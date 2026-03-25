const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getCurrentFolder: () => ipcRenderer.invoke('get-current-folder'),
  setUploadDir: (dir) => ipcRenderer.invoke('set-upload-dir', dir),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSetting: (key, value) => ipcRenderer.invoke('update-setting', key, value),
  openFolder: () => ipcRenderer.invoke('open-folder')
});
