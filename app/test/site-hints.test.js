'use strict';

/**
 * extension/site-hints.js のテスト。
 * DOM 非依存の関数が大半なので、Node からそのまま読み込んで検証する。
 * （site-hints.js は globalThis に載せる素のスクリプト）
 */

const path = require('path');
const { group, check, done } = require('./helper');

require(path.join(__dirname, '..', '..', 'extension', 'site-hints.js'));
const hints = globalThis.DougaSiteHints;

const engine = require('../src/main/engine');

/** targetForMedia 用の最小限の DOM もどき */
function fakeTweetVideo(statusHrefs) {
  const article = {
    querySelectorAll: () => statusHrefs.map((href) => ({ getAttribute: () => href }))
  };
  return { closest: (selector) => (selector === 'article' ? article : null) };
}

(() => {
  group('ページ URL の正規化（どのサイトでも効く汎用処理）');
  check(
    '未知のサイトの URL は素通しする',
    hints.normalizePageUrl('https://some-random-site.example/videos/12345') ===
      'https://some-random-site.example/videos/12345'
  );
  check(
    '動画の識別に使うクエリは残す',
    hints.normalizePageUrl('https://example.com/play?id=abc&quality=hd') ===
      'https://example.com/play?id=abc&quality=hd',
    hints.normalizePageUrl('https://example.com/play?id=abc&quality=hd')
  );
  check(
    'トラッキング用クエリだけ落とす',
    hints.normalizePageUrl('https://example.com/v/1?id=9&utm_source=x&fbclid=y') ===
      'https://example.com/v/1?id=9',
    hints.normalizePageUrl('https://example.com/v/1?id=9&utm_source=x&fbclid=y')
  );
  check('壊れた URL でも例外を投げない', hints.normalizePageUrl('not a url') === 'not a url');

  group('ページ URL の正規化（汎用処理では直せない例外）');
  check(
    '再生リスト付き URL は開いている1本に絞る',
    hints.normalizePageUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4') ===
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    hints.normalizePageUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4')
  );
  check(
    '投稿 URL の末尾 /video/1 を落とす',
    hints.normalizePageUrl('https://x.com/someone/status/1234567890/video/1') ===
      'https://x.com/someone/status/1234567890'
  );
  check(
    'twitter.com は x.com に寄せる',
    hints.normalizePageUrl('https://twitter.com/someone/status/1234567890') ===
      'https://x.com/someone/status/1234567890'
  );

  group('タイムライン再生時の対象特定');
  check(
    'article 内の投稿リンクを拾う',
    hints.targetForMedia(
      'https://x.com/home',
      fakeTweetVideo(['/someone/status/999', '/someone/status/999/likes'])
    ) === 'https://x.com/someone/status/999'
  );
  check(
    '通常のサイトでは null（ページ URL をそのまま使う）',
    hints.targetForMedia('https://example.com/watch', fakeTweetVideo(['/a/status/1'])) === null
  );
  check(
    'article が無ければ null',
    hints.targetForMedia('https://x.com/home', { closest: () => null }) === null
  );
  check('メディア要素が無ければ null', hints.targetForMedia('https://x.com/home', null) === null);

  group('ノイズ判定（除外ではなく降格）');
  check(
    '形式ごとに分かれた短命な実体 URL',
    hints.isNoise('https://rr3---sn-abc.googlevideo.com/videoplayback?x=1') === true
  );
  check('広告配信ドメイン', hints.isNoise('https://ads.trafficjunky.net/x.mp4') === true);
  check('計測ドメイン', hints.isNoise('https://sb.scorecardresearch.com/x') === true);
  check('通常の CDN は降格しない', hints.isNoise('https://cdn.example.com/master.m3u8') === false);
  check('壊れた URL は降格しない', hints.isNoise('not a url') === false);

  group('解析順の決定（サイト名で分岐しない）');
  const candidates = [
    { url: 'https://cdn.example.com/video.mp4', kind: 'file', size: 5000000 },
    { url: 'https://cdn.example.com/master.m3u8', kind: 'hls' },
    { url: 'https://ads.example.com/x.mp4', kind: 'file', noise: true },
    { url: 'https://cdn.example.com/audio.m4a', kind: 'audio' },
    { url: 'https://cdn.example.com/small.mp4', kind: 'file', size: 100000 }
  ];
  const order = engine.orderTargets('https://example.com/watch', candidates);
  check('ページ URL を最初に試す', order[0] === 'https://example.com/watch', order[0]);
  check('次にマニフェスト', order[1] === 'https://cdn.example.com/master.m3u8', order[1]);
  check('その次は大きいファイルから', order[2] === 'https://cdn.example.com/video.mp4', order[2]);
  check('小さいファイルは後回し', order[3] === 'https://cdn.example.com/small.mp4', order[3]);
  check('音声のみはさらに後', order[4] === 'https://cdn.example.com/audio.m4a', order[4]);
  check('ノイズは最後の手段として残す', order[5] === 'https://ads.example.com/x.mp4', order[5]);
  check('重複を除く', new Set(order).size === order.length);
  check(
    '候補が無ければページ URL だけ',
    JSON.stringify(engine.orderTargets('https://example.com/w', [])) ===
      JSON.stringify(['https://example.com/w'])
  );
  check(
    'ページ URL が候補にも含まれる場合は1回だけ',
    engine.orderTargets('https://cdn.example.com/master.m3u8', candidates).filter(
      (u) => u === 'https://cdn.example.com/master.m3u8'
    ).length === 1
  );
  check('ページ URL 無しでも候補だけで並ぶ', engine.orderTargets('', candidates).length === 5);

  group('追加 yt-dlp オプションの分解');
  check('空なら何も足さない', engine.tokenizeArgs('').length === 0);
  check('未設定なら何も足さない', engine.tokenizeArgs(undefined).length === 0);
  check(
    '空白区切りで分解',
    JSON.stringify(engine.tokenizeArgs('--no-part --geo-bypass')) ===
      JSON.stringify(['--no-part', '--geo-bypass'])
  );
  check(
    '二重引用符でくくった値を1つの引数として扱う',
    JSON.stringify(engine.tokenizeArgs('--extractor-args "youtube:player_client=web_safari"')) ===
      JSON.stringify(['--extractor-args', 'youtube:player_client=web_safari']),
    engine.tokenizeArgs('--extractor-args "youtube:player_client=web_safari"')
  );
  check(
    '単一引用符も同様',
    JSON.stringify(engine.tokenizeArgs("--user-agent 'Mozilla/5.0 (X11)'")) ===
      JSON.stringify(['--user-agent', 'Mozilla/5.0 (X11)'])
  );
  check(
    '空文字の引数を保てる',
    JSON.stringify(engine.tokenizeArgs('--foo ""')) === JSON.stringify(['--foo', '']),
    engine.tokenizeArgs('--foo ""')
  );

  done('site-hints');
})();
