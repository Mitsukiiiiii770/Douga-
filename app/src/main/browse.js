'use strict';

const { EventEmitter } = require('events');
const { session } = require('electron');
const detect = require('../shared/detect');

/**
 * アプリ内ブラウザ。拡張機能なしで完結させるための仕組み。
 *
 * Electron は Chromium そのものなので、ブラウザ拡張機能がやっていること
 * （配信 URL の盗聴・Cookie の取得・ページの情報読み取り）は、アプリの中に
 * ブラウザを持てば全部できる。配布するものが 1 つで済むのが利点。
 *
 * ログイン状態を残したいので、専用の永続パーティションを使う。
 * 利用者の普段使いのブラウザとは分離されており、ここでログインした情報だけが
 * このアプリに残る。
 */

const PARTITION = 'persist:douga-browse';

/** 1 ページあたりに覚えておく候補の上限 */
const MAX_CANDIDATES = 60;

class Browser extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    this.candidates = new Map();
    this.headers = {};
    this.pageUrl = '';
    this.pageTitle = '';
    this.segments = 0;
  }

  partition() {
    return PARTITION;
  }

  browseSession() {
    return session.fromPartition(PARTITION);
  }

  /**
   * webRequest の監視を始める。アプリ起動時に一度だけ呼ぶ。
   */
  attach() {
    if (this.attached) return;
    this.attached = true;
    const ses = this.browseSession();

    // 動画配信は Referer を見て弾くサイトが多いので、送られている値を控える
    ses.webRequest.onSendHeaders({ urls: ['<all_urls>'] }, (details) => {
      const headers = details.requestHeaders || {};
      for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (key === 'referer' && !this.headers.referer) this.headers.referer = value;
        if (key === 'user-agent') this.headers.userAgent = value;
        if (key === 'origin' && !this.headers.origin) this.headers.origin = value;
      }
    });

    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        this.inspect(details);
      } catch {
        /* 監視の失敗でページの読み込みを止めない */
      }
      callback({});
    });
  }

  inspect(details) {
    const url = details.url;
    if (detect.isSegment(url)) {
      this.segments++;
      return;
    }

    const responseHeaders = details.responseHeaders || {};
    let mime = '';
    let size = null;
    for (const [name, values] of Object.entries(responseHeaders)) {
      const key = name.toLowerCase();
      const value = Array.isArray(values) ? values[0] : values;
      if (key === 'content-type') mime = value || '';
      if (key === 'content-length') size = Number(value) || null;
    }

    const kind = detect.shouldRecord({
      url,
      mime,
      size,
      // Electron も Chrome と同じく <video> 由来のリクエストを 'media' と分類する
      isMedia: details.resourceType === 'media'
    });
    if (!kind) return;

    this.record(url, kind, size);
  }

  record(url, kind, size) {
    if (this.candidates.has(url)) {
      const existing = this.candidates.get(url);
      if (size && !existing.size) existing.size = size;
      return;
    }
    if (this.candidates.size >= MAX_CANDIDATES) return;

    this.candidates.set(url, {
      url,
      kind,
      size: size || null,
      label: detect.labelFor(url, kind, size),
      noise: detect.isNoise(url),
      seenAt: Date.now()
    });
    this.emit('update', this.state());
  }

  /** ページ遷移のたびに呼ぶ。前のページの候補を引きずらないため */
  reset(pageUrl = '') {
    this.candidates.clear();
    this.headers = {};
    this.segments = 0;
    this.pageUrl = pageUrl;
    this.pageTitle = '';
    this.emit('update', this.state());
  }

  setPage(url, title) {
    if (url) this.pageUrl = url;
    if (title) this.pageTitle = title;
  }

  state() {
    // マニフェストを先に、広告などは最後に
    const rank = (c) => {
      if (c.noise) return -1e15 + (c.size || 0);
      return (c.kind === 'hls' || c.kind === 'dash' ? 1e12 : 0) + (c.size || 0);
    };
    return {
      pageUrl: this.pageUrl,
      pageTitle: this.pageTitle,
      segments: this.segments,
      candidates: [...this.candidates.values()].sort((a, b) => rank(b) - rank(a))
    };
  }

  /**
   * 対象 URL に送られる Cookie を集める。
   * アプリ内ブラウザでログインした情報だけが対象になる。
   */
  async cookiesFor(urls) {
    const seen = new Set();
    const out = [];
    for (const url of urls.filter(Boolean)) {
      let list = [];
      try {
        list = await this.browseSession().cookies.get({ url });
      } catch {
        continue;
      }
      for (const cookie of list) {
        const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          hostOnly: !!cookie.hostOnly,
          session: cookie.session,
          expirationDate: cookie.expirationDate || null
        });
      }
    }
    return out;
  }

  /** アプリ内ブラウザのログイン情報を消す */
  async clearData() {
    await this.browseSession().clearStorageData();
    this.reset(this.pageUrl);
  }
}

module.exports = new Browser();
module.exports.PARTITION = PARTITION;
