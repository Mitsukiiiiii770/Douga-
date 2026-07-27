'use strict';

import { config, ping, pair } from './app-client.js';

const $ = (id) => document.getElementById(id);

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

async function refreshStatus() {
  const status = await ping();
  const dot = $('status-dot');
  dot.className = 'dot';
  if (!status.running) {
    dot.classList.add('is-off');
    $('status-text').textContent = 'アプリ未起動';
    $('pair-state').textContent =
      'デスクトップアプリが起動していないか、ポート番号が一致していません。';
    return;
  }
  if (!status.paired) {
    $('status-text').textContent = '未接続';
    $('pair-state').textContent =
      'アプリは起動しています。「接続 / 再接続」を押すと、アプリ側に許可ダイアログが出ます。';
    return;
  }
  dot.classList.add('is-on');
  $('status-text').textContent = `接続済み${status.version ? ` v${status.version}` : ''}`;
  $('pair-state').textContent = `ポート ${status.port} で接続しています。`;
}

$('pair-btn').addEventListener('click', async () => {
  $('pair-btn').disabled = true;
  const status = await ping();
  if (!status.running) {
    toast('アプリに接続できません', true);
  } else if (status.paired) {
    toast('すでに接続済みです');
  } else {
    const result = await pair();
    toast(result.ok ? '接続しました' : result.error, !result.ok);
  }
  $('pair-btn').disabled = false;
  await refreshStatus();
});

$('unpair-btn').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: '' });
  toast('接続情報を削除しました');
  await refreshStatus();
});

$('port').addEventListener('change', async (event) => {
  const port = Number(event.target.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    toast('ポート番号が不正です', true);
    return;
  }
  await chrome.storage.local.set({ port });
  await refreshStatus();
});

$('send-cookies').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ sendCookies: event.target.checked });
});

(async function init() {
  const cfg = await config();
  $('port').value = cfg.port;
  $('send-cookies').checked = !!cfg.sendCookies;
  await refreshStatus();
})();
