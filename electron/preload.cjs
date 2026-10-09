const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('managerHost', Object.freeze({ contract_version: 1, kind: 'desktop', transport: 'wired-read-only',
  observe: () => ipcRenderer.invoke('manager:observe'), cancel: () => ipcRenderer.invoke('manager:cancel') }));
