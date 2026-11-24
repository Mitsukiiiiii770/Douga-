'use strict';

/**
 * クリップボードの監視を検証する。
 *
 * 利用者はパスワードなども複写する。覚えておいてよいものではないので、
 * 「見るものを絞れているか」を厚く見る。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { group, check, done } = require('./helper');

const watcher = require('../src/main/clipboard-watch');
const { looksLikeVideoUrl, ClipboardWatcher } = watcher;
const browse = require('../src/main/browse');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  group('見るものを絞る');
  check('http の URL は見る', looksLikeVideoUrl('http://a.example/v'));
  check('https も見る', looksLikeVideoUrl('https://a.example/watch?v=1'));
  check('前後の空白は落とす', looksLikeVideoUrl('  https://a.example/v  '));

  check('ただの文字列は見ない', !looksLikeVideoUrl('おはよう'));
  check(
    'パスワードらしきものは見ない',
    !looksLikeVideoUrl('Tr0ub4dor&3'),
    '複写されるのは URL だけではない'
  );
  check('scheme が無ければ見ない', !looksLikeVideoUrl('example.com/video'));
  check(
    '文章に URL が混ざっていても見ない',
    !looksLikeVideoUrl('これ見て https://a.example/v'),
    '空白を含むものは URL そのものではない'
  );
  check('複数行は見ない', !looksLikeVideoUrl('https://a.example/v\nhttps://b.example/v'));
  check('file: は見ない', !looksLikeVideoUrl('file:///C:/secret.txt'));
  check('javascript: は見ない', !looksLikeVideoUrl('javascript:alert(1)'));
  check('ホスト名にドットが無ければ見ない', !looksLikeVideoUrl('http://localhost/v'));
  check('長すぎるものは見ない', !looksLikeVideoUrl('https://a.example/' + 'x'.repeat(3000)));
  check('空は見ない', !looksLikeVideoUrl(''));
  check('文字列でなくても落ちない', !looksLikeVideoUrl(null) && !looksLikeVideoUrl(42));

  group('知らせ方');
  let value = 'https://before.example/v';
  const w = new ClipboardWatcher();
  const seen = [];
  w.on('url', (url) => seen.push(url));
  w.start({ read: () => value, interval: 10 });

  await wait(40);
  check(
    '始めた時点の中身は知らせない',
    seen.length === 0,
    '前から入っていたものを「今コピーした」とは扱わない'
  );

  value = 'https://a.example/v';
  await wait(40);
  check('新しくコピーされたら知らせる', seen.includes('https://a.example/v'), seen);

  const count = seen.length;
  await wait(40);
  check('同じものは繰り返さない', seen.length === count, seen);

  value = 'ただの文章';
  await wait(40);
  check('URL でなくなっても知らせない', seen.length === count);

  value = 'https://b.example/v';
  await wait(40);
  check('次の URL は知らせる', seen.includes('https://b.example/v'));

  w.stop();
  const afterStop = seen.length;
  value = 'https://c.example/v';
  await wait(40);
  check('止めたら読まない', seen.length === afterStop, '設定を切れば何も見ない');

  check('読めなくても落ちない', (() => {
    const broken = new ClipboardWatcher();
    broken.start({
      read: () => {
        throw new Error('読めない');
      },
      interval: 5
    });
    broken.stop();
    return true;
  })());

  group('中身を残さない');
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'main', 'clipboard-watch.js'),
    'utf8'
  );
  check('ファイルに書かない', !/writeFile|appendFile/.test(source));
  check('検出ログに渡さない', !/diagnostics/.test(source));
  check('画面へ出すのは知らせのときだけ', (source.match(/this\.emit\(/g) || []).length === 1);

  group('ブラウザからの保存で既存を潰さない');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douga-dl-'));
  check('空のフォルダならそのまま', path.basename(browse.freeName(dir, 'a.mp4')) === 'a.mp4');

  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
  check(
    '同じ名前があれば番号を足す',
    path.basename(browse.freeName(dir, 'a.mp4')) === 'a (1).mp4',
    path.basename(browse.freeName(dir, 'a.mp4'))
  );

  fs.writeFileSync(path.join(dir, 'a (1).mp4'), 'x');
  check('続けて足す', path.basename(browse.freeName(dir, 'a.mp4')) === 'a (2).mp4');
  check('拡張子は保つ', browse.freeName(dir, 'a.mp4').endsWith('.mp4'));
  check(
    '名前が無ければ既定を使う',
    path.basename(browse.freeName(dir, '')).startsWith('download'),
    path.basename(browse.freeName(dir, ''))
  );
  fs.rmSync(dir, { recursive: true, force: true });

  done('clipboard');
})();
