'use strict';

/**
 * アドレス欄の入力をどこへ向けるかを検証する。
 *
 * 「URL なのか検索語なのか」を取り違えると、検索したいのに
 * 存在しないホストへ飛んだり、URL を打ったのに検索結果が出たりする。
 */

const { group, check, done } = require('./helper');
const search = require('../src/shared/search');

const GOOGLE = 'https://www.google.com/search?q=%s';
const DDG = 'https://duckduckgo.com/?q=%s';

(() => {
  group('URL として扱うもの');
  const go = (raw, template = GOOGLE) => search.resolveNavigation(raw, template);

  check('そのままの URL', go('https://a.example/x') === 'https://a.example/x');
  check('http も通す', go('http://a.example/') === 'http://a.example/');
  check('裸のホスト名は https を補う', go('example.com') === 'https://example.com');
  check('パス付きでも URL', go('example.com/watch?v=1') === 'https://example.com/watch?v=1');
  check('サブドメインも URL', go('www.example.co.jp') === 'https://www.example.co.jp');
  check('手元のサーバー', go('localhost:3000') === 'https://localhost:3000');
  check('IP アドレス', go('192.168.1.1') === 'https://192.168.1.1');
  check('about: はそのまま', go('about:blank') === 'about:blank');

  group('検索語として扱うもの');
  check('空白を含めば検索', go('動画 保存').startsWith('https://www.google.com/search?q='));
  check('ドットが無ければ検索', go('youtube').includes('search?q=youtube'));
  check('日本語は符号化する', go('保存').includes(encodeURIComponent('保存')));
  check(
    'ドットを含んでいても空白があれば検索',
    go('example.com の使い方').includes('search?q='),
    '文の一部にホスト名が出ることはある'
  );
  check('空なら何もしない', go('') === null);
  check('空白だけでも何もしない', go('   ') === null);
  check('null でも落ちない', go(null) === null);

  group('検索エンジンの切り替え');
  check('DuckDuckGo にできる', go('猫', DDG).startsWith('https://duckduckgo.com/?q='));
  check('Bing にできる', go('猫', 'https://www.bing.com/search?q=%s').includes('bing.com'));
  check('既定は Google', search.DEFAULT_SEARCH_URL.includes('google.com'));
  check(
    '指定が空なら既定を使う',
    search.searchUrlFor('猫', '').includes('google.com'),
    '設定を消しても検索できなくならないように'
  );
  check(
    '%s が無ければ末尾に付ける',
    search.searchUrlFor('猫', 'https://x.example/?q=').endsWith(encodeURIComponent('猫')),
    '書き方を間違えても動くように'
  );
  check(
    '%s が複数あれば全部置き換える',
    (search.searchUrlFor('猫', 'https://x/?a=%s&b=%s').match(/%E7%8C%AB/g) || []).length === 2
  );

  group('選べる一覧');
  check('3 つ用意している', search.ENGINES.length === 3);
  check('全てに %s がある', search.ENGINES.every((e) => e.url.includes('%s')));
  check('全てに名前がある', search.ENGINES.every((e) => e.label && e.id));
  check('先頭は Google', search.ENGINES[0].id === 'google');

  done('search');
})();
