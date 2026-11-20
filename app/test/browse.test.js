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

  group('ログインを拒否されるサイトの案内');
  // Google は 2019 年以降、埋め込みブラウザからのログインを
  // フィッシング対策として拒否する。理由が出ないとアプリの不具合に見える
  const { loginBlock } = require('../src/shared/login-blocks');

  const google = loginBlock('https://accounts.google.com/v3/signin/challenge/dp?TL=xxx');
  check('Google のログイン画面を見分ける', google && google.name === 'Google');
  check('理由を説明する', google && /拒否/.test(google.note), google && google.note);
  check(
    '代わりの手段を案内する',
    google && /拡張機能/.test(google.note),
    '案内だけして行き止まりにしない'
  );
  check(
    'ログイン不要で足りることも伝える',
    google && /ログインしなくても/.test(google.note),
    'YouTube は多くの場合ログイン不要'
  );

  check('Apple も対象', loginBlock('https://appleid.apple.com/auth/authorize') !== null);
  check('Microsoft も対象', loginBlock('https://login.microsoftonline.com/common') !== null);

  check('YouTube 本体は対象外', loginBlock('https://www.youtube.com/watch?v=1') === null);
  check(
    'google.com でも検索は対象外',
    loginBlock('https://www.google.com/search?q=x') === null,
    'ログイン画面だけを対象にする'
  );
  check('他のサイトは対象外', loginBlock('https://hanime.tv/videos/1') === null);
  check('壊れた URL でも落ちない', loginBlock('これは URL ではない') === null);
  check('空でも落ちない', loginBlock('') === null);

  check(
    '似た名前のドメインに釣られない',
    loginBlock('https://accounts.google.com.evil.example/signin') === null,
    '偽サイトを本物として案内しないため'
  );

  group('画面に出す経路');
  check('案内を表示する分岐がある', /browseState\.loginBlock/.test(appJs));
  check('移動のたびに判定する', /api\.browse\.loginBlock\(/.test(appJs));

  done('browse');
})();
