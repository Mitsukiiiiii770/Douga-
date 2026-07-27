'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');
const settings = require('./settings');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

const YTDLP_URL = IS_WIN
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : process.platform === 'darwin'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

const FFMPEG_ZIP_URL =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

/** 同梱 bin ディレクトリ（開発時は app/bin、配布時は resources/bin） */
function binDir() {
  const packed = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'bin');
  return packed;
}

/** ユーザーがダウンロードしたバイナリの置き場（書き込み可能） */
function userBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

function isExecutable(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function fromPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 優先順: 設定で明示されたパス → ユーザー bin → 同梱 bin → PATH
 */
function resolveBinary(name, configured) {
  if (isExecutable(configured)) return configured;
  const local = [
    path.join(userBinDir(), name + EXE),
    path.join(binDir(), name + EXE)
  ];
  for (const p of local) if (isExecutable(p)) return p;
  return fromPath(name);
}

function ytdlp() {
  return resolveBinary('yt-dlp', settings.get().ytdlpPath);
}

function ffmpeg() {
  return resolveBinary('ffmpeg', settings.get().ffmpegPath);
}

/** 任意インストール。無くても ffmpeg ベースの後処理は使える */
function realesrgan() {
  return (
    resolveBinary('realesrgan-ncnn-vulkan', settings.get().realesrganPath) ||
    resolveBinary('realesrgan', settings.get().realesrganPath)
  );
}

function version(bin, args = ['--version']) {
  return new Promise((resolve) => {
    if (!bin) return resolve(null);
    execFile(bin, args, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim().split('\n')[0]);
    });
  });
}

async function status() {
  const y = ytdlp();
  const f = ffmpeg();
  const r = realesrgan();
  const [yv, fv] = await Promise.all([version(y), version(f, ['-version'])]);
  return {
    ytdlp: { path: y, version: yv, ok: !!yv },
    ffmpeg: { path: f, version: fv ? fv.replace(/^ffmpeg version /, '') : null, ok: !!fv },
    // 任意。無くても ffmpeg ベースの後処理は使えるので、バージョン確認まではしない
    realesrgan: { path: r, version: null, ok: !!r, optional: true },
    platform: process.platform
  };
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('リダイレクトが多すぎます'));
    https
      .get(url, { headers: { 'User-Agent': 'Douga' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(download(next, dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`ダウンロード失敗 (HTTP ${res.statusCode})`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest + '.part');
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              fs.renameSync(dest + '.part', dest);
              if (!IS_WIN) fs.chmodSync(dest, 0o755);
              resolve(dest);
            } catch (err) {
              reject(err);
            }
          });
        });
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function unzipWindows(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
      ],
      { windowsHide: true }
    );
    let stderr = '';
    ps.stderr.on('data', (d) => (stderr += d));
    ps.on('error', reject);
    ps.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || `展開に失敗しました (code ${code})`))
    );
  });
}

function findFileRecursive(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

/**
 * yt-dlp を取得して userData/bin に配置する。
 */
async function installYtdlp(onProgress) {
  const dest = path.join(userBinDir(), 'yt-dlp' + EXE);
  await download(YTDLP_URL, dest, (received, total) =>
    onProgress && onProgress({ stage: 'yt-dlp', received, total })
  );
  settings.set({ ytdlpPath: dest });
  return dest;
}

/**
 * ffmpeg を取得。Windows のみ自動対応（zip 展開）。
 */
async function installFfmpeg(onProgress) {
  if (!IS_WIN) {
    throw new Error(
      'ffmpeg の自動インストールは Windows のみ対応しています。macOS は `brew install ffmpeg`、Linux は各ディストリのパッケージからインストールしてください。'
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douga-ffmpeg-'));
  const zip = path.join(tmp, 'ffmpeg.zip');
  await download(FFMPEG_ZIP_URL, zip, (received, total) =>
    onProgress && onProgress({ stage: 'ffmpeg', received, total })
  );
  onProgress && onProgress({ stage: 'ffmpeg-extract' });
  await unzipWindows(zip, tmp);

  const results = {};
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const found = findFileRecursive(tmp, name);
    if (!found) throw new Error(`${name} が展開結果に見つかりませんでした`);
    const dest = path.join(userBinDir(), name);
    fs.mkdirSync(userBinDir(), { recursive: true });
    fs.copyFileSync(found, dest);
    results[name] = dest;
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* 一時ディレクトリの削除失敗は無視 */ }

  settings.set({ ffmpegPath: results['ffmpeg.exe'] });
  return results['ffmpeg.exe'];
}

module.exports = {
  ytdlp,
  ffmpeg,
  realesrgan,
  status,
  installYtdlp,
  installFfmpeg,
  userBinDir,
  binDir
};
