const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('managerHost', Object.freeze({ kind: 'desktop', transport: 'not-configured' }));
