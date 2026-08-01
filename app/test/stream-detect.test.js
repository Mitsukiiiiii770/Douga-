'use strict';

/**
 * 拡張子を持たない配信 URL の検出を検証する。
 *
 * 実際のサイトで /hls/2572/<トークン> のような URL が見つかり、
 * 拡張子だけを頼りにしていた検出が丸ごと取りこぼしていた。
 * 拡張機能側の判定ロジックをここで固めておく。
 */

const path = require('path');
const { group, check, done } = require('./helper');

const engine = require('../src/main/engine');

/**
 * net-hook.js / background.js の判定と同じ規則。
 * 拡張機能側は Chrome API に依存するため直接読み込めないので、
 * 同じ正規表現をここに置いて挙動を固定する。
 */
const P = '(?:[^\\s"\'<>\\\\]|\\\\/)';
const MEDIA_URL_PATTERNS = [
  new RegExp(
    `https?:(?:\\\\?/){2}${P}+?\\.(?:m3u8|mpd|mp4|webm|mkv|mov|m4v|flv|ts|m4a|mp3)(?:\\?${P}*)?`,
    'gi'
  ),
  new RegExp(
    `https?:(?:\\\\?/){2}${P}*?\\\\?/(?:hls|dash|manifest|playlist|master|stream)\\\\?/${P}+`,
    'gi'
  )
];

const STREAM_PATH_RE = /\/(hls|dash|manifest|playlist|master|stream)\//i;

function scan(text) {
  const found = [];
  for (const pattern of MEDIA_URL_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) found.push(...matches.map((u) => u.replace(/\\\//g, '/')));
  }
  return [...new Set(found)];
}

(() => {
  group('JSON レスポンスからの抽出');
  check(
    '拡張子付きの URL を拾う',
    scan('{"src":"https://cdn.example.com/master.m3u8"}').includes(
      'https://cdn.example.com/master.m3u8'
    )
  );
  check(
    '拡張子の無い配信 URL も拾う',
    scan('{"url":"https://site.example/hls/2572/ybklz32clskych6f3nqn0qtdh1Zwrnj5gq"}').includes(
      'https://site.example/hls/2572/ybklz32clskych6f3nqn0qtdh1Zwrnj5gq'
    ),
    scan('{"url":"https://site.example/hls/2572/ybklz32clskych6f3nqn0qtdh1Zwrnj5gq"}')
  );
  check(
    'JSON でエスケープされた / を戻す',
    scan('{"u":"https:\\/\\/site.example\\/hls\\/1\\/token"}').includes(
      'https://site.example/hls/1/token'
    ),
    scan('{"u":"https:\\/\\/site.example\\/hls\\/1\\/token"}')
  );
  check(
    'dash や manifest も対象',
    scan('"a":"https://x.example/dash/abc","b":"https://y.example/manifest/def"').length === 2
  );
  check(
    '動画と無関係な URL は拾わない',
    scan('{"api":"https://site.example/api/v8/video?id=1"}').length === 0,
    scan('{"api":"https://site.example/api/v8/video?id=1"}')
  );
  check('引用符で切れる', !scan('"https://a.example/hls/1/tok"').join('').includes('"'));
  check('重複は1件にまとめる', scan('"https://a/hls/1/x" "https://a/hls/1/x"').length === 1);

  group('種類の判定（拡張子も Content-Type もあてにならない場合）');
  const kindOf = (url) => {
    try {
      return STREAM_PATH_RE.test(new URL(url).pathname) ? 'hls' : null;
    } catch {
      return null;
    }
  };
  check('/hls/ を含むパスは HLS 扱い', kindOf('https://site.example/hls/2572/token') === 'hls');
  check('/manifest/ も HLS 扱い', kindOf('https://site.example/manifest/abc') === 'hls');
  check('普通のパスは判定しない', kindOf('https://site.example/videos/hentai/title') === null);
  check('壊れた URL でも例外を投げない', kindOf('not a url') === null);

  group('マニフェスト扱いにすると解析順が上がる');
  const order = engine.orderTargets('https://site.example/watch', [
    { url: 'https://ads.example.com/creatives/1/ad.mp4', kind: 'file', size: 320000, noise: true },
    { url: 'https://site.example/hls/2572/token', kind: 'hls' }
  ]);
  check('ページ URL が先頭', order[0] === 'https://site.example/watch');
  check(
    '拡張子が無くても広告 mp4 より先に試す',
    order[1] === 'https://site.example/hls/2572/token',
    order[1]
  );
  check('広告は最後の手段として残る', order[2] === 'https://ads.example.com/creatives/1/ad.mp4');

  group('候補が広告しか無かったときの案内');
  const attempts = [
    { url: 'https://site.example/watch', error: 'このページは直接解析できませんでした。' },
    { url: 'https://ads.example.com/a.mp4', error: '再生できる形式が見つかりませんでした。' }
  ];
  const noCandidates = engine.summarizeAttempts(attempts, { hadUsableCandidates: false });
  check('再生を促す案内になる', /再生/.test(noCandidates), noCandidates);
  check(
    '「拡張機能から送ると」とは案内しない（既に送っているため）',
    !/拡張機能から送ると/.test(noCandidates),
    noCandidates
  );

  const withCandidates = engine.summarizeAttempts(attempts, { hadUsableCandidates: true });
  check(
    'まともな候補を試したうえで失敗した場合は、通常の要約を出す',
    /2 件の URL を試しました/.test(withCandidates),
    withCandidates
  );

  done('stream-detect');
})();
