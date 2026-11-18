'use strict';

/**
 * 保存されたファイルの場所の特定を検証する。
 *
 * ここが外れると、ダウンロード自体は成功しているのに後処理が
 * 「後処理の対象ファイルが見つかりません」で落ちる。
 * 実際に次の形でそれが起きた:
 *
 *   Music Video [...] - Metamorphose [1_NOTHw2lj].mkv は保存されているのに、
 *   高画質化だけが対象を見つけられずに失敗した。
 *
 * ファイルシステムは触らず、差し替え口から与える。
 */

const path = require('path');
const { group, check, done } = require('./helper');

const engine = require('../src/main/engine');

/** 指定したパスだけが存在する世界を作る */
function world(files, times = {}) {
  const set = new Set(files);
  return {
    exists: (target) => set.has(target),
    listDir: (dir) =>
      files
        .filter((f) => path.dirname(f) === dir)
        .map((f) => path.basename(f)),
    modifiedAt: (target) => (times[target] === undefined ? 1000 : times[target])
  };
}

const DIR = path.join('C:', 'Users', 'x', 'Desktop', '動画ダウンロード');
const MKV = path.join(DIR, 'Music Video [HATSUBOSHI GAKUEN] - Metamorphose [1_NOTHw2lj].mkv');
const TEMP_MP4 = path.join(DIR, 'Music Video [HATSUBOSHI GAKUEN] - Metamorphose [1_NOTHw2lj].f399.mp4');

(() => {
  group('yt-dlp が書き出した最終パスを最優先する');
  check(
    '書き出された値をそのまま使う',
    engine.resolveOutputPath({ printed: MKV, merged: null, destination: TEMP_MP4 }, world([MKV])) === MKV
  );
  check(
    '書き出された値が無ければ結合先を使う',
    engine.resolveOutputPath({ merged: MKV, destination: TEMP_MP4 }, world([MKV])) === MKV
  );
  check(
    'どちらも無ければダウンロード先を使う',
    engine.resolveOutputPath({ destination: MKV }, world([MKV])) === MKV
  );
  check(
    '存在しない値は飛ばす',
    engine.resolveOutputPath({ printed: path.join(DIR, '消えた.mp4'), merged: MKV }, world([MKV])) === MKV,
    '一時ファイルは結合後に消えるため'
  );

  group('結合でコンテナが変わった場合');
  check(
    'mp4 と言われても実体が mkv なら見つける',
    engine.resolveOutputPath({ destination: TEMP_MP4.replace('.f399.mp4', '.mp4') }, world([MKV])) === MKV,
    engine.resolveOutputPath({ destination: TEMP_MP4.replace('.f399.mp4', '.mp4') }, world([MKV]))
  );
  check(
    'webm に落ちた場合も見つける',
    (() => {
      const webm = path.join(DIR, 'a.webm');
      return engine.resolveOutputPath({ destination: path.join(DIR, 'a.mp4') }, world([webm])) === webm;
    })()
  );
  check(
    '音声だけの場合も見つける',
    (() => {
      const m4a = path.join(DIR, 'b.m4a');
      return engine.resolveOutputPath({ destination: path.join(DIR, 'b.webm') }, world([m4a])) === m4a;
    })()
  );
  check(
    '角括弧を含むタイトルでも壊れない',
    engine.resolveOutputPath({ destination: TEMP_MP4.replace('.f399.mp4', '.mp4') }, world([MKV])).includes(
      '[HATSUBOSHI GAKUEN]'
    )
  );

  group('出力を全く読み取れなかった場合');
  const started = 50_000;
  const fresh = path.join(DIR, '新しい.mkv');
  const old = path.join(DIR, '前からある.mkv');
  check(
    'この回に作られた一番新しい動画を拾う',
    engine.resolveOutputPath(
      { outDir: DIR, startedAt: started },
      world([DIR, fresh, old], { [DIR]: 0, [fresh]: 60_000, [old]: 10_000 })
    ) === fresh
  );
  check(
    'ダウンロード前からあるファイルは拾わない',
    engine.resolveOutputPath(
      { outDir: DIR, startedAt: started },
      world([DIR, old], { [DIR]: 0, [old]: 10_000 })
    ) === null,
    '別の動画を後処理してしまわないため'
  );
  check(
    '動画・音声以外は拾わない',
    engine.resolveOutputPath(
      { outDir: DIR, startedAt: started },
      world([DIR, path.join(DIR, 'メモ.txt')], { [DIR]: 0, [path.join(DIR, 'メモ.txt')]: 60_000 })
    ) === null
  );
  check(
    '保存先が無ければ推測を返す',
    engine.resolveOutputPath({ destination: MKV, outDir: null }, world([])) === MKV
  );
  check('手がかりが何も無ければ null', engine.resolveOutputPath({}, world([])) === null);

  group('引数の組み立て');
  const args = engine.buildDownloadArgs(
    { url: 'https://example.com/v', outDir: DIR, mode: 'video' },
    { downloadDir: DIR, container: 'mp4/mkv', qualityPreset: 'max' },
    { pathFile: 'C:\\tmp\\out.txt' }
  );
  const index = args.indexOf('--print-to-file');
  check('最終パスの書き出しを頼む', index >= 0, args.join(' '));
  check('全ての後処理の後の値を頼む', args[index + 1] === 'after_move:filepath');
  check('書き出し先を渡す', args[index + 2] === 'C:\\tmp\\out.txt');
  check('URL は最後に置く', args[args.length - 1] === 'https://example.com/v');
  check(
    '書き出し先を渡さなければ付けない',
    !engine
      .buildDownloadArgs(
        { url: 'https://example.com/v', outDir: DIR },
        { downloadDir: DIR, qualityPreset: 'max' }
      )
      .includes('--print-to-file'),
    '古い yt-dlp へ落とすときに外せること'
  );

  done('outpath');
})();
