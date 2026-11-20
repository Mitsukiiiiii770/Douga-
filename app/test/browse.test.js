'use strict';

/**
 * アプリ内ブラウザの区画（partition）を検証する。
 *
 * なぜテストするか:
 *   webview は DOM に入った時点で読み込みを始めるため、partition は
 *   HTML の属性として最初から書いておかないと効かない。
 *   後から JavaScript で代入しても無視される。
 *
 *   これを間違えると、盗聴用の session（persist:douga-browse）と
 *   ブラウザが実際に使う session が別物になり、
 *     - 動画の配信 URL を検出できない
 *     - ログイン状態が保存されない
 *     - 取得した Cookie を yt-dlp に渡せない
 *   が同時に起きる。しかも画面上はブラウザとして普通に動くので、
 *   原因が非常に分かりにくい。
 */

const fs = require('fs');
const path = require('path');
const { group, check, done } = require('./helper');

const browse = require('../src/main/browse');

const RENDERER = path.resolve(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

(() => {
  group('区画の指定');
  const tag = html.match(/<webview[\s\S]*?>/);
  check('webview がある', !!tag, tag && tag[0].slice(0, 40));

  const attr = tag && tag[0].match(/partition="([^"]+)"/);
  check('HTML に partition を書いている', !!attr, '後から代入しても効かないため');
  check(
    'アプリ側の区画と一致する',
    attr && attr[1] === browse.PARTITION,
    attr ? `HTML: ${attr[1]} / アプリ: ${browse.PARTITION}` : ''
  );
  check(
    'persist: で始まる',
    browse.PARTITION.startsWith('persist:'),
    'これが無いとメモリ上だけの session になり、閉じるとログインが消える'
  );

  group('JavaScript から代入していない');
  check(
    'partition を後から代入していない',
    !/\bview\.partition\s*=/.test(appJs) && !/browse-view'\)\.partition\s*=/.test(appJs),
    '代入しても無視されるうえ、効いているように見えてしまう'
  );
  check(
    '食い違いを検出する仕組みがある',
    /区画が一致しません/.test(appJs),
    '取り違えても画面上は普通に動くため、気づける必要がある'
  );

  group('盗聴とブラウザが同じ区画を見る');
  check('アプリ側が区画名を公開している', typeof browse.partition === 'function');
  check('公開している値が定数と一致する', browse.partition() === browse.PARTITION);

  done('browse');
})();
