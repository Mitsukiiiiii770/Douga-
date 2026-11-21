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

  group('通すストリームを明示する');
  // -map 0 で全部を対象にすると、埋め込みサムネイル（カバーアート）まで
  // 映像として再エンコードされ、ffmpeg が落ちる。画面には
  // "Conversion failed!" としか出ず、原因が分からなかった
  const mkvArgs = postprocess.buildFfmpegArgs('/in.mkv', '/out.mkv', baseCfg);
  const joined = mkvArgs.join(' ');

  check('入力を丸ごと指定しない', !/-map 0(?= |$)/.test(joined), joined);
  check('本編の映像だけを拾う', joined.includes('-map 0:V:0'), '大文字 V は添付画像を除く映像');
  check('音声は無くても失敗しない', joined.includes('-map 0:a?'));
  check('字幕は無くても失敗しない', joined.includes('-map 0:s?'));
  check('mkv なら添付も引き継ぐ', joined.includes('-map 0:t?') && joined.includes('-c:t copy'));
  check('音声は再エンコードしない', joined.includes('-c:a copy'));

  const mp4Args = postprocess.buildFfmpegArgs('/in.mp4', '/out.mp4', baseCfg).join(' ');
  check(
    'mp4 には添付を付けない',
    !mp4Args.includes('-map 0:t?'),
    'mp4 は添付を持てないので、付けると書き出しごと失敗する'
  );

  check('mkv は添付を持てる', postprocess.supportsAttachments('/a/b.mkv'));
  check('webm も持てる', postprocess.supportsAttachments('x.WEBM'));
  check('mp4 は持てない', !postprocess.supportsAttachments('x.mp4'));
  check('空でも落ちない', !postprocess.supportsAttachments(null));

  group('失敗の本当の理由を拾う');
  // ffmpeg は失敗すると必ず最後に "Conversion failed!" と出す。
  // 最終行をそのまま見せると、どの失敗でも同じ文言になってしまう
  const say = (lines) => postprocess.friendlyError(lines);

  check(
    '締めの決まり文句は見せない',
    say(['[libx264 @ 0x1] Invalid level', 'Conversion failed!']) !== 'Conversion failed!',
    say(['[libx264 @ 0x1] Invalid level', 'Conversion failed!'])
  );
  check(
    '手前の原因を拾う',
    /Invalid level/.test(say(['[libx264 @ 0x1] Invalid level', 'Conversion failed!']))
  );
  check(
    '進捗行は原因として扱わない',
    /No such file/.test(say(['Error opening output: No such file', 'frame= 10 fps=5', 'Conversion failed!'])),
    say(['Error opening output: No such file', 'frame= 10 fps=5', 'Conversion failed!'])
  );
  check(
    '書き込めない場合を説明する',
    /権限/.test(say(['[out] Permission denied', 'Conversion failed!']))
  );
  check(
    '壊れた動画を説明する',
    /壊れている/.test(say(['[mkv @ 0x1] Invalid data found when processing input']))
  );
  check(
    '入れ物に収まらない場合を説明する',
    /mkv/.test(say(['[mp4 @ 0x1] Could not write header for output file'])),
    say(['[mp4 @ 0x1] Could not write header for output file'])
  );
  check('既知のフィルタ誤りは従来どおり', /フィルタ/.test(say(['No such filter: hqdn3dx'])));
  check('空でも文言を返す', say([]) === '後処理に失敗しました。');
  check(
    '決まり文句しか無ければ既定の文言',
    say(['Conversion failed!']) === '後処理に失敗しました。',
    say(['Conversion failed!'])
  );

  group('10 秒お試し');
  // 高画質化は数時間かかることがある。効くかどうか分からないまま
  // 待つのは無駄なので、短く試せる必要がある
  const orig = postprocess.buildSampleOriginalArgs('/in.mkv', '/out.mkv', { start: 30, seconds: 10 });
  const origLine = orig.join(' ');
  check('切り出しは -i より前', origLine.indexOf('-ss') < origLine.indexOf('-i'), '後ろだと先頭から復号して遅い');
  check('長さを指定する', origLine.includes('-t 10'));
  check('元は作り直さない', origLine.includes('-c copy'), '比べる相手は手元の実物でなければ意味がない');
  check('カバーアートは通さない', origLine.includes('-map 0:V:0'));
  check('音声は無くても失敗しない', origLine.includes('-map 0:a?'));

  // baseCfg は postProcess:'none' なので、フィルタの入るプリセットで見る
  const sampleCfg = { ...baseCfg, postProcess: 'restore' };
  const trimmed = postprocess
    .buildFfmpegArgs('/in.mkv', '/out.mkv', sampleCfg, { trim: { start: 30, seconds: 10 } })
    .join(' ');
  check('処理側も -i より前で切り出す', trimmed.indexOf('-ss') < trimmed.indexOf('-i'), trimmed);
  check('処理側はフィルタが入る', trimmed.includes('-vf'), trimmed);
  check('同じ 10 秒を取る', trimmed.includes('-ss 30') && trimmed.includes('-t 10'));
  check(
    '切り出さない場合は -ss を付けない',
    !postprocess.buildFfmpegArgs('/in.mkv', '/out.mkv', sampleCfg).includes('-ss')
  );

  group('切り出す位置');
  check('長い動画は真ん中あたり', postprocess.sampleStart(600) === 300);
  check('短い動画は先頭から', postprocess.sampleStart(15) === 0, '真ん中だと 10 秒取れない');
  check('長さが分からなければ先頭', postprocess.sampleStart(undefined) === 0);
  check('0 でも落ちない', postprocess.sampleStart(0) === 0);

  group('お試しのファイル名');
  const made = postprocess.samplePathFor('/dir/動画 [abc].mkv', '元');
  check('元ファイルを上書きしない', made !== '/dir/動画 [abc].mkv');
  check('拡張子は引き継ぐ', made.endsWith('.mkv'), made);
  check('どちらか分かる名前', made.includes('お試し-元'), made);
  check(
    '処理後と名前が衝突しない',
    postprocess.samplePathFor('/dir/a.mkv', '元') !== postprocess.samplePathFor('/dir/a.mkv', '処理後')
  );

  done('postprocess');
})();
