'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const binaries = require('./binaries');
const settings = require('./settings');
const hls = require('./hls');

const PROGRESS_PREFIX = '@@DGPROG@@';
const PROGRESS_TEMPLATE =
  'download:' +
  PROGRESS_PREFIX +
  [
    '%(progress.status)s',
    '%(progress.downloaded_bytes)s',
    '%(progress.total_bytes)s',
    '%(progress.total_bytes_estimate)s',
    '%(progress.speed)s',
    '%(progress.eta)s',
    '%(progress.fragment_index)s',
    '%(progress.fragment_count)s'
  ].join('@@');

class EngineError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'EngineError';
    this.detail = detail;
  }
}

function num(value) {
  if (value == null) return null;
  const s = String(value);
  if (s === 'NA' || s === 'None' || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 抽出元サイトが要求しがちなヘッダを yt-dlp の引数に変換 */
function headerArgs(headers = {}) {
  const args = [];
  const map = {
    referer: 'Referer',
    userAgent: 'User-Agent',
    origin: 'Origin',
    cookie: 'Cookie'
  };
  for (const [key, headerName] of Object.entries(map)) {
    const value = headers[key];
    if (value) args.push('--add-header', `${headerName}:${value}`);
  }
  return args;
}

/**
 * 設定の「追加オプション」をコマンドライン引数に分解する。
 * サイト側の仕様変更に、コードを直さず yt-dlp のオプションだけで
 * 追従できるようにするための逃げ道。
 *
 *   --extractor-args "youtube:player_client=web_safari"
 *   → ['--extractor-args', 'youtube:player_client=web_safari']
 */
function tokenizeArgs(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;

  for (const char of raw.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * cfg を明示的に渡せるようにしてある。渡さなければ現在の設定を読む。
 * 引数の組み立てを設定ファイルから切り離しておくと、単体で検証できる。
 */
function baseArgs({ headers, cookieFile, cfg: given } = {}) {
  const cfg = given || settings.get();
  const args = [
    '--ignore-config',
    '--no-colors',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--socket-timeout',
    '20'
  ];
  const ff = binaries.ffmpeg();
  if (ff) args.push('--ffmpeg-location', path.dirname(ff));
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push(...headerArgs(headers));
  if (cfg.concurrentFragments > 1) {
    args.push('--concurrent-fragments', String(cfg.concurrentFragments));
  }
  args.push(...tokenizeArgs(cfg.extraArgs));
  return args;
}

function run(args, { onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const bin = binaries.ytdlp();
    if (!bin) {
      return reject(
        new EngineError('yt-dlp が見つかりません。設定タブからインストールしてください。')
      );
    }
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderrTail = [];
    let buffer = '';

    const handleChunk = (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (onLine) onLine(line);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (onLine) handleChunk(chunk);
    });
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        if (onLine) onLine(line);
      }
    });

    const onAbort = () => {
      child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) =>
      reject(new EngineError(`yt-dlp を起動できませんでした: ${err.message}`))
    );
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (buffer && onLine) onLine(buffer);
      if (code === 0) return resolve({ stdout, stderr: stderrTail.join('\n') });
      if (signal && signal.aborted) {
        const err = new EngineError('キャンセルされました');
        err.canceled = true;
        return reject(err);
      }
      reject(new EngineError(friendlyError(stderrTail), stderrTail.join('\n')));
    });
  });
}

/** yt-dlp の生エラーを日本語の短い説明に寄せる */
function friendlyError(lines) {
  const text = lines.join('\n');
  if (/DRM|Widevine|PlayReady|protected by DRM/i.test(text)) {
    return 'この動画は DRM で保護されているため、ダウンロードできません。';
  }
  if (/Sign in|login required|members-only|private video|This video is available to/i.test(text)) {
    return (
      'ログインか年齢確認が必要なページです。' +
      'ブラウザタブでこのサイトを開いて確認を通してから、もう一度お試しください。'
    );
  }
  if (/HTTP Error 40[34]/i.test(text)) {
    return 'サーバーにアクセスを拒否されました（403/404）。Referer や Cookie が必要な可能性があります。';
  }
  // YouTube は仕様変更が多く、yt-dlp が古いとここで止まる。
  // 実際にこの2つのメッセージで解析できなくなる事例が出た
  if (/Requested format is not available/i.test(text)) {
    return 'yt-dlp がこの動画の形式を取得できませんでした。設定タブで yt-dlp を「自動インストール」し直して最新版にしてください（YouTube は仕様変更が多く、更新で直ることがほとんどです）。';
  }
  if (/youtubetab|Playlists that require authentication/i.test(text)) {
    return 'YouTube のページとして解析しようとして失敗しました。動画ページの URL（watch?v=... の形）を指定してください。';
  }
  if (/Unsupported URL/i.test(text)) {
    return (
      'このページは直接解析できませんでした。' +
      'ブラウザタブで開いて動画を再生すると、配信 URL を自動で見つけて取り込みます。'
    );
  }
  if (/Unable to download webpage|getaddrinfo|Connection|timed out/i.test(text)) {
    return 'ネットワークに接続できませんでした。';
  }
  if (/ffmpeg|ffprobe/i.test(text) && /not found|not installed/i.test(text)) {
    return 'ffmpeg が見つかりません。設定タブからインストールしてください。';
  }
  const last = lines.filter((l) => /^ERROR/i.test(l)).pop();
  return last ? last.replace(/^ERROR:\s*/i, '') : '解析に失敗しました。';
}

function normalizeFormats(info) {
  let formats = Array.isArray(info.formats) ? info.formats : [];

  // 拡張子の無いメディア URL などでは、yt-dlp が formats 配列を作らず
  // トップレベルに url / ext だけを返すことがある。これを 1 件の形式として
  // 扱わないと「形式が見つからない」と誤判定してしまう。
  if (formats.length === 0 && info.url) {
    formats = [
      {
        format_id: info.format_id || 'direct',
        ext: info.ext || '',
        url: info.url,
        protocol: info.protocol || '',
        width: info.width,
        height: info.height,
        fps: info.fps,
        tbr: info.tbr,
        vcodec: info.vcodec || 'unknown',
        acodec: info.acodec || 'unknown',
        filesize: info.filesize || info.filesize_approx,
        format_note: info.format_note || ''
      }
    ];
  }

  const out = [];
  for (const f of formats) {
    if (!f || !f.format_id) continue;
    if (f.format_id === 'source' && !f.url) continue;
    const hasVideo = f.vcodec && f.vcodec !== 'none';
    const hasAudio = f.acodec && f.acodec !== 'none';
    if (!hasVideo && !hasAudio) continue;
    out.push({
      id: f.format_id,
      ext: f.ext || '',
      protocol: f.protocol || '',
      width: f.width || null,
      height: f.height || null,
      fps: f.fps || null,
      tbr: f.tbr || null,
      abr: f.abr || null,
      vcodec: hasVideo ? f.vcodec : null,
      acodec: hasAudio ? f.acodec : null,
      // HDR / Dolby Vision は解像度と同じくらい見た目に効くので拾っておく
      dynamicRange: f.dynamic_range || null,
      asr: f.asr || null,
      audioChannels: f.audio_channels || null,
      filesize: f.filesize || f.filesize_approx || null,
      note: f.format_note || '',
      kind: hasVideo && hasAudio ? 'both' : hasVideo ? 'video' : 'audio',
      language: f.language || null
    });
  }
  // 解像度 → フレームレート → HDR → ビットレートの順で良いものを上に
  const hdrRank = (f) => (f.dynamicRange && f.dynamicRange !== 'SDR' ? 1 : 0);
  out.sort(
    (a, b) =>
      (b.height || 0) - (a.height || 0) ||
      (b.fps || 0) - (a.fps || 0) ||
      hdrRank(b) - hdrRank(a) ||
      (b.tbr || 0) - (a.tbr || 0)
  );
  return out;
}

/**
 * URL を解析してタイトル・サムネイル・フォーマット一覧を返す。
 * プレイリストの場合は entries を返す。
 */
async function probe(url, { headers, cookieFile, signal } = {}) {
  const args = [
    ...baseArgs({ headers, cookieFile }),
    '-J',
    '--no-warnings',
    '--flat-playlist',
    url
  ];
  const { stdout } = await run(args, { signal });
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new EngineError('yt-dlp の応答を解析できませんでした。');
  }

  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    return {
      kind: 'playlist',
      title: info.title || 'プレイリスト',
      url,
      entries: info.entries
        .filter(Boolean)
        .map((e) => ({
          url: e.url || e.webpage_url || e.id,
          title: e.title || e.id || '(無題)',
          duration: e.duration || null
        }))
        .filter((e) => e.url)
    };
  }

  // --flat-playlist は単一動画では formats を返さないことがあるため再取得
  if (!Array.isArray(info.formats) || info.formats.length === 0) {
    const detailArgs = [...baseArgs({ headers, cookieFile }), '-J', '--no-warnings', '--no-playlist', url];
    const detail = await run(detailArgs, { signal });
    try {
      info = JSON.parse(detail.stdout);
    } catch {
      /* 直リンク等で formats が無いケースはそのまま扱う */
    }
  }

  const formats = normalizeFormats(info);
  return {
    kind: 'video',
    url,
    id: info.id || null,
    title: info.title || info.id || url,
    uploader: info.uploader || info.channel || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    isLive: !!info.is_live,
    extractor: info.extractor_key || info.extractor || null,
    formats,
    hasDrm: !!info._has_drm || formats.length === 0
  };
}

/**
 * yt-dlp が URL から機械的に作っただけのタイトルかどうか。
 *
 * generic 抽出では URL の最後のセグメントがそのままタイトルになるため、
 * master.m3u8 なら "master"、index.mpd なら "index" になる。
 * これをそのままファイル名にすると全部同じ名前で保存されてしまう。
 */
function isDerivedTitle(info, url) {
  if (!info || !info.title) return true;
  const title = String(info.title).trim();
  if (!title) return true;

  // 明らかに配信の都合で付いた名前
  if (/^(master|index|playlist|manifest|video|stream|media|chunklist|prog_index)$/i.test(title)) {
    return true;
  }

  let basename = '';
  try {
    const path = new URL(url).pathname;
    basename = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
  } catch {
    return false;
  }
  if (!basename) return false;

  // 拡張子あり・なしのどちらでも一致すれば URL 由来とみなす
  const withoutExt = basename.replace(/\.[a-z0-9]{1,5}$/i, '');
  return title === basename || title === withoutExt;
}

/**
 * yt-dlp の解析結果に、拡張機能がページから読み取った情報を補う。
 * yt-dlp 側で取れている値は上書きしない（そちらのほうが正確なため）。
 */
function applyPageMeta(info, meta) {
  if (!info || !meta) return info;

  if (meta.title && isDerivedTitle(info, info.url)) {
    info.title = meta.title;
    info.titleSource = 'page';
  }
  if (!info.thumbnail && meta.thumbnail) info.thumbnail = meta.thumbnail;
  if (!info.duration && meta.duration) info.duration = meta.duration;
  return info;
}

/**
 * 解析対象の並び順を決める。
 *
 * サイトごとの対応表は持たない。yt-dlp は多数のサイトに対応しているので
 * まずページ URL を試し、それが通らないサイトでは拡張機能が検出した
 * ストリームへ落ちる、という順番だけで大半のサイトが賄える。
 *
 * ストリーム同士では、単一ファイルより画質を選べるマニフェストを先に試す。
 */
function orderTargets(target, candidates = []) {
  const urls = [];
  const seen = new Set();
  const push = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  push(target);

  const usable = candidates.filter((c) => c && c.url && !c.noise);
  const rank = { hls: 0, dash: 0, file: 1, audio: 2 };
  const ordered = [...usable].sort(
    (a, b) =>
      (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3) ||
      manifestPreference(a.url) - manifestPreference(b.url) ||
      (b.size || 0) - (a.size || 0)
  );
  for (const candidate of ordered) push(candidate.url);

  // ノイズ扱いの URL も、他に何も無ければ最後の手段として試す
  for (const candidate of candidates) {
    if (candidate && candidate.noise) push(candidate.url);
  }
  return urls;
}

/**
 * 同じサイトから複数のマニフェストが見つかったときの優先度。
 *
 * HLS では「master プレイリスト」が画質ごとの variant を束ねている。
 * master を渡せば画質を選べるが、variant を直接渡すとその画質に固定される。
 * 名前からしか判別できないので、確実なものだけを上に置く。
 *
 * 小さいほど優先。
 */
function manifestPreference(url) {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return 1;
  }
  if (/master|^main\b/i.test(name)) return 0;

  // 解像度やビットレートが名前に入っているものは特定画質の variant。
  // 区切りが _ のことが多く、_ は単語構成文字なので \b は使えない。
  // 長い数字の一部を拾わないよう、前後を数字以外に限定する。
  const isVariant =
    /(?<!\d)\d{3,4}p(?!\d)/i.test(name) ||
    /(?<!\d)\d{3,4}x\d{3,4}(?!\d)/i.test(name) ||
    /(?<!\d)\d{3,5}k(?![0-9a-z])/i.test(name);
  return isVariant ? 2 : 1;
}

/**
 * yt-dlp が扱えなかった URL を、HLS プレイリストとして読み直す。
 * 中身が HLS でなければ null を返す（呼び出し側は次の候補へ進む）。
 */
async function probeAsHls(url, options = {}) {
  let result;
  try {
    result = await hls.probe(url, options);
  } catch (err) {
    if (err && err.canceled) throw err;
    return null;
  }
  if (!result || !result.formats.length) return null;

  const info = {
    kind: 'video',
    source: 'hls',
    url,
    id: null,
    title: url,
    uploader: null,
    duration: result.duration,
    thumbnail: null,
    isLive: false,
    extractor: 'HLS',
    formats: result.formats,
    hasDrm: false
  };
  applyPageMeta(info, options.meta);
  // ページ側の情報が無ければ URL 由来のままなので、その旨を残す
  if (!info.titleSource) info.titleSource = 'url';
  return info;
}

/**
 * 候補を順に解析し、最初に成功したものを返す。
 *
 * 「解析は通ったが形式が0件」も失敗として次へ進む。DRM で保護された
 * ページなどはここに当たる。
 */
async function probeChain(target, candidates, options = {}) {
  const urls = orderTargets(target, candidates);
  if (urls.length === 0) throw new EngineError('URL が指定されていません。');

  const attempts = [];
  for (const url of urls) {
    try {
      const info = await probe(url, options);
      if (info.kind === 'playlist' || (info.formats && info.formats.length > 0)) {
        // マニフェストへ落ちた場合、yt-dlp のタイトルは URL 由来で使えない。
        // 拡張機能がページから読み取ったタイトルで補う
        applyPageMeta(info, options.meta);
        return { info, usedUrl: url, attempts };
      }

      // yt-dlp が形式を出せなかった場合でも、中身が HLS なら自前で読める。
      // 拡張子の無いトークン型 URL は yt-dlp が判別できないことがある
      const viaHls = await probeAsHls(url, options);
      if (viaHls) return { info: viaHls, usedUrl: url, attempts };

      attempts.push({ url, error: '再生できる形式が見つかりませんでした。' });
    } catch (err) {
      if (err && err.canceled) throw err;

      // yt-dlp がエラーで終わった場合も、HLS として読めるなら救える
      try {
        const viaHls = await probeAsHls(url, options);
        if (viaHls) return { info: viaHls, usedUrl: url, attempts };
      } catch (hlsErr) {
        if (hlsErr && hlsErr.canceled) throw hlsErr;
      }

      attempts.push({ url, error: err ? err.message : String(err) });
    }
  }

  // 広告など降格された URL しか無かった場合は、検出そのものが
  // 足りていない可能性が高い。案内の文面を変えるために伝える
  const hadUsableCandidates = (candidates || []).some((c) => c && c.url && !c.noise);
  const error = new EngineError(summarizeAttempts(attempts, { hadUsableCandidates }));
  error.attempts = attempts;
  throw error;
}

/** 全部失敗したときに、一番役に立つ一文を選ぶ */
function summarizeAttempts(attempts, { hadUsableCandidates = true } = {}) {
  const messages = attempts.map((a) => a.error);
  // ログインや DRM のように、対処が具体的なものを優先して見せる
  const actionable = messages.find((m) => /ログイン|DRM|拒否/.test(m));
  if (actionable) return actionable;

  // ページ自体を解析できず、まともな候補も1つも無かった場合。
  // 「拡張機能から送ってください」と案内しても既に送っているので意味がない。
  // 本当に必要な操作（動画を再生してから送り直す）を伝える
  if (!hadUsableCandidates && messages.some((m) => /直接解析できませんでした/.test(m))) {
    return (
      'このサイトはページからは解析できませんでした。' +
      '下のボタンでブラウザタブに開き、動画を再生してください' +
      '（再生を始めないと配信 URL が現れないサイトがあります）。' +
      '見つかり次第、自動で取り込みます。'
    );
  }
  if (attempts.length > 1) {
    return `${attempts.length} 件の URL を試しましたが取得できませんでした。最後のエラー: ${
      messages[messages.length - 1]
    }`;
  }
  return messages[0] || '取得できませんでした。';
}

/**
 * 選択内容から yt-dlp の -f セレクタを組み立てる。
 *
 * bv*+ba は「映像単体トラック＋音声単体トラック」を選んで結合する指定。
 * 多くのサイトで最高画質は映像単体でしか配信されないため、
 * 映像+音声が入った単一ファイル（b）より優先する必要がある。
 */
function buildSelector({ formatId, mode, formats }) {
  if (mode === 'audio') return 'bestaudio/best';
  if (mode === 'best' || !formatId) return 'bestvideo*+bestaudio/best';
  const chosen = (formats || []).find((f) => f.id === formatId);
  if (chosen && chosen.kind === 'video') return `${formatId}+bestaudio/${formatId}`;
  return formatId;
}

/**
 * 画質の優先順位（yt-dlp の -S）を組み立てる。
 *
 * -S を指定しないと yt-dlp の既定順で選ばれ、HDR や高フレームレートが
 * 考慮されない。ここで明示することで「解像度 → フレームレート → HDR →
 * 映像コーデック → 音声チャンネル数 → 音声コーデック → ビットレート」の
 * 順に効かせる。
 */
function buildSortFields(cfg) {
  const fields = [];
  // 上限を設けると、それを超えない範囲で最良のものが選ばれる
  if (cfg.maxHeight) fields.push(`res:${cfg.maxHeight}`);

  if (cfg.qualityPreset === 'compat') {
    // 再生互換を優先: H.264 + AAC を選ばせる（無ければ通常の順で妥協する）
    fields.push('res', 'fps', 'vcodec:h264', 'acodec:aac', 'br');
  } else {
    // 既定は画質優先。hdr:12 は Dolby Vision まで含めて HDR を上位に置く
    fields.push('res', 'fps', 'hdr:12', 'vcodec', 'channels', 'acodec', 'br');
  }
  return fields;
}

/** 再エンコードが発生する = 音質が落ちる形式 */
const LOSSY_AUDIO = ['mp3', 'aac', 'opus', 'vorbis'];

/**
 * aria2c の接続数。
 * 増やすほど速いとは限らず、配信側に拒否されることもある。
 * 16 は実用上よく使われ、受け入れられやすい値。
 */
const ARIA2_CONNECTIONS = 16;

/** 最終ファイルを探すときに試す拡張子 */
const MEDIA_EXTS = [
  '.mkv', '.mp4', '.webm', '.mov', '.m4v', '.flv', '.avi',
  '.m4a', '.mp3', '.opus', '.flac', '.wav', '.aac', '.ogg'
];

/**
 * 保存されたファイルの場所を決める。
 *
 * これまでは yt-dlp の出力行から推測していたが、外れると後処理が
 * 「後処理の対象ファイルが見つかりません」で落ちていた。
 * 結合でコンテナが変わる場合（mp4 で始まり mkv で終わる）や、
 * 結合の行を取りこぼした場合に、消えた一時ファイルを指してしまう。
 *
 * yt-dlp 自身に最終パスを書かせたものを第一候補にし、
 * 古い yt-dlp や書き出しに失敗した場合のために推測も残す。
 *
 * @param {{printed?: string, merged?: string, destination?: string, outDir?: string, startedAt?: number}} info
 * @param {object} [io] テスト用の差し替え口
 */
function resolveOutputPath(info, io = {}) {
  const exists = io.exists || ((target) => fs.existsSync(target));
  const listDir = io.listDir || ((dir) => fs.readdirSync(dir));
  const modifiedAt = io.modifiedAt || ((target) => fs.statSync(target).mtimeMs);

  // 1. そのまま存在するもの
  for (const candidate of [info.printed, info.merged, info.destination]) {
    if (candidate && exists(candidate)) return candidate;
  }

  // 2. 拡張子だけ変わった場合。
  //    結合や変換で中身が mp4 に収まらないと mkv になる
  const base = info.merged || info.destination || info.printed;
  if (base) {
    const stem = base.slice(0, base.length - path.extname(base).length);
    for (const ext of MEDIA_EXTS) {
      if (exists(stem + ext)) return stem + ext;
    }
  }

  // 3. 保存先の中から、この回に作られた一番新しい動画・音声を探す。
  //    ここまで来るのは出力を読み取れなかったときだけ
  const dir = info.outDir || (base ? path.dirname(base) : null);
  if (!dir || !exists(dir)) return base || null;

  let best = null;
  let bestTime = -Infinity;
  let names = [];
  try {
    names = listDir(dir);
  } catch {
    return base || null;
  }
  for (const name of names) {
    if (!MEDIA_EXTS.includes(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    let time;
    try {
      time = modifiedAt(full);
    } catch {
      continue;
    }
    // ダウンロード開始より前からあったファイルは無関係
    if (info.startedAt && time < info.startedAt - 1000) continue;
    if (time > bestTime) {
      bestTime = time;
      best = full;
    }
  }
  return best || base || null;
}

/** ファイル名に使えない文字を落とす（Windows の禁止文字に合わせる） */
function sanitizeFileName(value) {
  const name = String(value)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    // 記号が連続すると "___" のような読めない名前になる
    .replace(/_{2,}/g, '_')
    // 末尾のドットと空白は Windows が扱えない
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 150);

  // 区切り記号しか残らなかった場合は名前として使えない
  return /[^_.\s]/.test(name) ? name : '';
}

/**
 * 出力ファイル名のテンプレートを決める。
 *
 * yt-dlp が正しくタイトルを取れているときは、そのまま %(title)s に任せる。
 * マニフェスト URL へフォールバックした場合は yt-dlp のタイトルが URL 由来
 * （master.m3u8 → "master"）になってしまうため、ページから読み取った
 * タイトルをテンプレートに直接埋め込む。
 */
function outputTemplateFor(job) {
  // 'user' は利用者が画面で打ち直した名前。これより優先するものは無い。
  // 'page' はページから読み取った題。yt-dlp が URL から機械的に作った
  // 名前（master など）しか持っていないときの補いとして使う
  if ((job.titleSource === 'user' || job.titleSource === 'page') && job.title) {
    const name = sanitizeFileName(job.title);
    if (name) {
      // テンプレート内の % は yt-dlp の書式指定として解釈されるので退避する
      return `${name.replace(/%/g, '%%')}.%(ext)s`;
    }
  }
  return '%(title).150B [%(id)s].%(ext)s';
}

/**
 * ダウンロード用の yt-dlp 引数を組み立てる。
 * 実行と切り離してあるので、引数の組み立て方だけを単体で検証できる。
 */
function buildDownloadArgs(job, cfg, { pathFile } = {}) {
  const outDir = job.outDir || cfg.downloadDir;
  const template = path.join(outDir, outputTemplateFor(job));

  const args = [
    ...baseArgs({ headers: job.headers, cookieFile: job.cookieFile, cfg }),
    '--newline',
    '--progress',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--no-playlist',
    '-o',
    template,
    '-f',
    buildSelector(job),
    '-S',
    buildSortFields(cfg).join(',')
  ];

  // aria2c があれば使う。
  //
  // yt-dlp 内蔵のダウンローダは 1 本の接続で順に取るが、aria2c は
  // 1 ファイルを複数の接続に分けて同時に取れる。回線に余裕があるほど
  // 差が出るので、入っているなら使わない理由がない。
  // 入っていなければ黙って従来どおりに動く。
  const aria2 = cfg.useAria2 === false ? null : binaries.aria2c();
  if (aria2) {
    args.push('--downloader', aria2);
    // -x: 1 サーバーあたりの接続数 / -s: 分割数 / -k: 分割の最小単位
    args.push('--downloader-args', `aria2c:-x${ARIA2_CONNECTIONS} -s${ARIA2_CONNECTIONS} -k1M`);
  }

  if (job.mode === 'audio') {
    const format = job.audioFormat || 'best';
    args.push('-x', '--audio-format', format);
    // 可逆な取り出し（best / flac / wav）では品質指定に意味がなく、
    // 付けると余計な再エンコードを招くので、非可逆のときだけ付ける
    if (LOSSY_AUDIO.includes(format)) args.push('--audio-quality', '0');
  } else {
    // 'mp4/mkv' のように / 区切りで書くと、mp4 に収まらないコーデック
    // （AV1 + Opus など）のときだけ mkv へ落ちる。再エンコードは起きない
    args.push('--merge-output-format', cfg.container || 'mp4/mkv');
  }

  if (job.subtitles) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'ja,en,-live_chat', '--embed-subs');
  }
  if (job.embedThumbnail) args.push('--embed-thumbnail');
  // 全ての後処理が終わったあとの、本当の保存先を書き出させる
  if (pathFile) args.push('--print-to-file', 'after_move:filepath', pathFile);
  args.push(job.url);
  return args;
}

/**
 * ダウンロードを実行する。進捗は onProgress で通知。
 */
async function download(job, { onProgress, onLog, signal } = {}) {
  const cfg = settings.get();
  const startedAt = Date.now();
  const outDir = job.outDir || cfg.downloadDir;

  // yt-dlp に最終的なファイル名を書かせる。出力の読み取りより確実
  const pathFile = path.join(
    os.tmpdir(),
    `douga-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  const args = buildDownloadArgs(job, cfg, { pathFile });

  let destination = null;
  let merged = null;

  await runWithFallback(args, pathFile, {
    signal,
    onLine(line) {
      if (line.startsWith(PROGRESS_PREFIX)) {
        const parts = line.slice(PROGRESS_PREFIX.length).split('@@');
        const [status, downloaded, total, totalEst, speed, eta, fragIndex, fragCount] = parts;
        onProgress &&
          onProgress({
            status: status || 'downloading',
            downloaded: num(downloaded),
            total: num(total) || num(totalEst),
            speed: num(speed),
            eta: num(eta),
            fragmentIndex: num(fragIndex),
            fragmentCount: num(fragCount)
          });
        return;
      }
      const dest = line.match(/^\[download\]\s+Destination:\s+(.+)$/);
      if (dest) destination = dest[1].trim();
      const mergeMatch = line.match(/^\[Merger\].*into\s+"(.+)"\s*$/);
      if (mergeMatch) merged = mergeMatch[1];
      const extractMatch = line.match(/^\[ExtractAudio\]\s+Destination:\s+(.+)$/);
      if (extractMatch) merged = extractMatch[1].trim();
      const already = line.match(/^\[download\]\s+(.+?)\s+has already been downloaded/);
      if (already) destination = already[1].trim();
      if (/^\[(Merger|ExtractAudio|EmbedSubtitle|Metadata|ThumbnailsConvertor)\]/.test(line)) {
        onProgress && onProgress({ status: 'processing' });
      }
      if (onLog) onLog(line);
    }
  });

  const printed = readPrintedPath(pathFile);
  return {
    filePath: resolveOutputPath({ printed, merged, destination, outDir, startedAt })
  };
}

/** yt-dlp が書き出した最終パスを読む。無ければ null */
function readPrintedPath(pathFile) {
  try {
    const lines = fs
      .readFileSync(pathFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(pathFile);
    } catch {
      /* 消せなくても害は無い */
    }
  }
}

/** 古い yt-dlp は --print-to-file を知らない。その場合だけ外して再実行する */
async function runWithFallback(args, pathFile, options) {
  try {
    return await run(args, options);
  } catch (err) {
    if (!/no such option|unrecognized arguments|Unknown option/i.test(err.message || '')) throw err;
    const index = args.indexOf('--print-to-file');
    if (index < 0) throw err;
    const without = [...args.slice(0, index), ...args.slice(index + 3)];
    return run(without, options);
  }
}

module.exports = {
  probe,
  probeChain,
  orderTargets,
  isDerivedTitle,
  applyPageMeta,
  manifestPreference,
  summarizeAttempts,
  outputTemplateFor,
  sanitizeFileName,
  download,
  EngineError,
  buildSelector,
  buildSortFields,
  buildDownloadArgs,
  resolveOutputPath,
  MEDIA_EXTS,
  ARIA2_CONNECTIONS,
  normalizeFormats,
  tokenizeArgs
};
