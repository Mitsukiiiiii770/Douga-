'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const settings = require('./settings');
const binaries = require('./binaries');
const engine = require('./engine');
const queue = require('./queue');
const bridge = require('./bridge');
const cookies = require('./cookies');
const postprocess = require('./postprocess');
const browse = require('./browse');
const diagnostics = require('./diagnostics');
const pageMetaScript = require('../shared/page-meta-script');

let mainWindow = null;
/** 解析中のリクエストを id で中断できるようにする */
const probeControllers = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#14161c',
    title: 'Douga',
    // 開発中（npm start）でもタスクバーにアイコンを出す。
    // インストーラ経由の場合は exe 側のアイコンが使われる
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // アプリ内ブラウザ用。拡張機能なしで配信 URL を拾うために必要
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 外部リンクは既定のブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function focusWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------------- 単一インスタンス ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);
}

/* ---------------- ブリッジ ---------------- */

bridge.onPairRequest = async (origin, name) => {
  focusWindow();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['許可', '拒否'],
    defaultId: 0,
    cancelId: 1,
    title: 'ブラウザ拡張機能からの接続',
    message: 'ブラウザ拡張機能が Douga への接続を求めています。',
    detail: `拡張機能: ${name}\n識別子: ${origin}\n\n心当たりがない場合は「拒否」を選んでください。`,
    noLink: true
  });
  return response === 0;
};

bridge.on('capture', (capture) => {
  diagnostics.capture({ ...capture, source: '拡張機能' });
  focusWindow();
  send('capture:incoming', capture);
});

bridge.on('status', (status) => send('bridge:status', status));
bridge.on('paired', (client) => send('bridge:paired', client));

/* ---------------- キュー ---------------- */

queue.on('update', (job) => send('job:update', job));
queue.on('removed', (id) => send('job:removed', id));

/* ---------------- IPC ---------------- */

ipcMain.handle('settings:get', () => settings.get());

ipcMain.handle('settings:set', async (_event, patch) => {
  const before = settings.get();
  const after = settings.set(patch || {});
  if (before.bridgePort !== after.bridgePort || before.bridgeEnabled !== after.bridgeEnabled) {
    if (after.bridgeEnabled) await bridge.start();
    else bridge.stop();
    send('bridge:status', bridge.status());
  }
  return after;
});

ipcMain.handle('settings:chooseDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.get().downloadDir
  });
  if (result.canceled || !result.filePaths.length) return null;
  settings.set({ downloadDir: result.filePaths[0] });
  return result.filePaths[0];
});

const BINARY_SETTING_KEYS = {
  ffmpeg: 'ffmpegPath',
  ytdlp: 'ytdlpPath',
  realesrgan: 'realesrganPath'
};

ipcMain.handle('settings:chooseBinary', async (_event, which) => {
  const titles = {
    ffmpeg: 'ffmpeg の実行ファイルを選択',
    ytdlp: 'yt-dlp の実行ファイルを選択',
    realesrgan: 'Real-ESRGAN の実行ファイルを選択'
  };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: titles[which] || '実行ファイルを選択'
  });
  if (result.canceled || !result.filePaths.length) return null;
  const chosen = result.filePaths[0];
  const key = BINARY_SETTING_KEYS[which];
  if (key) settings.set({ [key]: chosen });
  return chosen;
});

ipcMain.handle('bridge:status', () => bridge.status());

ipcMain.handle('bridge:unpair', (_event, origin) => {
  const cfg = settings.get();
  settings.set({ pairedClients: cfg.pairedClients.filter((c) => c.origin !== origin) });
  return bridge.status();
});

ipcMain.handle('bridge:regenerateToken', async () => {
  const crypto = require('crypto');
  settings.set({ token: crypto.randomBytes(24).toString('hex'), pairedClients: [] });
  return bridge.status();
});

ipcMain.handle('browse:partition', () => browse.partition());
ipcMain.handle('browse:metaScript', () => pageMetaScript.SOURCE);
ipcMain.handle('browse:state', () => browse.state());
ipcMain.handle('browse:reset', (_event, url) => {
  browse.reset(url || '');
  return browse.state();
});
ipcMain.handle('browse:setPage', (_event, { url, title }) => {
  browse.setPage(url, title);
  return browse.state();
});
ipcMain.handle('browse:cookies', (_event, urls) => browse.cookiesFor(urls || []));
ipcMain.handle('browse:clearData', () => browse.clearData());

/* ---------------- 検出ログ ---------------- */

/**
 * 観測した通信と判断の理由をファイルに書き出す。
 *
 * 手元で再現できない取りこぼしを直すには、実際に何が流れていたかを
 * 見る必要がある。推測で直すより、このファイルを 1 回見たほうが早い。
 */
ipcMain.handle('diagnostics:export', async () => {
  const bin = await binaries.status();
  const text = diagnostics.report(diagnostics.snapshot(), {
    app: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.arch}`,
    ytdlp: (bin.ytdlp && bin.ytdlp.version) || (bin.ytdlp && bin.ytdlp.path) || '不明',
    ffmpeg: (bin.ffmpeg && bin.ffmpeg.version) || (bin.ffmpeg && bin.ffmpeg.path) || '不明'
  });

  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const name =
    `douga-検出ログ-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}.txt`;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '検出ログを書き出す',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: 'テキスト', extensions: ['txt'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  await require('fs').promises.writeFile(result.filePath, text, 'utf8');
  return { ok: true, path: result.filePath, bytes: Buffer.byteLength(text, 'utf8') };
});

ipcMain.handle('diagnostics:preview', () => diagnostics.report());

ipcMain.handle('diagnostics:reset', () => {
  diagnostics.reset();
  return true;
});

ipcMain.handle('binaries:status', () => binaries.status());

ipcMain.handle('postprocess:presets', () => postprocess.presetList());

ipcMain.handle('binaries:install', async (_event, which) => {
  const onProgress = (p) => send('binaries:progress', p);
  // 未知の値で黙って yt-dlp を入れてしまわないよう、明示的に振り分ける
  const installers = {
    ffmpeg: binaries.installFfmpeg,
    ytdlp: binaries.installYtdlp
  };
  const install = installers[which];
  if (!install) throw new Error(`自動インストールに対応していません: ${which}`);
  await install(onProgress);
  return binaries.status();
});

ipcMain.handle(
  'engine:probe',
  async (_event, { id, url, headers, cookies: cookieList, candidates, meta }) => {
    const controller = new AbortController();
    if (id) probeControllers.set(id, controller);
    const cookieFile = settings.get().acceptCookies ? cookies.write(cookieList) : null;
    try {
      // ページ URL がだめでも、拡張機能が検出したストリームへ自動で落ちる
      const { info, usedUrl, attempts } = await engine.probeChain(url, candidates, {
        headers,
        cookieFile,
        // ページから読み取ったタイトル等。yt-dlp が取れなかった分だけ補う
        meta,
        signal: controller.signal
      });
      // 後続のダウンロードでも同じ Cookie を使えるようにパスを返す
      // HLS を ffmpeg で取る場合、Cookie はファイルではなくヘッダで渡す
      if (info && info.source === 'hls') {
        info.cookieHeader = cookies.headerFor(usedUrl, cookieList);
      }
      diagnostics.probe({
        target: url,
        ok: true,
        attempts,
        formats: info && Array.isArray(info.formats) ? info.formats.length : null,
        title: (info && info.title) || ''
      });
      return { ok: true, info, cookieFile, usedUrl, attempts };
    } catch (err) {
      cookies.remove(cookieFile);
      diagnostics.probe({
        target: url,
        ok: false,
        error: err.message,
        attempts: err.attempts || []
      });
      return {
        ok: false,
        error: err.message,
        detail: err.detail || null,
        attempts: err.attempts || []
      };
    } finally {
      if (id) probeControllers.delete(id);
    }
  }
);

ipcMain.handle('engine:cancelProbe', (_event, id) => {
  const controller = probeControllers.get(id);
  if (controller) controller.abort();
  return true;
});

ipcMain.handle('job:list', () => queue.list());
ipcMain.handle('job:add', (_event, spec) => queue.add(spec));
ipcMain.handle('job:cancel', (_event, id) => queue.cancel(id));
ipcMain.handle('job:retry', (_event, id) => queue.retry(id));
ipcMain.handle('job:remove', (_event, id) => queue.remove(id));
ipcMain.handle('job:clearFinished', () => {
  queue.clearFinished();
  return queue.list();
});
ipcMain.handle('job:resumeInterrupted', () => queue.resumeInterrupted());

ipcMain.handle('shell:showItem', (_event, filePath) => {
  if (!filePath) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('shell:openPath', async (_event, target) => {
  if (!target) return false;
  const error = await shell.openPath(target);
  return !error;
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (!/^https?:\/\//i.test(url || '')) return false;
  await shell.openExternal(url);
  return true;
});

/* ---------------- ライフサイクル ---------------- */

app.whenReady().then(async () => {
  cookies.clearAll();
  // アプリ内ブラウザの監視を始める（拡張機能なしで動かすための経路）
  browse.attach();
  // 前回のキューを読み込む（実行中だったものは「中断」になる）
  queue.restore();
  createWindow();
  await bridge.start();
  send('bridge:status', bridge.status());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  bridge.stop();
  // 遅延書き込みが残っていると終了時に失われるので、確実に吐き出す
  queue.saveNow();
  cookies.clearAll();
});
