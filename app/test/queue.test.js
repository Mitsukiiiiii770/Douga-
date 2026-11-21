'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fixture, group, check, done, sleep } = require('./helper');

const settings = require('../src/main/settings');
const queue = require('../src/main/queue');

(async () => {
  settings.set({
    ytdlpPath: fixture('slow-ytdlp.py'),
    ffmpegPath: '',
    downloadDir: path.join(os.tmpdir(), 'douga-test-out'),
    maxConcurrent: 2
  });

  group('同時実行数の制御（maxConcurrent = 2）');
  for (let i = 0; i < 4; i++) {
    queue.add({ url: `https://example.com/${i}`, title: `動画${i}` });
  }
  await sleep(400);

  let jobs = queue.list();
  check('4件がキューに入る', jobs.length === 4, jobs.length);
  check(
    '同時に走るのは2件まで',
    jobs.filter((j) => j.status === 'downloading').length === 2,
    jobs.map((j) => j.status)
  );
  check('残りは待機中', jobs.filter((j) => j.status === 'queued').length === 2);
  check('進捗が更新される', jobs.find((j) => j.status === 'downloading').progress > 0);

  group('レンダラーに渡す形');
  check('AbortController を含めない', !('controller' in jobs[0]));
  check('Cookie ファイルのパスを含めない', !('cookieFile' in jobs[0]));
  check('フォーマット一覧を含めない', !('formats' in jobs[0]));

  group('キャンセル');
  const running = jobs.find((j) => j.status === 'downloading');
  check('実行中のジョブをキャンセルできる', queue.cancel(running.id) === true);
  await sleep(500);
  jobs = queue.list();
  check(
    'ステータスが canceled になる',
    jobs.find((j) => j.id === running.id).status === 'canceled',
    jobs.find((j) => j.id === running.id).status
  );
  check(
    '空いた枠に次のジョブが入る',
    jobs.filter((j) => j.status === 'downloading').length === 2,
    jobs.map((j) => j.status)
  );

  group('再試行');
  check('キャンセル済みを再試行できる', queue.retry(running.id) === true);
  check('待機中に戻る', queue.list().find((j) => j.id === running.id).status === 'queued');

  group('完了');
  for (let i = 0; i < 80; i++) {
    const pending = queue
      .list()
      .some((j) => ['queued', 'downloading', 'processing'].includes(j.status));
    if (!pending) break;
    await sleep(200);
  }
  jobs = queue.list();
  check('全件が完了する', jobs.every((j) => j.status === 'completed'), jobs.map((j) => j.status));
  check('進捗が 100% になる', jobs.every((j) => j.progress === 100));
  check('保存先ファイルを記録する', jobs.every((j) => !!j.filePath), jobs.map((j) => j.filePath));

  group('後片付け');
  queue.clearFinished();
  check('完了済みを一括削除できる', queue.list().length === 0, queue.list().length);

  group('再試行のために Cookie を残す');
  // 失敗した時点で Cookie を消すと、再試行がログイン前の状態で走り、
  // 同じ理由で失敗する。hanime のようにログインが要るサイトで詰む
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'main', 'queue.js'),
    'utf8'
  );
  check(
    '成功したときだけ捨てる',
    /if \(job\.status === 'completed'\)\s*\{\s*cookies\.remove/.test(source),
    source.match(/cookies\.remove[^\n]*/g)
  );
  check(
    '無条件には消さない',
    !/this\.running\.delete\(job\.id\);\s*\n\s*cookies\.remove/.test(source)
  );
  check('ジョブを消すときは捨てる', /remove\(id\)[\s\S]{0,200}cookies\.remove/.test(source));

  done('queue');
})().catch((err) => {
  console.error('例外:', err);
  process.exit(1);
});
