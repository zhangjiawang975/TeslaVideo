const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickOutDir: () => ipcRenderer.invoke('pick-out-dir'),
  scan: root => ipcRenderer.invoke('scan', root),
  detect: () => ipcRenderer.invoke('detect'),
  probe: files => ipcRenderer.invoke('probe', files),
  exportClip: opts => ipcRenderer.invoke('export', opts),
  telemetry: file => ipcRenderer.invoke('telemetry', file),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  showItem: p => ipcRenderer.invoke('show-item', p),
  pathForFile: file => webUtils.getPathForFile(file),
  onExportProgress: cb => ipcRenderer.on('export-progress', (_, v) => cb(v)),
})
