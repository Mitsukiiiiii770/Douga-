'use strict';

/**
 * 検出ログを検証する。
 *
 * このログの目的は「手元で再現できない取りこぼしの原因を特定すること」なので、
 * 次の2点が崩れると意味がなくなる:
 *   1. 捨てた URL とその理由が必ず残る
 *   2. Cookie やトークンの全体が書き出されない
 */

const { group, check, done } = require('./helper');

const detect = require('../src/shared/detect');
const diagnostics = require('../src/main/diagnostics');

(() => {
  group('判定の理由');
  const reason = (input) => detect.explain(input).reason;

  check(
    'UI の効果音は「小さすぎる」で落ちる',
    /小さすぎる/.test(
      reason({
        url: 'https://www.youtube.com/s/search/audio/no_input.mp3',
        mime: 'audio/mpeg',
        size: 6800,
        isMedia: true
      })
    ),
    reason({
      url: 'https://www.youtube.com/s/search/audio/no_input.mp3',
      mime: 'audio/mpeg',
      size: 6800,
      isMedia: true
    })
  );
  check(
    '大きさの閾値が理由に入る（何 KB で落ちたか分かる）',
    /50\.0 KB/.test(reason({ url: 'https://x.example/a.mp4', size: 1024, isMedia: true }))
  );
  check(
    'セグメントは理由つきで落ちる',
    /セグメント/.test(reason({ url: 'https://x.example/seg-1.ts', mime: 'video/mp2t', isMedia: true }))
  );
  check(
    'マニフェストは小さくても落ちない',
    detect.explain({ url: 'https://x.example/master.m3u8', size: 400 }).kind === 'hls'
  );
  check(
    '採用したものにも理由が付く',
    detect.explain({ url: 'https://x.example/a.mp4', size: 9e6, isMedia: true }).reason === '採用'
  );
  check(
    '降格した場合はそう書かれる',
    /降格/.test(
      reason({ url: 'https://ads.adtng.com/creatives/1/a.mp4', mime: 'video/mp4', size: 9e6 })
    )
  );
  check(
    'blob: は理由つきで落ちる',
    /blob/.test(reason({ url: 'blob:https://x.example/abc', isMedia: true }))
  );
  check(
    '大きさが分からないファイルは落とさない',
    detect.explain({ url: 'https://x.example/a.mp4', size: null, isMedia: true }).kind === 'file'
  );
  check(
    'shouldRecord は explain と一致する',
    detect.shouldRecord({ url: 'https://x.example/a.mp4', size: 9e6, isMedia: true }) ===
      detect.explain({ url: 'https://x.example/a.mp4', size: 9e6, isMedia: true }).kind
  );

  group('長い URL の切り詰め');
  const longUrl = `https://x.example/hls/${'t'.repeat(600)}`;
  const trimmed = diagnostics.trimUrl(longUrl);
  check('上限を超えない', trimmed.length < longUrl.length, trimmed.length);
  check('元の長さが分かる', /600 \+ 22|622 文字/.test(trimmed) || /文字\)$/.test(trimmed), trimmed);
  check('ホストは残る', trimmed.startsWith('https://x.example/hls/'));
  check('短い URL はそのまま', diagnostics.trimUrl('https://x.example/a.mp4') === 'https://x.example/a.mp4');

  group('理由ごとのまとめ');
  const grouped = diagnostics.groupByReason([
    { reason: 'A' },
    { reason: 'B' },
    { reason: 'A' },
    { reason: 'A' }
  ]);
  check('件数の多い理由が先', grouped[0][0] === 'A' && grouped[0][1].length === 3);
  check('理由の数だけ並ぶ', grouped.length === 2);
  check('理由が空でも落ちない', diagnostics.groupByReason([{}])[0][0] === '(理由なし)');

  group('書き出しの内容');
  diagnostics.reset();
  diagnostics.observe({
    url: 'https://site.example/hls/2572/token',
    mime: 'application/vnd.apple.mpegurl',
    size: 1200,
    resourceType: 'xhr',
    kind: 'hls',
    reason: '採用'
  });
  diagnostics.observe({
    url: 'https://www.youtube.com/s/search/audio/no_input.mp3',
    mime: 'audio/mpeg',
    size: 6800,
    resourceType: 'media',
    kind: null,
    reason: '小さすぎる（6.6 KB < 50.0 KB）'
  });
  diagnostics.skip();
  diagnostics.skip();
  diagnostics.segment();
  diagnostics.capture({
    source: '拡張機能',
    pageUrl: 'https://site.example/watch?v=1',
    pageTitle: 'ある動画',
    segments: 12,
    uninteresting: 30,
    meta: { title: '本当のタイトル', duration: 300, thumbnail: 'https://x/t.jpg' },
    candidates: [{ url: 'https://site.example/hls/2572/token', kind: 'hls', size: null }],
    rejected: [
      { url: 'https://x.example/a.mp3', reason: '小さすぎる（6.6 KB < 50.0 KB）', size: 6800 },
      { url: 'https://x.example/b.mp3', reason: '小さすぎる（6.6 KB < 50.0 KB）', size: 6800 }
    ]
  });
  diagnostics.probe({
    target: 'https://site.example/watch?v=1',
    ok: false,
    error: '再生できる形式が見つかりませんでした。',
    attempts: [
      { url: 'https://site.example/watch?v=1', error: 'Unsupported URL' },
      { url: 'https://site.example/hls/2572/token', formats: 0 }
    ]
  });
  diagnostics.note('yt-dlp が見つかりません');

  const text = diagnostics.report(diagnostics.snapshot(), { app: '0.1.0', ytdlp: '2025.01.01' });

  check('採用した URL が入る', text.includes('https://site.example/hls/2572/token'));
  check('不採用の理由が入る', text.includes('小さすぎる'));
  check('不採用の URL が入る', text.includes('no_input.mp3'));
  check('試行した URL が入る', text.includes('Unsupported URL'));
  check('ページから読み取ったタイトルが入る', text.includes('本当のタイトル'));
  check('手がかりの無い通信は件数だけ', /CSS・画像など）: 2 件/.test(text), text.match(/CSS.*/)?.[0]);
  check('セグメントも件数が入る', /セグメントの通信: 1 件/.test(text));
  check('拡張機能の不採用がまとめられる', /小さすぎる.*2 件/.test(text));
  check('バージョン情報が入る', text.includes('yt-dlp: 2025.01.01'));
  check('その他の記録が入る', text.includes('yt-dlp が見つかりません'));
  check('Cookie の注意書きが入る', text.includes('Cookie'));
  check('節に分かれている', (text.match(/={6,}/g) || []).length >= 4);

  group('Cookie を書き出さない');
  diagnostics.reset();
  diagnostics.capture({
    pageUrl: 'https://site.example/',
    cookies: [{ name: 'session', value: 'SECRET-TOKEN-VALUE' }],
    candidates: [],
    rejected: []
  });
  const safe = diagnostics.report();
  check('Cookie の値は出ない', !safe.includes('SECRET-TOKEN-VALUE'), safe.includes('SECRET'));
  check('Cookie の名前も出ない', !safe.includes('session'));

  group('記録の消去と上限');
  diagnostics.reset();
  check('消した直後は空', diagnostics.snapshot().observed.length === 0);
  check('消した直後は件数も 0', diagnostics.snapshot().uninteresting === 0);
  for (let i = 0; i < diagnostics.MAX_ENTRIES + 50; i++) {
    diagnostics.observe({ url: `https://x.example/${i}.mp4`, kind: 'file', reason: '採用' });
  }
  check(
    '上限を超えない',
    diagnostics.snapshot().observed.length === diagnostics.MAX_ENTRIES,
    diagnostics.snapshot().observed.length
  );
  check(
    '新しいものが残る',
    diagnostics.snapshot().observed.at(-1).url.includes(`${diagnostics.MAX_ENTRIES + 49}.mp4`)
  );
  check('空の状態でも書き出せる', (() => {
    diagnostics.reset();
    const empty = diagnostics.report();
    return empty.includes('まだ解析していません') && empty.includes('ここまで');
  })());

  done('diagnostics');
})();
