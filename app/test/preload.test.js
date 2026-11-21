'use strict';

/**
 * 画面と preload の橋渡しが噛み合っているかを検証する。
 *
 * レンダラーは nodeIntegration 無効なので、主処理に触るには preload が
 * 公開した口しか使えない。公開を足し忘れると、押した瞬間に
 * 「api.xxx.yyy is not a function」で止まる。
 *
 * 実際それが起きた。「10秒お試し」を作ったとき preload への追加が
 * 無言で失敗しており、構文検査は通るので気づけなかった。
 * 機械で分かることなので機械に見させる。
 */

const fs = require('fs');
const path = require('path');
const { group, check, done } = require('./helper');

const SRC = path.resolve(__dirname, '..', 'src');
const preload = fs.readFileSync(path.join(SRC, 'preload', 'index.js'), 'utf8');
const renderer = fs.readFileSync(path.join(SRC, 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(SRC, 'main', 'index.js'), 'utf8');

/** preload が公開している名前を読み取る（2 段までの入れ子） */
function exposedApi(source) {
  const start = source.indexOf("exposeInMainWorld('douga', {");
  if (start < 0) return {};
  const body = source.slice(start);
  const api = {};
  let current = null;

  for (const line of body.split('\n')) {
    const namespace = line.match(/^ {2}(\w+): \{/);
    if (namespace) {
      current = namespace[1];
      api[current] = new Set();
      continue;
    }
    if (/^ {2}\}/.test(line)) {
      current = null;
      continue;
    }
    const member = line.match(/^ {4}(\w+):/);
    if (member && current) api[current].add(member[1]);
  }
  return api;
}

const api = exposedApi(preload);

(() => {
  group('公開されている口');
  check('読み取れている', Object.keys(api).length > 5, Object.keys(api).join(', '));
  for (const ns of ['settings', 'engine', 'jobs', 'browse', 'postprocess', 'update', 'shell']) {
    check(`${ns} がある`, !!api[ns]);
  }

  group('画面が呼ぶ口が全て存在する');
  const calls = [...renderer.matchAll(/\bapi\.(\w+)\.(\w+)\s*\(/g)].map((m) => ({
    ns: m[1],
    fn: m[2]
  }));
  check('呼び出しを拾えている', calls.length > 20, `${calls.length} 箇所`);

  const missing = [];
  for (const call of calls) {
    if (!api[call.ns] || !api[call.ns].has(call.fn)) {
      missing.push(`api.${call.ns}.${call.fn}`);
    }
  }
  check(
    '公開されていない口を呼んでいない',
    missing.length === 0,
    missing.length ? `足りない: ${[...new Set(missing)].join(', ')}` : ''
  );

  group('preload が呼ぶ窓口が主処理にある');
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  check('窓口を拾えている', channels.length > 20, `${channels.length} 件`);

  // 引数が複数行に分かれている書き方もあるので、文字列一致では拾えない
  const handled = new Set(
    [...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1])
  );
  const unhandled = [...new Set(channels)].filter((channel) => !handled.has(channel));
  check(
    '受け手のいない窓口が無い',
    unhandled.length === 0,
    unhandled.length ? `受け手なし: ${unhandled.join(', ')}` : ''
  );

  group('主処理からの通知を画面が受け取れる');
  const sent = [...new Set([...main.matchAll(/send\('([^']+)'/g)].map((m) => m[1]))];
  const listened = [...preload.matchAll(/listen\('([^']+)'\)/g)].map((m) => m[1]);
  const deaf = sent.filter((channel) => !listened.includes(channel));
  check(
    '届け先のない通知が無い',
    deaf.length === 0,
    deaf.length ? `受け取る口が無い: ${deaf.join(', ')}` : ''
  );

  group('画面の id と JavaScript の対応');
  const html = fs.readFileSync(path.join(SRC, 'renderer', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...renderer.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const absent = [...used].filter((id) => !ids.has(id));
  check(
    '参照している id が全て画面にある',
    absent.length === 0,
    absent.length ? `無い id: ${absent.join(', ')}` : ''
  );

  done('preload');
})();
