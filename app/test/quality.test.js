'use strict';

/**
 * 画質に関わる引数の組み立てを検証する。
 * ここが崩れると、黙って劣化した動画が保存されるので単体で固めておく。
 */

const { group, check, done } = require('./helper');

const engine = require('../src/main/engine');

const baseCfg = {
  downloadDir: '/out',
  container: 'mp4/mkv',
  qualityPreset: 'max',
  maxHeight: 0,
  concurrentFragments: 5,
  extraArgs: ''
};

/** args から `flag` の直後の値を取り出す */
function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

const formats = [
  { id: '137', kind: 'video', height: 1080 },
  { id: '18', kind: 'both', height: 360 },
  { id: '251', kind: 'audio' }
];

(() => {
  group('画質の優先順位（-S）');
  let fields = engine.buildSortFields(baseCfg);
  check('解像度を最優先', fields[0] === 'res', fields);
  check('フレームレートを次に見る', fields[1] === 'fps', fields);
  check('HDR を Dolby Vision まで含めて優先', fields.includes('hdr:12'), fields);
  check('音声チャンネル数も見る', fields.includes('channels'), fields);
  check('ビットレートは最後', fields[fields.length - 1] === 'br', fields);

  fields = engine.buildSortFields({ ...baseCfg, qualityPreset: 'compat' });
  check('互換性優先では H.264 を選ばせる', fields.includes('vcodec:h264'), fields);
  check('互換性優先では AAC を選ばせる', fields.includes('acodec:aac'), fields);
  check('互換性優先では HDR を優先しない', !fields.includes('hdr:12'), fields);
  check('互換性優先でも解像度は最優先', fields[0] === 'res', fields);

  fields = engine.buildSortFields({ ...baseCfg, maxHeight: 1080 });
  check('上限を指定すると先頭に来る', fields[0] === 'res:1080', fields);
  check('上限指定でも他の条件は残る', fields.includes('hdr:12'), fields);
  check('上限なしなら res: を付けない', !engine.buildSortFields(baseCfg).some((f) => f.startsWith('res:')));

  group('映像の選び方');
  check(
    '最高画質は映像単体+音声単体を優先する',
    engine.buildSelector({ mode: 'best', formats }) === 'bestvideo*+bestaudio/best'
  );
  check(
    '映像のみの形式を選んだら音声を自動で足す',
    engine.buildSelector({ mode: 'format', formatId: '137', formats }) === '137+bestaudio/137'
  );
  check(
    '映像+音声入りの形式はそのまま',
    engine.buildSelector({ mode: 'format', formatId: '18', formats }) === '18'
  );

  group('コンテナ（再エンコードを避ける）');
  let args = engine.buildDownloadArgs({ url: 'u', mode: 'best' }, baseCfg);
  check(
    '既定は mp4、収まらなければ mkv',
    valueOf(args, '--merge-output-format') === 'mp4/mkv',
    valueOf(args, '--merge-output-format')
  );
  check('-S を必ず渡す', args.includes('-S'), args);
  args = engine.buildDownloadArgs({ url: 'u', mode: 'best' }, { ...baseCfg, container: 'mkv' });
  check('明示指定を尊重する', valueOf(args, '--merge-output-format') === 'mkv');

  group('音声のみ（既定で再エンコードしない）');
  args = engine.buildDownloadArgs({ url: 'u', mode: 'audio' }, baseCfg);
  check('形式未指定なら best（元のまま）', valueOf(args, '--audio-format') === 'best', args);
  check(
    '可逆な取り出しでは --audio-quality を付けない',
    !args.includes('--audio-quality'),
    args
  );
  check('コンテナ指定は付けない', !args.includes('--merge-output-format'));

  args = engine.buildDownloadArgs({ url: 'u', mode: 'audio', audioFormat: 'flac' }, baseCfg);
  check('flac でも --audio-quality を付けない', !args.includes('--audio-quality'), args);

  args = engine.buildDownloadArgs({ url: 'u', mode: 'audio', audioFormat: 'mp3' }, baseCfg);
  check('mp3 のときだけ品質指定を付ける', valueOf(args, '--audio-quality') === '0', args);
  check('mp3 を指定すればそれに従う', valueOf(args, '--audio-format') === 'mp3');

  group('その他の引数');
  args = engine.buildDownloadArgs(
    { url: 'https://example.com/v', mode: 'best', subtitles: true, embedThumbnail: true },
    baseCfg
  );
  check('URL は最後', args[args.length - 1] === 'https://example.com/v');
  check('字幕を埋め込む', args.includes('--embed-subs'));
  check('サムネイルを埋め込む', args.includes('--embed-thumbnail'));
  check('プレイリスト展開を抑止', args.includes('--no-playlist'));
  args = engine.buildDownloadArgs({ url: 'u', mode: 'best' }, baseCfg);
  check('指定しなければ字幕を付けない', !args.includes('--embed-subs'));
  check(
    '追加オプションを反映する',
    engine.buildDownloadArgs({ url: 'u', mode: 'best' }, { ...baseCfg, extraArgs: '--geo-bypass' }).includes(
      '--geo-bypass'
    )
  );

  group('形式一覧の並び');
  const sorted = engine.normalizeFormats({
    formats: [
      { format_id: 'a', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, tbr: 3000 },
      { format_id: 'b', vcodec: 'vp9', acodec: 'none', height: 1080, fps: 60, tbr: 4000 },
      { format_id: 'c', vcodec: 'av01', acodec: 'none', height: 2160, fps: 60, tbr: 12000 },
      {
        format_id: 'd',
        vcodec: 'vp9',
        acodec: 'none',
        height: 1080,
        fps: 60,
        tbr: 5000,
        dynamic_range: 'HDR10'
      }
    ]
  });
  check('解像度が最優先', sorted[0].id === 'c', sorted.map((f) => f.id));
  check('同解像度ならフレームレート', sorted[1].id !== 'a', sorted.map((f) => f.id));
  check('同解像度・同fps なら HDR', sorted[1].id === 'd', sorted.map((f) => f.id));
  check('HDR 情報を保持する', sorted[1].dynamicRange === 'HDR10', sorted[1]);

  group('aria2c があれば使う');
  // yt-dlp 内蔵のダウンローダは 1 本の接続で順に取る。
  // aria2c は 1 ファイルを複数の接続に分けて同時に取れるので速い
  const binaries = require('../src/main/binaries');
  const realAria = binaries.aria2c;

  binaries.aria2c = () => 'C:\\bin\\aria2c.exe';
  const withAria = engine
    .buildDownloadArgs({ url: 'https://x/v', outDir: '/out' }, { downloadDir: '/out', useAria2: true })
    .join(' ');
  check('ダウンローダとして渡す', withAria.includes('--downloader C:\\bin\\aria2c.exe'), withAria);
  check('接続数を指定する', /aria2c:-x16 -s16 -k1M/.test(withAria), withAria);

  const disabled = engine
    .buildDownloadArgs({ url: 'https://x/v', outDir: '/out' }, { downloadDir: '/out', useAria2: false })
    .join(' ');
  check('設定で切れる', !disabled.includes('--downloader'), disabled);

  binaries.aria2c = () => null;
  const without = engine
    .buildDownloadArgs({ url: 'https://x/v', outDir: '/out' }, { downloadDir: '/out', useAria2: true })
    .join(' ');
  check(
    '入っていなければ何も足さない',
    !without.includes('--downloader'),
    '任意のものなので、無くても従来どおり動く'
  );
  check('その場合も URL は最後', without.endsWith('https://x/v'));

  binaries.aria2c = realAria;

  done('quality');
})();
