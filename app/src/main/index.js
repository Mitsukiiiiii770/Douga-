'use strict';

const fs = require('fs');
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
const browseStore = require('./browse-store');
const shortcuts = require('../shared/shortcuts');
const adblock = require('../shared/adblock');
const diagnostics = require('./diagnostics');
const update = require('./update');
const pageMetaScript = require('../shared/page-meta-script');

let mainWindow = null;
/** 解析中のリクエストを id で中断できるようにする */
const probeControllers = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    // 用意ができるまで出さない。先に出すと白い画面が一瞬見える
    show: false,
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部リンクは既定のブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // アプリ内ブラウザの中で「新しいタブで開く」リンクを踏んだとき。
  // 既定のブラウザへ投げてしまうと、ログイン状態も監視も引き継げない
  mainWindow.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // ポップアンダー広告は script が勝手に開くもの。
      // 利用者がリンクを押したもの（中クリック等）だけ新しいタブにする。
      // ここを素通しにすると、広告を自分でタブとして開いてしまう
      const cfg = settings.get();
      const allowed = adblock.allowWindow(
        { url, disposition },
        { enabled: cfg.blockAds !== false, extra: adblock.parseExtra(cfg.adBlockExtra) }
      );
      if (allowed) send('browse:open-tab', url);
      return { action: 'deny' };
    });

    // ページの中にフォーカスがあると、画面側の keydown には届かない。
    // タブ操作のキーだけここで拾って画面へ回す
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const action = shortcuts.fromElectron(input);
      if (!action) return;
      event.preventDefault();
      send('browse:shortcut', action);
    });
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
  realesrgan: 'realesrganPath',
  aria2c: 'aria2cPath'
};

ipcMain.handle('settings:chooseBinary', async (_event, which) => {
  const titles = {
    ffmpeg: 'ffmpeg の実行ファイルを選択',
    ytdlp: 'yt-dlp の実行ファイルを選択',
    realesrgan: 'Real-ESRGAN の実行ファイルを選択',
    aria2c: 'aria2c の実行ファイルを選択'
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
ipcMain.handle('browse:state', (_event, id) => browse.state(id));
ipcMain.handle('browse:forget', (_event, id) => {
  browse.forget(id);
  return true;
});
ipcMain.handle('browse:reset', (_event, { id, url } = {}) => {
  browse.reset(id, url || '');
  return browse.state(id);
});
ipcMain.handle('browse:setPage', (_event, { id, url, title } = {}) => {
  browse.setPage(id, url, title);
  return browse.state(id);
});
ipcMain.handle('browse:cookies', (_event, urls) => browse.cookiesFor(urls || []));
ipcMain.handle('browse:clearData', () => browse.clearData());

/* ---------------- 履歴とブックマーク ---------------- */

ipcMain.handle('browse:visit', (_event, { url, title } = {}) => {
  browseStore.addHistory({ url, title });
  return true;
});
ipcMain.handle('browse:titleKnown', (_event, { url, title } = {}) => {
  browseStore.updateTitle(url, title);
  return true;
});
ipcMain.handle('browse:history', (_event, options) => browseStore.history(options || {}));
ipcMain.handle('browse:historyRemove', (_event, url) => browseStore.removeHistory(url));
ipcMain.handle('browse:historyClear', () => browseStore.clearHistory());
ipcMain.handle('browse:bookmarks', () => browseStore.bookmarks());
ipcMain.handle('browse:bookmarkToggle', (_event, info) => browseStore.toggleBookmark(info || {}));
ipcMain.handle('browse:bookmarkRemove', (_event, url) => browseStore.removeBookmark(url));
ipcMain.handle('browse:isBookmarked', (_event, url) => browseStore.isBookmarked(url));

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

/* ---------------- 自動更新 ---------------- */

/**
 * 確認のときに落としたソースを覚えておく。
 * 更新を実行するときに、同じものをもう一度落とさずに済ませるため。
 */
let pendingUpdate = null;

ipcMain.handle('update:check', async (_event, options = {}) => {
  try {
    const result = await update.check({ auto: !!options.auto });
    // 回数制限中や、直前に確認済みの場合は問い合わせ自体を省く
    if (result.skipped) return { ok: true, skipped: true, reason: result.reason };
    pendingUpdate = result.upToDate ? null : { version: result.latest, tree: result.tree };
    return {
      ok: true,
      upToDate: result.upToDate,
      current: result.current,
      latest: { sha: result.latest.sha, message: result.latest.message, date: result.latest.date },
      changes: result.changes
        ? {
            changed: result.changes.changed,
            added: result.changes.added,
            removed: result.changes.removed
          }
        : null,
      depsChanged: !!result.depsChanged
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 起動時の自動更新。
 *
 * 手で展開したフォルダには版の記録が無いため、開くたびに「不明」となり、
 * そのつど自分で更新を当てる必要があった。同じ場所から開くだけで
 * 最新になっているのが期待される動きなので、見つけたら当てる。
 *
 * ただし勝手に再起動はしない。作業中に画面が消えるほうが困るため、
 * 反映は利用者が再起動を押したときにする。
 */
ipcMain.handle('update:autoApply', async () => {
  const cfg = settings.get();
  if (!cfg.autoUpdateCheck || !cfg.autoUpdateApply) return { ok: true, skipped: true };

  // ダウンロード中にソースを入れ替えない。動いている処理の足元を崩さないため
  const busy = queue.list().some((job) => queue.ACTIVE_STATUSES.includes(job.status));
  if (busy) return { ok: true, skipped: true, reason: 'busy' };

  try {
    const found = await update.check({ auto: true });
    if (found.skipped || found.upToDate) return { ok: true, skipped: true };

    const result = await update.apply({
      tree: found.tree,
      version: found.latest,
      keep: cfg.keepVersions
    });
    return { ok: true, applied: true, ...result };
  } catch (err) {
    // 更新できなくても、アプリ自体は使える
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:apply', async () => {
  try {
    const tree = pendingUpdate ? pendingUpdate.tree : null;
    const version = pendingUpdate ? pendingUpdate.version : null;
    const result = await update.apply({ tree, version, keep: settings.get().keepVersions });
    pendingUpdate = null;
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * PC の起動時にアプリを開く設定。
 *
 * npm start で動かしている場合、実行ファイルは electron 本体なので、
 * アプリの場所を引数で渡さないと「Electron の既定アプリ」が開いてしまう。
 */
function applyLoginItem(enabled) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname, '..', '..')]
    });
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('app:openAtLogin', (_event, enabled) => {
  settings.set({ openAtLogin: !!enabled });
  return applyLoginItem(enabled);
});

ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.exit(0);
  return true;
});

ipcMain.handle('update:restart', () => {
  // 実行中のダウンロードがあれば、再開できる形で止めてから落とす
  app.relaunch();
  app.exit(0);
  return true;
});

/**
 * デスクトップにショートカットを作る。
 *
 * ランチャー（Douga起動.bat）は npm 経由で起動するため、黒いコンソール窓が
 * 残り続ける。Electron 本体は GUI アプリなので、直接起動すれば窓は出ない。
 * その「直接起動する」ショートカットをここで作る。
 */
ipcMain.handle('shell:createShortcut', async () => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'この機能は Windows 専用です' };
  }
  try {
    // 起動のされ方で app.getAppPath() が app か、その親かに変わる。
    // アイコンは自分の居場所から数えたほうが確実
    const appDir = path.resolve(__dirname, '..', '..');
    const iconPath = path.join(appDir, 'build', 'icon.ico');
    const target = path.join(app.getPath('desktop'), 'Douga.lnk');

    const created = shell.writeShortcutLink(target, 'create', {
      // 開発用に npm start で動かしている場合、execPath は electron 本体を指す。
      // その場合だけアプリの場所を引数で渡す必要がある
      target: process.execPath,
      // 空白を含む場所に置かれていても 1 つの引数として渡るよう囲む
      args: app.isPackaged ? '' : `"${appDir}"`,
      cwd: appDir,
      icon: fs.existsSync(iconPath) ? iconPath : process.execPath,
      iconIndex: 0,
      description: 'Douga - 動画抽出・ダウンローダー'
    });

    if (!created) return { ok: false, error: 'ショートカットを作成できませんでした' };
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------------- 過去の版とパッチ ---------------- */

ipcMain.handle('update:versions', () => update.listVersions());

ipcMain.handle('update:restore', async (_event, name) => {
  try {
    return { ok: true, ...update.restoreVersion(name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:patches', () => {
  const dir = settings.get().patchDir;
  if (!dir) return { ok: true, dir: '', patches: [] };
  return { ok: true, dir, patches: update.listPatches(dir) };
});

ipcMain.handle('update:applyPatch', async (_event, name) => {
  try {
    const cfg = settings.get();
    if (!cfg.patchDir) return { ok: false, error: 'パッチ置き場が設定されていません' };
    return { ok: true, ...update.applyPatch(cfg.patchDir, name, { keep: cfg.keepVersions }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:choosePatchDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'パッチ置き場を選ぶ',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  settings.set({ patchDir: result.filePaths[0] });
  return result.filePaths[0];
});

ipcMain.handle('update:version', () => ({
  app: app.getVersion(),
  commit: update.localCommit(),
  branch: update.BRANCH,
  // どのフォルダを動かしているか。コピーが複数あると、
  // 更新したつもりの版と動かしている版が食い違う
  root: update.rootDir()
}));

ipcMain.handle('update:openFolder', async () => {
  await shell.openPath(update.rootDir());
  return true;
});

ipcMain.handle('diagnostics:reset', () => {
  diagnostics.reset();
  return true;
});

ipcMain.handle('binaries:status', (_event, options = {}) => binaries.status(options));

ipcMain.handle('postprocess:presets', () => postprocess.presetList());

/**
 * 10 秒だけ処理して、元と処理後を書き出す。
 *
 * 高画質化は動画の長さによっては数時間かかる。効果があるか
 * 分からないまま待つのは無駄なので、先に短く試せるようにする。
 */
ipcMain.handle('postprocess:sample', async (_event, { filePath, duration } = {}) => {
  try {
    const result = await postprocess.sample(filePath, {
      duration,
      onProgress: (p) => send('postprocess:sampleProgress', p)
    });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('binaries:install', async (_event, which) => {
  const onProgress = (p) => send('binaries:progress', p);
  // 未知の値で黙って yt-dlp を入れてしまわないよう、明示的に振り分ける
  const installers = {
    ffmpeg: binaries.installFfmpeg,
    ytdlp: binaries.installYtdlp,
    aria2c: binaries.installAria2c
  };
  const install = installers[which];
  if (!install) throw new Error(`自動インストールに対応していません: ${which}`);
  await install(onProgress);
  return binaries.status();
});

ipcMain.handle(
  'engine:probe',
  async (_event, { id, url, headers, cookies: cookieList, cookieSource, candidates, meta }) => {
    const controller = new AbortController();
    if (id) probeControllers.set(id, controller);

    const trusted = cookies.shouldUse({
      cookieSource,
      acceptCookies: settings.get().acceptCookies
    });
    const cookieFile = trusted ? cookies.write(cookieList) : null;
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
      if (info && info.source === 'hls' && trusted) {
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
  // Windows がこのアプリを 1 つのものとして扱うために要る。
  // これが無いとタスクバーへの固定が electron.exe として扱われ、
  // 固定したアイコンから起動できないことがある
  if (process.platform === 'win32') app.setAppUserModelId('com.douga.app');

  // アプリ内ブラウザの監視を始める（拡張機能なしで動かすための経路）
  browse.attach();
  // 前回のキューを読み込む（実行中だったものは「中断」になる）
  queue.restore();
  createWindow();

  // ここから先は画面が出てからでよい。起動を待たせない
  setImmediate(async () => {
    cookies.clearAll();
    try {
      await bridge.start();
      send('bridge:status', bridge.status());
    } catch {
      /* 連携が始まらなくても、アプリ単体では使える */
    }
    applyLoginItem(settings.get().openAtLogin);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  bridge.stop();
  // 遅延書き込みが残っていると履歴が失われる
  browseStore.saveNow();
  // 遅延書き込みが残っていると終了時に失われるので、確実に吐き出す
  queue.saveNow();
  cookies.clearAll();
});
