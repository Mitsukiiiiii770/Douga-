'use strict';

/**
 * クリップボードを見て、動画のページらしき URL が来たら知らせる。
 *
 * サイトで URL をコピーするだけでアプリが気づくので、貼って押す手間が無くなる。
 *
 * 扱いの決まり:
 *   - 中身はどこにも残さない。検出ログにも書かない。
 *     利用者はパスワードなども複写するので、覚えておいてよいものではない。
 *   - http(s):// で始まるものだけを見る。それ以外は中身を見ずに捨てる。
 *   - 勝手に解析まで進めない。画面に出して、押されたときだけ動く。
 *   - 設定で止められる。
 *
 * clipboard には変化の通知が無いので、定期的に読むしかない。
 */

const { EventEmitter } = require('events');
const { clipboard } = require('electron');

/** 読みに行く間隔 */
const INTERVAL_MS = 1000;

/** これより長いものは URL ではないとみなす */
const MAX_LENGTH = 2000;

/** 動画のページらしき URL か。ここで弾いたものは中身を覚えない */
function looksLikeVideoUrl(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (!value || value.length > MAX_LENGTH) return false;
  // 複数行は URL ではない（文章の中に URL があるだけ）
  if (/\s/.test(value)) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && url.hostname.includes('.');
  } catch {
    return false;
  }
}

class ClipboardWatcher extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    /** 直前に見た URL。同じものを何度も知らせないため */
    this.lastSeen = null;
    this.enabled = false;
  }

  /**
   * @param {{read?: () => string, interval?: number}} [io] テスト用の差し替え口
   */
  start(io = {}) {
    this.stop();
    this.enabled = true;
    const read = io.read || (() => clipboard.readText());
    const interval = io.interval || INTERVAL_MS;

    // 起動した時点の中身は知らせない。
    // 前から入っていたものを「今コピーされた」と扱うのは不自然
    try {
      const current = read();
      if (looksLikeVideoUrl(current)) this.lastSeen = current.trim();
    } catch {
      /* 読めなければ空のまま始める */
    }

    this.timer = setInterval(() => {
      let text = '';
      try {
        text = read();
      } catch {
        return;
      }
      if (!looksLikeVideoUrl(text)) return;
      const url = text.trim();
      if (url === this.lastSeen) return;
      this.lastSeen = url;
      this.emit('url', url);
    }, interval);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 同じ URL をもう一度知らせたいとき（取り込み後など）に忘れさせる */
  forget() {
    this.lastSeen = null;
  }
}

module.exports = new ClipboardWatcher();
module.exports.looksLikeVideoUrl = looksLikeVideoUrl;
module.exports.ClipboardWatcher = ClipboardWatcher;
module.exports.INTERVAL_MS = INTERVAL_MS;
