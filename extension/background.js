'use strict';

/**
 * タブごとに「動画っぽい」ネットワークリクエストを収集する service worker。
 *
 * MV3 の service worker はいつでも停止しうるので、収集結果は
 * chrome.storage.session にも書き戻して復帰できるようにしている。
 */

importScripts('site-hints.js');
const hints = self.DougaSiteHints;

const MANIFEST_RE = /\.(m3u8|m3u|mpd|f4m|ism(?:\/manifest)?)(\?|$)/i;
const MEDIA_FILE_RE =
  /\.(mp4|webm|mkv|mov|m4v|flv|avi|ogv|ogg|mpg|mpeg|3gp|wmv|asf|f4v|divx|m2ts|mts|vob|rm|rmvb|m4a|mp3|aac|opus|wav|flac|wma)(\?|$)/i;
const SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa|dash|seg)(\?|$)/i;
const MEDIA_MIME_RE =
  /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|f4m|vnd\.ms-sstr\+xml))/i;

/** 小さすぎるファイルはスプライトやプレビューのことが多い */
const MIN_FILE_SIZE = 50 * 1024;

const MAX_PER_TAB = 60;

/** @type {Map<number, {candidates: Map<string, object>, segments: number, headers: object, pageUrl: string, pageTitle: string}>} */
const tabs = new Map();

function stateFor(tabId) {
  let entry = tabs.get(tabId);
  if (!entry) {
    entry = { candidates: new Map(), segments: 0, headers: {}, pageUrl: '', pageTitle: '' };
    tabs.set(tabId, entry);
  }
  return entry;
}

function persist(tabId) {
  const entry = tabs.get(tabId);
  if (!entry) return;
  chrome.storage.session
    .set({
      [`tab_${tabId}`]: {
        candidates: [...entry.candidates.values()],
        segments: entry.segments,
        headers: entry.headers,
        pageUrl: entry.pageUrl,
        pageTitle: entry.pageTitle,
        usesMediaSource: !!entry.usesMediaSource,
        pageTarget: entry.pageTarget || '',
        meta: entry.meta || null
      }
    })
    .catch(() => { /* セッションストレージ未対応時は無視 */ });
}

async function restore(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  const stored = await chrome.storage.session.get(`tab_${tabId}`);
  const saved = stored[`tab_${tabId}`];
  const entry = stateFor(tabId);
  if (saved) {
    for (const candidate of saved.candidates || []) entry.candidates.set(candidate.url, candidate);
    entry.segments = saved.segments || 0;
    entry.headers = saved.headers || {};
    entry.pageUrl = saved.pageUrl || '';
    entry.pageTitle = saved.pageTitle || '';
    entry.usesMediaSource = !!saved.usesMediaSource;
    entry.pageTarget = saved.pageTarget || '';
    entry.meta = saved.meta || null;
  }
  return entry;
}

function updateBadge(tabId) {
  const entry = tabs.get(tabId);
  const count = entry ? entry.candidates.size : 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f8cff' }).catch(() => {});
}

function classify(url, mime) {
  if (MANIFEST_RE.test(url)) return /\.mpd(\?|$)/i.test(url) ? 'dash' : 'hls';
  if (/dash\+xml/i.test(mime || '')) return 'dash';
  if (/mpegurl/i.test(mime || '')) return 'hls';
  if (MEDIA_FILE_RE.test(url)) return 'file';
  if (/^audio\//i.test(mime || '')) return 'audio';
  if (/^video\//i.test(mime || '')) return 'file';
  return null;
}

function labelFor(url, kind, size) {
  let name = url;
  try {
    const parsed = new URL(url);
    name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
  } catch { /* 相対 URL 等はそのまま */ }
  const parts = [name];
  if (kind === 'hls') parts.push('HLS プレイリスト');
  if (kind === 'dash') parts.push('DASH マニフェスト');
  if (size) parts.push(formatBytes(size));
  return parts.join(' — ');
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function record(tabId, url, kind, extra = {}) {
  if (tabId < 0 || !url || url.startsWith('blob:') || url.startsWith('data:')) return;
  const entry = stateFor(tabId);
  if (entry.candidates.has(url)) {
    if (extra.size && !entry.candidates.get(url).size) {
      entry.candidates.get(url).size = extra.size;
    }
    return;
  }
  if (entry.candidates.size >= MAX_PER_TAB) return;
  entry.candidates.set(url, {
    url,
    kind,
    size: extra.size || null,
    label: labelFor(url, kind, extra.size),
    seenAt: Date.now(),
    source: extra.source || 'network',
    // YouTube の実体 URL や広告配信は一覧の下に沈める
    noise: hints.isNoise(url)
  });
  persist(tabId);
  updateBadge(tabId);
}

/* ---------------- ネットワーク監視 ---------------- */

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const entry = stateFor(details.tabId);
    for (const header of details.requestHeaders || []) {
      const name = header.name.toLowerCase();
      if (name === 'referer' && !entry.headers.referer) entry.headers.referer = header.value;
      if (name === 'user-agent') entry.headers.userAgent = header.value;
      if (name === 'origin' && !entry.headers.origin) entry.headers.origin = header.value;
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;

    let mime = '';
    let size = null;
    for (const header of details.responseHeaders || []) {
      const name = header.name.toLowerCase();
      if (name === 'content-type') mime = header.value || '';
      if (name === 'content-length') size = Number(header.value) || null;
    }

    // 個々のセグメントは候補に出さない（マニフェストがあれば十分）
    if (SEGMENT_RE.test(url) && !MANIFEST_RE.test(url)) {
      const entry = stateFor(details.tabId);
      entry.segments++;
      return;
    }

    // Chrome は <video>/<audio> が出したリクエストを type:'media' で分類する。
    // 拡張子も Content-Type もあてにならないサイトでも、これは効く。
    const isMediaRequest = details.type === 'media';

    const kind = classify(url, mime) || (isMediaRequest ? 'file' : null);
    if (!kind) return;
    if (
      !isMediaRequest &&
      !MEDIA_MIME_RE.test(mime) &&
      !MANIFEST_RE.test(url) &&
      !MEDIA_FILE_RE.test(url)
    ) {
      return;
    }
    // ごく小さいレスポンスはスプライトやプレビュー、広告ビーコンのことが多い
    if (kind === 'file' && !isMediaRequest && size !== null && size < MIN_FILE_SIZE) return;

    record(details.tabId, url, kind, { size });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

/* ---------------- タブのライフサイクル ---------------- */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const entry = stateFor(tabId);
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // ページ遷移で候補をリセット
    entry.candidates.clear();
    entry.segments = 0;
    entry.pageTarget = '';
    entry.usesMediaSource = false;
    entry.meta = null;
    updateBadge(tabId);
  }
  if (tab && tab.url) entry.pageUrl = tab.url;
  if (tab && tab.title) entry.pageTitle = tab.title;
  persist(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
});

/* ---------------- メッセージ ---------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'video-elements') {
      // content script からの <video> 検出結果
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) return sendResponse({ ok: false });
      for (const item of message.sources || []) {
        if (!item.src || item.src.startsWith('blob:') || item.src.startsWith('data:')) continue;
        record(tabId, item.src, classify(item.src, '') || 'file', { source: 'element' });
      }
      const entry = stateFor(tabId);
      entry.usesMediaSource = entry.usesMediaSource || !!message.usesMediaSource;
      // X のように、ページ URL ではなく投稿の個別 URL を渡す必要があるサイト用
      if (message.pageTarget) entry.pageTarget = message.pageTarget;
      // ページから読み取ったタイトル・サムネ・尺。後から良い値が来たら上書きする
      if (message.meta) {
        entry.meta = { ...(entry.meta || {}), ...pruneEmpty(message.meta) };
      }
      persist(tabId);
      return sendResponse({ ok: true });
    }

    if (message.type === 'get-candidates') {
      const entry = await restore(message.tabId);
      return sendResponse({
        ok: true,
        candidates: [...entry.candidates.values()].sort((a, b) => rank(b) - rank(a)),
        segments: entry.segments,
        headers: entry.headers,
        usesMediaSource: !!entry.usesMediaSource,
        pageTarget: entry.pageTarget || '',
        meta: entry.meta || null
      });
    }

    if (message.type === 'clear-candidates') {
      const entry = stateFor(message.tabId);
      entry.candidates.clear();
      entry.segments = 0;
      persist(message.tabId);
      updateBadge(message.tabId);
      return sendResponse({ ok: true });
    }

    return sendResponse({ ok: false, error: 'unknown message' });
  })();
  return true; // 非同期レスポンス
});

/** null / 空文字を落とす。既存の良い値を空で上書きしないため */
function pruneEmpty(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/** マニフェストを最優先、次に大きいファイル。降格された URL は最後に回す */
function rank(candidate) {
  if (candidate.noise) return -1e15 + (candidate.size || 0);
  const base = candidate.kind === 'hls' || candidate.kind === 'dash' ? 1e12 : 0;
  return base + (candidate.size || 0);
}
