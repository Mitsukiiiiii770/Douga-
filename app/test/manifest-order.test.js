'use strict';

/**
 * yt-dlp が対応していないサイト（拡張機能が拾った HLS に頼る経路）で、
 * どのマニフェストを先に試すかを検証する。
 *
 * master プレイリストを渡せば画質を選べるが、variant を直接渡すと
 * その画質に固定されてしまうため、順序が結果に直結する。
 */

const { group, check, done } = require('./helper');

const engine = require('../src/main/engine');

const hls = (url) => ({ url, kind: 'hls' });

(() => {
  group('マニフェストの優先度');
  check(
    'master は最優先',
    engine.manifestPreference('https://cdn.example.com/hls/master.m3u8') === 0
  );
  check(
    'main も master 扱い',
    engine.manifestPreference('https://cdn.example.com/hls/main.m3u8') === 0
  );
  check(
    '解像度入りは variant として後回し',
    engine.manifestPreference('https://cdn.example.com/hls/1080p.m3u8') === 2
  );
  check(
    '解像度が w x h 形式でも variant',
    engine.manifestPreference('https://cdn.example.com/v_1920x1080.m3u8') === 2
  );
  check(
    'ビットレート入りも variant',
    engine.manifestPreference('https://cdn.example.com/stream_2500k.m3u8') === 2
  );
  check(
    'どちらとも言えないものは中間',
    engine.manifestPreference('https://cdn.example.com/index.m3u8') === 1
  );
  check('壊れた URL でも例外を投げない', engine.manifestPreference('not a url') === 1);

  group('解析順への反映');
  let order = engine.orderTargets('https://site.example/watch', [
    hls('https://cdn.example.com/720p.m3u8'),
    hls('https://cdn.example.com/master.m3u8'),
    hls('https://cdn.example.com/1080p.m3u8')
  ]);
  check('ページ URL が先頭', order[0] === 'https://site.example/watch');
  check(
    'variant より master を先に試す',
    order[1] === 'https://cdn.example.com/master.m3u8',
    order[1]
  );
  check('variant も候補として残る', order.length === 4, order.length);

  order = engine.orderTargets('', [
    hls('https://cdn.example.com/480p.m3u8'),
    hls('https://cdn.example.com/index.m3u8')
  ]);
  check(
    'master が無ければ、素性の分からないものを variant より先に',
    order[0] === 'https://cdn.example.com/index.m3u8',
    order[0]
  );

  group('種類の優先は変わらない');
  order = engine.orderTargets('', [
    { url: 'https://cdn.example.com/video.mp4', kind: 'file', size: 9e9 },
    hls('https://cdn.example.com/1080p.m3u8')
  ]);
  check(
    'variant のマニフェストでも単一ファイルより先',
    order[0] === 'https://cdn.example.com/1080p.m3u8',
    order[0]
  );

  done('manifest-order');
})();
