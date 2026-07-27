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
  container: 'mp4',
  acceptCookies: true
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
