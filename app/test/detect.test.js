'use strict';

/**
 * 拡張機能から独立させた検出ロジックの検証。
 * アプリ内ブラウザ（拡張機能なしの経路）がこの判定を使う。
 */

const { group, check, done } = require('./helper');
const detect = require('../src/shared/detect');

(() => {
  group('種別の判定');
  check('m3u8 は HLS', detect.classify('https://x/master.m3u8', '') === 'hls');
  check('mpd は DASH', detect.classify('https://x/index.mpd', '') === 'dash');
  check('Content-Type からも判定', detect.classify('https://x/abc', 'application/x-mpegurl') === 'hls');
  check(
    '拡張子も Content-Type も無ければパスで判定',
    detect.classify('https://x/hls/2572/token', '') === 'hls'
  );
  check('mp4 はファイル', detect.classify('https://x/a.mp4', '') === 'file');
  check('無関係な URL は判定しない', detect.classify('https://x/api/v8/video?id=1', '') === null);

  group('セグメントは候補に出さない');
  check('.ts はセグメント', detect.isSegment('https://x/seg-1.ts') === true);
  check('.m4s もセグメント', detect.isSegment('https://x/seg-1.m4s') === true);
  check('マニフェストはセグメントではない', detect.isSegment('https://x/master.m3u8') === false);

  group('候補にするかの判断');
  check(
    'メディア要素が出したリクエストは拡張子不要',
    detect.shouldRecord({ url: 'https://x/stream', mime: '', isMedia: true }) === 'file'
  );
  check(
    '小さすぎる mp4 はプレビューとみなして捨てる',
    detect.shouldRecord({ url: 'https://x/a.mp4', mime: 'video/mp4', size: 1000, isMedia: false }) === null
  );
  check(
    '十分な大きさの mp4 は採用',
    detect.shouldRecord({ url: 'https://x/a.mp4', mime: 'video/mp4', size: 9e6, isMedia: false }) === 'file'
  );
  check(
    'マニフェストは大きさを問わず採用',
    detect.shouldRecord({ url: 'https://x/master.m3u8', mime: '', size: 300, isMedia: false }) === 'hls'
  );
  check('blob: は対象外', detect.shouldRecord({ url: 'blob:https://x/abc', isMedia: true }) === null);
  check('data: は対象外', detect.shouldRecord({ url: 'data:video/mp4,AAA', isMedia: true }) === null);
  check(
    'セグメントは採用しない',
    detect.shouldRecord({ url: 'https://x/seg-1.ts', mime: 'video/mp2t', isMedia: true }) === null
  );

  group('ノイズ判定（除外ではなく降格）');
  check('広告ドメイン', detect.isNoise('https://ht-cdn2.adtng.com/a/x.mp4') === true);
  check('広告のパス', detect.isNoise('https://cdn.example.com/creatives/1/x.mp4') === true);
  check('形式ごとに分かれる実体 URL', detect.isNoise('https://r1.googlevideo.com/videoplayback') === true);
  check('通常の CDN は降格しない', detect.isNoise('https://cdn.example.com/master.m3u8') === false);
  check('壊れた URL でも例外を投げない', detect.isNoise('not a url') === false);

  group('表示ラベル');
  check(
    'ファイル名と種別を出す',
    detect.labelFor('https://x/master.m3u8', 'hls', null) === 'master.m3u8 — HLS プレイリスト'
  );
  check(
    '大きさが分かれば添える',
    detect.labelFor('https://x/a.mp4', 'file', 1536 * 1024).includes('1.5 MB')
  );

  done('detect');
})();
