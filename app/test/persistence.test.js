'use strict';

/**
 * キューの永続化を検証する。
 * アプリを閉じてもジョブ一覧が残り、実行中だったものは中断扱いになること。
 */

const fs = require('fs');
const path = require('path');
const { fixture, group, check, done, sleep } = require('./helper');

const settings = require('../src/main/settings');
const queue = require('../src/main/queue');

const { Queue } = queue;

/** 独立したインスタンスを、指定したファイルに紐づけて作る */
function makeQueue(file) {
  const q = new Queue();
  q.storePath = file;
  return q;
}

(async () => {
  settings.set({
    ytdlpPath: fixture('fake-ytdlp.py'),
    ffmpegPath: '',
    postProcess: 'none',
    maxConcurrent: 2,
    downloadDir: path.join(require('os').tmpdir(), 'douga-persist-out')
  });

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'douga-persist-'));
  const file = path.join(dir, 'jobs.json');

  group('保存');
  const first = makeQueue(file);
  // 走らせたくないので、pump を無効化して状態だけ作る
  first.pump = () => {};
  const a = first.add({ url: 'https://example.com/1', title: '動画1' });
  first.add({ url: 'https://example.com/2', title: '動画2' });
  first.saveNow();

  check('ファイルが作られる', fs.existsSync(file));
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('2件保存される', saved.length === 2, saved.length);
  check('URL を保持', saved[0].url === 'https://example.com/1', saved[0]);
  check('AbortController を保存しない', !('controller' in saved[0]), Object.keys(saved[0]));
  check('Cookie のパスを保存しない', !('cookieFile' in saved[0]), Object.keys(saved[0]));

  group('復元');
  // 実行中のまま終了した状況を作る
  saved[0].status = 'downloading';
  saved[0].progress = 42;
  saved[1].status = 'completed';
  saved[1].filePath = '/out/動画2.mp4';
  fs.writeFileSync(file, JSON.stringify(saved));

  const second = makeQueue(file);
  second.pump = () => {};
  const restored = second.restore();
  check('2件復元する', restored === 2, restored);

  const jobs = second.list();
  const one = jobs.find((j) => j.url === 'https://example.com/1');
  const two = jobs.find((j) => j.url === 'https://example.com/2');
  check('実行中だったものは中断扱いになる', one.status === 'interrupted', one.status);
  check('勝手に再開しない', second.running.size === 0);
  check('完了済みはそのまま残る', two.status === 'completed', two.status);
  check('保存先ファイルのパスも残る', two.filePath === '/out/動画2.mp4');
  check('速度と残り時間はクリアされる', one.speed === null && one.eta === null, one);

  group('中断したジョブの再開');
  const resumed = second.resumeInterrupted();
  check('中断分だけ待機中に戻す', resumed === 1, resumed);
  check('待機中になる', second.list().find((j) => j.url === 'https://example.com/1').status === 'queued');
  check('完了済みは触らない', second.list().find((j) => j.url === 'https://example.com/2').status === 'completed');
  check('中断がもう無ければ0件', second.resumeInterrupted() === 0);

  group('壊れたファイル・存在しないファイル');
  const missing = makeQueue(path.join(dir, 'nope.json'));
  check('無ければ0件で、例外を投げない', missing.restore() === 0);
  const brokenFile = path.join(dir, 'broken.json');
  fs.writeFileSync(brokenFile, '{ これは JSON ではない');
  const broken = makeQueue(brokenFile);
  check('壊れていても0件で済ませる', broken.restore() === 0);
  const notArray = path.join(dir, 'obj.json');
  fs.writeFileSync(notArray, '{"a":1}');
  check('配列でなければ0件', makeQueue(notArray).restore() === 0);

  group('URL の無い項目は捨てる');
  const partial = path.join(dir, 'partial.json');
  fs.writeFileSync(
    partial,
    JSON.stringify([{ id: 'x', url: 'https://example.com/ok', status: 'completed' }, { id: 'y' }, null])
  );
  check('壊れた項目を飛ばして読む', makeQueue(partial).restore() === 1);

  group('履歴の上限');
  const capped = makeQueue(path.join(dir, 'capped.json'));
  capped.pump = () => {};
  for (let i = 0; i < 250; i++) {
    const job = capped.add({ url: `https://example.com/h${i}`, title: `h${i}` });
    capped.jobs.get(job.id).status = 'completed';
  }
  capped.saveNow();
  const cappedSaved = JSON.parse(fs.readFileSync(path.join(dir, 'capped.json'), 'utf8'));
  check('完了済みは 200 件までに抑える', cappedSaved.length === 200, cappedSaved.length);
  check(
    '古いものから捨て、新しいものを残す',
    cappedSaved[cappedSaved.length - 1].url === 'https://example.com/h249',
    cappedSaved[cappedSaved.length - 1].url
  );

  group('実行中のジョブは上限に関係なく残す');
  const mixed = makeQueue(path.join(dir, 'mixed.json'));
  mixed.pump = () => {};
  for (let i = 0; i < 210; i++) {
    const job = mixed.add({ url: `https://example.com/m${i}`, title: `m${i}` });
    mixed.jobs.get(job.id).status = 'completed';
  }
  const active = mixed.add({ url: 'https://example.com/active', title: 'active' });
  mixed.jobs.get(active.id).status = 'downloading';
  mixed.saveNow();
  const mixedSaved = JSON.parse(fs.readFileSync(path.join(dir, 'mixed.json'), 'utf8'));
  check(
    '実行中のジョブは必ず含まれる',
    mixedSaved.some((j) => j.url === 'https://example.com/active'),
    mixedSaved.length
  );
  check('完了済みは上限どおり', mixedSaved.length === 201, mixedSaved.length);

  group('削除は即座に書き出す');
  const removable = makeQueue(path.join(dir, 'rm.json'));
  removable.pump = () => {};
  const target = removable.add({ url: 'https://example.com/rm', title: 'rm' });
  removable.saveNow();
  removable.remove(target.id);
  const afterRemove = JSON.parse(fs.readFileSync(path.join(dir, 'rm.json'), 'utf8'));
  check('削除が保存に反映される', afterRemove.length === 0, afterRemove);

  group('遅延保存');
  const delayed = makeQueue(path.join(dir, 'delayed.json'));
  delayed.pump = () => {};
  delayed.add({ url: 'https://example.com/d', title: 'd' });
  check('直後にはまだ書かれていない', !fs.existsSync(path.join(dir, 'delayed.json')));
  await sleep(700);
  check('少し待つと書き出される', fs.existsSync(path.join(dir, 'delayed.json')));

  // タイマーが残っているとプロセスが終わらないので片付ける
  for (const q of [first, second, missing, broken, capped, mixed, removable, delayed]) {
    if (q.saveTimer) clearTimeout(q.saveTimer);
  }

  done('persistence');
})().catch((err) => {
  console.error('例外:', err);
  process.exit(1);
});
