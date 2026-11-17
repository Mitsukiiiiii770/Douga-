'use strict';

/**
 * 検出の記録。
 *
 * このアプリの難しさは「手元で再現できない」ことにある。どのサイトで何が
 * 流れていて、どれをなぜ捨てたのかが分からないまま直すと、当てずっぽうの
 * 修正を何度も重ねることになる。
 *
 * そこで、観測した URL と判断の理由をそのまま溜めておき、1 ファイルに
 * 書き出せるようにした。これを見れば、推測ではなく実際の通信を元に直せる。
 *
 * 個人情報を書き出さないための決まり:
 *   - Cookie とその値は一切記録しない
 *   - URL のクエリは、長いものは切り詰める（トークンが全部残らないように）
 *   - 記録するのは件数・大きさ・種別・理由だけ
 */

/** 溜めておく上限。古いものから捨てる */
const MAX_ENTRIES = 600;

/** URL をこの長さで切る。配信 URL の署名トークンは非常に長い */
const MAX_URL = 300;

const state = {
  startedAt: Date.now(),
  /** @type {Array<object>} アプリ内ブラウザが観測した通信 */
  observed: [],
  /** @type {Array<object>} 拡張機能 / アプリ内ブラウザから受け取った候補の送信 */
  captures: [],
  /** @type {Array<object>} 解析（yt-dlp / HLS）の試行結果 */
  probes: [],
  /** @type {Array<string>} その他の出来事 */
  notes: [],
  /**
   * 「動画の手がかりが全く無い」通信の件数。
   * CSS や画像まで 1 件ずつ残すとログが埋まって読めなくなるので、
   * これだけは数だけ数える。
   */
  uninteresting: 0,
  /** セグメントの通信数。1 件ずつは残さない（数千件になる） */
  segments: 0
};

function push(list, entry) {
  list.push(entry);
  while (list.length > MAX_ENTRIES) list.shift();
}

/** 長すぎる URL を切る。先頭は残すので、どのホストの何かは分かる */
function trimUrl(url) {
  const text = String(url || '');
  if (text.length <= MAX_URL) return text;
  return `${text.slice(0, MAX_URL)}…(${text.length} 文字)`;
}

/**
 * 1 件の通信を記録する。
 * @param {{url: string, mime?: string, size?: number|null, resourceType?: string,
 *          kind: string|null, reason: string, source?: string}} info
 */
function observe(info) {
  push(state.observed, {
    at: Date.now(),
    url: trimUrl(info.url),
    mime: info.mime || '',
    size: info.size === undefined ? null : info.size,
    resourceType: info.resourceType || '',
    kind: info.kind || null,
    reason: info.reason || '',
    source: info.source || 'browser'
  });
}

/**
 * 候補一覧を受け取ったことを記録する。
 * 拡張機能側は「捨てた URL」も送ってくるので、それも残す。
 */
function capture(payload) {
  const accepted = (payload.candidates || []).map((c) => ({
    url: trimUrl(c.url),
    kind: c.kind || '',
    size: c.size || null,
    noise: !!c.noise
  }));
  const rejected = (payload.rejected || []).map((r) => ({
    url: trimUrl(r.url),
    mime: r.mime || '',
    size: r.size === undefined ? null : r.size,
    resourceType: r.resourceType || '',
    reason: r.reason || ''
  }));
  push(state.captures, {
    at: Date.now(),
    source: payload.source || 'extension',
    pageUrl: trimUrl(payload.pageUrl || ''),
    pageTitle: payload.pageTitle || '',
    segments: payload.segments || 0,
    usesMediaSource: !!payload.usesMediaSource,
    meta: payload.meta
      ? {
          title: payload.meta.title || '',
          duration: payload.meta.duration || null,
          thumbnail: payload.meta.thumbnail ? '(あり)' : ''
        }
      : null,
    accepted,
    rejected
  });
}

/**
 * 解析の試行結果を記録する。
 * @param {{target: string, attempts?: Array<object>, ok?: boolean, error?: string,
 *          formats?: number, title?: string}} info
 */
function probe(info) {
  push(state.probes, {
    at: Date.now(),
    target: trimUrl(info.target || ''),
    ok: !!info.ok,
    error: info.error || '',
    formats: info.formats === undefined ? null : info.formats,
    title: info.title || '',
    attempts: (info.attempts || []).map((a) => ({
      url: trimUrl(a.url),
      error: a.error || '',
      formats: a.formats === undefined ? null : a.formats
    }))
  });
}

/** 動画の手がかりが無い通信。数だけ数える */
function skip() {
  state.uninteresting++;
}

/** セグメントの通信。数だけ数える */
function segment() {
  state.segments++;
}

function note(text) {
  push(state.notes, { at: Date.now(), text: String(text || '') });
}

function reset() {
  state.startedAt = Date.now();
  state.observed = [];
  state.captures = [];
  state.probes = [];
  state.notes = [];
  state.uninteresting = 0;
  state.segments = 0;
}

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

/* ---------------- 書き出し ---------------- */

function stamp(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function bytes(size) {
  if (size === null || size === undefined) return '不明';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(size);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 同じ理由で落ちた URL をまとめる。そのままでは広告で埋まるため */
function groupByReason(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.reason || '(理由なし)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function describe(entry) {
  const facts = [];
  if (entry.resourceType) facts.push(`種類=${entry.resourceType}`);
  if (entry.mime) facts.push(`Content-Type=${entry.mime}`);
  facts.push(`大きさ=${bytes(entry.size)}`);
  return facts.join('  ');
}

/**
 * 人が読める形に整える。
 * @param {object} [data] snapshot() の結果。省略時は現在の状態
 * @param {object} [env] アプリ・外部ツールのバージョン情報
 */
function report(data = snapshot(), env = {}) {
  const lines = [];
  const now = new Date();
  lines.push('Douga 検出ログ');
  lines.push(`書き出し: ${now.toLocaleString('ja-JP')}`);
  if (env.app) lines.push(`アプリ: ${env.app}`);
  if (env.electron) lines.push(`Electron: ${env.electron}`);
  if (env.platform) lines.push(`OS: ${env.platform}`);
  if (env.ytdlp) lines.push(`yt-dlp: ${env.ytdlp}`);
  if (env.ffmpeg) lines.push(`ffmpeg: ${env.ffmpeg}`);
  lines.push('');
  lines.push('※ Cookie とその値は含まれません。長い URL は途中で切っています。');
  lines.push('');

  /* --- 解析の試行 --- */
  lines.push('================ 1. 解析（yt-dlp / HLS）の試行 ================');
  if (!data.probes.length) {
    lines.push('（まだ解析していません）');
  }
  for (const entry of data.probes) {
    lines.push('');
    lines.push(`[${stamp(entry.at)}] 対象: ${entry.target}`);
    lines.push(`  結果: ${entry.ok ? '成功' : '失敗'}${entry.error ? ` — ${entry.error}` : ''}`);
    if (entry.ok) {
      if (entry.title) lines.push(`  タイトル: ${entry.title}`);
      if (entry.formats !== null) lines.push(`  形式: ${entry.formats} 件`);
    }
    for (const [index, attempt] of entry.attempts.entries()) {
      lines.push(`  ${index + 1}. ${attempt.url}`);
      if (attempt.formats !== null && attempt.formats !== undefined) {
        lines.push(`     形式 ${attempt.formats} 件`);
      }
      if (attempt.error) lines.push(`     → ${attempt.error}`);
    }
  }
  lines.push('');

  /* --- 送られてきた候補 --- */
  lines.push('================ 2. 候補の受け取り ================');
  if (!data.captures.length) {
    lines.push('（候補を受け取っていません）');
  }
  for (const entry of data.captures) {
    lines.push('');
    lines.push(`[${stamp(entry.at)}] 送信元: ${entry.source}`);
    lines.push(`  ページ: ${entry.pageUrl}`);
    if (entry.pageTitle) lines.push(`  表題: ${entry.pageTitle}`);
    if (entry.meta) {
      lines.push(
        `  読み取ったメタ情報: タイトル=${entry.meta.title || '(なし)'}  ` +
          `長さ=${entry.meta.duration ?? '(なし)'}  サムネ=${entry.meta.thumbnail || '(なし)'}`
      );
    }
    lines.push(`  セグメント: ${entry.segments} 件  MediaSource: ${entry.usesMediaSource ? 'あり' : 'なし'}`);
    lines.push(`  採用 ${entry.accepted.length} 件 / 不採用 ${entry.rejected.length} 件`);
    for (const candidate of entry.accepted) {
      lines.push(
        `    ○ ${candidate.url}` +
          `\n        種別=${candidate.kind || '不明'}  大きさ=${bytes(candidate.size)}` +
          (candidate.noise ? '  ※広告・計測として降格' : '')
      );
    }
    for (const [reason, items] of groupByReason(entry.rejected)) {
      lines.push(`    × ${reason}（${items.length} 件）`);
      for (const item of items.slice(0, 5)) {
        lines.push(`        ${item.url}`);
        lines.push(`          ${describe(item)}`);
      }
      if (items.length > 5) lines.push(`        …他 ${items.length - 5} 件`);
    }
  }
  lines.push('');

  /* --- アプリ内ブラウザが見た通信 --- */
  lines.push('================ 3. アプリ内ブラウザが観測した通信 ================');
  const accepted = data.observed.filter((e) => e.kind);
  const rejected = data.observed.filter((e) => !e.kind);
  lines.push(`観測 ${data.observed.length} 件（採用 ${accepted.length} / 不採用 ${rejected.length}）`);
  lines.push(
    `動画の手がかりが無い通信（CSS・画像など）: ${data.uninteresting || 0} 件 — 数のみ記録` +
      `\nセグメントの通信: ${data.segments || 0} 件 — 数のみ記録`
  );

  if (accepted.length) {
    lines.push('');
    lines.push('-- 採用 --');
    for (const entry of accepted) {
      lines.push(`[${stamp(entry.at)}] ${entry.url}`);
      lines.push(`  ${describe(entry)}`);
      lines.push(`  → ${entry.kind}: ${entry.reason}`);
    }
  }

  if (rejected.length) {
    lines.push('');
    lines.push('-- 不採用（理由ごとにまとめ）--');
    for (const [reason, items] of groupByReason(rejected)) {
      lines.push('');
      lines.push(`■ ${reason}（${items.length} 件）`);
      for (const item of items.slice(0, 15)) {
        lines.push(`  ${item.url}`);
        lines.push(`    ${describe(item)}`);
      }
      if (items.length > 15) lines.push(`  …他 ${items.length - 15} 件`);
    }
  }
  lines.push('');

  if (data.notes.length) {
    lines.push('================ 4. その他 ================');
    for (const entry of data.notes) lines.push(`[${stamp(entry.at)}] ${entry.text}`);
    lines.push('');
  }

  lines.push('================ ここまで ================');
  return lines.join('\n');
}

module.exports = {
  observe,
  skip,
  segment,
  capture,
  probe,
  note,
  reset,
  snapshot,
  report,
  trimUrl,
  groupByReason,
  MAX_ENTRIES,
  MAX_URL
};
