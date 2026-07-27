'use strict';

/**
 * サイトごとの癖を吸収するヘルパー。
 *
 * content script / service worker / popup の3か所から使うため、
 * ES モジュールではなく globalThis に載せている。
 * （content script は import できず、service worker は importScripts で読む）
 */

(function (root) {
  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };

  const matches = (host, domains) =>
    domains.some((domain) => host === domain || host.endsWith('.' + domain));

  /** yt-dlp の専用エクストラクタが強く、ページ URL を渡すのが確実なサイト */
  const PAGE_FIRST = [
    'youtube.com',
    'youtu.be',
    'x.com',
    'twitter.com',
    'pornhub.com',
    'xvideos.com',
    'xhamster.com',
    'nicovideo.jp',
    'vimeo.com',
    'twitch.tv',
    'bilibili.com',
    'dailymotion.com',
    'tiktok.com',
    'instagram.com',
    'reddit.com'
  ];

  /**
   * 一覧に出しても役に立たない、あるいは短命な URL。
   * 完全に隠さず優先度を下げるだけにして、いざという時は使えるようにしておく。
   */
  const DEMOTED = [
    // YouTube の実体 URL。形式ごとに分かれていて有効期限も短く、
    // ページ URL を yt-dlp に渡したほうが確実
    /(^|\.)googlevideo\.com$/i,
    // 広告・トラッキング系
    /(^|\.)doubleclick\.net$/i,
    /(^|\.)googlesyndication\.com$/i,
    /(^|\.)adsrvr\.org$/i,
    /(^|\.)exoclick\.com$/i,
    /(^|\.)trafficjunky\.net$/i,
    /(^|\.)juicyads\.com$/i
  ];

  const NOTES = {
    'youtube.com':
      'YouTube は「このページをアプリで開く」が確実です。年齢制限つきの動画は Cookie の送信を有効にしてください。',
    'youtu.be': 'YouTube は「このページをアプリで開く」が確実です。',
    'x.com':
      'X は再生中の投稿の個別 URL を自動で拾います。鍵アカウントやセンシティブな投稿は Cookie の送信が必要です。',
    'twitter.com': 'X は再生中の投稿の個別 URL を自動で拾います。',
    'pornhub.com': '年齢確認や会員限定の動画は Cookie の送信を有効にしてください。',
    'xvideos.com': '年齢確認や会員限定の動画は Cookie の送信を有効にしてください。',
    'hanime.tv':
      'hanime.tv は専用の解析には対応していないため、下の HLS プレイリスト（.m3u8）を選んでください。'
  };

  /**
   * ページ URL を yt-dlp に渡しやすい形に整える。
   */
  function normalizePageUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return rawUrl;
    }
    const host = url.hostname.replace(/^www\./, '');

    if (matches(host, ['youtube.com'])) {
      // 再生リスト内の動画でも「今見ている1本」を対象にする
      if (url.pathname === '/watch') {
        const id = url.searchParams.get('v');
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }
      if (url.pathname.startsWith('/shorts/')) {
        return `https://www.youtube.com${url.pathname}`;
      }
    }

    if (matches(host, ['x.com', 'twitter.com'])) {
      // /status/<id>/photo/1 や /video/1 といった末尾を落とす
      const status = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (status) return `https://x.com/${status[1]}/status/${status[2]}`;
    }

    // トラッキング用のクエリは落とす
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'si', 'feature', 'pp']) {
      url.searchParams.delete(key);
    }
    return url.toString();
  }

  /**
   * ページ URL だけでは対象が特定できないサイト向けに、
   * 再生中のメディア要素から本当の対象 URL を探す。
   *
   * X はタイムライン上で再生できるため、ページ URL がタイムラインのままになる。
   * 再生中の video から投稿の permalink をたどる。
   */
  function targetForMedia(pageUrl, mediaElement) {
    const host = hostOf(pageUrl);
    if (!matches(host, ['x.com', 'twitter.com']) || !mediaElement) return null;

    const article = mediaElement.closest('article');
    if (!article) return null;

    // 投稿本文の時刻リンクが個別 URL になっている
    for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
      const match = anchor.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
      if (match) return `https://x.com/${match[1]}/status/${match[2]}`;
    }
    return null;
  }

  /** ページ URL を優先すべきサイトか */
  function prefersPageUrl(pageUrl) {
    return matches(hostOf(pageUrl), PAGE_FIRST);
  }

  /** 候補の並び順を下げるべき URL か */
  function isDemoted(url) {
    const host = hostOf(url);
    if (!host) return false;
    return DEMOTED.some((pattern) => pattern.test(host));
  }

  /** ポップアップに出すサイト固有の注意書き */
  function noteFor(pageUrl) {
    const host = hostOf(pageUrl);
    for (const [domain, note] of Object.entries(NOTES)) {
      if (host === domain || host.endsWith('.' + domain)) return note;
    }
    return null;
  }

  root.DougaSiteHints = {
    hostOf,
    normalizePageUrl,
    targetForMedia,
    prefersPageUrl,
    isDemoted,
    noteFor,
    PAGE_FIRST
  };
})(typeof self !== 'undefined' ? self : globalThis);
