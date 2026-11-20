'use strict';

/**
 * アプリ内ブラウザの履歴とブックマーク。
 *
 * 置き場所は userData。アプリのソースとは別の場所なので、
 * 更新でソースを入れ替えても消えない。
 *
 * 履歴は放っておくと際限なく増えるので上限を決め、古いものから捨てる。
 * ブックマークは利用者が明示的に足したものなので、勝手には消さない。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** 覚えておく履歴の上限 */
const MAX_HISTORY = 2000;

/** 書き出しをまとめる間隔。1 ページ見るたびに書くと重い */
const SAVE_DELAY_MS = 1500;

let storePath = null;
let data = null;
let timer = null;

function file() {
  if (!storePath) storePath = path.join(app.getPath('userData'), 'browse-data.json');
  return storePath;
}

/** テスト用。保存先を差し替える */
function useFile(target) {
  storePath = target;
  data = null;
  return storePath;
}

function load() {
  if (data) return data;
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    data = {
      history: Array.isArray(parsed.history) ? parsed.history : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []
    };
  } catch {
    data = { history: [], bookmarks: [] };
  }
  return data;
}

function saveNow() {
  if (!data) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(data), 'utf8');
  } catch {
    /* 書けなくても、その回の履歴が残らないだけ */
  }
}

function saveLater() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    saveNow();
  }, SAVE_DELAY_MS);
  if (timer.unref) timer.unref();
}

/* ---------------- 履歴 ---------------- */

/** 記録しても意味のない場所 */
function skip(url) {
  return !url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('chrome-');
}

function addHistory({ url, title = '' } = {}) {
  if (skip(url)) return null;
  const store = load();

  // 同じページを続けて開いたら、最後の 1 件を更新するだけにする。
  // 再読み込みや画面内の移動で同じ URL が並ぶのを防ぐ
  const last = store.history[0];
  if (last && last.url === url) {
    if (title) last.title = title;
    last.at = Date.now();
    saveLater();
    return last;
  }

  const entry = { url, title: title || '', at: Date.now() };
  store.history.unshift(entry);
  if (store.history.length > MAX_HISTORY) store.history.length = MAX_HISTORY;
  saveLater();
  return entry;
}

/** 題が後から分かることがあるので、最新の 1 件に書き戻す */
function updateTitle(url, title) {
  if (!title || skip(url)) return;
  const store = load();
  const hit = store.history.find((item) => item.url === url);
  if (hit && hit.title !== title) {
    hit.title = title;
    saveLater();
  }
}

/**
 * @param {{query?: string, limit?: number}} [options]
 */
function history({ query = '', limit = 200 } = {}) {
  const store = load();
  const needle = String(query || '').trim().toLowerCase();
  const list = needle
    ? store.history.filter(
        (item) =>
          item.url.toLowerCase().includes(needle) ||
          (item.title || '').toLowerCase().includes(needle)
      )
    : store.history;
  return list.slice(0, Math.max(1, limit));
}

function removeHistory(url) {
  const store = load();
  const before = store.history.length;
  store.history = store.history.filter((item) => item.url !== url);
  if (store.history.length !== before) saveNow();
  return before - store.history.length;
}

function clearHistory() {
  const store = load();
  const count = store.history.length;
  store.history = [];
  saveNow();
  return count;
}

/* ---------------- ブックマーク ---------------- */

function bookmarks() {
  return [...load().bookmarks];
}

function isBookmarked(url) {
  return load().bookmarks.some((item) => item.url === url);
}

function addBookmark({ url, title = '' } = {}) {
  if (skip(url)) return null;
  const store = load();
  const existing = store.bookmarks.find((item) => item.url === url);
  if (existing) {
    if (title) existing.title = title;
    saveNow();
    return existing;
  }
  const entry = { url, title: title || url, at: Date.now() };
  store.bookmarks.unshift(entry);
  saveNow();
  return entry;
}

function removeBookmark(url) {
  const store = load();
  const before = store.bookmarks.length;
  store.bookmarks = store.bookmarks.filter((item) => item.url !== url);
  if (store.bookmarks.length !== before) saveNow();
  return before !== store.bookmarks.length;
}

/** 開いているページを登録・解除する。@returns 登録後の状態 */
function toggleBookmark({ url, title = '' } = {}) {
  if (skip(url)) return false;
  if (isBookmarked(url)) {
    removeBookmark(url);
    return false;
  }
  addBookmark({ url, title });
  return true;
}

module.exports = {
  addHistory,
  updateTitle,
  history,
  removeHistory,
  clearHistory,
  bookmarks,
  isBookmarked,
  addBookmark,
  removeBookmark,
  toggleBookmark,
  saveNow,
  useFile,
  MAX_HISTORY
};
