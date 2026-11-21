'use strict';

/**
 * アプリ内ブラウザの広告ブロック。
 *
 * 方針:
 *   - 止めるのは「広告・計測だと分かっている配信元」だけにする。
 *     汎用の CDN を巻き込むと、肝心の動画まで止まる。
 *   - 外部のフィルタ一覧は同梱しない。配布条件が付いて回るうえ、
 *     更新が止まれば古い一覧を抱えることになる。
 *     代わりに、利用者が自分で足せるようにしておく。
 *   - 迷ったら通す。広告が 1 つ残るより、動画が再生できないほうが困る。
 */

/** 広告・計測の配信元。動画の配信には使われない */
const HOSTS = [
  // 一般的な広告・計測
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagservices.com',
  'googletagmanager.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'adsrvr.org',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'casalemedia.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'creativecdn.com',
  'moatads.com',
  'quantserve.com',
  'hotjar.com',
  'branch.io',
  // 動画サイトでよく見かける広告網
  'exoclick.com',
  'exosrv.com',
  'magsrv.com',
  'ads-twitter.com',
  'realsrv.com',
  'trafficjunky.net',
  'trafficfactory.biz',
  'juicyads.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'tsyndicate.com',
  'adsterra.com',
  'hilltopads.net',
  'hilltopads.com',
  'adtng.com',
  'adsco.re',
  'pubadx.one',
  'clickadu.com',
  'adspyglass.com',
  'a-ads.com',
  'mgid.com',
  'plugrush.com',
  'trafficstars.com',
  'tsyndicate.net',
  'bidvertiser.com',
  'adcash.com',
  'ad-maven.com',
  'onclickalgo.com',
  'onclicksuper.com',
  'highperformanceformat.com'
];

/**
 * 配信元だけでは拾いきれないもの。
 * 広告は creatives / banners のような置き場を使うことが多い。
 */
const PATHS = [/\/adserver\//i, /\/adframe\//i, /\/vast\//i, /\/popunder/i, /\/prebid/i];

/** ホスト名を取り出す。www. は落とす */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** host が base そのものか、その下にあるか */
function underHost(host, base) {
  return host === base || host.endsWith('.' + base);
}

/** 利用者が足した分を読む。1 行 1 件、# で始まる行は覚書 */
function parseExtra(text) {
  return String(text || '')
    .split(/[\r\n,]+/)
    .map((line) => line.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('/')[0]);
}

/**
 * この URL を止めるか。
 *
 * @param {string} url
 * @param {{extra?: string[], enabled?: boolean}} [options]
 */
function shouldBlock(url, { extra = [], enabled = true } = {}) {
  if (!enabled) return false;
  const host = hostOf(url);
  if (!host) return false;

  for (const base of HOSTS) {
    if (underHost(host, base)) return true;
  }
  for (const base of extra) {
    if (base && underHost(host, base)) return true;
  }

  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * 新しい窓を開く要求を通すか。
 *
 * 利用者がリンクを押したものは通し、ページの script が勝手に開くものは
 * 止める。ポップアンダー広告はこちらに当たる。
 */
function allowWindow({ url, disposition }, options = {}) {
  if (shouldBlock(url, options)) return false;
  if (!options.enabled) return true;
  // 中クリックや Ctrl+クリックはこの 2 つになる
  return disposition === 'foreground-tab' || disposition === 'background-tab';
}

module.exports = { HOSTS, PATHS, hostOf, parseExtra, shouldBlock, allowWindow };
