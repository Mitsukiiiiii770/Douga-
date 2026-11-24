'use strict';

const { EventEmitter } = require('events');
const { session } = require('electron');
const fs = require('fs');
const path = require('path');
const detect = require('../shared/detect');
const adblock = require('../shared/adblock');
const settings = require('./settings');
const diagnostics = require('./diagnostics');

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

/**
 * 同じ名前があれば番号を足す。
 * ブラウザから落としたファイルで既存を黙って潰さないため。
 */
function freeName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext) || 'download';
  let candidate = path.join(dir, base + ext);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
    if (n > 999) break;
  }
  return candidate;
}

/** 1 ページあたりに覚えておく候補の上限 */
const MAX_CANDIDATES = 60;

/** タブ 1 つ分の状態 */
function emptyTab() {
  return {
    candidates: new Map(),
    headers: {},
    pageUrl: '',
    pageTitle: '',
    segments: 0
  };
}

class Browser extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    /**
     * タブごとの状態。鍵は webContents の id。
     *
     * 同じ区画の webview は webRequest を共有するため、どのタブの通信かは
     * details.webContentsId でしか見分けられない。1 つにまとめて持つと、
     * 別のタブで再生した動画が混ざって取り込まれてしまう。
     */
    this.tabs = new Map();
    /** 止めた数。画面に出して、効いていることが分かるようにする */
    this.blocked = 0;
  }

  /** 今の広告ブロック設定 */
  adBlockOptions() {
    let cfg = {};
    try {
      cfg = settings.get();
    } catch {
      return { enabled: false, extra: [] };
    }
    return {
      enabled: cfg.blockAds !== false,
      extra: adblock.parseExtra(cfg.adBlockExtra)
    };
  }

  /** 指定タブの状態。無ければ作る */
  tab(id) {
    const key = id == null ? 0 : id;
    if (!this.tabs.has(key)) this.tabs.set(key, emptyTab());
    return this.tabs.get(key);
  }

  /** タブを閉じたときに忘れる */
  forget(id) {
    this.tabs.delete(id == null ? 0 : id);
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

    // 広告・計測を止める。
    //
    // 止めるのは広告だと分かっている配信元だけにする。汎用の CDN まで
    // 巻き込むと、肝心の動画が再生できなくなる。
    // アプリ自身の画面には影響しない（この区画だけが対象）。
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        if (adblock.shouldBlock(details.url, this.adBlockOptions())) {
          this.blocked++;
          return callback({ cancel: true });
        }
      } catch {
        /* 判定に失敗したら通す。止めすぎるより通しすぎるほうが安全 */
      }
      callback({});
    });

    // ブラウザの中でファイルのリンクを押したとき。
    //
    // 既定では何も起きない（Electron は保存先を決めないと落とさない）。
    // ブラウザとして使う以上、押して無反応なのは欠陥に近い。
    // 保存先はアプリの設定と同じ場所にして、進み具合を画面へ流す。
    ses.on('will-download', (event, item) => {
      let dir = '';
      try {
        dir = settings.get().downloadDir;
      } catch {
        /* 設定が読めなければ Electron の既定に任せる */
      }
      if (!dir) return;

      let target = '';
      try {
        fs.mkdirSync(dir, { recursive: true });
        target = freeName(dir, item.getFilename() || 'download');
        item.setSavePath(target);
      } catch {
        return; // 決められなければ Electron の既定（保存先を尋ねる）に任せる
      }

      const name = path.basename(target);
      const total = item.getTotalBytes();
      this.emit('download', { state: 'started', name, path: target, total });

      item.on('updated', (_e, state) => {
        this.emit('download', {
          state: state === 'interrupted' ? 'interrupted' : 'progress',
          name,
          path: target,
          received: item.getReceivedBytes(),
          total
        });
      });

      item.once('done', (_e, state) => {
        this.emit('download', { state, name, path: target, total });
      });
    });

    // 動画配信は Referer を見て弾くサイトが多いので、送られている値を控える
    ses.webRequest.onSendHeaders({ urls: ['<all_urls>'] }, (details) => {
      const tab = this.tab(details.webContentsId);
      const headers = details.requestHeaders || {};
      for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (key === 'referer' && !tab.headers.referer) tab.headers.referer = value;
        if (key === 'user-agent') tab.headers.userAgent = value;
        if (key === 'origin' && !tab.headers.origin) tab.headers.origin = value;
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
    const tab = this.tab(details.webContentsId);
    if (detect.isSegment(url)) {
      tab.segments++;
      diagnostics.segment();
      // 最初の数件だけは残す。マニフェストを取りこぼしたとき、
      // セグメントの URL からどこに置かれているか分かる
      if (tab.segments <= 3) {
        diagnostics.observe({
          url,
          resourceType: details.resourceType || '',
          kind: null,
          reason: 'セグメント（マニフェストがあれば足りる）'
        });
      }
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

    const { kind, reason } = detect.explain({
      url,
      mime,
      size,
      // Electron も Chrome と同じく <video> 由来のリクエストを 'media' と分類する
      isMedia: details.resourceType === 'media'
    });

    // 手がかりが全く無いもの（CSS・画像・API）は数だけ数える。
    // 1 件ずつ残すとログが埋まって、肝心の取りこぼしが読めなくなる
    if (!kind && reason === '動画と判定できる手がかりが無い') {
      diagnostics.skip();
      return;
    }

    diagnostics.observe({ url, mime, size, resourceType: details.resourceType || '', kind, reason });
    if (!kind) return;

    this.record(details.webContentsId, url, kind, size);
  }

  record(id, url, kind, size) {
    const tab = this.tab(id);
    if (tab.candidates.has(url)) {
      const existing = tab.candidates.get(url);
      if (size && !existing.size) existing.size = size;
      return;
    }
    if (tab.candidates.size >= MAX_CANDIDATES) return;

    tab.candidates.set(url, {
      url,
      kind,
      size: size || null,
      label: detect.labelFor(url, kind, size),
      noise: detect.isNoise(url),
      seenAt: Date.now()
    });
    this.emit('update', { id, ...this.state(id) });
  }

  /** ページ遷移のたびに呼ぶ。前のページの候補を引きずらないため */
  reset(id, pageUrl = '') {
    const tab = this.tab(id);
    tab.candidates.clear();
    tab.headers = {};
    tab.segments = 0;
    tab.pageUrl = pageUrl;
    tab.pageTitle = '';
    this.emit('update', { id, ...this.state(id) });
  }

  setPage(id, url, title) {
    const tab = this.tab(id);
    if (url) tab.pageUrl = url;
    if (title) tab.pageTitle = title;
  }

  state(id) {
    const tab = this.tab(id);
    // マニフェストを先に、広告などは最後に
    const rank = (c) => {
      if (c.noise) return -1e15 + (c.size || 0);
      return (c.kind === 'hls' || c.kind === 'dash' ? 1e12 : 0) + (c.size || 0);
    };
    return {
      pageUrl: tab.pageUrl,
      pageTitle: tab.pageTitle,
      segments: tab.segments,
      blocked: this.blocked,
      headers: tab.headers,
      candidates: [...tab.candidates.values()].sort((a, b) => rank(b) - rank(a))
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
    for (const id of [...this.tabs.keys()]) this.reset(id, this.tab(id).pageUrl);
  }
}

module.exports = new Browser();
module.exports.freeName = freeName;
module.exports.PARTITION = PARTITION;
