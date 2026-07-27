'use strict';

/**
 * URL の整形と、ノイズの切り分け。
 *
 * 基本方針は「サイトを列挙しない」こと。どのサイトでも同じ経路で動くのが前提で、
 * ここに書くのは次の2種類だけ:
 *
 *   1. どのサイトにも効く汎用処理（トラッキング用クエリの除去など）
 *   2. 汎用処理では原理的に解決できない例外
 *      （タイムライン上で再生するサイトは、ページ URL が動画を指さない）
 *
 * 「このサイトは対応/ 非対応」という判定はここでは持たない。
 * 対応可否はアプリ側が実際に試して決める（engine.probeChain）。
 *
 * content script / service worker / popup の3か所から使うため、
 * ES モジュールではなく globalThis に載せている。
 */

(function (root) {
  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };

  /** どのサイトでも動画本体とは無関係な、計測・共有用のクエリ */
  const TRACKING_PARAMS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'fbclid',
    'gclid',
    'igshid',
    'si',
    'ref_src',
    'ref_url',
    's',
    'pp'
  ];

  /**
   * 動画そのものではないが、ページ内で大量に流れて一覧を埋めてしまう配信元。
   * 「非対応」ではなく「並び順を下げる」だけなので、必要なら選べる。
   */
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
    /(^|\.)trafficjunky\.net$/i,
    /(^|\.)juicyads\.com$/i,
    /(^|\.)popads\.net$/i
  ];

  /**
   * ページ URL を、動画1本を指す形に整える。
   *
   * 大半は汎用のクエリ除去で足りる。以下2件だけは、そのままだと
   * 「別の動画」や「動画以外」を指してしまうため個別に扱う。
   */
  function normalizePageUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return rawUrl;
    }
    const host = url.hostname.replace(/^www\./, '');

    // 再生リスト付きの URL は、リスト全体ではなく開いている1本を対象にする
    if (host === 'youtube.com' && url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }

    // 投稿 URL の末尾に /video/1 や /photo/1 が付くと解析できない
    if (host === 'x.com' || host === 'twitter.com') {
      const status = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (status) return `https://x.com/${status[1]}/status/${status[2]}`;
    }

    for (const key of TRACKING_PARAMS) url.searchParams.delete(key);
    return url.toString();
  }

  /**
   * ページ URL だけでは対象を特定できない場合に、
   * 再生中のメディア要素から本当の対象 URL を探す。
   *
   * タイムライン上で動画を再生できるサイトでは、ページ URL は一覧
   * （例: /home）のままで、どの投稿を見ているかの情報を持たない。
   * 再生中の要素から投稿の permalink をたどる必要がある。
   */
  function targetForMedia(pageUrl, mediaElement) {
    if (!mediaElement) return null;
    const host = hostOf(pageUrl);
    if (host !== 'x.com' && host !== 'twitter.com') return null;

    const article = mediaElement.closest('article');
    if (!article) return null;

    for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
      const match = anchor.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
      if (match) return `https://x.com/${match[1]}/status/${match[2]}`;
    }
    return null;
  }

  /** 候補一覧で並び順を下げる URL か（除外はしない） */
  function isNoise(url) {
    const host = hostOf(url);
    if (!host) return false;
    return NOISE_HOSTS.some((pattern) => pattern.test(host));
  }

  root.DougaSiteHints = {
    hostOf,
    normalizePageUrl,
    targetForMedia,
    isNoise,
    TRACKING_PARAMS
  };
})(typeof self !== 'undefined' ? self : globalThis);
