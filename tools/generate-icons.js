'use strict';

/**
 * 拡張機能とデスクトップアプリのアイコンを生成する。
 *
 *   npm run icons        （リポジトリ直下で）
 *   node tools/generate-icons.js
 *
 * 出力:
 *   extension/icons/icon-{16,32,48,128}.png   拡張機能
 *   app/build/icon.ico                        アプリ（インストーラと exe）
 *
 * 画像ライブラリを入れるほどの絵ではないので、PNG と ICO を直接書き出している。
 * PNG は「シグネチャ + チャンク列」で、各チャンクは
 * 長さ・種別・データ・CRC32 の並び。必要なのは IHDR / IDAT / IEND の3つだけ。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA のピクセル配列を PNG バイト列にする */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // カラータイプ: RGBA
  ihdr[10] = 0; // 圧縮方式
  ihdr[11] = 0; // フィルタ方式
  ihdr[12] = 0; // インターレースなし

  // 各行の先頭にフィルタ種別（0 = なし）のバイトが要る
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 背景の角丸四角の内側かどうか */
function insideRoundedSquare(x, y, size) {
  const radius = size * 0.22;
  const min = radius;
  const max = size - radius;
  const cx = Math.min(Math.max(x, min), max);
  const cy = Math.min(Math.max(y, min), max);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 中央の再生三角形の内側かどうか */
function insideTriangle(x, y, size) {
  // 見た目の重心が中央に来るよう、やや右に寄せた正三角形
  const left = size * 0.36;
  const right = size * 0.72;
  const top = size * 0.26;
  const bottom = size * 0.74;
  if (x < left || x > right) return false;
  const progress = (x - left) / (right - left);
  const half = ((bottom - top) / 2) * (1 - progress);
  const midY = (top + bottom) / 2;
  return y >= midY - half && y <= midY + half;
}

const BG = [28, 31, 39]; // アプリの --bg-elevated と同じ
const FG = [79, 140, 255]; // アプリの --accent と同じ

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  // 縁を滑らかにするため、1ピクセルを 3x3 で見て平均を取る
  const SAMPLES = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (!insideRoundedSquare(px, py, size)) continue;
          bgHits++;
          if (insideTriangle(px, py, size)) fgHits++;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = bgHits / total;
      const fgRatio = bgHits > 0 ? fgHits / bgHits : 0;

      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(BG[c] * (1 - fgRatio) + FG[c] * fgRatio);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, pixels);
}

/**
 * 複数サイズの PNG をまとめて ICO にする。
 *
 * ICO は「ヘッダ + サイズごとの目録 + 画像データ」の並び。
 * Windows Vista 以降は各画像を PNG のまま埋め込めるので、
 * ビットマップへ変換せずそのまま入れている。
 */
function encodeIco(images) {
  const HEADER = 6;
  const ENTRY = 16;

  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // 予約領域
  header.writeUInt16LE(1, 2); // 1 = アイコン
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = HEADER + ENTRY * images.length;

  for (const { size, data } of images) {
    const entry = Buffer.alloc(ENTRY);
    // 256 は 1 バイトに収まらないので 0 で表す決まり
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // パレット数（真彩色なので 0）
    entry.writeUInt8(0, 3); // 予約領域
    entry.writeUInt16LE(1, 4); // プレーン数
    entry.writeUInt16LE(32, 6); // ビット深度
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

if (require.main === module) {
  const root = path.join(__dirname, '..');

  const extDir = path.join(root, 'extension', 'icons');
  fs.mkdirSync(extDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const file = path.join(extDir, `icon-${size}.png`);
    fs.writeFileSync(file, render(size));
    console.log(`extension/icons/${path.basename(file)}`);
  }

  // Windows のインストーラと exe が使うアイコン。256px を含める必要がある
  const appBuild = path.join(root, 'app', 'build');
  fs.mkdirSync(appBuild, { recursive: true });
  const ico = encodeIco(
    [16, 32, 48, 64, 128, 256].map((size) => ({ size, data: render(size) }))
  );
  fs.writeFileSync(path.join(appBuild, 'icon.ico'), ico);
  console.log('app/build/icon.ico');
}

module.exports = { encodePng, encodeIco, render, crc32 };
