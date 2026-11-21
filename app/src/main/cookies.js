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

/**
 * 指定 URL に送るべき Cookie を選び、ヘッダ用の文字列にする。
 * ffmpeg のように Netscape ファイルを読めない相手へ渡すときに使う。
 */
function headerFor(url, cookieList) {
  if (!Array.isArray(cookieList) || cookieList.length === 0) return null;
  let target;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const host = target.hostname;
  const now = Date.now() / 1000;

  const matched = cookieList.filter((cookie) => {
    if (!cookie || !cookie.name) return false;
    if (cookie.expirationDate && cookie.expirationDate < now) return false;
    if (cookie.secure && target.protocol !== 'https:') return false;

    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!domain) return false;
    const domainOk = cookie.hostOnly
      ? host === domain
      : host === domain || host.endsWith('.' + domain);
    if (!domainOk) return false;

    const cookiePath = cookie.path || '/';
    return (
      target.pathname === cookiePath ||
      target.pathname.startsWith(cookiePath.replace(/\/$/, '') + '/')
    );
  });

  return matched.length ? matched.map((c) => `${c.name}=${c.value}`).join('; ') : null;
}

/**
 * その Cookie を使ってよいか。
 *
 * 「Cookie を受け取る」設定は、外部のブラウザ拡張機能が localhost 経由で
 * 送ってくるものを許すかどうかの話。アプリ内ブラウザでログインした分は
 * 利用者自身がこのアプリの中で入れたものなので、同じ扱いにすると
 * 「ログインしたのに取得できない」という理由の分からない失敗になる。
 *
 * @param {{cookieSource?: string, acceptCookies?: boolean}} input
 */
function shouldUse({ cookieSource, acceptCookies } = {}) {
  if (cookieSource === 'browser') return true;
  return !!acceptCookies;
}

module.exports = { write, remove, clearAll, toNetscape, headerFor, shouldUse };
