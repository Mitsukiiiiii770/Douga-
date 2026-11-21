'use strict';

/**
 * 拡張機能の配線を検証する。
 *
 * 拡張機能は Chrome API に依存するため、ここで動かして試すことはできない。
 * それでも「読み込めない」「黙って動かない」原因の多くは静的に見つかる:
 *   - マニフェストが実在しないファイルを指している
 *   - 画面の id と JavaScript の参照が食い違っている
 *   - メッセージの種類が送る側と受ける側で合っていない
 *
 * 実際、検出できない不具合を追うのに何度も往復したので、
 * 機械で分かる範囲は機械に見させる。
 */

const fs = require('fs');
const path = require('path');
const { group, check, done } = require('./helper');

const DIR = path.resolve(__dirname, '..', '..', 'extension');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const background = read('background.js');
const popupJs = read('popup.js');
const popupHtml = read('popup.html');
const contentJs = read('content.js');
const netHook = read('net-hook.js');

(() => {
  group('マニフェストの参照');
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ];
  for (const file of [...new Set(referenced)]) {
    check(`${file} が存在する`, fs.existsSync(path.join(DIR, file)));
  }

  group('画面と JavaScript の対応');
  const ids = new Set([...popupHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...popupJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !ids.has(id));
  check(
    '参照している id が全て画面にある',
    missing.length === 0,
    missing.length ? `無い id: ${missing.join(', ')}` : ''
  );

  group('メッセージの種類が噛み合っている');
  const handled = new Set(
    [...background.matchAll(/message\.type === '([^']+)'/g)].map((m) => m[1])
  );
  const sent = new Set(
    [...(popupJs + contentJs).matchAll(/type: '([^']+)'/g)].map((m) => m[1])
  );
  for (const type of sent) {
    check(`${type} を service worker が受け取る`, handled.has(type));
  }

  group('検出の本体が残っている');
  check('通信を監視している', background.includes('chrome.webRequest.onHeadersReceived'));
  check('候補として記録する経路がある', /record\(details\.tabId, url, kind/.test(background));
  check('video 要素からの検出も記録する', /message\.type === 'video-elements'/.test(background));
  check(
    'ページ側の通信を覗く仕掛けがある',
    netHook.includes('XMLHttpRequest') && netHook.includes('fetch'),
    '再生前に配信情報だけ来るサイト用'
  );
  check(
    'その結果を content script が受け取る',
    contentJs.includes("data.source !== 'douga:media-urls'"),
    '受け取らないと net-hook の検出が捨てられる'
  );
  check(
    '受け取った URL を service worker へ渡す',
    /sendMessage\(\{\s*type: 'video-elements'/.test(contentJs)
  );

  group('捨てた URL を理由つきで控える');
  check('控える仕組みがある', /function reject\(tabId, url, reason/.test(background));
  check('小さすぎる場合', background.includes('小さすぎる'));
  check('セグメントの場合', background.includes('セグメント'));
  check('メディアでない場合', background.includes('メディア要素の読み込みではなく'));
  check('手がかりが無いものは数だけ', /uninteresting\+\+/.test(background));

  group('検出ログを出せる');
  check('まとめる処理がある', /function buildReport\(/.test(background));
  check('画面から呼べる', popupJs.includes("type: 'get-report'"));
  check('service worker が応じる', background.includes("message.type === 'get-report'"));
  check('Cookie は含めないと明記している', background.includes('Cookie とその値は含まれません'));
  check('採用した候補を出す', background.includes('採用した候補'));
  check('捨てた URL を理由ごとにまとめる', background.includes('捨てた URL'));

  done('extension');
})();
