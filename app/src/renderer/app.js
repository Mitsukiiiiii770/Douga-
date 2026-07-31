'use strict';

const api = window.douga;

const state = {
  settings: null,
  info: null,
  /** 直近の解析で使った Cookie ファイル。ジョブ投入時に引き継ぐ */
  cookieFile: null,
  headers: {},
  capture: null,
  playlist: null,
  probeId: null,
  jobs: new Map()
};

const $ = (id) => document.getElementById(id);

/** 実行中とみなす状態。中止できて、削除はできない */
const ACTIVE_STATUSES = ['queued', 'downloading', 'processing', 'enhancing'];

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
  // HDR は解像度と同じくらい見た目に効くので目立たせる
  if (f.dynamicRange && f.dynamicRange !== 'SDR') parts.push(f.dynamicRange);
  if (f.ext) parts.push(f.ext);
  if (f.vcodec) parts.push(f.vcodec.split('.')[0]);
  if (f.kind === 'video') parts.push('映像のみ（音声を自動結合）');
  if (f.audioChannels && f.audioChannels > 2) parts.push(`${f.audioChannels}ch`);
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
  $('probe-fallback').hidden = true;
  $('result').hidden = true;
  $('playlist').hidden = true;
  setProbing(true);

  state.probeId = uuid();
  state.headers = extra.headers || {};

  const response = await api.engine.probe({
    id: state.probeId,
    url,
    headers: state.headers,
    cookies: extra.cookies || [],
    // ページを解析できないサイトでは、これらへ自動で切り替わる
    candidates: extra.candidates || [],
    // マニフェストへ落ちたときに使うタイトル・サムネ・尺
    meta: extra.meta || null
  });
  setProbing(false);
  state.probeId = null;

  if (!response.ok) {
    $('probe-error').textContent = response.error;
    $('probe-error').hidden = false;
    renderAttempts(response.attempts);
    return;
  }

  state.cookieFile = response.cookieFile || null;

  // ページ URL 以外に切り替わった場合は、何を使ったのか黙らずに伝える
  if (response.usedUrl && response.usedUrl !== url) {
    $('probe-fallback').textContent =
      `このページは直接解析できなかったため、検出されたストリームを使いました: ${response.usedUrl}`;
    $('probe-fallback').hidden = false;
  }

  if (response.info.kind === 'playlist') {
    renderPlaylist(response.info);
    return;
  }
  renderVideo(response.info);
}

/** 全部失敗したとき、何をどう試したのかを見せる */
function renderAttempts(attempts) {
  if (!attempts || attempts.length < 2) return;
  const lines = attempts.map((a) => `・${a.url}\n　→ ${a.error}`).join('\n');
  $('probe-fallback').textContent = `試した URL:\n${lines}`;
  $('probe-fallback').hidden = false;
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

/** プレイリストの1件をキューに積む。まとめて追加でも使う */
function addPlaylistEntry(entry) {
  api.jobs.add({
    url: entry.url,
    title: entry.title,
    duration: entry.duration,
    mode: 'best',
    qualityLabel: '最高画質',
    headers: state.headers,
    cookieFile: state.cookieFile
  });
}

function renderPlaylist(info) {
  state.playlist = info;
  $('playlist-title').textContent = info.title;
  $('playlist-sub').textContent = `${info.entries.length} 件の動画`;
  $('playlist-add-all').textContent = `すべて（${info.entries.length} 件）をキューに追加`;
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
      addPlaylistEntry(entry);
      showTab('queue');
    });
    li.append(label, time, open, add);
    list.appendChild(li);
  }
  $('playlist').hidden = false;
}

$('playlist-add-all').addEventListener('click', () => {
  if (!state.playlist) return;
  for (const entry of state.playlist.entries) addPlaylistEntry(entry);
  // 全件で同じ Cookie を使い回したので、ここで解析側の参照を手放す
  state.cookieFile = null;
  showTab('queue');
});

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
    titleSource: state.info.titleSource || null,
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
      probe(candidate.url, { headers, cookies: capture.cookies, meta: capture.meta })
    );

    li.append(main, tag, button);
    list.appendChild(li);
  }
  $('captured').hidden = !(capture.candidates && capture.candidates.length);

  showTab('download');
  const target = capture.target || capture.pageUrl;
  if (target) {
    probe(target, {
      headers,
      cookies: capture.cookies,
      candidates: capture.candidates,
      meta: capture.meta
    });
  }
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
    enhancing: '高画質化中',
    completed: '完了',
    error: 'エラー',
    canceled: 'キャンセル',
    interrupted: '中断（アプリ終了）'
  }[job.status] || job.status;

  const details = [statusText];
  if (job.qualityLabel) details.push(job.qualityLabel);
  if (job.status === 'enhancing') {
    details.push(`${job.progress.toFixed(1)}%`);
    if (job.encodeSpeed) details.push(job.encodeSpeed);
  }
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

  if (ACTIVE_STATUSES.includes(job.status)) {
    addButton('中止', () => api.jobs.cancel(job.id));
  }
  if (['error', 'canceled', 'interrupted'].includes(job.status)) {
    addButton('再試行', () => api.jobs.retry(job.id));
  }
  if (job.status === 'completed' && job.filePath) {
    addButton('再生', () => api.shell.openPath(job.filePath), 'small primary');
    addButton('フォルダを開く', () => api.shell.showItem(job.filePath));
    // 後処理で別ファイルを作った場合、元ファイルにも辿れるようにする
    if (job.sourcePath) {
      addButton('元ファイル', () => api.shell.openPath(job.sourcePath));
    }
  }
  if (!ACTIVE_STATUSES.includes(job.status)) {
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

  // 後処理の失敗はダウンロード自体の失敗ではないので、
  // エラーにはせず警告として出す（元ファイルは残っている）
  if (job.postProcessError) {
    const warn = document.createElement('div');
    warn.className = 'job-warn';
    warn.textContent = `高画質化に失敗しました（動画は保存済みです）: ${job.postProcessError}`;
    li.appendChild(warn);
  }

  if (job.error) {
    const error = document.createElement('div');
    error.className = 'job-error';
    error.textContent = job.error;
    li.appendChild(error);
  }
}

function refreshQueueBadge() {
  const active = [...state.jobs.values()].filter((j) =>
    ACTIVE_STATUSES.includes(j.status)
  ).length;
  const badge = $('queue-badge');
  badge.textContent = String(active);
  badge.hidden = active === 0;
  $('queue-empty').hidden = state.jobs.size > 0;

  // 前回終了時に走っていたジョブがあるときだけ再開ボタンを出す
  const interrupted = [...state.jobs.values()].filter((j) => j.status === 'interrupted').length;
  const resume = $('resume-interrupted');
  resume.hidden = interrupted === 0;
  resume.textContent = `中断した ${interrupted} 件を再開`;
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

$('resume-interrupted').addEventListener('click', async () => {
  await api.jobs.resumeInterrupted();
});

/* ---------------- 設定 ---------------- */

async function loadSettings() {
  state.settings = await api.settings.get();
  const s = state.settings;
  $('download-dir').textContent = s.downloadDir;
  $('max-concurrent').value = s.maxConcurrent;
  $('concurrent-fragments').value = s.concurrentFragments;
  $('container-select').value = s.container;
  $('quality-preset').value = s.qualityPreset;
  $('max-height').value = String(s.maxHeight || 0);
  $('extra-args').value = s.extraArgs || '';
  $('post-process').value = s.postProcess;
  $('post-encoder').value = s.postEncoder;
  $('post-crf').value = s.postCrf;
  $('post-custom').value = s.postProcessCustom || '';
  renderPostNote();
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
  ['quality-preset', 'qualityPreset', String],
  ['max-height', 'maxHeight', Number],
  ['extra-args', 'extraArgs', String],
  ['post-process', 'postProcess', String],
  ['post-encoder', 'postEncoder', String],
  ['post-crf', 'postCrf', Number],
  ['post-custom', 'postProcessCustom', String],
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

/** 後処理プリセットの一覧を main から取り、選択肢を作る */
async function loadPostPresets() {
  const presets = await api.postprocess.presets();
  const select = $('post-process');
  select.innerHTML = '';
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

function renderPostNote() {
  const preset = $('post-process').value;
  const custom = $('post-custom').value.trim();
  const note = $('post-note');
  if (custom) {
    note.textContent = 'カスタムフィルタが指定されているため、プリセットは無視されます。';
    return;
  }
  note.textContent =
    preset === 'none'
      ? '後処理は行いません。ダウンロードしたファイルがそのまま残ります。'
      : '元ファイルは残したまま、別名で書き出します。動画の長さによっては数十分かかります。';
}

$('post-process').addEventListener('change', renderPostNote);
$('post-custom').addEventListener('input', renderPostNote);

async function refreshBinaries() {
  const status = await api.binaries.status();

  const esrgan = status.realesrgan || { ok: false, path: null };
  $('realesrgan-status').textContent = esrgan.ok ? '検出済み' : '未検出（任意）';
  $('realesrgan-status').className = `status ${esrgan.ok ? 'ok' : ''}`;
  $('realesrgan-path').textContent = esrgan.path || '';

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
  await loadPostPresets();
  await loadSettings();
  await refreshBinaries();
  renderBridgeStatus(await api.bridge.status());
  for (const job of await api.jobs.list()) {
    state.jobs.set(job.id, job);
    renderJob(job);
  }
  refreshQueueBadge();
})();
