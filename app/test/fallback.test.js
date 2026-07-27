'use strict';

/**
 * 「サイトを列挙せず、試して落ちたら次へ」という解析経路のテスト。
 * ここが通っていれば、対応表に無いサイトでも拡張機能経由で取得できる。
 */

const { fixture, group, check, done } = require('./helper');

const settings = require('../src/main/settings');
const engine = require('../src/main/engine');

const hls = (url) => ({ url, kind: 'hls' });
const file = (url, size) => ({ url, kind: 'file', size });

(async () => {
  settings.set({ ytdlpPath: fixture('fallback-ytdlp.py'), ffmpegPath: '', extraArgs: '' });

  group('ページ URL がそのまま通る場合');
  let result = await engine.probeChain('https://example.com/watch', [
    hls('https://cdn.example.com/master.m3u8')
  ]);
  check('ページ URL を使う', result.usedUrl === 'https://example.com/watch', result.usedUrl);
  check('無駄な再試行をしない', result.attempts.length === 0, result.attempts);
  check('形式を返す', result.info.formats.length === 1);

  group('yt-dlp が知らないサイト（Unsupported URL）');
  result = await engine.probeChain('https://unsupported.example/watch', [
    hls('https://cdn.example.com/master.m3u8')
  ]);
  check(
    '検出済みのストリームへ自動で切り替わる',
    result.usedUrl === 'https://cdn.example.com/master.m3u8',
    result.usedUrl
  );
  check('失敗した試行を記録する', result.attempts.length === 1, result.attempts);
  check(
    '失敗理由を日本語で持つ',
    /直接解析できませんでした/.test(result.attempts[0].error),
    result.attempts[0]
  );

  group('解析は通るが形式が0件（DRM ページなど）');
  result = await engine.probeChain('https://drm.example/watch', [
    hls('https://cdn.example.com/master.m3u8')
  ]);
  check(
    '形式0件も失敗として次へ進む',
    result.usedUrl === 'https://cdn.example.com/master.m3u8',
    result.usedUrl
  );
  check(
    '「形式が見つからない」と記録する',
    /形式が見つかりません/.test(result.attempts[0].error),
    result.attempts[0]
  );

  group('候補が複数あるときの順番');
  result = await engine.probeChain('https://unsupported.example/watch', [
    file('https://cdn.example.com/video.mp4', 9000000),
    hls('https://cdn.example.com/master.m3u8')
  ]);
  check(
    '単一ファイルよりマニフェストを先に試す',
    result.usedUrl === 'https://cdn.example.com/master.m3u8',
    result.usedUrl
  );

  group('ノイズ扱いの URL');
  result = await engine.probeChain('https://unsupported.example/watch', [
    { url: 'https://ads.example.com/x.mp4', kind: 'file', noise: true },
    hls('https://cdn.example.com/master.m3u8')
  ]);
  check(
    'ノイズより通常の候補を優先',
    result.usedUrl === 'https://cdn.example.com/master.m3u8',
    result.usedUrl
  );
  result = await engine.probeChain('https://unsupported.example/watch', [
    { url: 'https://ads.example.com/x.mp4', kind: 'file', noise: true }
  ]);
  check(
    '他に無ければノイズも最後の手段として試す',
    result.usedUrl === 'https://ads.example.com/x.mp4',
    result.usedUrl
  );

  group('全部だめだった場合');
  try {
    await engine.probeChain('https://unsupported.example/a', [
      hls('https://unsupported.example/b.m3u8')
    ]);
    check('例外を投げる', false);
  } catch (err) {
    check('例外を投げる', true);
    check('試したすべてを記録する', err.attempts.length === 2, err.attempts);
    check('試行回数をメッセージに含める', /2 件の URL を試しました/.test(err.message), err.message);
  }

  group('対処できるエラーを優先して見せる');
  try {
    await engine.probeChain('https://login.example/watch', [
      hls('https://unsupported.example/b.m3u8')
    ]);
    check('例外を投げる', false);
  } catch (err) {
    check(
      'ログインが必要な旨を最後のエラーより優先する',
      /ログイン/.test(err.message),
      err.message
    );
  }

  group('URL が無い場合');
  try {
    await engine.probeChain('', []);
    check('例外を投げる', false);
  } catch (err) {
    check('URL 未指定を伝える', /URL が指定されていません/.test(err.message), err.message);
  }

  group('キャンセルはフォールバックせず即座に止まる');
  const controller = new AbortController();
  controller.abort();
  try {
    await engine.probeChain('https://example.com/watch', [hls('https://cdn.example.com/a.m3u8')], {
      signal: controller.signal
    });
    check('例外を投げる', false);
  } catch (err) {
    check('キャンセルとして扱う', err.canceled === true || /キャンセル/.test(err.message), err.message);
  }

  done('fallback');
})().catch((err) => {
  console.error('例外:', err);
  process.exit(1);
});
