'use strict';

/**
 * ランチャー（Douga起動.bat）を検証する。
 *
 * なぜテストするか:
 *   cmd.exe はバッチファイルを「システムの OEM コードページ」で読む。
 *   先頭に chcp 65001 を書いても、ファイル自体の読み取りには効かない。
 *   そのため UTF-8 の日本語を直接書くと、2 バイト目以降がずれて
 *   コメントの途中からコマンドとして実行されることがある。
 *
 *   実際に次のエラーが出ていた:
 *     '◆先に取得を試みる。' is not recognized as an internal or external command
 *
 *   日本語は messages\*.txt に置き、type で表示する（type の中身は
 *   cmd が解釈しないので安全）。この決まりが崩れていないか見張る。
 */

const fs = require('fs');
const path = require('path');
const { group, check, done } = require('./helper');

const ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(ROOT, 'Douga起動.bat');

(() => {
  group('バッチファイルの中身');
  const raw = fs.readFileSync(LAUNCHER);
  const text = raw.toString('latin1');

  const nonAscii = [...raw].filter((byte) => byte > 127);
  check(
    'ASCII 以外の文字を含まない',
    nonAscii.length === 0,
    nonAscii.length ? `${nonAscii.length} バイトが ASCII 外` : ''
  );
  check('改行は CRLF', text.includes('\r\n') && !/[^\r]\n/.test(text));
  check('UTF-8 の指定が先頭付近にある', text.indexOf('chcp 65001') < 400);
  check('app フォルダへ移動する', text.includes('cd /d "%~dp0app"'));
  check('最後に npm start を呼ぶ', text.includes('npm start'));

  group('日本語メッセージの参照');
  const referenced = [...text.matchAll(/messages\\([a-z-]+\.txt)/g)].map((m) => m[1]);
  check('メッセージを参照している', referenced.length >= 5, referenced.length);

  for (const name of new Set(referenced)) {
    const full = path.join(ROOT, 'messages', name);
    check(`${name} が存在する`, fs.existsSync(full));
    if (!fs.existsSync(full)) continue;
    const body = fs.readFileSync(full);
    check(`${name} は UTF-8 として読める`, body.toString('utf8').includes('\n'));
    check(`${name} に置換文字が無い`, !body.toString('utf8').includes('�'));
  }

  group('必要な場面を網羅している');
  check('Node.js が無い場合', text.includes('node-missing.txt'));
  check('初回の準備', text.includes('setup-first.txt'));
  check('更新で依存が変わった場合', text.includes('setup-deps.txt'));
  check('Electron 本体が無い場合', text.includes('electron-missing.txt'));
  check(
    '自動更新が残す印を見ている',
    text.includes('.deps-stale'),
    'update.js が置く印を拾わないと、更新後に起動できなくなる'
  );
  check('印は使い終わったら消す', text.includes('del ".deps-stale"'));

  group('どちらを指しても起動できる');
  // ショートカットが app を指すか、その親を指すかは作られ方で変わる。
  // 実際「Unable to find Electron app at ...\\Neo」で起動できなくなった
  const rootPkgPath = path.join(ROOT, 'package.json');
  check('フォルダの直下に package.json がある', fs.existsSync(rootPkgPath));

  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const appPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8'));
  check('入口を指している', !!rootPkg.main, rootPkg.main);
  check('その先が実在する', fs.existsSync(path.join(ROOT, rootPkg.main)), rootPkg.main);
  check('app 側の入口と同じ場所', rootPkg.main.endsWith(appPkg.main.replace(/^\.\//, '')));
  check('版が食い違っていない', rootPkg.version === appPkg.version, `${rootPkg.version} / ${appPkg.version}`);
  check('公開しない印が付いている', rootPkg.private === true, '取り違えて公開されないように');
  check(
    '依存を持たない',
    !rootPkg.dependencies && !rootPkg.devDependencies,
    'ここで npm install させないため'
  );

  group('起動のされ方に依存しない');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'main', 'index.js'), 'utf8');
  const binSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'main', 'binaries.js'), 'utf8');

  check(
    'ダウンロード済みの実行ファイルの置き場を見失わない',
    !/getAppPath\(\), 'bin'/.test(binSrc) && /__dirname/.test(binSrc),
    'app の親から起動されると app/bin を見失う'
  );
  check(
    'アイコンの場所も自分の居場所から数える',
    /const appDir = path\.resolve\(__dirname/.test(mainSrc),
    mainSrc.match(/const appDir =.*/)?.[0]
  );
  group('空白を含む場所に置かれても起動する');
  // Windows は囲まれていない引数を空白で分割する。実際これで
  // 「Unable to find Electron app at ...\\総本山\\Neo」が出ていた
  const quoted = [...mainSrc.matchAll(/args:[^\n]*/g)].map((m) => m[0]);
  check('引数を渡している箇所がある', quoted.length >= 2, quoted);
  check(
    'どの引数も囲んである',
    quoted.every((line) => /isPackaged \? (\[\]|'') :/.test(line) === false || /`"\$\{appDir\}"`/.test(line)),
    quoted
  );
  check(
    'ショートカットの引数を囲んでいる',
    /args: app\.isPackaged \? '' : `"\$\{appDir\}"`/.test(mainSrc),
    mainSrc.match(/args: app\.isPackaged \? ''.*/)?.[0]
  );
  check(
    '自動起動の引数も囲んでいる',
    /args: app\.isPackaged \? \[\] : \[`"\$\{appDir\}"`\]/.test(mainSrc),
    'setLoginItemSettings は 1 つずつ囲んでくれない'
  );
  check(
    '自動起動も自分の居場所から数える',
    /function applyLoginItem[\s\S]{0,1200}path\.resolve\(__dirname/.test(mainSrc)
  );

  done('launcher');
})();
