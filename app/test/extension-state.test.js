'use strict';

/**
 * 拡張機能の状態保持を検証する。
 *
 * MV3 の service worker は数十秒で止められ、通信のたびに起こし直される。
 * 起きた直後の記憶は空なので、そこへ書き込んで保存すると、それまでに
 * 溜めた候補を空で上書きしてしまう。
 *
 * 実際 YouTube で候補が 0 件になっていた原因がこれだった:
 *
 *     セグメントの通信: 0 件
 *     動画の手がかりが無い通信: 46 件
 *     採用した候補: 0 件
 *
 * 数百のリクエストが出るページで 46 件しか見えていなかった。
 *
 * ここでは Chrome の API を偽物に差し替えて background.js を実際に動かし、
 * 止まって起き直しても候補が残ることを確かめる。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { group, check, done } = require('./helper');

const DIR = path.resolve(__dirname, '..', '..', 'extension');

/** service worker を 1 つ起動する。storage は呼び出し側で共有する */
function startWorker(storage, { openTabs = [] } = {}) {
  const listeners = {
    headers: null,
    sendHeaders: null,
    message: null,
    updated: null,
    removed: null,
    installed: null,
    startup: null
  };
  const injected = [];

  const chrome = {
    storage: {
      session: {
        get: async (key) => {
          if (key === null || key === undefined) return { ...storage };
          if (typeof key === 'string') return key in storage ? { [key]: storage[key] } : {};
          return {};
        },
        set: async (obj) => Object.assign(storage, obj),
        remove: async (key) => {
          delete storage[key];
        }
      }
    },
    webRequest: {
      onHeadersReceived: { addListener: (cb) => (listeners.headers = cb) },
      onSendHeaders: { addListener: (cb) => (listeners.sendHeaders = cb) }
    },
    tabs: {
      onUpdated: { addListener: (cb) => (listeners.updated = cb) },
      onRemoved: { addListener: (cb) => (listeners.removed = cb) },
      query: async () => openTabs,
      get: async (id) => {
        const hit = openTabs.find((t) => t.id === id);
        if (!hit) throw new Error('no tab');
        return hit;
      }
    },
    scripting: {
      executeScript: async (opts) => {
        injected.push(opts);
        return [];
      }
    },
    runtime: {
      onMessage: { addListener: (cb) => (listeners.message = cb) },
      onInstalled: { addListener: (cb) => (listeners.installed = cb) },
      onStartup: { addListener: (cb) => (listeners.startup = cb) }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    }
  };

  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Math,
    JSON,
    Object,
    Number,
    String,
    Boolean,
    Array,
    Map,
    Set,
    RegExp,
    Error,
    importScripts(name) {
      vm.runInContext(fs.readFileSync(path.join(DIR, name), 'utf8'), sandbox.__ctx);
    }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.__ctx = context;

  vm.runInContext(fs.readFileSync(path.join(DIR, 'background.js'), 'utf8'), context);
  return { listeners, chrome, injected };
}

/** 動画らしい応答を 1 件流す */
function sendResponse(listeners, tabId, url, { mime = 'video/mp4', size = 9e6, type = 'xmlhttprequest' } = {}) {
  listeners.headers({
    tabId,
    url,
    type,
    responseHeaders: [
      { name: 'Content-Type', value: mime },
      { name: 'Content-Length', value: String(size) }
    ]
  });
}

function ask(listeners, message) {
  return new Promise((resolve) => {
    listeners.message(message, {}, resolve);
  });
}

(async () => {
  group('普通に拾えること');
  const storage = {};
  let worker = startWorker(storage);
  sendResponse(worker.listeners, 7, 'https://cdn.example/video.mp4');
  let answer = await ask(worker.listeners, { type: 'get-candidates', tabId: 7 });
  check('候補として拾う', answer.candidates.length === 1, answer.candidates.length);
  check('種別が付く', answer.candidates[0].kind === 'file');

  // 保存が終わるのを待つ
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('保存される', !!storage.tab_7, Object.keys(storage));

  group('止まって起き直しても消えない');
  // service worker の再起動。記憶は失われ、storage だけが残る
  worker = startWorker(storage);

  // 起きた直後に別の通信が来る。ここで空のまま保存すると前の分が消える
  sendResponse(worker.listeners, 7, 'https://cdn.example/another.mp4');
  await new Promise((resolve) => setTimeout(resolve, 10));

  answer = await ask(worker.listeners, { type: 'get-candidates', tabId: 7 });
  check(
    '前に拾った分が残っている',
    answer.candidates.some((c) => c.url.includes('video.mp4')),
    answer.candidates.map((c) => c.url)
  );
  check(
    '起き直した後の分も入る',
    answer.candidates.some((c) => c.url.includes('another.mp4')),
    answer.candidates.map((c) => c.url)
  );
  check('2 件そろう', answer.candidates.length === 2, answer.candidates.length);
  check(
    '保存側も空になっていない',
    (storage.tab_7.candidates || []).length === 2,
    (storage.tab_7.candidates || []).length
  );

  group('捨てた記録も残る');
  const store2 = {};
  let w2 = startWorker(store2);
  sendResponse(w2.listeners, 9, 'https://cdn.example/tiny.mp4', { size: 1024 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  w2 = startWorker(store2);
  sendResponse(w2.listeners, 9, 'https://cdn.example/ok.mp4');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const report = await ask(w2.listeners, { type: 'get-report', tabId: 9 });
  check('捨てた理由が残る', /小さすぎる/.test(report.text), report.text.slice(0, 200));
  check('採用した分も出る', /ok\.mp4/.test(report.text));

  group('ページを移ったら捨てる');
  const store3 = {};
  const w3 = startWorker(store3);
  sendResponse(w3.listeners, 11, 'https://cdn.example/old.mp4');
  w3.listeners.updated(11, { status: 'loading', url: 'https://other.example/' }, { id: 11, url: 'https://other.example/' });
  const after = await ask(w3.listeners, { type: 'get-candidates', tabId: 11 });
  check('前のページの候補は残さない', after.candidates.length === 0, after.candidates.length);

  group('判定そのもの');
  const store4 = {};
  const w4 = startWorker(store4);
  sendResponse(w4.listeners, 13, 'https://cdn.example/master.m3u8', { mime: 'application/vnd.apple.mpegurl', size: 900 });
  sendResponse(w4.listeners, 13, 'https://cdn.example/style.css', { mime: 'text/css' });
  sendResponse(w4.listeners, 13, 'https://cdn.example/seg-1.ts', { mime: 'video/mp2t' });
  const got = await ask(w4.listeners, { type: 'get-candidates', tabId: 13 });
  check('マニフェストは小さくても拾う', got.candidates.some((c) => c.kind === 'hls'));
  check('CSS は拾わない', !got.candidates.some((c) => c.url.includes('.css')));
  check('セグメントは候補にしない', !got.candidates.some((c) => c.url.includes('seg-1')));
  check('セグメントは数える', got.segments === 1, got.segments);

  group('どのタブにも紐づかない通信');
  // service worker や事前読み込みから出た通信は tabId が -1 になる。
  // 候補にはできないが、「見えていたのに捨てた」のか
  // 「そもそも見えていない」のかで原因が全く違うので記録する
  const store5 = {};
  const w5 = startWorker(store5);
  sendResponse(w5.listeners, 15, 'https://site.example/page.html', { mime: 'text/html' });
  sendResponse(w5.listeners, -1, 'https://cdn.example/hidden.mp4', { mime: 'video/mp4' });
  sendResponse(w5.listeners, -1, 'https://cdn.example/tracker.gif', { mime: 'image/gif' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const offReport = await ask(w5.listeners, { type: 'get-report', tabId: 15 });
  check('紐づかない通信を数える', /どのタブにも紐づかない通信: 2 件/.test(offReport.text), offReport.text.slice(0, 400));
  check('そのうち動画らしきものも数える', /動画らしきもの 1 件/.test(offReport.text));
  check('見本を出す', /hidden\.mp4/.test(offReport.text), '原因の特定に使う');
  check('動画でないものは見本に出さない', !/tracker\.gif/.test(offReport.text));
  check(
    '候補には混ぜない',
    !(await ask(w5.listeners, { type: 'get-candidates', tabId: 15 })).candidates.some((c) =>
      c.url.includes('hidden.mp4')
    ),
    'どのタブのものか分からないため'
  );

  group('既に開いているタブへ入れ直す');
  // 拡張機能を読み込み直すと、開いているタブには content script が入らない。
  // 利用者には「再読み込みしたのに検出しない」としか見えず、原因が分かりにくい
  const store6 = {};
  const openTabs = [
    { id: 21, url: 'https://www.youtube.com/watch?v=abc', title: 'ある動画 - YouTube' },
    { id: 22, url: 'https://site.example/', title: 'どこか' }
  ];
  const w6 = startWorker(store6, { openTabs });
  check('入れ直す仕組みがある', typeof w6.listeners.installed === 'function');
  check('起動時にも入れ直す', typeof w6.listeners.startup === 'function');

  await w6.listeners.installed();
  await new Promise((resolve) => setTimeout(resolve, 10));

  check('開いているタブに入れる', w6.injected.length >= 2, w6.injected.length);
  check(
    'content script を入れる',
    w6.injected.some((i) => (i.files || []).includes('content.js'))
  );
  check(
    'ページ側の通信を覗く分は MAIN に入れる',
    w6.injected.some((i) => (i.files || []).includes('net-hook.js') && i.world === 'MAIN'),
    'ページと同じ世界でないと fetch を覗けない'
  );
  check(
    'ページ情報も拾う',
    (await ask(w6.listeners, { type: 'get-report', tabId: 21 })).text.includes('youtube.com/watch'),
    '再読み込み直後は onUpdated が来ないため'
  );

  group('記録が無ければタブ自身に聞く');
  const store7 = {};
  const w7 = startWorker(store7, {
    openTabs: [{ id: 31, url: 'https://ask.example/page', title: '聞いて分かった題' }]
  });
  const asked = await ask(w7.listeners, { type: 'get-report', tabId: 31 });
  check('ページ URL が埋まる', asked.text.includes('https://ask.example/page'), asked.text.slice(0, 200));
  check('表題も埋まる', asked.text.includes('聞いて分かった題'));
  check('閉じられたタブでも落ちない', (await ask(w7.listeners, { type: 'get-report', tabId: 999 })).ok === true);

  done('extension-state');
})();
