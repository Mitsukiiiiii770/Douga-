'use strict';

const api = window.douga;

const state = {
  settings: null,
  info: null,
  /** 直近の解析で使った Cookie ファイル。ジョブ投入時に引き継ぐ */
  cookieFile: null,
  headers: {},
  capture: null,
  probeId: null,
  jobs: new Map()
};

const $ = (id) => document.getElementById(id);

const uuid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/* ---------------- 表示ユーティリティ ---------------- */

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatLabel(f) {
  const parts = [];
  if (f.height) parts.push(`${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ''}`);
  else if (f.kind === 'audio') parts.push('音声');
  if (f.ext) parts.push(f.ext);
  if (f.vcodec) parts.push(f.vcodec.split('.')[0]);
  if (f.kind === 'video') parts.push('映像のみ（音声を自動結合）');
  if (f.abr) parts.push(`${Math.round(f.abr)}kbps`);
  if (f.filesize) parts.push(formatBytes(f.filesize));
  if (f.note && !parts.includes(f.note)) parts.push(f.note);
  return parts.filter(Boolean).join(' · ');
}

function classifyUrl(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return { tag: 'HLS', cls: 'hls' };
  if (/\.mpd(\?|$)/i.test(url)) return { tag: 'DASH', cls: 'dash' };
  if (/\.(mp4|webm|mkv|mov|m4v|flv|avi)(\?|$)/i.test(url)) return { tag: '直リンク', cls: 'file' };
  if (/\.(m4a|mp3|aac|opus|ogg)(\?|$)/i.test(url)) return { tag: '音声', cls: 'file' };
  return { tag: 'その他', cls: '' };
}

/* ---------------- タブ ---------------- */

$('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  showTab(tab.dataset.tab);
});

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  document
    .querySelectorAll('.panel')
    .forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
}

/* ---------------- 解析 ---------------- */

$('probe-btn').addEventListener('click', () => probe($('url-input').value.trim()));
$('url-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') probe($('url-input').value.trim());
});
$('probe-cancel').addEventListener('click', () => {
  if (state.probeId) api.engine.cancelProbe(state.probeId);
});

async function probe(url, extra = {}) {
  if (!url) return;
  $('url-input').value = url;
  $('probe-error').hidden = true;
  $('result').hidden = true;
  $('playlist').hidden = true;
  setProbing(true);

  state.probeId = uuid();
  state.headers = extra.headers || {};

  const response = await api.engine.probe({
    id: state.probeId,
    url,
    headers: state.headers,
    cookies: extra.cookies || []
  });
  setProbing(false);
  state.probeId = null;

  if (!response.ok) {
    $('probe-error').textContent = response.error;
    $('probe-error').hidden = false;
    return;
  }

  state.cookieFile = response.cookieFile || null;

  if (response.info.kind === 'playlist') {
    renderPlaylist(response.info);
    return;
  }
  renderVideo(response.info);
}

function setProbing(on) {
  $('probe-btn').disabled = on;
  $('probe-btn').textContent = on ? '解析中…' : '解析';
  $('probe-cancel').hidden = !on;
  $('url-input').disabled = on;
}

function renderVideo(info) {
  state.info = info;

  $('result-title').textContent = info.title;
  const sub = [];
  if (info.uploader) sub.push(info.uploader);
  if (info.duration) sub.push(formatDuration(info.duration));
  if (info.extractor) sub.push(info.extractor);
  if (info.isLive) sub.push('ライブ配信');
  $('result-sub').textContent = sub.join(' · ');

  const thumb = $('result-thumb');
  if (info.thumbnail) {
    thumb.src = info.thumbnail;
    thumb.hidden = false;
  } else {
    thumb.hidden = true;
    thumb.removeAttribute('src');
  }

  const select = $('format-select');
  select.innerHTML = '';
  for (const f of info.formats) {
    const option = document.createElement('option');
    option.value = f.id;
    option.textContent = formatLabel(f);
    select.appendChild(option);
  }

  if (info.formats.length === 0) {
    $('probe-error').textContent =
      'ダウンロード可能な形式が見つかりませんでした。DRM で保護されているか、対応していない配信方式の可能性があります。';
    $('probe-error').hidden = false;
  }

  $('save-to').textContent = `保存先: ${state.settings.downloadDir}`;
  $('result').hidden = false;
  syncModeFields();
}

function renderPlaylist(info) {
  $('playlist-title').textContent = info.title;
  $('playlist-sub').textContent = `${info.entries.length} 件の動画`;
  const list = $('playlist-list');
  list.innerHTML = '';
  for (const entry of info.entries) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = entry.title;
    const time = document.createElement('span');
    time.className = 'tag';
    time.textContent = formatDuration(entry.duration) || '–';
    const open = document.createElement('button');
    open.className = 'small ghost';
    open.textContent = '解析';
    open.addEventListener('click', () => probe(entry.url, { headers: state.headers }));
    const add = document.createElement('button');
    add.className = 'small primary';
    add.textContent = '追加';
    add.addEventListener('click', () => {
      api.jobs.add({
        url: entry.url,
        title: entry.title,
        mode: 'best',
        headers: state.headers,
        cookieFile: state.cookieFile
      });
      showTab('queue');
    });
    li.append(label, time, open, add);
    list.appendChild(li);
  }
  $('playlist').hidden = false;
}

$('mode-select').addEventListener('change', syncModeFields);

function syncModeFields() {
  const mode = $('mode-select').value;
  $('format-field').hidden = mode !== 'format';
  $('audio-field').hidden = mode !== 'audio';
}

$('add-btn').addEventListener('click', () => {
  if (!state.info) return;
  const mode = $('mode-select').value;
  const formatId = mode === 'format' ? $('format-select').value : null;
  const chosen = state.info.formats.find((f) => f.id === formatId);

  api.jobs.add({
    url: state.info.url,
    title: state.info.title,
    thumbnail: state.info.thumbnail,
    duration: state.info.duration,
    formats: state.info.formats,
    formatId,
    mode: mode === 'format' ? 'format' : mode,
    audioFormat: $('audio-select').value,
    subtitles: $('opt-subs').checked,
    thumbnailEmbed: $('opt-thumb').checked,
    qualityLabel: chosen ? formatLabel(chosen) : mode === 'audio' ? '音声のみ' : '最高画質',
    headers: state.headers,
    cookieFile: state.cookieFile
  });
  // Cookie ファイルはジョブに引き継いだので、解析側の参照は手放す
  state.cookieFile = null;
  showTab('queue');
});

/* ---------------- 拡張機能からの受信 ---------------- */

api.bridge.onCapture((capture) => {
  state.capture = capture;
  const headers = capture.headers || {};

  $('captured-page').textContent = capture.pageTitle
    ? `${capture.pageTitle} — ${capture.pageUrl}`
    : capture.pageUrl;

  const list = $('candidate-list');
  list.innerHTML = '';
  for (const candidate of capture.candidates || []) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'cand-main';
    const name = document.createElement('strong');
    name.textContent = candidate.label || candidate.url;
    const url = document.createElement('code');
    url.textContent = candidate.url;
    main.append(name, url);

    const info = classifyUrl(candidate.url);
    const tag = document.createElement('span');
    tag.className = `tag ${info.cls}`;
    tag.textContent = info.tag;

    const button = document.createElement('button');
    button.className = 'small ghost';
    button.textContent = '解析';
    button.addEventListener('click', () =>
      probe(candidate.url, { headers, cookies: capture.cookies })
    );

    li.append(main, tag, button);
    list.appendChild(li);
  }
  $('captured').hidden = !(capture.candidates && capture.candidates.length);

  showTab('download');
  const target = capture.target || capture.pageUrl;
  if (target) probe(target, { headers, cookies: capture.cookies });
});

/* ---------------- キュー ---------------- */

function renderJob(job) {
  let li = document.getElementById(`job-${job.id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `job-${job.id}`;
    li.className = 'job';
    $('job-list').prepend(li);
  }
  li.className = `job is-${job.status}`;

  const statusText = {
    queued: '待機中',
    downloading: 'ダウンロード中',
    processing: '変換中',
    completed: '完了',
    error: 'エラー',
    canceled: 'キャンセル'
  }[job.status] || job.status;

  const details = [statusText];
  if (job.qualityLabel) details.push(job.qualityLabel);
  if (job.status === 'downloading') {
    if (job.total) details.push(`${formatBytes(job.downloaded)} / ${formatBytes(job.total)}`);
    else if (job.downloaded) details.push(formatBytes(job.downloaded));
    if (job.speed) details.push(`${formatBytes(job.speed)}/s`);
    if (job.eta) details.push(`残り ${formatDuration(job.eta)}`);
  }
  if (job.status === 'completed' && job.filePath) details.push(job.filePath);

  li.innerHTML = '';

  const top = document.createElement('div');
  top.className = 'job-top';

  const meta = document.createElement('div');
  meta.style.minWidth = '0';
  meta.style.flex = '1';
  const title = document.createElement('div');
  title.className = 'job-title';
  title.textContent = job.title;
  title.title = job.url;
  const sub = document.createElement('div');
  sub.className = 'job-sub';
  sub.textContent = details.join(' · ');
  meta.append(title, sub);

  const actions = document.createElement('div');
  actions.className = 'job-actions';
  const addButton = (label, handler, cls = 'small ghost') => {
    const button = document.createElement('button');
    button.className = cls;
    button.textContent = label;
    button.addEventListener('click', handler);
    actions.appendChild(button);
  };

  if (['queued', 'downloading', 'processing'].includes(job.status)) {
    addButton('中止', () => api.jobs.cancel(job.id));
  }
  if (['error', 'canceled'].includes(job.status)) {
    addButton('再試行', () => api.jobs.retry(job.id));
  }
  if (job.status === 'completed' && job.filePath) {
    addButton('再生', () => api.shell.openPath(job.filePath), 'small primary');
    addButton('フォルダを開く', () => api.shell.showItem(job.filePath));
  }
  if (!['downloading', 'processing'].includes(job.status)) {
    addButton('削除', () => api.jobs.remove(job.id));
  }

  top.append(meta, actions);
  li.appendChild(top);

  const progress = document.createElement('div');
  progress.className = 'progress';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;
  progress.appendChild(fill);
  li.appendChild(progress);

  if (job.error) {
    const error = document.createElement('div');
    error.className = 'job-error';
    error.textContent = job.error;
    li.appendChild(error);
  }
}

function refreshQueueBadge() {
  const active = [...state.jobs.values()].filter((j) =>
    ['queued', 'downloading', 'processing'].includes(j.status)
  ).length;
  const badge = $('queue-badge');
  badge.textContent = String(active);
  badge.hidden = active === 0;
  $('queue-empty').hidden = state.jobs.size > 0;
}

api.jobs.onUpdate((job) => {
  state.jobs.set(job.id, job);
  renderJob(job);
  refreshQueueBadge();
});

api.jobs.onRemoved((id) => {
  state.jobs.delete(id);
  const li = document.getElementById(`job-${id}`);
  if (li) li.remove();
  refreshQueueBadge();
});

$('clear-finished').addEventListener('click', async () => {
  await api.jobs.clearFinished();
});

/* ---------------- 設定 ---------------- */

async function loadSettings() {
  state.settings = await api.settings.get();
  const s = state.settings;
  $('download-dir').textContent = s.downloadDir;
  $('max-concurrent').value = s.maxConcurrent;
  $('concurrent-fragments').value = s.concurrentFragments;
  $('container-select').value = s.container;
  $('extra-args').value = s.extraArgs || '';
  $('bridge-port').value = s.bridgePort;
  $('bridge-enabled').checked = s.bridgeEnabled;
  $('accept-cookies').checked = s.acceptCookies;
  renderClients(s.pairedClients);
}

function renderClients(clients) {
  const list = $('client-list');
  list.innerHTML = '';
  if (!clients || !clients.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '接続済みの拡張機能はありません。';
    list.appendChild(li);
    return;
  }
  for (const client of clients) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = client.name;
    const origin = document.createElement('code');
    origin.textContent = client.origin;
    const remove = document.createElement('button');
    remove.className = 'small ghost danger';
    remove.textContent = '解除';
    remove.addEventListener('click', async () => {
      await api.bridge.unpair(client.origin);
      await loadSettings();
    });
    li.append(label, origin, remove);
    list.appendChild(li);
  }
}

$('choose-dir').addEventListener('click', async () => {
  const dir = await api.settings.chooseDir();
  if (dir) await loadSettings();
});

$('open-dir').addEventListener('click', () => api.shell.openPath(state.settings.downloadDir));

for (const [id, key, cast] of [
  ['max-concurrent', 'maxConcurrent', Number],
  ['concurrent-fragments', 'concurrentFragments', Number],
  ['container-select', 'container', String],
  ['extra-args', 'extraArgs', String],
  ['bridge-port', 'bridgePort', Number]
]) {
  $(id).addEventListener('change', async (event) => {
    await api.settings.set({ [key]: cast(event.target.value) });
    await loadSettings();
  });
}

$('bridge-enabled').addEventListener('change', async (event) => {
  await api.settings.set({ bridgeEnabled: event.target.checked });
  await loadSettings();
});

$('accept-cookies').addEventListener('change', async (event) => {
  await api.settings.set({ acceptCookies: event.target.checked });
});

$('regen-token').addEventListener('click', async () => {
  await api.bridge.regenerateToken();
  await loadSettings();
});

/* ---------------- バイナリ ---------------- */

async function refreshBinaries() {
  const status = await api.binaries.status();
  for (const which of ['ytdlp', 'ffmpeg']) {
    const item = status[which];
    const badge = $(`${which}-status`);
    badge.textContent = item.ok ? `OK（${item.version || '不明'}）` : '未検出';
    badge.className = `status ${item.ok ? 'ok' : 'ng'}`;
    $(`${which}-path`).textContent = item.path || '';
  }
  return status;
}

document.querySelectorAll('[data-install]').forEach((button) => {
  button.addEventListener('click', async () => {
    const which = button.dataset.install;
    button.disabled = true;
    $('install-progress').hidden = false;
    $('install-progress').textContent = `${which} を取得しています…`;
    try {
      await api.binaries.install(which);
      $('install-progress').textContent = `${which} のインストールが完了しました。`;
    } catch (err) {
      $('install-progress').textContent = `インストールに失敗しました: ${err.message}`;
    } finally {
      button.disabled = false;
      await refreshBinaries();
    }
  });
});

document.querySelectorAll('[data-choose]').forEach((button) => {
  button.addEventListener('click', async () => {
    const chosen = await api.settings.chooseBinary(button.dataset.choose);
    if (chosen) await refreshBinaries();
  });
});

api.binaries.onProgress((p) => {
  if (p.stage === 'ffmpeg-extract') {
    $('install-progress').textContent = 'ffmpeg を展開しています…';
    return;
  }
  const pct = p.total ? ` (${Math.round((p.received / p.total) * 100)}%)` : '';
  $('install-progress').textContent = `${p.stage} をダウンロード中${pct}`;
});

/* ---------------- 連携状態 ---------------- */

function renderBridgeStatus(status) {
  const dot = $('bridge-dot');
  const label = $('bridge-label');
  dot.className = 'dot';
  if (status.error) {
    dot.classList.add('is-error');
    label.textContent = '連携エラー';
    $('bridge-error').textContent = status.error;
    $('bridge-error').hidden = false;
    return;
  }
  $('bridge-error').hidden = true;
  if (!status.running) {
    label.textContent = '連携オフ';
    return;
  }
  dot.classList.add('is-on');
  const count = (status.pairedClients || []).length;
  label.textContent = count ? `拡張機能 ${count} 件と接続` : `ポート ${status.port} で待機中`;
}

api.bridge.onStatus(renderBridgeStatus);
api.bridge.onPaired(async () => {
  await loadSettings();
  renderBridgeStatus(await api.bridge.status());
});

/* ---------------- 起動 ---------------- */

(async function init() {
  await loadSettings();
  await refreshBinaries();
  renderBridgeStatus(await api.bridge.status());
  for (const job of await api.jobs.list()) {
    state.jobs.set(job.id, job);
    renderJob(job);
  }
  refreshQueueBadge();
})();
