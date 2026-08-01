'use strict';

/**
 * 拡張子の無い HLS を自前で読む経路の検証。
 *
 * https://example.com/hls/2572/<トークン> のように拡張子を持たない
 * マニフェストは yt-dlp が中身を判別できず「形式0件」で終わる。
 * その受け皿がこの経路なので、パーサと ffmpeg 引数を固めておく。
 */

const { group, check, done } = require('./helper');

const hls = require('../src/main/hls');

const MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=60
https://other-cdn.example.com/1080/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
seg-1.ts
#EXTINF:9.009,
seg-2.ts
#EXTINF:3.500,
seg-3.ts
#EXT-X-ENDLIST
`;

/** args から flag の直後の値を取り出す */
function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

(() => {
  group('プレイリストの判別（拡張子ではなく中身で見る）');
  check('マスターを認識', hls.isPlaylist(MASTER) === true);
  check('メディアプレイリストを認識', hls.isPlaylist(MEDIA) === true);
  check('先頭に空白があっても認識', hls.isPlaylist('\n  #EXTM3U\n') === true);
  check('HTML はプレイリストではない', hls.isPlaylist('<!DOCTYPE html>') === false);
  check('空文字も違う', hls.isPlaylist('') === false);
  check('マスターと単一を区別', hls.isMaster(MASTER) === true && hls.isMaster(MEDIA) === false);

  group('マスタープレイリストの解析');
  const formats = hls.parseMaster(MASTER, 'https://cdn.example.com/hls/2572/token');
  check('3 画質を取り出す', formats.length === 3, formats.length);
  check('解像度の高い順に並ぶ', formats[0].height === 1080, formats.map((f) => f.height));
  check('解像度を読む', formats[0].width === 1920 && formats[0].height === 1080);
  check('フレームレートを読む', formats[0].fps === 60, formats[0].fps);
  check(
    'BANDWIDTH(bps) を tbr(kbps) に直す',
    formats[0].tbr === 5000,
    formats[0].tbr
  );
  check('映像コーデックを読む', formats[0].vcodec === 'avc1.640028', formats[0].vcodec);
  check('音声コーデックを読む', formats[0].acodec === 'mp4a.40.2', formats[0].acodec);
  check(
    '相対 URL を絶対 URL に直す',
    formats[1].url === 'https://cdn.example.com/hls/2572/720/index.m3u8',
    formats[1].url
  );
  check(
    '絶対 URL はそのまま使う',
    formats[0].url === 'https://other-cdn.example.com/1080/index.m3u8',
    formats[0].url
  );
  check('映像+音声として扱う', formats.every((f) => f.kind === 'both'));
  check('画質ごとに別 id が付く', new Set(formats.map((f) => f.id)).size === 3);

  group('尺の計算');
  check('EXTINF を合計する', Math.abs(hls.parseDuration(MEDIA) - 21.518) < 0.001, hls.parseDuration(MEDIA));
  check('EXTINF が無ければ null', hls.parseDuration(MASTER) === null);
  check(
    'ffmpeg の Duration 行を読む',
    Math.abs(hls.parseDurationLine('  Duration: 00:24:13.45, start: 0.0') - 1453.45) < 0.01,
    hls.parseDurationLine('  Duration: 00:24:13.45, start: 0.0')
  );
  check('無関係な行は null', hls.parseDurationLine('frame= 100 fps=25') === null);

  group('出力コンテナ（音声コーデックで決める）');
  check('AAC なら mp4', hls.containerFor({ acodec: 'mp4a.40.2' }) === 'mp4');
  check('不明なら mp4', hls.containerFor({}) === 'mp4');
  check('AAC 以外は mkv（mp4 に収まらない）', hls.containerFor({ acodec: 'opus' }) === 'mkv');
  check('AC-3 も mkv', hls.containerFor({ acodec: 'ac-3' }) === 'mkv');

  group('ffmpeg 引数');
  const job = {
    url: 'https://cdn.example.com/hls/2572/token',
    formatId: formats[1].id,
    formats,
    headers: { referer: 'https://site.example/watch', userAgent: 'UA/1.0' },
    cookieHeader: 'sid=abc'
  };
  let args = hls.buildFfmpegArgs(job, '/out/video.mp4');
  check(
    '選んだ画質の URL を入力にする',
    valueOf(args, '-i') === 'https://cdn.example.com/hls/2572/720/index.m3u8',
    valueOf(args, '-i')
  );
  check('再エンコードしない', valueOf(args, '-c') === 'copy');
  check('Referer を渡す', (valueOf(args, '-headers') || '').includes('Referer: https://site.example/watch'));
  check('Cookie を渡す', (valueOf(args, '-headers') || '').includes('Cookie: sid=abc'));
  check('User-Agent を渡す', valueOf(args, '-user_agent') === 'UA/1.0');
  check(
    'HLS が使うプロトコルを許可する',
    (valueOf(args, '-protocol_whitelist') || '').includes('crypto')
  );
  check('mp4 では音声ヘッダを変換する', args.includes('aac_adtstoasc'), args);
  check('出力は最後', args[args.length - 1] === '/out/video.mp4');
  check('ヘッダは -i より前に置く', args.indexOf('-headers') < args.indexOf('-i'));

  args = hls.buildFfmpegArgs(job, '/out/video.mkv');
  check('mkv では音声ヘッダ変換を付けない', !args.includes('aac_adtstoasc'), args);

  args = hls.buildFfmpegArgs({ url: 'https://x/a', formats: [] }, '/out/a.mp4');
  check('画質情報が無ければ元の URL を使う', valueOf(args, '-i') === 'https://x/a');
  check('ヘッダが無ければ -headers を付けない', !args.includes('-headers'), args);

  group('ヘッダの組み立て');
  check('空なら空文字', hls.headerBlock({}, null) === '');
  check(
    'CRLF で区切って末尾にも付ける',
    hls.headerBlock({ referer: 'https://a/' }, 'k=v') === 'Referer: https://a/\r\nCookie: k=v\r\n',
    JSON.stringify(hls.headerBlock({ referer: 'https://a/' }, 'k=v'))
  );

  done('hls');
})();
