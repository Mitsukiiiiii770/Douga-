'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const binaries = require('./binaries');
const settings = require('./settings');

/**
 * ダウンロード後の高画質化（後処理）。
 *
 * 前提として、元動画に無い情報は復元できない。ここでできるのは2種類:
 *
 *   1. 劣化の除去 — 配信時の圧縮で入ったブロックノイズ・バンディング・
 *      リンギングを取り除く。元動画に含まれる「傷」を消す作業なので、
 *      素直に見た目が良くなる。ffmpeg だけで完結する。
 *   2. detail の生成 — AI が推測した質感を描き足す。情報の復元ではなく
 *      生成だが、特にアニメでは効果が大きい。Real-ESRGAN を使う。
 *
 * どちらも再エンコードを伴うので、元ファイルより厳密な意味で「劣化しない」
 * わけではない。CRF を十分低く取って知覚上の劣化を無視できる範囲に収める。
 */

class PostProcessError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'PostProcessError';
    this.detail = detail;
  }
}

/**
 * プリセットごとの ffmpeg フィルタ。
 *
 * hqdn3d  : 時間方向も使うノイズ除去。圧縮ノイズに効く
 * deblock : ブロック境界のならし
 * gradfun : グラデーションのバンディング（縞）除去
 * unsharp : 輪郭の復元。かけ過ぎると不自然になるので控えめに
 * scale   : lanczos は拡大時に最もシャープな部類
 */
const PRESETS = {
  none: {
    label: '後処理なし',
    filters: [],
    scale: 1
  },
  restore: {
    label: '圧縮ノイズ除去（等倍）',
    filters: ['hqdn3d=1.5:1.5:6:6', 'deblock=filter=weak:block=4', 'gradfun=1.2:8'],
    scale: 1
  },
  sharpen: {
    label: '軽い先鋭化（等倍）',
    filters: ['hqdn3d=1:1:4:4', 'unsharp=5:5:0.8:5:5:0.0'],
    scale: 1
  },
  upscale2x: {
    label: '2倍アップスケール（Lanczos）',
    filters: ['hqdn3d=1.5:1.5:6:6', 'scale=iw*2:ih*2:flags=lanczos', 'unsharp=5:5:0.5:5:5:0.0'],
    scale: 2
  },
  anime: {
    label: 'アニメ向け（ノイズ除去＋2倍）',
    // アニメは平坦部が広くバンディングが出やすいので gradfun を強めに入れる
    filters: [
      'hqdn3d=2:1.5:8:6',
      'gradfun=1.5:12',
      'scale=iw*2:ih*2:flags=lanczos',
      'unsharp=5:5:0.7:5:5:0.0'
    ],
    scale: 2
  }
};

const ENCODERS = {
  x264: { label: 'H.264（互換性が高い）', args: ['-c:v', 'libx264', '-preset', 'slow'] },
  x265: { label: 'H.265（同画質でファイル小）', args: ['-c:v', 'libx265', '-preset', 'medium'] }
};

function presetList() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, scale: p.scale }));
}

/**
 * -vf に渡すフィルタ文字列を組み立てる。
 * カスタム指定があればプリセットより優先する。
 */
function buildFilterChain(presetId, custom) {
  if (custom && custom.trim()) return custom.trim();
  const preset = PRESETS[presetId];
  if (!preset || preset.filters.length === 0) return '';
  return preset.filters.join(',');
}

/**
 * ffmpeg の引数を組み立てる。実行と分離してあるので単体で検証できる。
 */
function buildFfmpegArgs(input, output, cfg) {
  const args = ['-y', '-hide_banner', '-nostats', '-i', input];

  const chain = buildFilterChain(cfg.postProcess, cfg.postProcessCustom);
  if (chain) args.push('-vf', chain);

  const encoder = ENCODERS[cfg.postEncoder] || ENCODERS.x264;
  args.push(...encoder.args);
  // CRF は小さいほど高画質。18 前後で知覚上ほぼ劣化なし
  args.push('-crf', String(cfg.postCrf ?? 18));
  args.push('-pix_fmt', 'yuv420p');

  // 音声は触らない。再エンコードすると純粋に劣化するだけ
  args.push('-c:a', 'copy');
  // 字幕やチャプターも維持する
  args.push('-c:s', 'copy');

  // どのストリームを通すかを明示する。
  //
  // 以前は -map 0 で「入力の全部」を指定していたが、これだと
  // 埋め込みサムネイル（カバーアート）も映像として扱われ、
  // フィルタと再エンコードの対象になって ffmpeg ごと落ちていた
  // （画面には "Conversion failed!" としか出ない）。
  //
  // 大文字の V は「添付画像を除く映像」を指す。これで本編だけを拾える。
  args.push('-map', '0:V:0');
  // ? を付けると、無い場合に失敗しない
  args.push('-map', '0:a?');
  args.push('-map', '0:s?');
  if (supportsAttachments(output)) {
    // mkv は字幕用フォントなどを添付として持てる。mp4 は持てないので付けない
    args.push('-map', '0:t?', '-c:t', 'copy');
  }

  args.push('-progress', 'pipe:1');
  args.push(output);
  return args;
}

/** 添付ストリーム（フォント等）を持てる入れ物か */
function supportsAttachments(filePath) {
  return /\.(mkv|mka|webm)$/i.test(String(filePath || ''));
}

/** 出力ファイル名。元ファイルは残し、別名で書き出す */
function outputPathFor(input, presetId) {
  const dir = path.dirname(input);
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  const suffix = PRESETS[presetId] && PRESETS[presetId].scale > 1 ? 'upscaled' : 'enhanced';
  return path.join(dir, `${base} [${suffix}]${ext === '.webm' ? '.mkv' : ext}`);
}

/** ffmpeg の -progress 出力から進捗を読む */
function parseProgress(line, durationSeconds) {
  const match = line.match(/^(out_time_us|out_time_ms|frame|speed|progress)=(.*)$/);
  if (!match) return null;
  const [, key, rawValue] = match;
  const value = rawValue.trim();

  if (key === 'out_time_us' || key === 'out_time_ms') {
    // out_time_ms は実際にはマイクロ秒で出てくる（ffmpeg の既知の癖）
    const micros = Number(value);
    if (!Number.isFinite(micros) || !durationSeconds) return null;
    return { percent: Math.min(100, (micros / 1e6 / durationSeconds) * 100) };
  }
  if (key === 'speed') return { speed: value };
  if (key === 'progress' && value === 'end') return { done: true };
  return null;
}

function runFfmpeg(args, { onProgress, duration, signal } = {}) {
  return new Promise((resolve, reject) => {
    const bin = binaries.ffmpeg();
    if (!bin) {
      return reject(
        new PostProcessError('ffmpeg が見つかりません。設定タブからインストールしてください。')
      );
    }
    const child = spawn(bin, args, { windowsHide: true });
    const stderrTail = [];
    let buffer = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        const update = parseProgress(line, duration);
        if (update && onProgress) onProgress(update);
      }
    });
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
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
      reject(new PostProcessError(`ffmpeg を起動できませんでした: ${err.message}`))
    );
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) return resolve();
      if (signal && signal.aborted) {
        const err = new PostProcessError('キャンセルされました');
        err.canceled = true;
        return reject(err);
      }
      reject(new PostProcessError(friendlyError(stderrTail), stderrTail.join('\n')));
    });
  });
}

/**
 * ffmpeg の出力から、利用者に意味の通る説明を作る。
 *
 * ffmpeg は失敗すると最後に必ず "Conversion failed!" と出す。
 * 以前は最終行をそのまま見せていたため、どの動画で失敗しても
 * 同じ文言しか出ず、原因が全く分からなかった。
 * 本当の理由はその手前の行にあるので、そちらを探す。
 */
function friendlyError(lines) {
  const text = lines.join('\n');
  if (/No such filter|Unknown filter/i.test(text)) {
    return 'フィルタ指定が不正です。カスタムフィルタの内容を確認してください。';
  }
  if (/Unknown encoder/i.test(text)) {
    return '指定したエンコーダがこの ffmpeg に含まれていません。別のエンコーダを選んでください。';
  }
  if (/No space left/i.test(text)) return 'ディスクの空き容量が足りません。';
  if (/Permission denied/i.test(text)) return 'ファイルに書き込めません。保存先の権限を確認してください。';
  if (/Invalid data found/i.test(text)) return '元の動画を読み取れません。ダウンロードが壊れている可能性があります。';
  if (/could not find tag|Could not write header/i.test(text)) {
    return 'この形式では保存できない音声・字幕が含まれています。保存形式を mkv にすると通ることがあります。';
  }
  if (/Filtergraph .* was (specified|defined)/i.test(text)) {
    return 'フィルタを適用できないストリームがあります。';
  }

  return meaningfulError(lines) || '後処理に失敗しました。';
}

/** 締めの決まり文句ではなく、原因を述べている行を探す */
function meaningfulError(lines) {
  const noise =
    /^(Conversion failed|Error while filtering|Press \[q\]|frame=|size=|video:|\[.*\] Error (sending|submitting))/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i]).trim();
    if (!line || noise.test(line)) continue;
    if (/error|invalid|unable|unsupported|no such|cannot|could not|failed|denied/i.test(line)) {
      return line;
    }
  }
  // それらしい行が無ければ、決まり文句以外の最後の行
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i]).trim();
    if (line && !noise.test(line)) return line;
  }
  return '';
}

/**
 * ダウンロード済みファイルに後処理をかける。
 * 元ファイルは消さず、別名で書き出す。
 */
async function process(filePath, { duration, onProgress, signal } = {}) {
  const cfg = settings.get();
  if (!cfg.postProcess || cfg.postProcess === 'none') return null;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new PostProcessError('後処理の対象ファイルが見つかりません。');
  }

  const output = outputPathFor(filePath, cfg.postProcess);
  await runFfmpeg(buildFfmpegArgs(filePath, output, cfg), { onProgress, duration, signal });
  return output;
}

/* ---------------- Real-ESRGAN（detail を生成する経路） ---------------- */

/**
 * フレームに分解して Real-ESRGAN にかけ、再結合する。
 *
 * ffmpeg のフィルタと違い、こちらは学習済みモデルが「無かったはずの
 * 質感」を描き足す。情報の復元ではないが、実写よりアニメで効果が大きい。
 *
 * 全フレームを PNG で書き出すため、一時領域を大量に使う。
 * 1080p 5分の動画でおよそ 20〜40GB になる点に注意。
 */
async function upscaleWithEsrgan(filePath, { scale = 2, model, onProgress, signal } = {}) {
  const esrgan = binaries.realesrgan();
  if (!esrgan) {
    throw new PostProcessError(
      'Real-ESRGAN が見つかりません。設定タブからインストールするか、実行ファイルのパスを指定してください。'
    );
  }
  const ffmpeg = binaries.ffmpeg();
  if (!ffmpeg) throw new PostProcessError('ffmpeg が見つかりません。');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'douga-esrgan-'));
  const framesIn = path.join(work, 'in');
  const framesOut = path.join(work, 'out');
  fs.mkdirSync(framesIn, { recursive: true });
  fs.mkdirSync(framesOut, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch { /* 一時領域の削除失敗は無視 */ }
  };

  try {
    onProgress && onProgress({ stage: 'extract', percent: 0 });
    await runFfmpeg(
      ['-y', '-hide_banner', '-nostats', '-i', filePath, path.join(framesIn, '%08d.png'), '-progress', 'pipe:1'],
      { signal }
    );

    onProgress && onProgress({ stage: 'upscale', percent: 0 });
    await runEsrgan(esrgan, framesIn, framesOut, { scale, model, onProgress, signal });

    onProgress && onProgress({ stage: 'encode', percent: 0 });
    const cfg = settings.get();
    const output = outputPathFor(filePath, 'upscale2x');
    const encoder = ENCODERS[cfg.postEncoder] || ENCODERS.x264;
    await runFfmpeg(
      [
        '-y',
        '-hide_banner',
        '-nostats',
        '-framerate',
        String(cfg.postFrameRate || 30),
        '-i',
        path.join(framesOut, '%08d.png'),
        // 音声は元ファイルからそのまま持ってくる
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-map',
        '1:a?',
        ...encoder.args,
        '-crf',
        String(cfg.postCrf ?? 18),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        '-progress',
        'pipe:1',
        output
      ],
      { signal }
    );
    return output;
  } finally {
    cleanup();
  }
}

function runEsrgan(bin, inDir, outDir, { scale, model, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const args = ['-i', inDir, '-o', outDir, '-s', String(scale)];
    if (model) args.push('-n', model);

    const child = spawn(bin, args, { windowsHide: true });
    const stderrTail = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        // ncnn 版は "12.34%" 形式で進捗を出す
        const match = line.match(/([\d.]+)%/);
        if (match && onProgress) {
          onProgress({ stage: 'upscale', percent: Number(match[1]) });
        }
      }
    });

    const onAbort = () => child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) =>
      reject(new PostProcessError(`Real-ESRGAN を起動できませんでした: ${err.message}`))
    );
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) return resolve();
      if (signal && signal.aborted) {
        const err = new PostProcessError('キャンセルされました');
        err.canceled = true;
        return reject(err);
      }
      reject(new PostProcessError('Real-ESRGAN の処理に失敗しました。', stderrTail.join('\n')));
    });
  });
}

module.exports = {
  PRESETS,
  ENCODERS,
  presetList,
  buildFilterChain,
  buildFfmpegArgs,
  friendlyError,
  meaningfulError,
  supportsAttachments,
  outputPathFor,
  parseProgress,
  process,
  upscaleWithEsrgan,
  PostProcessError
};
