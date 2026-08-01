'use strict';

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const binaries = require('./binaries');

/**
 * HLS プレイリストを自前で解析して、ffmpeg で保存する経路。
 *
 * なぜ必要か:
 *   yt-dlp は URL の拡張子から中身を推測する場面が多く、
 *   https://example.com/hls/2572/<長いトークン> のように拡張子を持たない
 *   マニフェストだと「形式が見つからない」で終わってしまう。
 *   トークン型の配信 URL は珍しくないため、拡張機能が Content-Type から
 *   「これは HLS だ」と分かっている場合は、こちらで直接読む。
 *
 * ffmpeg は拡張子に依存せず中身で判断するので、保存は ffmpeg に任せる。
 * -c copy なので再エンコードは発生しない。
 */

class HlsError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'HlsError';
    this.detail = detail;
  }
}

/** 取得する本文の上限。マニフェストがこれを超えることはない */
const MAX_BODY = 5 * 1024 * 1024;

function fetchText(url, { headers = {}, cookieHeader, signal } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new HlsError('リダイレクトが多すぎます'));
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new HlsError('URL の形式が不正です'));
    }
    const client = parsed.protocol === 'http:' ? http : https;

    const requestHeaders = {
      'User-Agent': headers.userAgent || 'Mozilla/5.0',
      Accept: '*/*'
    };
    if (headers.referer) requestHeaders.Referer = headers.referer;
    if (headers.origin) requestHeaders.Origin = headers.origin;
    if (cookieHeader) requestHeaders.Cookie = cookieHeader;

    const request = client.get(url, { headers: requestHeaders }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, { headers, cookieHeader, signal }, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new HlsError(`取得できませんでした（HTTP ${res.statusCode}）`));
      }

      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.destroy();
          reject(new HlsError('応答が大きすぎます（プレイリストではありません）'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({
          text: Buffer.concat(chunks).toString('utf8'),
          finalUrl: url,
          contentType: res.headers['content-type'] || ''
        })
      );
      res.on('error', reject);
    });

    request.on('error', (err) => reject(new HlsError(err.message)));
    if (signal) {
      const onAbort = () => request.destroy(new HlsError('キャンセルされました'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 本文が HLS プレイリストか（拡張子ではなく中身で判断する） */
function isPlaylist(text) {
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

/** マスタープレイリストか（画質ごとの variant を束ねているか） */
function isMaster(text) {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

/** #EXT-X-STREAM-INF の属性を読む。値は引用符付きのこともある */
function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(line))) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

/**
 * マスタープレイリストから画質の一覧を作る。
 * yt-dlp の formats と同じ形にそろえて、UI 側を共通で使えるようにする。
 */
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const formats = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    // 属性行の次の非コメント行が variant の URL
    let target = '';
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      target = candidate;
      break;
    }
    if (!target) continue;

    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    const [width, height] = (attrs.RESOLUTION || '').split('x').map((n) => Number(n) || null);
    const bandwidth = Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH']) || null;
    const codecs = (attrs.CODECS || '').split(',').map((c) => c.trim()).filter(Boolean);

    let url;
    try {
      url = new URL(target, baseUrl).toString();
    } catch {
      continue;
    }

    formats.push({
      id: `hls-${height || bandwidth || formats.length}`,
      ext: 'mp4',
      protocol: 'm3u8',
      url,
      width: width || null,
      height: height || null,
      fps: Number(attrs['FRAME-RATE']) || null,
      // BANDWIDTH は bps、tbr は kbps
      tbr: bandwidth ? Math.round(bandwidth / 1000) : null,
      abr: null,
      vcodec: codecs.find((c) => /^(avc|hev|hvc|av01|vp0?9)/i.test(c)) || null,
      acodec: codecs.find((c) => /^(mp4a|ac-3|ec-3|opus)/i.test(c)) || null,
      dynamicRange: null,
      audioChannels: null,
      filesize: null,
      note: 'HLS',
      kind: 'both',
      language: null
    });
  }

  // 解像度の高い順
  formats.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  return formats;
}

/** メディアプレイリストの #EXTINF を合計して尺を出す */
function parseDuration(text) {
  let total = 0;
  for (const match of text.matchAll(/^#EXTINF:\s*([\d.]+)/gm)) {
    total += Number(match[1]) || 0;
  }
  return total > 0 ? total : null;
}

/**
 * URL を HLS として解析する。
 * プレイリストでなければ null を返し、呼び出し側は別の手段へ進む。
 */
async function probe(url, options = {}) {
  const { text, finalUrl } = await fetchText(url, options);
  if (!isPlaylist(text)) return null;

  if (isMaster(text)) {
    const formats = parseMaster(text, finalUrl);
    if (formats.length === 0) throw new HlsError('プレイリストに画質の情報がありませんでした。');
    return { source: 'hls', url, formats, duration: null };
  }

  // 画質が 1 つだけのプレイリスト
  return {
    source: 'hls',
    url,
    duration: parseDuration(text),
    formats: [
      {
        id: 'hls',
        ext: 'mp4',
        protocol: 'm3u8',
        url: finalUrl,
        width: null,
        height: null,
        fps: null,
        tbr: null,
        abr: null,
        vcodec: null,
        acodec: null,
        dynamicRange: null,
        audioChannels: null,
        filesize: null,
        note: 'HLS',
        kind: 'both',
        language: null
      }
    ]
  };
}

/* ---------------- ダウンロード ---------------- */

/** ffmpeg に渡すヘッダは CRLF 区切りの 1 文字列 */
function headerBlock(headers = {}, cookieHeader) {
  const lines = [];
  if (headers.referer) lines.push(`Referer: ${headers.referer}`);
  if (headers.origin) lines.push(`Origin: ${headers.origin}`);
  if (cookieHeader) lines.push(`Cookie: ${cookieHeader}`);
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}

/**
 * 出力コンテナを決める。
 * mp4 に AAC 以外の音声は入れにくいので、確証があるときだけ mp4 を使う。
 */
function containerFor(format) {
  const acodec = (format && format.acodec) || '';
  return !acodec || /^mp4a/i.test(acodec) ? 'mp4' : 'mkv';
}

function buildFfmpegArgs(job, output) {
  const format = (job.formats || []).find((f) => f.id === job.formatId) || (job.formats || [])[0];
  const target = (format && format.url) || job.url;

  const args = ['-y', '-hide_banner', '-nostats'];

  const block = headerBlock(job.headers, job.cookieHeader);
  if (block) args.push('-headers', block);
  if (job.headers && job.headers.userAgent) args.push('-user_agent', job.headers.userAgent);

  // HLS は暗号鍵の取得などで複数のプロトコルをまたぐ
  args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');
  args.push('-i', target);

  // 再エンコードしない。TS から mp4 へ移すときは音声のヘッダ形式だけ変換が要る
  args.push('-c', 'copy');
  if (output.endsWith('.mp4')) args.push('-bsf:a', 'aac_adtstoasc');
  args.push('-progress', 'pipe:1', output);
  return args;
}

/** ffmpeg の stderr に出る Duration: 00:24:13.45 を秒に直す */
function parseDurationLine(line) {
  const match = line.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
  if (!match) return null;
  const [, h, m, s, frac] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);
}

function download(job, output, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const bin = binaries.ffmpeg();
    if (!bin) {
      return reject(
        new HlsError('ffmpeg が見つかりません。設定タブからインストールしてください。')
      );
    }

    const child = spawn(bin, buildFfmpegArgs(job, output), { windowsHide: true });
    const stderrTail = [];
    let duration = job.duration || null;
    let buffer = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        const micros = line.match(/^out_time_us=(\d+)$/);
        if (micros && duration) {
          onProgress &&
            onProgress({ percent: Math.min(100, (Number(micros[1]) / 1e6 / duration) * 100) });
        }
        const speed = line.match(/^speed=(.+)$/);
        if (speed) onProgress && onProgress({ speed: speed[1].trim() });
      }
    });

    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        // 尺が分かるのは解析後なので、stderr から拾って進捗計算に使う
        if (!duration) duration = parseDurationLine(line) || duration;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
      }
    });

    const onAbort = () => child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) =>
      reject(new HlsError(`ffmpeg を起動できませんでした: ${err.message}`))
    );
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) return resolve({ filePath: output });
      if (signal && signal.aborted) {
        const err = new HlsError('キャンセルされました');
        err.canceled = true;
        return reject(err);
      }
      reject(new HlsError(friendlyError(stderrTail), stderrTail.join('\n')));
    });
  });
}

function friendlyError(lines) {
  const text = lines.join('\n');
  if (/403|Forbidden/i.test(text)) {
    return 'サーバーにアクセスを拒否されました。拡張機能の Cookie 送信を有効にして再試行してください。';
  }
  if (/404|Not Found/i.test(text)) return 'プレイリストが見つかりませんでした（404）。';
  if (/Invalid data found/i.test(text)) return 'この URL は再生可能な形式ではありませんでした。';
  if (/No space left/i.test(text)) return 'ディスクの空き容量が足りません。';
  return lines[lines.length - 1] || 'ダウンロードに失敗しました。';
}

module.exports = {
  probe,
  download,
  buildFfmpegArgs,
  containerFor,
  parseMaster,
  parseDuration,
  parseDurationLine,
  isPlaylist,
  isMaster,
  headerBlock,
  HlsError
};
