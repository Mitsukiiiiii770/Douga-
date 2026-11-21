'use strict';

/**
 * 広告ブロックを検証する。
 *
 * 一番こわいのは止めすぎることなので、そちらを厚く見る。
 * 広告が 1 つ残るより、動画が再生できなくなるほうが困る。
 */

const { group, check, done } = require('./helper');
const adblock = require('../src/shared/adblock');

const block = (url, options) => adblock.shouldBlock(url, options);

(() => {
  group('広告・計測は止める');
  check('広告網', block('https://ads.exoclick.com/ad.js'));
  check('配信ドメイン違いでも', block('https://s.magsrv.com/v1/api.php'));
  check('計測', block('https://www.google-analytics.com/collect'));
  check('タグ配信', block('https://www.googletagmanager.com/gtm.js'));
  check('動画サイトの広告網', block('https://cdn.trafficjunky.net/banner.mp4'));
  check('ポップアップ広告', block('https://popads.net/x'));
  check('サブドメインも対象', block('https://a.b.doubleclick.net/x'));
  check('www は無視して判定', block('https://www.adsterra.com/x'));

  group('動画の配信は止めない');
  // ここを間違えると、広告は消えるが動画も消える
  check('YouTube の配信元', !block('https://rr3---sn-x.googlevideo.com/videoplayback?x=1'));
  check('一般の CDN', !block('https://cdn.example.com/video.mp4'));
  check('配信マニフェスト', !block('https://hanime.tv/hls/2572/token'));
  check('サイト本体', !block('https://www.pornhub.com/view_video.php?viewkey=x'));
  check('似た名前のホストに釣られない', !block('https://notdoubleclick.net.example.com/x'));
  check(
    '広告網を名前に含むだけのホスト',
    !block('https://popads.net.example.org/video.mp4'),
    '末尾一致で見るため'
  );
  check('壊れた URL は通す', !block('これは URL ではない'));
  check('空も通す', !block(''));

  group('置き場で判断するもの');
  check('広告配信の置き場', block('https://x.example/adserver/banner.js'));
  check('VAST', block('https://x.example/vast/tag.xml'));
  check('ポップアンダー', block('https://x.example/popunder/go.js'));
  check(
    '紛らわしい語を含むだけの道は通す',
    !block('https://x.example/upload/advanced/video.mp4'),
    'adserver ではない'
  );

  group('切れること');
  check('無効なら何も止めない', !block('https://ads.exoclick.com/x', { enabled: false }));
  check('無効なら置き場の判定もしない', !block('https://x.example/vast/a.xml', { enabled: false }));

  group('自分で足した分');
  const extra = adblock.parseExtra('ads.example.com\n# 覚書\n\nhttps://www.bad.example/path\n');
  check('1 行 1 件で読む', extra.includes('ads.example.com'));
  check('覚書は飛ばす', !extra.some((e) => e.startsWith('#')));
  check('空行は飛ばす', !extra.includes(''));
  check('URL で書かれても host だけ取る', extra.includes('bad.example'), extra);
  check('足した分が効く', block('https://ads.example.com/x', { extra }));
  check('その下も効く', block('https://sub.ads.example.com/x', { extra }));
  check('関係ないものは通す', !block('https://ok.example/x', { extra }));
  check('空でも落ちない', adblock.parseExtra('').length === 0);
  check('null でも落ちない', adblock.parseExtra(null).length === 0);

  group('新しい窓を開く要求');
  const allow = (url, disposition, options = {}) =>
    adblock.allowWindow({ url, disposition }, { enabled: true, extra: [], ...options });

  check(
    '中クリックは通す',
    allow('https://site.example/page', 'background-tab'),
    '利用者が自分で押したもの'
  );
  check('前面タブも通す', allow('https://site.example/page', 'foreground-tab'));
  check(
    'script が勝手に開く窓は止める',
    !allow('https://site.example/page', 'new-window'),
    'ポップアンダー広告がこれに当たる'
  );
  check('種別不明も止める', !allow('https://site.example/page', 'other'));
  check(
    '広告の URL はリンクでも止める',
    !allow('https://popads.net/x', 'foreground-tab')
  );
  check(
    '無効なら script の窓も通す',
    adblock.allowWindow(
      { url: 'https://site.example/x', disposition: 'new-window' },
      { enabled: false }
    ),
    '切ったなら普通のブラウザと同じ挙動にする'
  );

  group('一覧の中身');
  check('重複が無い', new Set(adblock.HOSTS).size === adblock.HOSTS.length);
  check('全て小文字', adblock.HOSTS.every((h) => h === h.toLowerCase()));
  check('scheme や / を含まない', adblock.HOSTS.every((h) => !/[:/]/.test(h)));
  check(
    '動画の配信元を入れていない',
    !adblock.HOSTS.some((h) => /googlevideo|akamai|cloudfront|fastly/.test(h)),
    '汎用 CDN を止めると動画が死ぬ'
  );

  done('adblock');
})();
