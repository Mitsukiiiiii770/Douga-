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
  browse: {
    partition: () => ipcRenderer.invoke('browse:partition'),
    metaScript: () => ipcRenderer.invoke('browse:metaScript'),
    state: () => ipcRenderer.invoke('browse:state'),
    reset: (url) => ipcRenderer.invoke('browse:reset', url),
    setPage: (info) => ipcRenderer.invoke('browse:setPage', info),
    cookies: (urls) => ipcRenderer.invoke('browse:cookies', urls),
    clearData: () => ipcRenderer.invoke('browse:clearData'),
    onUpdate: listen('browse:update')
  },
  diagnostics: {
    // 観測した通信と判断の理由を書き出す
    export: () => ipcRenderer.invoke('diagnostics:export'),
    preview: () => ipcRenderer.invoke('diagnostics:preview'),
    reset: () => ipcRenderer.invoke('diagnostics:reset')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    apply: () => ipcRenderer.invoke('update:apply'),
    restart: () => ipcRenderer.invoke('update:restart'),
    version: () => ipcRenderer.invoke('update:version'),
    createShortcut: () => ipcRenderer.invoke('shell:createShortcut'),
    versions: () => ipcRenderer.invoke('update:versions'),
    restore: (name) => ipcRenderer.invoke('update:restore', name),
    patches: () => ipcRenderer.invoke('update:patches'),
    applyPatch: (name) => ipcRenderer.invoke('update:applyPatch', name),
    choosePatchDir: () => ipcRenderer.invoke('update:choosePatchDir')
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
    resumeInterrupted: () => ipcRenderer.invoke('job:resumeInterrupted'),
    onUpdate: listen('job:update'),
    onRemoved: listen('job:removed')
  },
  shell: {
    showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
    openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  }
});
