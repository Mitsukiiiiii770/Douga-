'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULTS = {
  downloadDir: '',
  ytdlpPath: '',
  ffmpegPath: '',
  maxConcurrent: 2,
  concurrentFragments: 5,
  bridgePort: 47615,
  bridgeEnabled: true,
  token: '',
  pairedClients: [],
  // mp4 に収まらないコーデックのときだけ mkv へ落とす（再エンコードなし）
  container: 'mp4/mkv',
  qualityPreset: 'max',
  maxHeight: 0,
  acceptCookies: true,
  extraArgs: '',
  // ダウンロード後の高画質化。既定は無効（再エンコードに時間がかかるため）
  postProcess: 'none',
  postProcessCustom: '',
  postEncoder: 'x264',
  postCrf: 18,
  postFrameRate: 30,
  realesrganPath: '',
  // 起動時に更新を確認する。既定は有効（手で ZIP を落とす手間を無くすのが目的のため）
  autoUpdateCheck: true,
  // 更新が見つかったら、確認を待たずに適用する（反映は再起動時）
  autoUpdateApply: true,
  // 非公開リポジトリから更新を取るときだけ必要。空なら送らない
  githubToken: '',
  // GitHub を経由せず、手元のフォルダに置いたパッチから更新する場合の置き場
  patchDir: '',
  // 更新前の状態を何世代残すか
  keepVersions: 3,
  // PC の起動時にアプリを開く
  openAtLogin: false,
  // アプリ内ブラウザで一度に開けるタブの数
  maxBrowseTabs: 5,
  // アプリ内ブラウザを開いたときに表示するページ
  browseHomePage: 'https://www.google.com'
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
  if (!cache.downloadDir) cache.downloadDir = app.getPath('downloads');
  if (!cache.token) {
    cache.token = crypto.randomBytes(24).toString('hex');
    save();
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('設定の保存に失敗:', err);
  }
}

function get() {
  return { ...load() };
}

function set(patch) {
  load();
  Object.assign(cache, patch);
  save();
  return get();
}

module.exports = { get, set, DEFAULTS };
