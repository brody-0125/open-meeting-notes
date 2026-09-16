const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureTest', {
  start: () => ipcRenderer.invoke('start'),
  append: chunk => ipcRenderer.invoke('append', chunk),
  stop: cutoffs => ipcRenderer.invoke('stop', cutoffs),
  pause: record => ipcRenderer.invoke('pause', record),
  resume: record => ipcRenderer.invoke('resume', record),
  abort: reason => ipcRenderer.invoke('abort', reason),
  finish: () => ipcRenderer.invoke('finish')
});
