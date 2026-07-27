'use strict';

const path = require('path');
const { fixture, group, check, done } = require('./helper');

const settings = require('../src/main/settings');
const engine = require('../src/main/engine');
const cookies = require('../src/main/cookies');

(async () => {
  settings.set({ ytdlpPath: fixture('fake-ytdlp.py'), ffmpegPath: '' });

  group('probe（単一動画）');
  const info = await engine.probe('https://example.com/watch?v=abc123');
  check('kind が video', info.kind === 'video', info.kind);
  check('タイトルを取得', info.title === 'テスト動画', info.title);
  check('投稿者を取得', info.uploader === 'テスト投稿者', info.uploader);
  check('映像も音声も無い形式を除外（サムネ用 sb0）', !info.formats.some((f) => f.id === 'sb0'));
  check('形式は3件', info.formats.length === 3, info.formats.length);
  check('高画質が先頭に来る', info.formats[0].id === '137', info.formats[0].id);
  check('映像のみを video と判定', info.formats[0].kind === 'video', info.formats[0].kind);
  check('映像+音声を both と判定', info.formats.find((f) => f.id === '18').kind === 'both');
  check('音声のみを audio と判定', info.formats.find((f) => f.id === '251').kind === 'audio');

  group('probe（プレイリスト）');
  const playlist = await engine.probe('https://example.com/playlist?list=xyz');
  check('kind が playlist', playlist.kind === 'playlist', playlist.kind);
  check('entries を2件返す', playlist.entries.length === 2, playlist.entries.length);
  check('entry に URL がある', !!playlist.entries[0].url, playlist.entries[0]);

  group('buildSelector（-f の組み立て）');
  check(
    'best は映像+音声の最高画質',
    engine.buildSelector({ mode: 'best', formats: info.formats }) === 'bestvideo*+bestaudio/best'
  );
  check(
    'audio は bestaudio',
    engine.buildSelector({ mode: 'audio', formats: info.formats }) === 'bestaudio/best'
  );
  check(
    '映像のみの形式には bestaudio を足す',
    engine.buildSelector({ mode: 'format', formatId: '137', formats: info.formats }) ===
      '137+bestaudio/137'
  );
  check(
    '映像+音声の形式はそのまま使う',
    engine.buildSelector({ mode: 'format', formatId: '18', formats: info.formats }) === '18'
  );

  group('download（進捗のパース）');
  const events = [];
  const result = await engine.download(
    {
      url: 'https://example.com/watch?v=abc123',
      mode: 'format',
      formatId: '137',
      formats: info.formats,
      outDir: path.join(require('os').tmpdir(), 'douga-test-out')
    },
    { onProgress: (p) => events.push(p) }
  );
  const progressEvents = events.filter((e) => e.status === 'downloading');
  check('進捗イベントを5回受信', progressEvents.length === 5, progressEvents.length);
  const last = progressEvents[progressEvents.length - 1];
  check('downloaded_bytes をパース', last.downloaded === 10000000, last.downloaded);
  check('total_bytes をパース', last.total === 10000000, last.total);
  check('speed をパース', last.speed === 2500000, last.speed);
  check('"NA" は null に正規化', last.fragmentIndex === null, last.fragmentIndex);
  check('後処理を processing として通知', events.some((e) => e.status === 'processing'));
  check(
    'Merger 行から最終ファイル名を取得',
    !!result.filePath && result.filePath.endsWith('テスト動画 [abc123].mp4'),
    result.filePath
  );

  group('Cookie の Netscape 形式変換');
  const jar = cookies.toNetscape([
    {
      name: 'sid',
      value: 'v1',
      domain: '.example.com',
      path: '/',
      secure: true,
      hostOnly: false,
      session: false,
      expirationDate: 1893456000.5
    },
    {
      name: 'tmp',
      value: 'v2',
      domain: 'a.example.com',
      path: '/x',
      secure: false,
      hostOnly: true,
      session: true
    }
  ]);
  const lines = jar.split('\n').filter((line) => line && !line.startsWith('#'));
  check('Cookie 2件を出力', lines.length === 2, lines.length);
  check(
    'サブドメイン共有 Cookie は先頭ドット + TRUE',
    lines[0] === '.example.com\tTRUE\t/\tTRUE\t1893456000\tsid\tv1',
    lines[0]
  );
  check(
    'hostOnly Cookie は FALSE、セッション Cookie は expiry 0',
    lines[1] === 'a.example.com\tFALSE\t/x\tFALSE\t0\ttmp\tv2',
    lines[1]
  );

  group('エラーメッセージ');
  settings.set({ ytdlpPath: path.join(require('os').tmpdir(), 'no-such-yt-dlp') });
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await engine.probe('https://example.com/x');
    check('yt-dlp 不在を検出', false);
  } catch (err) {
    check('yt-dlp 不在を日本語で通知', /yt-dlp が見つかりません/.test(err.message), err.message);
  } finally {
    process.env.PATH = originalPath;
  }

  done('engine');
})().catch((err) => {
  console.error('例外:', err);
  process.exit(1);
});
