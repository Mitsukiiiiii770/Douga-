'use strict';

/**
 * 後処理（高画質化）の引数組み立てと進捗パースを検証する。
 * 実際の ffmpeg は起動しない。
 */

const path = require('path');
const { group, check, done } = require('./helper');

const postprocess = require('../src/main/postprocess');

const baseCfg = {
  postProcess: 'none',
  postProcessCustom: '',
  postEncoder: 'x264',
  postCrf: 18
};

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

(() => {
  group('フィルタチェーンの組み立て');
  check('後処理なしは空', postprocess.buildFilterChain('none', '') === '');
  check('未知のプリセットも空', postprocess.buildFilterChain('nope', '') === '');

  const restore = postprocess.buildFilterChain('restore', '');
  check('ノイズ除去を含む', restore.includes('hqdn3d'), restore);
  check('ブロックノイズ除去を含む', restore.includes('deblock'), restore);
  check('バンディング除去を含む', restore.includes('gradfun'), restore);
  check('等倍なので拡大しない', !restore.includes('scale='), restore);

  const upscale = postprocess.buildFilterChain('upscale2x', '');
  check('2倍に拡大する', upscale.includes('scale=iw*2:ih*2'), upscale);
  check('拡大には lanczos を使う', upscale.includes('flags=lanczos'), upscale);
  check('拡大前にノイズを取る', upscale.indexOf('hqdn3d') < upscale.indexOf('scale='), upscale);
  check('拡大後に先鋭化する', upscale.indexOf('scale=') < upscale.indexOf('unsharp'), upscale);

  const anime = postprocess.buildFilterChain('anime', '');
  check('アニメ向けはバンディング除去を強める', anime.includes('gradfun=1.5:12'), anime);

  check(
    'カスタム指定はプリセットより優先',
    postprocess.buildFilterChain('anime', 'scale=iw*3:ih*3') === 'scale=iw*3:ih*3'
  );
  check(
    '空白だけのカスタムは無視',
    postprocess.buildFilterChain('restore', '   ') === restore
  );

  group('ffmpeg 引数');
  let args = postprocess.buildFfmpegArgs('/in.mp4', '/out.mp4', {
    ...baseCfg,
    postProcess: 'upscale2x'
  });
  check('入力を指定', valueOf(args, '-i') === '/in.mp4');
  check('出力は最後', args[args.length - 1] === '/out.mp4');
  check('フィルタを渡す', (valueOf(args, '-vf') || '').includes('scale=iw*2'), valueOf(args, '-vf'));
  check('音声は再エンコードしない', valueOf(args, '-c:a') === 'copy', args);
  check('字幕も維持する', valueOf(args, '-c:s') === 'copy');
  check('CRF を渡す', valueOf(args, '-crf') === '18');
  check('進捗を pipe で受け取る', valueOf(args, '-progress') === 'pipe:1');
  check('上書きを許可', args.includes('-y'));

  args = postprocess.buildFfmpegArgs('/in.mp4', '/out.mp4', { ...baseCfg, postEncoder: 'x265' });
  check('H.265 を選べる', valueOf(args, '-c:v') === 'libx265', args);
  args = postprocess.buildFfmpegArgs('/in.mp4', '/out.mp4', { ...baseCfg, postEncoder: 'nope' });
  check('未知のエンコーダは H.264 に落とす', valueOf(args, '-c:v') === 'libx264');

  args = postprocess.buildFfmpegArgs('/in.mp4', '/out.mp4', { ...baseCfg, postCrf: 14 });
  check('CRF を変更できる', valueOf(args, '-crf') === '14');
  args = postprocess.buildFfmpegArgs('/in.mp4', '/out.mp4', { ...baseCfg, postCrf: 0 });
  check('CRF 0（実質可逆）も指定できる', valueOf(args, '-crf') === '0', valueOf(args, '-crf'));

  args = postprocess.buildFfmpegArgs('/in.mp4', '/out.mp4', baseCfg);
  check('後処理なしなら -vf を付けない', !args.includes('-vf'), args);

  group('出力ファイル名（元ファイルを上書きしない）');
  const upscaled = postprocess.outputPathFor(path.join('/dir', 'video.mp4'), 'upscale2x');
  check('拡大時は upscaled を付ける', path.basename(upscaled) === 'video [upscaled].mp4', upscaled);
  check('同じディレクトリに置く', path.dirname(upscaled) === path.sep + 'dir', upscaled);
  const enhanced = postprocess.outputPathFor(path.join('/dir', 'video.mp4'), 'restore');
  check('等倍時は enhanced を付ける', path.basename(enhanced) === 'video [enhanced].mp4', enhanced);
  check(
    '入力と出力が必ず異なる',
    postprocess.outputPathFor('/dir/a.mp4', 'restore') !== '/dir/a.mp4'
  );
  check(
    'webm は mkv で書き出す（H.264 を webm に入れられないため）',
    path.basename(postprocess.outputPathFor('/dir/a.webm', 'restore')) === 'a [enhanced].mkv',
    postprocess.outputPathFor('/dir/a.webm', 'restore')
  );

  group('進捗のパース');
  check(
    '経過時間から割合を出す',
    Math.round(postprocess.parseProgress('out_time_us=30000000', 60).percent) === 50,
    postprocess.parseProgress('out_time_us=30000000', 60)
  );
  check(
    '100%を超えない',
    postprocess.parseProgress('out_time_us=90000000', 60).percent === 100
  );
  check('速度を拾う', postprocess.parseProgress('speed=2.5x', 60).speed === '2.5x');
  check('終了を検出', postprocess.parseProgress('progress=end', 60).done === true);
  check('継続中は done にしない', postprocess.parseProgress('progress=continue', 60) === null);
  check('尺が不明なら割合を出さない', postprocess.parseProgress('out_time_us=1000', 0) === null);
  check('無関係な行は無視', postprocess.parseProgress('bitrate=1234kbits/s', 60) === null);

  group('プリセット一覧');
  const presets = postprocess.presetList();
  check('none を含む', presets.some((p) => p.id === 'none'));
  check('すべてラベルを持つ', presets.every((p) => !!p.label), presets);
  check('拡大倍率を持つ', presets.find((p) => p.id === 'upscale2x').scale === 2);
  check('等倍プリセットは scale 1', presets.find((p) => p.id === 'restore').scale === 1);

  done('postprocess');
})();
