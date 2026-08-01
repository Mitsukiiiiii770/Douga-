'use strict';

/**
 * ページ側の fetch / XMLHttpRequest を観測して、
 * JSON レスポンスに含まれる動画 URL を拾う。
 *
 * なぜ必要か:
 *   MV3 の webRequest はレスポンス本文を読めない。そのため
 *   background.js が検出できるのは「プレイヤーが実際にメディア URL を
 *   要求した後」だけになる。
 *
 *   ところが最近のサイトは、先に API から JSON で配信情報を受け取り、
 *   再生ボタンを押して初めてマニフェストを取りに行く作りが多い。
 *   その JSON の中身が読めれば、再生前でも候補を出せる。
 *
 * このスクリプトはページと同じ世界（MAIN world）で動く。
 * 拡張機能の API は使えないので、結果は postMessage で content script へ渡す。
 *
 * 原則: ページの動作を絶対に壊さない。
 *   - 例外は全て握りつぶし、常に元の結果をそのまま返す
 *   - 本文はクローンして読む（ページ側が読めなくなるのを防ぐ）
 *   - 大きすぎる本文は走査しない
 */

(function () {
  // 二重に差し込まれても一度だけ
  if (window.__dougaNetHook) return;
  window.__dougaNetHook = true;

  const CHANNEL = 'douga:media-urls';

  /** 走査対象にする本文の上限。これを超えるものは JSON ではないとみなす */
  const MAX_SCAN_BYTES = 3 * 1024 * 1024;

  /**
   * JSON 内に現れる動画 URL。エスケープされた \/ も考慮する。
   *
   * 拡張子を持つものと持たないものの両方を見る。
   * 配信 URL がトークンだけで拡張子を持たない作りは珍しくなく
   * （例: /hls/2572/<長いトークン>）、拡張子だけを頼りにすると
   * そういうサイトを丸ごと取りこぼす。
   */
  // パスを構成する 1 文字。JSON 内では / が \/ と書かれるため、
  // これを 1 単位として扱わないとパスの途中で切れてしまう
  const P = '(?:[^\\s"\'<>\\\\]|\\\\/)';

  const MEDIA_URL_PATTERNS = [
    new RegExp(
      `https?:(?:\\\\?/){2}${P}+?\\.(?:m3u8|mpd|mp4|webm|mkv|mov|m4v|flv|ts|m4a|mp3)(?:\\?${P}*)?`,
      'gi'
    ),
    // 拡張子は無いが、パスが配信用だと分かるもの
    new RegExp(
      `https?:(?:\\\\?/){2}${P}*?\\\\?/(?:hls|dash|manifest|playlist|master|stream)\\\\?/${P}+`,
      'gi'
    )
  ];

  /** 本文が文字列として読めそうな Content-Type か */
  function isScannable(contentType) {
    if (!contentType) return false;
    return /(json|javascript|text\/|xml)/i.test(contentType);
  }

  const reported = new Set();

  function report(urls) {
    const fresh = [];
    for (const raw of urls) {
      // JSON 内では / が \/ とエスケープされていることがある
      const url = raw.replace(/\\\//g, '/');
      if (reported.has(url)) continue;
      reported.add(url);
      fresh.push(url);
    }
    if (!fresh.length) return;
    try {
      window.postMessage({ source: CHANNEL, urls: fresh }, '*');
    } catch {
      /* 送れなくても本来の通信には影響させない */
    }
  }

  function scan(text) {
    if (typeof text !== 'string' || text.length === 0) return;
    if (text.length > MAX_SCAN_BYTES) return;
    const found = [];
    for (const pattern of MEDIA_URL_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) found.push(...matches);
    }
    if (found.length) report(found);
  }

  /* ---------------- fetch ---------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      try {
        promise
          .then((response) => {
            try {
              if (!response || !isScannable(response.headers.get('content-type'))) return;
              // クローンして読む。元のレスポンスはページ側がそのまま使える
              response
                .clone()
                .text()
                .then(scan)
                .catch(() => {});
            } catch {
              /* 観測できなくても素通しする */
            }
          })
          .catch(() => {});
      } catch {
        /* 同上 */
      }
      return promise;
    };
  }

  /* ---------------- XMLHttpRequest ---------------- */

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    try {
      this.__dougaWatched = true;
    } catch {
      /* 読み取り専用にされている場合は諦める */
    }
    return originalOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__dougaWatched) {
        this.addEventListener('load', () => {
          try {
            const type = this.getResponseHeader && this.getResponseHeader('content-type');
            if (!isScannable(type)) return;
            // responseType が blob/arraybuffer だと responseText の参照で例外になる
            if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') {
              return;
            }
            if (this.responseType === 'json') {
              scan(JSON.stringify(this.response));
              return;
            }
            scan(this.responseText);
          } catch {
            /* 観測失敗は無視 */
          }
        });
      }
    } catch {
      /* 同上 */
    }
    return originalSend.apply(this, args);
  };
})();
