'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const loginBlocks = require('../shared/login-blocks');
const shortcutsShared = require('../shared/shortcuts');
const searchShared = require('../shared/search');

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
    status: (options) => ipcRenderer.invoke('binaries:status', options),
    install: (which) => ipcRenderer.invoke('binaries:install', which),
    onProgress: listen('binaries:progress')
  },
  browse: {
    partition: () => ipcRenderer.invoke('browse:partition'),
    metaScript: () => ipcRenderer.invoke('browse:metaScript'),
    state: (id) => ipcRenderer.invoke('browse:state', id),
    reset: (info) => ipcRenderer.invoke('browse:reset', info),
    setPage: (info) => ipcRenderer.invoke('browse:setPage', info),
    forget: (id) => ipcRenderer.invoke('browse:forget', id),
    visit: (info) => ipcRenderer.invoke('browse:visit', info),
    titleKnown: (info) => ipcRenderer.invoke('browse:titleKnown', info),
    history: (options) => ipcRenderer.invoke('browse:history', options),
    historyRemove: (url) => ipcRenderer.invoke('browse:historyRemove', url),
    historyClear: () => ipcRenderer.invoke('browse:historyClear'),
    bookmarks: () => ipcRenderer.invoke('browse:bookmarks'),
    bookmarkToggle: (info) => ipcRenderer.invoke('browse:bookmarkToggle', info),
    bookmarkRemove: (url) => ipcRenderer.invoke('browse:bookmarkRemove', url),
    isBookmarked: (url) => ipcRenderer.invoke('browse:isBookmarked', url),
    onOpenTab: listen('browse:open-tab'),
    onShortcut: listen('browse:shortcut'),
    // 画面側にフォーカスがあるときは、こちらで判定する
    shortcutFor: (event) => shortcutsShared.fromDom(event),
    cookies: (urls) => ipcRenderer.invoke('browse:cookies', urls),
    clearData: () => ipcRenderer.invoke('browse:clearData'),
    onUpdate: listen('browse:update'),
    onDownload: listen('browse:download'),
    // 埋め込みブラウザからのログインを拒否するサイトか
    loginBlock: (url) => loginBlocks.loginBlock(url),
    // アドレス欄の入力を移動先に変える。URL か検索語かはここで判断する
    resolveNavigation: (raw, template) => searchShared.resolveNavigation(raw, template),
    searchEngines: () => searchShared.ENGINES
  },
  app: {
    restart: () => ipcRenderer.invoke('app:restart'),
    watchClipboard: (enabled) => ipcRenderer.invoke('app:watchClipboard', enabled),
    onClipboardUrl: listen('clipboard:url'),
    openAtLogin: (enabled) => ipcRenderer.invoke('app:openAtLogin', enabled)
  },
  diagnostics: {
    // 観測した通信と判断の理由を書き出す
    export: () => ipcRenderer.invoke('diagnostics:export'),
    preview: () => ipcRenderer.invoke('diagnostics:preview'),
    reset: () => ipcRenderer.invoke('diagnostics:reset')
  },
  update: {
    check: (options) => ipcRenderer.invoke('update:check', options),
    apply: () => ipcRenderer.invoke('update:apply'),
    autoApply: () => ipcRenderer.invoke('update:autoApply'),
    restart: () => ipcRenderer.invoke('update:restart'),
    version: () => ipcRenderer.invoke('update:version'),
    openFolder: () => ipcRenderer.invoke('update:openFolder'),
    createShortcut: () => ipcRenderer.invoke('shell:createShortcut'),
    versions: () => ipcRenderer.invoke('update:versions'),
    restore: (name) => ipcRenderer.invoke('update:restore', name),
    patches: () => ipcRenderer.invoke('update:patches'),
    applyPatch: (name) => ipcRenderer.invoke('update:applyPatch', name),
    choosePatchDir: () => ipcRenderer.invoke('update:choosePatchDir')
  },
  postprocess: {
    presets: () => ipcRenderer.invoke('postprocess:presets'),
    // 10 秒だけ処理して、元と処理後を書き出す
    sample: (info) => ipcRenderer.invoke('postprocess:sample', info),
    onSampleProgress: listen('postprocess:sampleProgress')
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
