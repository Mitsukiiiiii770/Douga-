'use strict';

import { config, ping, pair, capture, collectCookies } from './app-client.js';

const $ = (id) => document.getElementById(id);

const hints = window.DougaSiteHints;

let currentTab = null;
let detection = {
  candidates: [],
  headers: {},
  usesMediaSource: false,
  segments: 0,
  pageTarget: ''
};
let connection = { running: false, paired: false };

/**
 * 「このページをアプリで開く」で実際に渡す URL。
 * X のようにタイムライン上で再生するサイトでは、content script が
 * 拾った投稿の個別 URL を優先する。
 */
function pageTargetUrl() {
  const raw = detection.pageTarget || (currentTab && currentTab.url) || '';
  return hints ? hints.normalizePageUrl(raw) : raw;
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function renderStatus() {
  const dot = $('status-dot');
  dot.className = 'dot';
  if (!connection.running) {
    dot.classList.add('is-off');
    $('status-text').textContent = 'アプリ未起動';
    $('connect-msg').textContent =
      'Douga デスクトップアプリが見つかりません。アプリを起動してから再試行してください。';
    $('connect').hidden = false;
    $('connect-btn').textContent = '再確認';
    return;
  }
  if (!connection.paired) {
    $('status-text').textContent = '未接続';
    $('connect-msg').textContent = 'アプリとの接続を許可してください。';
    $('connect').hidden = false;
    $('connect-btn').textContent = 'アプリと接続';
    return;
  }
  dot.classList.add('is-on');
  $('status-text').textContent = `接続済み${connection.version ? ` v${connection.version}` : ''}`;
  $('connect').hidden = true;
}

function tagInfo(kind) {
  if (kind === 'hls') return { text: 'HLS', cls: 'hls' };
  if (kind === 'dash') return { text: 'DASH', cls: 'dash' };
  if (kind === 'audio') return { text: '音声', cls: 'file' };
  return { text: '動画', cls: 'file' };
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname;
  } catch {
    return url;
  }
}

function renderTarget() {
  const note = hints && currentTab ? hints.noteFor(currentTab.url) : null;
  if (note) $('site-note').textContent = note;

  const target = pageTargetUrl();
  const el = $('page-target');
  // ページ URL と違う URL を渡す場合だけ、何を送るのか明示する
  if (target && currentTab && target !== currentTab.url) {
    el.textContent = `送信先: ${target}`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function renderList() {
  const list = $('list');
  list.innerHTML = '';

  for (const candidate of detection.candidates) {
    const li = document.createElement('li');
    if (candidate.demoted) li.classList.add('is-demoted');

    const main = document.createElement('div');
    main.className = 'item-main';
    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = candidate.label || shortUrl(candidate.url);
    const url = document.createElement('div');
    url.className = 'item-url';
    url.textContent = shortUrl(candidate.url);
    url.title = candidate.url;
    main.append(name, url);

    const info = tagInfo(candidate.kind);
    const tag = document.createElement('span');
    tag.className = `tag ${info.cls}`;
    tag.textContent = info.text;

    const send = document.createElement('button');
    send.textContent = 'アプリに送る';
    send.addEventListener('click', () => sendToApp(candidate.url, send));

    li.append(main, tag, send);
    list.appendChild(li);
  }

  $('empty').hidden = detection.candidates.length > 0;
  $('mse-hint').hidden = !detection.usesMediaSource;
}

async function sendToApp(target, button) {
  if (!connection.paired) {
    toast('先にアプリと接続してください', true);
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = '送信中…';
  }

  const cfg = await config();
  const cookies = cfg.sendCookies
    ? await collectCookies([currentTab.url, target].filter(Boolean))
    : [];

  const result = await capture({
    pageUrl: currentTab.url,
    pageTitle: currentTab.title,
    target,
    headers: {
      referer: detection.headers.referer || currentTab.url,
      userAgent: detection.headers.userAgent || navigator.userAgent,
      origin: detection.headers.origin || null
    },
    cookies,
    candidates: detection.candidates.map((c) => ({
      url: c.url,
      kind: c.kind,
      label: c.label
    }))
  });

  if (button) {
    button.disabled = false;
    button.textContent = 'アプリに送る';
  }

  if (result.ok) {
    toast('アプリに送りました');
    setTimeout(() => window.close(), 700);
  } else {
    toast(result.error, true);
    if (/ペアリング/.test(result.error)) {
      connection.paired = false;
      renderStatus();
    }
  }
}

async function loadDetection() {
  const response = await chrome.runtime
    .sendMessage({ type: 'get-candidates', tabId: currentTab.id })
    .catch(() => null);
  if (response && response.ok) {
    detection = {
      candidates: response.candidates || [],
      headers: response.headers || {},
      usesMediaSource: !!response.usesMediaSource,
      segments: response.segments || 0,
      pageTarget: response.pageTarget || ''
    };
  }
  renderTarget();
  renderList();
}

/* ---------------- イベント ---------------- */

$('connect-btn').addEventListener('click', async () => {
  const button = $('connect-btn');
  button.disabled = true;
  connection = await ping();
  if (connection.running && !connection.paired) {
    const result = await pair();
    if (result.ok) {
      connection = await ping();
      toast('接続しました');
    } else {
      toast(result.error, true);
    }
  } else if (!connection.running) {
    toast('アプリが見つかりません', true);
  }
  button.disabled = false;
  renderStatus();
});

$('send-page').addEventListener('click', () => sendToApp(pageTargetUrl(), $('send-page')));

$('refresh').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-candidates', tabId: currentTab.id }).catch(() => {});
  await chrome.tabs.reload(currentTab.id);
  toast('ページを再読み込みしました。再生を開始してください。');
  setTimeout(() => window.close(), 1200);
});

$('send-cookies').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ sendCookies: event.target.checked });
});

$('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

/* ---------------- 起動 ---------------- */

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  const cfg = await config();
  $('send-cookies').checked = !!cfg.sendCookies;

  if (!tab || !/^https?:/i.test(tab.url || '')) {
    $('send-page').disabled = true;
    $('empty').textContent = 'このページでは利用できません。';
  } else {
    await loadDetection();
  }

  connection = await ping();
  renderStatus();
})();
