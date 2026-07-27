'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * レンダラーに公開する API。nodeIntegration は無効なので、
 * 必要な操作だけをここで明示的に橋渡しする。
 */
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('douga', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    chooseDir: () => ipcRenderer.invoke('settings:chooseDir'),
    chooseBinary: (which) => ipcRenderer.invoke('settings:chooseBinary', which)
  },
  bridge: {
    status: () => ipcRenderer.invoke('bridge:status'),
    unpair: (origin) => ipcRenderer.invoke('bridge:unpair', origin),
    regenerateToken: () => ipcRenderer.invoke('bridge:regenerateToken'),
    onStatus: listen('bridge:status'),
    onPaired: listen('bridge:paired'),
    onCapture: listen('capture:incoming')
  },
  binaries: {
    status: () => ipcRenderer.invoke('binaries:status'),
    install: (which) => ipcRenderer.invoke('binaries:install', which),
    onProgress: listen('binaries:progress')
  },
  postprocess: {
    presets: () => ipcRenderer.invoke('postprocess:presets')
  },
  engine: {
    probe: (payload) => ipcRenderer.invoke('engine:probe', payload),
    cancelProbe: (id) => ipcRenderer.invoke('engine:cancelProbe', id)
  },
  jobs: {
    list: () => ipcRenderer.invoke('job:list'),
    add: (spec) => ipcRenderer.invoke('job:add', spec),
    cancel: (id) => ipcRenderer.invoke('job:cancel', id),
    retry: (id) => ipcRenderer.invoke('job:retry', id),
    remove: (id) => ipcRenderer.invoke('job:remove', id),
    clearFinished: () => ipcRenderer.invoke('job:clearFinished'),
    onUpdate: listen('job:update'),
    onRemoved: listen('job:removed')
  },
  shell: {
    showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
    openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  }
});
