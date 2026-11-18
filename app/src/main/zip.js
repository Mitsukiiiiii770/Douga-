'use strict';

/**
 * ZIP の読み取り。
 *
 * 更新を取ってくるために GitHub のソース ZIP を展開する必要があるが、
 * そのためだけに外部パッケージを増やしたくない（配布物が重くなるし、
 * 更新の仕組み自体が依存パッケージの更新で壊れるのは本末転倒）。
 * Node の zlib だけで足りるので、必要な部分だけ自前で読む。
 *
 * 対応するのは「格納（無圧縮）」と「deflate」の2つだけ。
 * GitHub のソース ZIP はこの2つしか使わない。
 *
 * 安全性について:
 *   展開するのはネットから落としてきたファイルなので、中身は信用しない。
 *   `../` や絶対パスを含む項目は、展開先の外にファイルを書けてしまうため
 *   必ず弾く（Zip Slip）。
 */

const zlib = require('zlib');
const path = require('path');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** EOCD（終端レコード）は末尾にある。コメントが付くことがあるので後ろから探す */
function findEndRecord(buf) {
  // 固定部 22 バイト + コメント最大 65535 バイト
  const start = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 展開先の外に出ようとするパスを弾く。
 * @returns {string|null} 安全なら正規化した相対パス、危険なら null
 */
function safePath(name) {
  if (!name) return null;
  // ZIP の区切りは / と決まっているが、\ を混ぜてくるものもある
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;
  const parts = [];
  for (const part of unified.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (!parts.length) return null;
  return parts.join('/');
}

/**
 * 中央ディレクトリを読んで項目一覧を返す。
 *
 * 圧縮後の大きさは必ず中央ディレクトリ側から取る。
 * ローカルヘッダ側は 0 が入っていることがある（flag の bit 3）ため。
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, method: number, offset: number,
 *                  compressedSize: number, size: number, directory: boolean}>}
 */
function entries(buf) {
  const end = findEndRecord(buf);
  if (end < 0) throw new Error('ZIP の終端レコードが見つかりません');

  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16);
  if (pos === 0xffffffff) throw new Error('ZIP64 には対応していません');

  const list = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length) throw new Error('ZIP が壊れています');
    if (buf.readUInt32LE(pos) !== CENTRAL_SIG) throw new Error('ZIP の中央ディレクトリが壊れています');

    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);

    list.push({
      name,
      method,
      offset,
      compressedSize,
      size,
      directory: name.endsWith('/')
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return list;
}

/** 1 項目の中身を取り出す */
function read(buf, entry) {
  const head = entry.offset;
  if (head + 30 > buf.length) throw new Error('ZIP が壊れています');
  if (buf.readUInt32LE(head) !== LOCAL_SIG) throw new Error('ZIP のヘッダが壊れています');

  const nameLen = buf.readUInt16LE(head + 26);
  const extraLen = buf.readUInt16LE(head + 28);
  const start = head + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return zlib.inflateRawSync(body);
  throw new Error(`対応していない圧縮方式です (${entry.method})`);
}

/**
 * ZIP を「相対パス → 中身」の対応表にする。
 *
 * @param {Buffer} buf
 * @param {{strip?: number}} [options] strip: 先頭から取り除く階層の数。
 *        GitHub のソース ZIP は全体が `リポジトリ名-ブランチ名/` で包まれているので 1 を渡す
 * @returns {Map<string, Buffer>}
 */
function extract(buf, options = {}) {
  const strip = options.strip || 0;
  const out = new Map();

  for (const entry of entries(buf)) {
    if (entry.directory) continue;

    const safe = safePath(entry.name);
    // 展開先の外を指す項目は、黙って飛ばさず止める。
    // 攻撃された ZIP を黙って部分展開するより、更新を失敗させたほうが安全
    if (!safe) throw new Error(`ZIP に不正なパスが含まれています: ${entry.name}`);

    const parts = safe.split('/');
    if (parts.length <= strip) continue;
    const key = parts.slice(strip).join('/');

    out.set(key, read(buf, entry));
  }
  return out;
}

module.exports = { entries, read, extract, safePath, findEndRecord, normalize: (p) => path.posix.normalize(p) };
