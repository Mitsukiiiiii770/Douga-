'use strict';

/**
 * 埋め込みブラウザからのログインを拒否するサービスの案内。
 *
 * Google は 2019 年以降、webview などの組み込みブラウザからの
 * ログインをフィッシング対策として拒否している。アプリ内ブラウザで
 * ログインしようとすると、理由の説明もなくエラー画面になる。
 *
 * この仕組みは利用者を守るためのものなので、回避はしない。
 * 代わりに「なぜ失敗したのか」と「どうすればよいか」をその場で出す。
 *
 * ここに並べるのは「アプリ内ブラウザでログインできないサイト」だけで、
 * 「対応していないサイト」の一覧ではない。動画の取得自体は別の話。
 */

/** ログインを拒否することが分かっているホスト */
const BLOCKED = [
  {
    pattern: /(^|\.)accounts\.google\.com$/i,
    name: 'Google',
    note:
      'Google は、アプリに埋め込まれたブラウザからのログインを拒否しています（偽サイト対策）。' +
      'YouTube はログインしなくても多くの動画を取得できます。' +
      '年齢制限や限定公開の動画が必要な場合は、Chrome 拡張機能からページを送ってください。'
  },
  {
    pattern: /(^|\.)appleid\.apple\.com$/i,
    name: 'Apple',
    note:
      'Apple も埋め込みブラウザからのログインを拒否しています。' +
      '普段お使いのブラウザと拡張機能をご利用ください。'
  },
  {
    pattern: /(^|\.)login\.microsoftonline\.com$/i,
    name: 'Microsoft',
    note:
      'Microsoft も埋め込みブラウザからのログインを拒否しています。' +
      '普段お使いのブラウザと拡張機能をご利用ください。'
  }
];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * そのページがログイン拒否の対象か。
 * @returns {{name: string, note: string}|null}
 */
function loginBlock(url) {
  const host = hostOf(url);
  if (!host) return null;
  const hit = BLOCKED.find((entry) => entry.pattern.test(host));
  return hit ? { name: hit.name, note: hit.note } : null;
}

module.exports = { loginBlock, hostOf, BLOCKED };
