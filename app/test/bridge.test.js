'use strict';

const { group, check, done } = require('./helper');

const settings = require('../src/main/settings');
const bridge = require('../src/main/bridge');

const PORT = 47699;
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

async function call(pathname, { method = 'GET', origin, token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { 'X-Douga-Token': token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    data: await response.json().catch(() => ({})),
    headers: response.headers
  };
}

(async () => {
  settings.set({ bridgePort: PORT, bridgeEnabled: true, acceptCookies: true, pairedClients: [] });

  let approve = false;
  let dialog = null;
  bridge.onPairRequest = async (origin, name) => {
    dialog = { origin, name };
    return approve;
  };

  const captures = [];
  bridge.on('capture', (capture) => captures.push(capture));

  const status = await bridge.start();
  check('127.0.0.1 で待ち受け開始', status.running && status.port === PORT, status);

  group('未ペアリングの状態');
  let res = await call('/ping');
  check('/ping は認証なしで応答', res.status === 200 && res.data.app === 'douga', res.data);
  check('/ping が paired:false を返す', res.data.paired === false);
  res = await call('/capture', { method: 'POST', body: { target: 'https://x/1' } });
  check('/capture はトークンなしだと 401', res.status === 401, res.status);

  group('普通の Web ページからは接続できない');
  res = await call('/pair', {
    method: 'POST',
    origin: 'https://evil.example.com',
    body: { name: 'evil' }
  });
  check('http(s) オリジンは 403', res.status === 403, res.data);
  check('許可ダイアログすら出さない', dialog === null);
  check('CORS を許可しない', res.headers.get('access-control-allow-origin') === null);

  group('拡張機能からのペアリング（ユーザーが拒否）');
  approve = false;
  res = await call('/pair', { method: 'POST', origin: EXT_ORIGIN, body: { name: 'Douga 拡張' } });
  check('拒否すると 403', res.status === 403, res.data);
  check('ダイアログに拡張機能名を渡す', dialog && dialog.name === 'Douga 拡張', dialog);
  check('トークンを渡さない', !res.data.token);

  group('拡張機能からのペアリング（ユーザーが許可）');
  approve = true;
  res = await call('/pair', { method: 'POST', origin: EXT_ORIGIN, body: { name: 'Douga 拡張' } });
  check('許可するとトークンを返す', res.status === 200 && !!res.data.token, res.data);
  check('拡張オリジンには CORS を許可', res.headers.get('access-control-allow-origin') === EXT_ORIGIN);
  check('ペアリング済みとして保存', settings.get().pairedClients.length === 1);
  const token = res.data.token;

  res = await call('/ping', { token });
  check('/ping が paired:true になる', res.data.paired === true);

  group('検出結果の送信');
  res = await call('/capture', {
    method: 'POST',
    token,
    body: {
      pageUrl: 'https://example.com/watch',
      pageTitle: 'テストページ',
      target: 'https://cdn.example.com/master.m3u8',
      headers: { referer: 'https://example.com/watch', userAgent: 'UA' },
      cookies: [{ name: 'sid', value: 'v', domain: '.example.com', path: '/' }],
      candidates: [{ url: 'https://cdn.example.com/master.m3u8', kind: 'hls', label: 'master.m3u8' }]
    }
  });
  check('capture が 200', res.status === 200, res.data);
  check('アプリ側にイベントが届く', captures.length === 1);
  check('target を保持', captures[0].target === 'https://cdn.example.com/master.m3u8');
  check('候補一覧を保持', captures[0].candidates.length === 1);
  check('Cookie を受け取る', captures[0].cookies.length === 1);

  group('Cookie の受け取りを無効にした場合');
  settings.set({ acceptCookies: false });
  await call('/capture', {
    method: 'POST',
    token,
    body: { target: 'https://x/2', cookies: [{ name: 'a', value: 'b', domain: 'x' }] }
  });
  check('Cookie を破棄する', captures[1].cookies.length === 0, captures[1].cookies);
  settings.set({ acceptCookies: true });

  group('異常系');
  res = await call('/capture', { method: 'POST', token: 'wrong', body: { target: 'https://x/3' } });
  check('偽のトークンは 401', res.status === 401, res.status);
  res = await call('/capture', { method: 'POST', token, body: {} });
  check('URL 未指定は 400', res.status === 400, res.data);
  res = await call('/nope', { token });
  check('未知のパスは 404', res.status === 404, res.status);
  res = await call('/capture', { method: 'OPTIONS', origin: EXT_ORIGIN });
  check('プリフライトは 204', res.status === 204, res.status);

  bridge.stop();
  group('Cookie を使ってよいかの判断');
  // 「Cookie を受け取る」は、外部の拡張機能が localhost 経由で送ってくる
  // ものを許すかどうかの設定。アプリ内ブラウザでログインした分を同じ扱いに
  // すると「ログインしたのに取得できない」という失敗になる
  const cookiesMod = require('../src/main/cookies');
  const use = (o) => cookiesMod.shouldUse(o);

  check(
    'アプリ内ブラウザの分は設定に関係なく使う',
    use({ cookieSource: 'browser', acceptCookies: false }) === true,
    '利用者自身がこのアプリの中でログインしたもの'
  );
  check('設定が入でも使う', use({ cookieSource: 'browser', acceptCookies: true }) === true);
  check(
    '拡張機能からの分は設定に従う',
    use({ cookieSource: 'extension', acceptCookies: false }) === false
  );
  check('設定が入なら使う', use({ cookieSource: 'extension', acceptCookies: true }) === true);
  check('出どころ不明は設定に従う', use({ acceptCookies: false }) === false);
  check('引数が無くても落ちない', use() === false);

  done('bridge');
})().catch((err) => {
  console.error('例外:', err);
  process.exit(1);
});
