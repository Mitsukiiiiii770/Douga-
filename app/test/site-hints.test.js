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
    querySelectorAll: () =>
      statusHrefs.map((href) => ({ getAttribute: () => href }))
  };
  return { closest: (selector) => (selector === 'article' ? article : null) };
}

(() => {
  group('ページ URL の正規化');
  check(
    'YouTube: 再生リスト内でも1本に絞る',
    hints.normalizePageUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4') ===
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    hints.normalizePageUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4')
  );
  check(
    'YouTube: Shorts はパスを保つ',
    hints.normalizePageUrl('https://www.youtube.com/shorts/abc123?feature=share') ===
      'https://www.youtube.com/shorts/abc123'
  );
  check(
    'youtu.be: 短縮 URL のトラッキング用 si を落とす',
    hints.normalizePageUrl('https://youtu.be/abc123?si=xyz') === 'https://youtu.be/abc123'
  );
  check(
    'X: /status/<id>/video/1 を投稿 URL に丸める',
    hints.normalizePageUrl('https://x.com/someone/status/1234567890/video/1') ===
      'https://x.com/someone/status/1234567890'
  );
  check(
    'twitter.com も x.com に寄せる',
    hints.normalizePageUrl('https://twitter.com/someone/status/1234567890') ===
      'https://x.com/someone/status/1234567890'
  );
  check(
    'Pornhub: viewkey を壊さない',
    hints.normalizePageUrl('https://www.pornhub.com/view_video.php?viewkey=ph123abc') ===
      'https://www.pornhub.com/view_video.php?viewkey=ph123abc',
    hints.normalizePageUrl('https://www.pornhub.com/view_video.php?viewkey=ph123abc')
  );
  check(
    'Xvideos: 動画 URL をそのまま通す',
    hints.normalizePageUrl('https://www.xvideos.com/video12345/title_here') ===
      'https://www.xvideos.com/video12345/title_here'
  );
  check(
    'hanime.tv: 動画 URL をそのまま通す',
    hints.normalizePageUrl('https://hanime.tv/videos/hentai/some-title-1') ===
      'https://hanime.tv/videos/hentai/some-title-1'
  );
  check('壊れた URL でも例外を投げない', hints.normalizePageUrl('not a url') === 'not a url');

  group('X: 再生中の投稿 URL をたどる');
  check(
    'article 内の /status/ リンクを拾う',
    hints.targetForMedia(
      'https://x.com/home',
      fakeTweetVideo(['/someone/status/999', '/someone/status/999/likes'])
    ) === 'https://x.com/someone/status/999'
  );
  check(
    'X 以外では null（ページ URL を使う）',
    hints.targetForMedia('https://www.youtube.com/watch?v=a', fakeTweetVideo(['/x/status/1'])) === null
  );
  check(
    'article が無ければ null',
    hints.targetForMedia('https://x.com/home', { closest: () => null }) === null
  );
  check('メディア要素が無ければ null', hints.targetForMedia('https://x.com/home', null) === null);

  group('ページ URL を優先すべきサイトの判定');
  for (const url of [
    'https://www.youtube.com/watch?v=a',
    'https://youtu.be/a',
    'https://x.com/a/status/1',
    'https://www.pornhub.com/view_video.php?viewkey=a',
    'https://www.xvideos.com/video1/a'
  ]) {
    check(`${hints.hostOf(url)} はページ URL 優先`, hints.prefersPageUrl(url) === true, url);
  }
  check(
    'hanime.tv は専用エクストラクタが無いのでストリーム優先',
    hints.prefersPageUrl('https://hanime.tv/videos/hentai/a') === false
  );

  group('候補の降格');
  check(
    'YouTube の実体 URL は降格',
    hints.isDemoted('https://rr3---sn-abc.googlevideo.com/videoplayback?x=1') === true
  );
  check(
    '広告配信ドメインは降格',
    hints.isDemoted('https://ads.trafficjunky.net/x.mp4') === true
  );
  check(
    '通常の CDN は降格しない',
    hints.isDemoted('https://cdn.hanime.tv/master.m3u8') === false
  );
  check(
    'Xvideos の配信 URL は降格しない',
    hints.isDemoted('https://cdn77-vid.xvideos-cdn.com/x.mp4') === false
  );

  group('サイト別の注意書き');
  check('YouTube に注意書きがある', !!hints.noteFor('https://www.youtube.com/watch?v=a'));
  check('X に注意書きがある', !!hints.noteFor('https://x.com/a/status/1'));
  check('hanime.tv に注意書きがある', !!hints.noteFor('https://hanime.tv/videos/hentai/a'));
  check('未知のサイトは注意書きなし', hints.noteFor('https://example.com/a') === null);

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
