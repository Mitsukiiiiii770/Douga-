'use strict';

/**
 * 自動更新を検証する。
 *
 * ここで守りたいのは2つ:
 *   1. 落としてきた ZIP は信用しない（展開先の外に書かせない）
 *   2. 入れ替えで消してはいけないものを消さない
 *      （node_modules と、ダウンロード済みの yt-dlp / ffmpeg）
 *
 * 通信はしない。ZIP は自前で組み立て、入れ替え先は一時フォルダを使う。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { group, check, done } = require('./helper');

const zip = require('../src/main/zip');
const update = require('../src/main/update');

/* ---------------- ZIP を組み立てる ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** テスト用の最小限の ZIP 書き出し */
function makeZip(files, { method = 8 } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, raw] of Object.entries(files)) {
    const content = Buffer.from(raw);
    const body = method === 8 ? zlib.deflateRawSync(content) : content;
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(content), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, end]);
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'douga-update-'));
}

function write(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

(async () => {
  group('ZIP の読み取り');
  const buf = makeZip({
    'Douga--v1/README.md': 'ここに説明',
    'Douga--v1/app/src/main/index.js': 'console.log(1)'.repeat(400)
  });
  const tree = zip.extract(buf, { strip: 1 });
  check('先頭の階層を取り除く', tree.has('README.md') && tree.has('app/src/main/index.js'));
  check('日本語を含む中身が戻る', tree.get('README.md').toString('utf8') === 'ここに説明');
  check(
    '圧縮された中身が戻る',
    tree.get('app/src/main/index.js').toString() === 'console.log(1)'.repeat(400)
  );
  check(
    '無圧縮でも読める',
    zip.extract(makeZip({ 'r/a.txt': 'plain' }, { method: 0 }), { strip: 1 }).get('a.txt').toString() ===
      'plain'
  );
  check('フォルダの項目は含まない', !zip.extract(makeZip({ 'r/d/': '' }), { strip: 1 }).has('d/'));
  check('壊れた ZIP は例外になる', (() => {
    try {
      zip.extract(Buffer.from('これは ZIP ではない'));
      return false;
    } catch {
      return true;
    }
  })());

  group('展開先の外に書かせない');
  check('.. を含むパスを弾く', zip.safePath('a/../../b') === null);
  check('絶対パスを弾く', zip.safePath('/etc/passwd') === null);
  check('Windows の絶対パスを弾く', zip.safePath('C:\\Windows\\x') === null);
  check('\\ 区切りの .. も弾く', zip.safePath('a\\..\\..\\b') === null);
  check('普通のパスは通る', zip.safePath('a//b/./c') === 'a/b/c');
  check(
    '危険な項目があれば展開ごと止める',
    (() => {
      try {
        zip.extract(makeZip({ 'r/../../evil.js': 'x' }), { strip: 1 });
        return false;
      } catch (err) {
        return /不正なパス/.test(err.message);
      }
    })(),
    '黙って飛ばすのではなく例外にする'
  );

  group('アクセストークンの送り先');
  const secret = 'ghp_dummy_for_test';
  check(
    'GitHub の API には送る',
    update.tokenFor('https://api.github.com/repos/a/b/commits/v1', secret) === secret
  );
  check(
    'GitHub の配信元にも送る',
    update.tokenFor('https://codeload.github.com/a/b/zip/refs/heads/v1', secret) === secret
  );
  check(
    'GitHub 以外には送らない',
    update.tokenFor('https://evil.example/steal', secret) === null,
    'リダイレクトで外へ飛ばされてもトークンを渡さないため'
  );
  check(
    '似た名前のドメインにも送らない',
    update.tokenFor('https://api.github.com.evil.example/x', secret) === null
  );
  check('トークンが空なら送らない', update.tokenFor('https://api.github.com/x', '') === null);
  check('空白だけでも送らない', update.tokenFor('https://api.github.com/x', '   ') === null);
  check('壊れた URL でも落ちない', update.tokenFor('これは URL ではない', secret) === null);

  group('消してはいけない場所');
  check('node_modules は守る', update.isProtected('app/node_modules/electron/index.js'));
  check('ダウンロード済みの yt-dlp / ffmpeg は守る', update.isProtected('app/bin/yt-dlp.exe'));
  check('.git は守る', update.isProtected('.git/config'));
  check('ふつうのファイルは対象', !update.isProtected('app/src/main/index.js'));
  check('名前が似ているだけのものは対象', !update.isProtected('app/binaries.js'));

  group('差分の算出');
  const root = tempRoot();
  write(root, 'README.md', '古い説明');
  write(root, 'app/src/main/index.js', 'old');
  write(root, 'app/src/main/消される.js', 'stale');
  write(root, 'app/node_modules/electron/index.js', '触るな');
  write(root, 'app/bin/yt-dlp.exe', '触るな');

  const incoming = new Map([
    ['README.md', Buffer.from('新しい説明')],
    ['app/src/main/index.js', Buffer.from('old')],
    ['app/src/main/新しい.js', Buffer.from('new')]
  ]);
  const changes = update.diff(incoming, root);
  check('中身が変わったものを挙げる', changes.changed.includes('README.md'), changes.changed);
  check('同じ中身は挙げない', !changes.changed.includes('app/src/main/index.js'));
  check('増えたものを挙げる', changes.added.includes('app/src/main/新しい.js'));
  check('消えたものを挙げる', changes.removed.includes('app/src/main/消される.js'));
  check(
    'node_modules は差分に出ない',
    !changes.removed.some((f) => f.includes('node_modules')),
    changes.removed
  );
  check('bin も差分に出ない', !changes.removed.some((f) => f.includes('app/bin')));

  group('依存の変化');
  write(root, 'app/package.json', JSON.stringify({ devDependencies: { electron: '^33.2.0' } }));
  check(
    '同じなら変化なし',
    !update.dependenciesChanged(
      new Map([['app/package.json', Buffer.from(JSON.stringify({ devDependencies: { electron: '^33.2.0' } }))]]),
      root
    )
  );
  check(
    'バージョンが変わったら検出する',
    update.dependenciesChanged(
      new Map([['app/package.json', Buffer.from(JSON.stringify({ devDependencies: { electron: '^34.0.0' } }))]]),
      root
    )
  );
  check(
    '依存以外の変化では反応しない',
    !update.dependenciesChanged(
      new Map([
        [
          'app/package.json',
          Buffer.from(JSON.stringify({ version: '0.2.0', devDependencies: { electron: '^33.2.0' } }))
        ]
      ]),
      root
    )
  );
  check('package.json が無ければ変化なし', !update.dependenciesChanged(new Map(), root));

  group('書き込み');
  const target = tempRoot();
  write(target, 'README.md', '古い');
  write(target, 'app/src/old.js', 'stale');
  write(target, 'app/bin/yt-dlp.exe', 'さわるな');
  write(target, 'app/node_modules/x/index.js', 'さわるな');

  const result = await update.apply({
    root: target,
    tree: new Map([
      ['README.md', Buffer.from('新しい')],
      ['app/src/new.js', Buffer.from('fresh')]
    ]),
    version: { sha: 'a'.repeat(40), message: 'テスト', date: null }
  });

  check('更新した件数を返す', result.updated === 2, result.updated);
  check('消した件数を返す', result.removed === 1, result.removed);
  check('中身が入れ替わる', fs.readFileSync(path.join(target, 'README.md'), 'utf8') === '新しい');
  check('増えたファイルが置かれる', fs.existsSync(path.join(target, 'app/src/new.js')));
  check('消えたファイルが消える', !fs.existsSync(path.join(target, 'app/src/old.js')));
  check(
    'ダウンロード済みの yt-dlp は残る',
    fs.readFileSync(path.join(target, 'app/bin/yt-dlp.exe'), 'utf8') === 'さわるな'
  );
  check(
    'node_modules は残る',
    fs.readFileSync(path.join(target, 'app/node_modules/x/index.js'), 'utf8') === 'さわるな'
  );
  check('控えのファイルを残さない', !update.walk(target, target).some((f) => f.endsWith('.douga-bak')));

  group('依存が変わったときの印');
  const deps = tempRoot();
  write(deps, 'app/package.json', JSON.stringify({ devDependencies: { electron: '^33.2.0' } }));
  const bumped = await update.apply({
    root: deps,
    tree: new Map([
      ['app/package.json', Buffer.from(JSON.stringify({ devDependencies: { electron: '^34.0.0' } }))]
    ]),
    version: { sha: 'c'.repeat(40), message: '', date: null }
  });
  check('依存の変化を知らせる', bumped.depsChanged === true);
  check(
    'ランチャー用の印を残す',
    fs.existsSync(path.join(deps, update.STALE_DEPS_FILE)),
    update.STALE_DEPS_FILE
  );

  const same = tempRoot();
  write(same, 'app/package.json', JSON.stringify({ devDependencies: { electron: '^33.2.0' } }));
  write(same, 'README.md', '古い');
  const plain = await update.apply({
    root: same,
    tree: new Map([
      ['app/package.json', Buffer.from(JSON.stringify({ devDependencies: { electron: '^33.2.0' } }))],
      ['README.md', Buffer.from('新しい')]
    ]),
    version: { sha: 'd'.repeat(40), message: '', date: null }
  });
  check('依存が同じなら知らせない', plain.depsChanged === false);
  check('印も残さない', !fs.existsSync(path.join(same, update.STALE_DEPS_FILE)));
  fs.rmSync(deps, { recursive: true, force: true });
  fs.rmSync(same, { recursive: true, force: true });

  group('書き込みに失敗したら元に戻す');
  const broken = tempRoot();
  write(broken, 'README.md', '元のまま');
  write(broken, 'app/src/a.js', '元のまま');
  // 書けないパスを混ぜる（既存のファイルの下にフォルダを作ろうとする）
  let restored = false;
  try {
    await update.apply({
      root: broken,
      tree: new Map([
        ['README.md', Buffer.from('書き換え')],
        ['app/src/a.js/невозможно.js', Buffer.from('ここは作れない')]
      ]),
      version: { sha: 'b'.repeat(40), message: '', date: null }
    });
  } catch {
    restored = true;
  }
  check('失敗したら例外になる', restored);
  check(
    '書き換えたファイルが元に戻る',
    fs.readFileSync(path.join(broken, 'README.md'), 'utf8') === '元のまま',
    fs.readFileSync(path.join(broken, 'README.md'), 'utf8')
  );
  check('失敗したら版も更新しない', update.localCommit(broken) === null);
  check('控えのファイルを残さない', !update.walk(broken, broken).some((f) => f.endsWith('.douga-bak')));

  group('過去の版を取っておく');
  const keepRoot = tempRoot();
  write(keepRoot, 'app/src/a.js', 'v1');
  write(keepRoot, 'README.md', 'v1');
  write(keepRoot, 'app/node_modules/x/i.js', '触るな');
  write(keepRoot, 'app/bin/yt-dlp.exe', '触るな');

  const saved = update.backupCurrent(keepRoot, { sha: 'e'.repeat(40), note: 'テスト' });
  check('控えを作る', saved && saved.files === 2, saved && saved.files);
  check('一覧に出る', update.listVersions(keepRoot).length === 1);
  check('覚書が読める', update.listVersions(keepRoot)[0].note === 'テスト');
  check('版が記録される', update.listVersions(keepRoot)[0].sha === 'e'.repeat(40));
  check(
    'node_modules は控えない',
    !fs.existsSync(path.join(keepRoot, update.VERSIONS_DIR, saved.name, 'app/node_modules')),
    '容量が無駄になるうえ、戻すときに壊れる'
  );
  check(
    'ダウンロード済みの yt-dlp も控えない',
    !fs.existsSync(path.join(keepRoot, update.VERSIONS_DIR, saved.name, 'app/bin'))
  );

  group('古い世代を消す');
  const manyRoot = tempRoot();
  write(manyRoot, 'app/src/a.js', 'x');
  const names = [];
  for (let i = 0; i < 5; i++) {
    // 名前は秒単位なので、並び順を確実にするため自分で作る
    const dir = path.join(manyRoot, update.VERSIONS_DIR, `2026111${i}-120000`);
    fs.mkdirSync(path.join(dir, 'app/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/src/a.js'), `v${i}`);
    names.push(`2026111${i}-120000`);
  }
  check('5 世代ある', update.listVersions(manyRoot).length === 5);
  const pruned = update.pruneVersions(manyRoot, 3);
  check('超えた分を消す', pruned.length === 2, pruned);
  check('残るのは指定した数', update.listVersions(manyRoot).length === 3);
  check('新しいものが残る', update.listVersions(manyRoot)[0].name === names[4]);
  check('古いものから消える', !update.listVersions(manyRoot).some((v) => v.name === names[0]));
  check('0 を指定すると全部消える', (() => {
    update.pruneVersions(manyRoot, 0);
    return update.listVersions(manyRoot).length === 0;
  })());

  group('過去の版に戻す');
  const backRoot = tempRoot();
  write(backRoot, 'app/src/a.js', '古い中身');
  write(backRoot, 'README.md', '古い説明');
  update.backupCurrent(backRoot, { sha: 'f'.repeat(40), note: '更新前' });
  const old = update.listVersions(backRoot)[0].name;

  write(backRoot, 'app/src/a.js', '新しい中身');
  write(backRoot, 'app/src/あとで増えた.js', '増えた');
  const back = update.restoreVersion(old, { root: backRoot });

  check('戻した件数を返す', back.restored === 2, back.restored);
  check('中身が戻る', fs.readFileSync(path.join(backRoot, 'app/src/a.js'), 'utf8') === '古い中身');
  check(
    '戻した版に無いファイルは消す',
    !fs.existsSync(path.join(backRoot, 'app/src/あとで増えた.js'))
  );
  check('版の記録も戻る', update.localCommit(backRoot) === 'f'.repeat(40));
  check(
    '戻す前の状態も控える',
    update.listVersions(backRoot).length === 2,
    '戻したこと自体をやり直せるようにするため'
  );
  check('知らない版を指定したら例外', (() => {
    try {
      update.restoreVersion('存在しない版', { root: backRoot });
      return false;
    } catch (err) {
      return /見つかりません/.test(err.message);
    }
  })());

  group('手元のパッチを読む');
  const patchRoot = tempRoot();
  const patchDir = tempRoot();
  write(patchRoot, 'app/src/a.js', '元の中身');
  write(patchRoot, 'app/src/消される.js', 'いらない');

  write(patchDir, '20261118-01/app/src/a.js', '直した中身');
  write(
    patchDir,
    '20261118-01/patch.json',
    JSON.stringify({ note: '検出の修正', remove: ['app/src/消される.js'] })
  );
  write(patchDir, '20261118-02/app/src/b.js', '新機能');

  const patches = update.listPatches(patchDir, { root: patchRoot });
  check('パッチを見つける', patches.length === 2, patches.length);
  check('名前順に並ぶ', patches[0].name === '20261118-01');
  check('覚書を読む', patches[0].note === '検出の修正');
  check('patch.json 自体はファイル数に数えない', patches[0].files.length === 1, patches[0].files);
  check('まだ当てていない扱い', patches.every((patch) => !patch.applied));
  check('置き場が無ければ空', update.listPatches('', { root: patchRoot }).length === 0);
  check('存在しない場所でも落ちない', update.listPatches('/存在しない場所').length === 0);

  group('パッチを当てる');
  const applied = update.applyPatch(patchDir, '20261118-01', { root: patchRoot });
  check('書き込んだ件数を返す', applied.written === 1, applied.written);
  check('中身が入れ替わる', fs.readFileSync(path.join(patchRoot, 'app/src/a.js'), 'utf8') === '直した中身');
  check('指定されたファイルを消す', !fs.existsSync(path.join(patchRoot, 'app/src/消される.js')));
  check('当てる前の状態を控える', update.listVersions(patchRoot).length === 1);
  check('適用済みとして記録する', update.appliedPatches(patchRoot).includes('20261118-01'));
  check(
    '二度目は候補に出ない',
    !update.pendingPatches(patchDir, { root: patchRoot }).some((p) => p.name === '20261118-01')
  );
  check(
    'まだのパッチは候補に残る',
    update.pendingPatches(patchDir, { root: patchRoot }).some((p) => p.name === '20261118-02')
  );

  group('パッチは指定が無ければ何も消さない');
  const safeRoot = tempRoot();
  const safeDir = tempRoot();
  write(safeRoot, 'app/src/a.js', '元');
  write(safeRoot, 'app/src/触られないはず.js', '残る');
  write(safeDir, 'p1/app/src/a.js', '直した');
  update.applyPatch(safeDir, 'p1', { root: safeRoot });
  check(
    '一部だけのパッチで他が消えない',
    fs.existsSync(path.join(safeRoot, 'app/src/触られないはず.js')),
    'パッチは差分なので、入っていない＝削除ではない'
  );

  group('パッチの削除指定も信用しない');
  const evilRoot = tempRoot();
  const evilDir = tempRoot();
  write(evilRoot, 'app/src/a.js', '元');
  write(evilRoot, 'app/bin/yt-dlp.exe', '守る');
  write(evilDir, 'p1/app/src/a.js', '直した');
  write(
    evilDir,
    'p1/patch.json',
    JSON.stringify({ remove: ['../../外に出る.txt', 'app/bin/yt-dlp.exe', 'app/node_modules/x'] })
  );
  const guarded = update.applyPatch(evilDir, 'p1', { root: evilRoot });
  check('外へ出る指定は無視する', guarded.deleted === 0, guarded.deleted);
  check('守る場所は消さない', fs.existsSync(path.join(evilRoot, 'app/bin/yt-dlp.exe')));

  for (const dir of [keepRoot, manyRoot, backRoot, patchRoot, patchDir, safeRoot, safeDir, evilRoot, evilDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  group('版の記録');
  check('更新後に版が記録される', update.localCommit(target) === 'a'.repeat(40));
  check('壊れた版ファイルは無視する', (() => {
    fs.writeFileSync(update.versionPath(target), 'これは SHA ではない');
    return update.localCommit(target) === null;
  })());
  check('ファイルが無ければ不明', update.localCommit(tempRoot()) === null);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(broken, { recursive: true, force: true });
  done('update');
})();
