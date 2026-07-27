'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * 拡張機能から受け取った chrome.cookies 形式の配列を
 * Netscape cookie file に変換して一時保存する。yt-dlp の --cookies に渡す。
 *
 * 認証情報そのものなので、ユーザーデータ配下の専用ディレクトリに
 * 0600 で書き、アプリ終了時にまとめて削除する。
 */
function jarDir() {
  return path.join(app.getPath('userData'), 'cookiejars');
}

function toNetscape(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Douga が拡張機能から受け取った Cookie を一時的に書き出したものです。',
    ''
  ];
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const domain = c.domain || '';
    if (!domain) continue;
    // hostOnly の Cookie はサブドメインに送らない = 先頭ドットなし
    const includeSubdomains = c.hostOnly ? 'FALSE' : 'TRUE';
    const normalizedDomain = c.hostOnly ? domain.replace(/^\./, '') : domain.startsWith('.') ? domain : '.' + domain;
    const expiry = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate);
    lines.push(
      [
        normalizedDomain,
        includeSubdomains,
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        String(expiry),
        c.name,
        c.value == null ? '' : String(c.value)
      ].join('\t')
    );
  }
  return lines.join('\n') + '\n';
}

function write(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  const dir = jarDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, crypto.randomBytes(12).toString('hex') + '.txt');
  fs.writeFileSync(file, toNetscape(cookies), { mode: 0o600 });
  return file;
}

function remove(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch { /* 削除失敗は無視 */ }
}

function clearAll() {
  try {
    fs.rmSync(jarDir(), { recursive: true, force: true });
  } catch { /* 削除失敗は無視 */ }
}

module.exports = { write, remove, clearAll, toNetscape };
