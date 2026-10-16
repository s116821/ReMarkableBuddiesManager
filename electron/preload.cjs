const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('managerHost', Object.freeze({ contract_version: 1, kind: 'desktop', transport: 'wired-maintenance',
  driveAuth: Object.freeze({ status: () => ipcRenderer.invoke('manager:drive:status'), begin: () => ipcRenderer.invoke('manager:drive:begin'),
    cancel: () => ipcRenderer.invoke('manager:drive:cancel'), check: () => ipcRenderer.invoke('manager:drive:check'),
    disconnect: () => ipcRenderer.invoke('manager:drive:disconnect'), revoke: id => ipcRenderer.invoke('manager:drive:revoke', id) }),
  personalization: request => ipcRenderer.invoke('manager:personalization', request),
  inspectOwned: () => ipcRenderer.invoke('manager:inspectOwned'),
  observe: () => ipcRenderer.invoke('manager:observe'), cancel: () => ipcRenderer.invoke('manager:cancel') }));
