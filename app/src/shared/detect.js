'use strict';

/**
 * 「これは動画か」を判定する規則。
 *
 * もともとブラウザ拡張機能の中にあったが、アプリ内ブラウザでも同じ判定が
 * 要るのでこちらへ移した。拡張機能は任意で使える補助という位置づけになり、
 * アプリ単体で完結する経路がこのファイルを使う。
 *
 * Chrome の webRequest でも Electron の session.webRequest でも、
 * 渡ってくる情報（URL・Content-Type・リソース種別）は同じ形なので、
 * 判定はここに一本化できる。
 */

const MANIFEST_RE = /\.(m3u8|m3u|mpd|f4m|ism(?:\/manifest)?)(\?|$)/i;
const MEDIA_FILE_RE =
  /\.(mp4|webm|mkv|mov|m4v|flv|avi|ogv|ogg|mpg|mpeg|3gp|wmv|asf|f4v|divx|m2ts|mts|vob|rm|rmvb|m4a|mp3|aac|opus|wav|flac|wma)(\?|$)/i;
const SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa|dash|seg)(\?|$)/i;
const MEDIA_MIME_RE =
  /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|f4m|vnd\.ms-sstr\+xml))/i;

/**
 * 拡張子を持たない配信エンドポイント。
 * 例: /hls/2572/<トークン>
 * 拡張子も Content-Type もあてにならないサイトが実在するため、
 * パスの形からも判断する。
 */
const STREAM_PATH_RE = /\/(hls|dash|manifest|playlist|master|stream)\//i;

/** 小さすぎるファイルはスプライトやプレビューのことが多い */
const MIN_FILE_SIZE = 50 * 1024;

/** 動画そのものではないが、一覧を埋めてしまう配信元 */
const NOISE_HOSTS = [
  // 形式ごとに URL が分かれ、有効期限も短い。ページ URL を渡したほうが確実
  /(^|\.)googlevideo\.com$/i,
  // 広告・計測
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)adsrvr\.org$/i,
  /(^|\.)adnxs\.com$/i,
  /(^|\.)scorecardresearch\.com$/i,
  /(^|\.)exoclick\.com$/i,
  /(^|\.)exosrv\.com$/i,
  /(^|\.)realsrv\.com$/i,
  /(^|\.)trafficjunky\.net$/i,
  /(^|\.)juicyads\.com$/i,
  /(^|\.)popads\.net$/i,
  /(^|\.)tsyndicate\.com$/i,
  /(^|\.)adsterra\.com$/i,
  /(^|\.)hilltopads\.net$/i,
  /(^|\.)adtng\.com$/i,
  /(^|\.)adsco\.re$/i,
  /(^|\.)pubadx\.one$/i,
  /(^|\.)creativecdn\.com$/i
];

/** 広告 CDN がよく使うパス */
const NOISE_PATHS = [/\/creatives?\//i, /\/banners?\//i, /\/adserver\//i, /\/vast\//i];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 候補一覧で並び順を下げる URL か（除外はしない） */
function isNoise(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (NOISE_HOSTS.some((pattern) => pattern.test(host))) return true;
  try {
    return NOISE_PATHS.some((pattern) => pattern.test(new URL(url).pathname));
  } catch {
    return false;
  }
}

/**
 * URL と Content-Type から種別を決める。
 * どれにも当てはまらなければ null（候補にしない）。
 */
function classify(url, mime) {
  if (MANIFEST_RE.test(url)) return /\.mpd(\?|$)/i.test(url) ? 'dash' : 'hls';
  if (/dash\+xml/i.test(mime || '')) return 'dash';
  if (/mpegurl/i.test(mime || '')) return 'hls';
  if (MEDIA_FILE_RE.test(url)) return 'file';
  if (/^audio\//i.test(mime || '')) return 'audio';
  if (/^video\//i.test(mime || '')) return 'file';

  try {
    if (STREAM_PATH_RE.test(new URL(url).pathname)) return 'hls';
  } catch { /* 壊れた URL は判定しない */ }
  return null;
}

/** セグメントは候補に出さない（マニフェストがあれば十分） */
function isSegment(url) {
  return SEGMENT_RE.test(url) && !MANIFEST_RE.test(url);
}

/**
 * 候補として採用するか。
 * isMedia は「メディア要素が出したリクエストか」（Electron / Chrome が教えてくれる）。
 */
function shouldRecord({ url, mime, size, isMedia }) {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
  if (isSegment(url)) return null;

  const kind = classify(url, mime) || (isMedia ? 'file' : null);
  if (!kind) return null;

  if (!isMedia && !MEDIA_MIME_RE.test(mime || '') && !MANIFEST_RE.test(url) && !MEDIA_FILE_RE.test(url)) {
    return null;
  }
  // 大きさが分かっているなら、小さすぎるものは常に捨てる。
  // マニフェストは中身が目録なので小さくて当然だが、実体ファイルが数 KB
  // ということはない。UI の効果音（YouTube は <audio> で先読みする）や
  // スプライト、広告ビーコンがここで落ちる。
  // 「メディア要素が出したリクエストだから」という理由だけでは通せない。
  const isManifest = kind === 'hls' || kind === 'dash';
  if (!isManifest && size !== null && size !== undefined && size < MIN_FILE_SIZE) {
    return null;
  }
  return kind;
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

module.exports = {
  classify,
  isNoise,
  isSegment,
  shouldRecord,
  labelFor,
  formatBytes,
  hostOf,
  MIN_FILE_SIZE
};
