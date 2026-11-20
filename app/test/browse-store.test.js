'use strict';

/**
 * 履歴とブックマークを検証する。
 *
 * 置き場所は userData。アプリのソースとは別なので、更新で
 * ソースを入れ替えても消えない。ここで見るのは中身の扱い方:
 *   - 履歴は際限なく増やさない
 *   - 同じページを続けて開いても並べない
 *   - ブックマークは勝手に消さない
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { group, check, done } = require('./helper');

const store = require('../src/main/browse-store');
const shortcuts = require('../src/shared/shortcuts');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douga-browse-'));
  store.useFile(path.join(dir, 'browse-data.json'));
  return dir;
}

(() => {
  group('履歴');
  let dir = freshStore();
  store.addHistory({ url: 'https://a.example/1', title: 'ページ A' });
  store.addHistory({ url: 'https://b.example/2', title: 'ページ B' });
  check('新しいものが先頭', store.history()[0].url === 'https://b.example/2');
  check('両方残る', store.history().length === 2);

  store.addHistory({ url: 'https://b.example/2', title: 'ページ B' });
  check(
    '同じページを続けて開いても並べない',
    store.history().length === 2,
    '再読み込みや画面内の移動で埋まらないように'
  );

  store.addHistory({ url: 'https://a.example/1' });
  check('間に別のページを挟めば並ぶ', store.history().length === 3);

  check('題は後から書き戻せる', (() => {
    store.addHistory({ url: 'https://c.example/3' });
    store.updateTitle('https://c.example/3', 'あとで分かった題');
    return store.history()[0].title === 'あとで分かった題';
  })());

  check('about:blank は記録しない', (() => {
    const before = store.history().length;
    store.addHistory({ url: 'about:blank' });
    return store.history().length === before;
  })());
  check('空の URL も記録しない', (() => {
    const before = store.history().length;
    store.addHistory({ url: '' });
    return store.history().length === before;
  })());

  group('履歴の絞り込みと削除');
  check('題で絞り込める', store.history({ query: 'ページ A' }).length === 1);
  check('URL でも絞り込める', store.history({ query: 'b.example' }).length === 1);
  check('大文字小文字は区別しない', store.history({ query: 'B.EXAMPLE' }).length === 1);
  check('件数を制限できる', store.history({ limit: 2 }).length === 2);
  check('1 件消せる', (() => {
    const before = store.history().length;
    store.removeHistory('https://a.example/1');
    return store.history().length < before;
  })());
  check('まとめて消せる', (() => {
    store.clearHistory();
    return store.history().length === 0;
  })());
  fs.rmSync(dir, { recursive: true, force: true });

  group('履歴の上限');
  dir = freshStore();
  for (let i = 0; i < store.MAX_HISTORY + 50; i++) {
    store.addHistory({ url: `https://x.example/${i}` });
  }
  check('上限を超えない', store.history({ limit: 99999 }).length === store.MAX_HISTORY);
  check(
    '新しいものが残る',
    store.history()[0].url === `https://x.example/${store.MAX_HISTORY + 49}`
  );
  fs.rmSync(dir, { recursive: true, force: true });

  group('ブックマーク');
  dir = freshStore();
  check('最初は空', store.bookmarks().length === 0);
  check('入れられる', store.toggleBookmark({ url: 'https://a.example/', title: 'A' }) === true);
  check('入っていると分かる', store.isBookmarked('https://a.example/'));
  check('同じものは重複しない', (() => {
    store.addBookmark({ url: 'https://a.example/', title: 'A' });
    return store.bookmarks().length === 1;
  })());
  check('もう一度押すと外れる', store.toggleBookmark({ url: 'https://a.example/' }) === false);
  check('外れたことが分かる', !store.isBookmarked('https://a.example/'));
  check('題が無ければ URL を使う', (() => {
    store.addBookmark({ url: 'https://b.example/' });
    return store.bookmarks()[0].title === 'https://b.example/';
  })());
  check('履歴を全部消してもブックマークは残る', (() => {
    store.addHistory({ url: 'https://b.example/' });
    store.clearHistory();
    return store.bookmarks().length === 1;
  })());
  fs.rmSync(dir, { recursive: true, force: true });

  group('保存と読み直し');
  dir = freshStore();
  store.addHistory({ url: 'https://keep.example/', title: '残るはず' });
  store.addBookmark({ url: 'https://mark.example/', title: '印' });
  store.saveNow();
  const file = path.join(dir, 'browse-data.json');
  check('ファイルに書かれる', fs.existsSync(file));
  store.useFile(file);
  check('読み直せる', store.history()[0].url === 'https://keep.example/');
  check('ブックマークも読み直せる', store.bookmarks()[0].url === 'https://mark.example/');

  fs.writeFileSync(file, 'これは JSON ではない');
  store.useFile(file);
  check('壊れていても落ちない', store.history().length === 0 && store.bookmarks().length === 0);
  fs.rmSync(dir, { recursive: true, force: true });

  group('キーボード操作');
  const press = (key, mods = {}) => shortcuts.shortcutFor({ key, ...mods });
  check('Ctrl+T で新しいタブ', press('t', { control: true }) === 'new-tab');
  check('Ctrl+W で閉じる', press('w', { control: true }) === 'close-tab');
  check('Ctrl+L でアドレス欄', press('l', { control: true }) === 'focus-url');
  check('Ctrl+D でブックマーク', press('d', { control: true }) === 'bookmark');
  check('Ctrl+H で履歴', press('h', { control: true }) === 'history');
  check('Ctrl+R で再読み込み', press('r', { control: true }) === 'reload');
  check('F5 でも再読み込み', press('F5') === 'reload');
  check('Ctrl+Tab で次のタブ', press('Tab', { control: true }) === 'next-tab');
  check('Ctrl+Shift+Tab で前のタブ', press('Tab', { control: true, shift: true }) === 'prev-tab');
  check('Alt+← で戻る', press('ArrowLeft', { alt: true }) === 'back');
  check('Alt+→ で進む', press('ArrowRight', { alt: true }) === 'forward');
  check('Ctrl+1 で 1 番目のタブ', press('1', { control: true }) === 'tab-1');
  check('Ctrl+9 まで', press('9', { control: true }) === 'tab-9');
  check('Ctrl+0 は割り当てない', press('0', { control: true }) === null);
  check('mac の Command でも効く', press('t', { meta: true }) === 'new-tab');

  check('修飾無しの文字は拾わない', press('t') === null, 'ページへの入力を奪わないため');
  check('Ctrl+Shift+T は割り当てていない', press('t', { control: true, shift: true }) === null);
  check('空でも落ちない', shortcuts.shortcutFor({}) === null);
  check('null でも落ちない', shortcuts.shortcutFor(null) === null);

  done('browse-store');
})();
