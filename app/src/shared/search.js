'use strict';

/**
 * アドレス欄に入れられた文字を、移動先の URL に変える。
 *
 * 「URL なのか検索語なのか」の判定と、検索 URL の組み立てを分けておく。
 * 画面側に埋め込むと検証できないので、ここに出してある。
 */

/** よく使う検索エンジン。%s が検索語に置き換わる */
const ENGINES = [
  { id: 'google', label: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  { id: 'bing', label: 'Bing', url: 'https://www.bing.com/search?q=%s' }
];

const DEFAULT_SEARCH_URL = ENGINES[0].url;

/**
 * URL として扱うべき文字列か。
 *
 * 「example.com」のような裸のホスト名は URL として扱い、
 * 「動画 保存」のような空白を含むものは検索語として扱う。
 */
function looksLikeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^(about|file|view-source):/i.test(text)) return true;
  // 空白を含むものは検索語。ホスト名に空白は入らない
  if (/\s/.test(text)) return false;
  // 手元のサーバーはドットを含まない
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(text)) return true;
  // ホスト名らしき形（ドットで区切られ、末尾が文字）
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text);
}

/** 検索 URL を組み立てる */
function searchUrlFor(query, template) {
  const base = String(template || '').trim() || DEFAULT_SEARCH_URL;
  const encoded = encodeURIComponent(String(query || ''));
  // %s が無い書き方をされた場合は、末尾に付ける
  return base.includes('%s') ? base.replace(/%s/g, encoded) : base + encoded;
}

/**
 * アドレス欄の入力から移動先を決める。
 * @returns {string|null} 空なら null
 */
function resolveNavigation(raw, template) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(about|file|view-source):/i.test(text)) return text;
  if (looksLikeUrl(text)) return `https://${text}`;
  return searchUrlFor(text, template);
}

module.exports = { ENGINES, DEFAULT_SEARCH_URL, looksLikeUrl, searchUrlFor, resolveNavigation };
