'use strict';

/**
 * 保存ファイル名がタイトルになるかを検証する。
 *
 * マニフェスト URL へフォールバックすると yt-dlp は URL のファイル名から
 * タイトルを作るため、放っておくと全部 "master" で保存される。
 */

const path = require('path');
const { group, check, done } = require('./helper');

const engine = require('../src/main/engine');

const cfg = {
  downloadDir: '/out',
  container: 'mp4/mkv',
  qualityPreset: 'max',
  maxHeight: 0,
  concurrentFragments: 5,
  extraArgs: ''
};

/** -o に渡されたテンプレートを取り出す */
function outputOf(job) {
  const args = engine.buildDownloadArgs(job, cfg);
  return args[args.indexOf('-o') + 1];
}

(() => {
  group('URL 由来のタイトルを見抜く');
  const derived = [
    ['master', 'https://cdn.example.com/hls/master.m3u8'],
    ['index', 'https://cdn.example.com/dash/index.mpd'],
    ['playlist', 'https://cdn.example.com/playlist.m3u8'],
    ['manifest', 'https://cdn.example.com/manifest'],
    ['chunklist', 'https://cdn.example.com/chunklist.m3u8']
  ];
  for (const [title, url] of derived) {
    check(`"${title}" は配信都合の名前`, engine.isDerivedTitle({ title }, url) === true, title);
  }
  check(
    'URL の末尾と一致するタイトルも URL 由来',
    engine.isDerivedTitle({ title: 'video_1080p' }, 'https://x.example/video_1080p.mp4') === true
  );
  check(
    '拡張子込みで一致する場合も URL 由来',
    engine.isDerivedTitle({ title: 'clip.mp4' }, 'https://x.example/clip.mp4') === true
  );
  check(
    '本物のタイトルは URL 由来と判定しない',
    engine.isDerivedTitle({ title: '猫がキーボードを踏む動画' }, 'https://x.example/master.m3u8') === false
  );
  check(
    'URL エンコードされたファイル名も比較できる',
    engine.isDerivedTitle({ title: 'テスト動画' }, 'https://x.example/%E3%83%86%E3%82%B9%E3%83%88%E5%8B%95%E7%94%BB.mp4') === true
  );
  check('タイトルが無ければ URL 由来扱い', engine.isDerivedTitle({}, 'https://x/a.mp4') === true);
  check('空文字も URL 由来扱い', engine.isDerivedTitle({ title: '   ' }, 'https://x/a.mp4') === true);
  check(
    '壊れた URL でも例外を投げない',
    engine.isDerivedTitle({ title: 'なにか' }, 'not a url') === false
  );

  group('ページ側のタイトルで補う');
  let info = { title: 'master', url: 'https://cdn.example.com/master.m3u8', thumbnail: null };
  engine.applyPageMeta(info, {
    title: '第3話 決戦',
    thumbnail: 'https://example.com/thumb.jpg',
    duration: 1450
  });
  check('タイトルを差し替える', info.title === '第3話 決戦', info.title);
  check('差し替えたことを記録する', info.titleSource === 'page', info.titleSource);
  check('サムネイルを補う', info.thumbnail === 'https://example.com/thumb.jpg');
  check('再生時間を補う', info.duration === 1450);

  info = { title: '公式タイトル', url: 'https://example.com/watch?v=abc', duration: 100 };
  engine.applyPageMeta(info, { title: 'ページのタイトル', duration: 999 });
  check('yt-dlp が取れているタイトルは上書きしない', info.title === '公式タイトル', info.title);
  check('その場合 titleSource も付けない', !info.titleSource, info.titleSource);
  check('yt-dlp の再生時間も上書きしない', info.duration === 100, info.duration);

  info = { title: 'master', url: 'https://cdn.example.com/master.m3u8' };
  engine.applyPageMeta(info, null);
  check('meta が無ければ何もしない', info.title === 'master');
  check('info が無くても落ちない', engine.applyPageMeta(null, { title: 'x' }) === null);

  group('出力ファイル名');
  check(
    '通常は yt-dlp のタイトルに任せる',
    outputOf({ url: 'u', mode: 'best' }) === path.join('/out', '%(title).150B [%(id)s].%(ext)s'),
    outputOf({ url: 'u', mode: 'best' })
  );
  check(
    'ページ由来のタイトルはファイル名に直接使う',
    outputOf({ url: 'u', mode: 'best', title: '第3話 決戦', titleSource: 'page' }) ===
      path.join('/out', '第3話 決戦.%(ext)s'),
    outputOf({ url: 'u', mode: 'best', title: '第3話 決戦', titleSource: 'page' })
  );
  check(
    'ファイル名に使えない文字を置き換える',
    outputOf({ url: 'u', mode: 'best', title: 'A/B:C?D*E', titleSource: 'page' }) ===
      path.join('/out', 'A_B_C_D_E.%(ext)s'),
    outputOf({ url: 'u', mode: 'best', title: 'A/B:C?D*E', titleSource: 'page' })
  );
  check(
    'タイトル中の % を書式指定と誤解させない',
    outputOf({ url: 'u', mode: 'best', title: '達成率100%の話', titleSource: 'page' }) ===
      path.join('/out', '達成率100%%の話.%(ext)s'),
    outputOf({ url: 'u', mode: 'best', title: '達成率100%の話', titleSource: 'page' })
  );
  check(
    '末尾のドットと空白を落とす（Windows が扱えない）',
    outputOf({ url: 'u', mode: 'best', title: 'タイトル... ', titleSource: 'page' }) ===
      path.join('/out', 'タイトル.%(ext)s'),
    outputOf({ url: 'u', mode: 'best', title: 'タイトル... ', titleSource: 'page' })
  );
  check(
    '長すぎるタイトルは切り詰める',
    outputOf({ url: 'u', mode: 'best', title: 'あ'.repeat(300), titleSource: 'page' }).length <
      path.join('/out', 'x').length + 170
  );
  check(
    '記号だけのタイトルは既定のテンプレートに戻す',
    outputOf({ url: 'u', mode: 'best', title: '///', titleSource: 'page' }) ===
      path.join('/out', '%(title).150B [%(id)s].%(ext)s'),
    outputOf({ url: 'u', mode: 'best', title: '///', titleSource: 'page' })
  );
  check(
    'titleSource が無ければタイトルがあっても既定を使う',
    outputOf({ url: 'u', mode: 'best', title: 'なにか' }) ===
      path.join('/out', '%(title).150B [%(id)s].%(ext)s')
  );

  done('title');
})();
