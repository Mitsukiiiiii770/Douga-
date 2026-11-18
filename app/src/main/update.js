'use strict';

/**
 * アプリの自動更新。
 *
 * これまでは更新のたびに GitHub から手で ZIP を落として、展開して、
 * 上書きする必要があった。面倒なうえに、どこまで更新したかも分からなくなる。
 * アプリの中から取りに行けるようにする。
 *
 * 作りの方針:
 *   - インストーラを使わず、ソースをそのまま入れ替える。
 *     このアプリは `npm start` で動くので、JS を差し替えて再起動すれば済む。
 *     Windows でも、実行中にロックされるのは Electron 本体だけで、
 *     読み込み済みの JS ファイルは上書きできる。
 *   - 設定とダウンロード履歴は userData フォルダにあるので、
 *     ソースを丸ごと入れ替えても消えない。
 *   - yt-dlp / ffmpeg は app/bin に置かれる。ZIP には含まれないので触らない。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const zip = require('./zip');
const settings = require('./settings');

const OWNER = 'Mitsukiiiii770';
const REPO = 'Douga-';
/** 配布用のブランチ。開発用ブランチではなくこちらを見る */
const BRANCH = 'v1';

/** 今どの版を使っているかを覚えておくファイル */
const VERSION_FILE = '.douga-version';

/**
 * 依存パッケージが変わったときに置く印。
 * ランチャー（Douga起動.bat）がこれを見て npm install を走らせる。
 * アプリ自身は実行中なので、自分で入れ直すことはできない。
 */
const STALE_DEPS_FILE = 'app/.deps-stale';

/**
 * 中身を丸ごと入れ替えるフォルダ。
 * 上流で消されたファイルが残らないよう、一度消してから書き直す。
 */
const REPLACE_DIRS = ['app/src', 'app/test', 'extension', 'tools'];

/**
 * 絶対に触らない場所。
 * node_modules と bin は ZIP に含まれないが、取り違えで消すと
 * 再インストールや再ダウンロードが必要になるので明示的に守る。
 */
const PROTECTED = ['app/node_modules', 'app/bin', 'app/dist', '.git', 'versions'];

/** 過去の版を取っておく場所 */
const VERSIONS_DIR = 'versions';

/** 既定で残す世代数。これを超えた古いものから消す */
const DEFAULT_KEEP = 3;

/** 適用済みのパッチを覚えておくファイル。同じものを二度当てないため */
const APPLIED_FILE = '.douga-applied';

class UpdateError extends Error {}

function rootDir() {
  // app/src/main/update.js → リポジトリの一番上
  return path.resolve(__dirname, '..', '..', '..');
}

function versionPath(root = rootDir()) {
  return path.join(root, VERSION_FILE);
}

/** 今の版（コミット）。手で ZIP を落とした直後は分からない */
function localCommit(root = rootDir()) {
  try {
    const text = fs.readFileSync(versionPath(root), 'utf8').trim();
    return /^[0-9a-f]{7,40}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function writeLocalCommit(sha, root = rootDir()) {
  fs.writeFileSync(versionPath(root), `${sha}\n`, 'utf8');
}

/* ---------------- 通信 ---------------- */

/**
 * アクセストークンを送ってよい相手。
 *
 * リダイレクトを追うときに無条件で持ち回すと、GitHub 以外へ
 * 飛ばされた場合にトークンを渡してしまう。送り先を限定する。
 */
const TOKEN_HOSTS = ['api.github.com', 'codeload.github.com'];

function tokenFor(url, explicit) {
  let token = '';
  try {
    token = ((explicit === undefined ? settings.get().githubToken : explicit) || '').trim();
  } catch {
    return null;
  }
  if (!token) return null;
  try {
    return TOKEN_HOSTS.includes(new URL(url).hostname) ? token : null;
  } catch {
    return null;
  }
}

/**
 * 本文をまとめて受け取る。リダイレクトは追う。
 * User-Agent には利用者を特定できる情報を入れない。
 */
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new UpdateError('リダイレクトが多すぎます'));
    const headers = { 'User-Agent': 'Douga', Accept: '*/*' };
    // 非公開リポジトリは、トークンが無いと 404 になる（403 ではない）
    const token = tokenFor(url);
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = https.get(url, { headers, timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode === 403 && /rate limit/i.test(res.headers['x-ratelimit-remaining'] || '')) {
          res.resume();
          return reject(new UpdateError('GitHub の利用制限に達しました。しばらく待ってから試してください'));
        }
        if (res.statusCode === 404) {
          res.resume();
          return reject(
            new UpdateError(
              settings.get().githubToken
                ? '見つかりませんでした。アクセストークンの権限（Contents: Read）を確認してください'
                : 'リポジトリが非公開のため取得できません。公開するか、設定の「GitHub アクセストークン」を入力してください'
            )
          );
        }
        if (res.statusCode === 401) {
          res.resume();
          return reject(new UpdateError('アクセストークンが無効です。入力し直してください'));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new UpdateError(`取得に失敗しました (HTTP ${res.statusCode})`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new UpdateError('接続がタイムアウトしました')));
    req.on('error', (err) =>
      reject(err instanceof UpdateError ? err : new UpdateError(`通信に失敗しました: ${err.message}`))
    );
  });
}

/** 配布ブランチの最新コミット */
async function latest() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/commits/${BRANCH}`;
  let data;
  try {
    data = JSON.parse((await get(url)).toString('utf8'));
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    throw new UpdateError('GitHub の応答を読めませんでした');
  }
  if (!data || !data.sha) throw new UpdateError('更新情報を取得できませんでした');
  return {
    sha: data.sha,
    message: ((data.commit && data.commit.message) || '').split('\n')[0],
    date: (data.commit && data.commit.committer && data.commit.committer.date) || null
  };
}

/** ソース一式を取ってきて展開する */
async function fetchTree() {
  // API 経由なら非公開リポジトリでもトークンで取得できる
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/zipball/${BRANCH}`;
  const buf = await get(url);
  // GitHub の ZIP は全体が「リポジトリ名-ブランチ名/」で包まれている
  return zip.extract(buf, { strip: 1 });
}

/* ---------------- 比較 ---------------- */

function digest(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isProtected(relPath) {
  return PROTECTED.some((base) => relPath === base || relPath.startsWith(`${base}/`));
}

/**
 * 取ってきた中身と手元の中身を比べ、書き換わるファイルを挙げる。
 * @returns {{changed: string[], added: string[], removed: string[]}}
 */
function diff(tree, root = rootDir()) {
  const changed = [];
  const added = [];

  for (const [relPath, content] of tree) {
    if (isProtected(relPath)) continue;
    const full = path.join(root, relPath);
    let existing;
    try {
      existing = fs.readFileSync(full);
    } catch {
      added.push(relPath);
      continue;
    }
    if (digest(existing) !== digest(content)) changed.push(relPath);
  }

  // 入れ替え対象のフォルダから消えたファイル
  const removed = [];
  for (const dir of REPLACE_DIRS) {
    for (const relPath of walk(path.join(root, dir), root)) {
      if (!tree.has(relPath)) removed.push(relPath);
    }
  }

  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/** フォルダ以下のファイルを、root からの相対パスで列挙する */
function walk(dir, root, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (isProtected(rel)) continue;
    if (item.isDirectory()) walk(full, root, out);
    else out.push(rel);
  }
  return out;
}

/** package.json の依存が変わったか（変わったら npm install が要る） */
function dependenciesChanged(tree, root = rootDir()) {
  const incoming = tree.get('app/package.json');
  if (!incoming) return false;
  let current;
  try {
    current = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf8'));
  } catch {
    return true;
  }
  let next;
  try {
    next = JSON.parse(incoming.toString('utf8'));
  } catch {
    return false;
  }
  const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
  return !same(current.dependencies, next.dependencies) ||
    !same(current.devDependencies, next.devDependencies);
}

/* ---------------- 過去の版 ---------------- */

/**
 * 今の中身を versions/ に取っておく。
 *
 * 更新で動かなくなったとき、GitHub から古い版を探して落とし直すのは
 * 手間がかかる。手元に数世代あれば、ボタン一つで戻せる。
 */
function backupCurrent(root = rootDir(), { sha = null, note = '' } = {}) {
  const name = `${stampNow()}${sha ? `_${sha.slice(0, 7)}` : ''}`;
  const dest = path.join(root, VERSIONS_DIR, name);

  let count = 0;
  for (const relPath of walk(root, root)) {
    const from = path.join(root, relPath);
    const to = path.join(dest, relPath);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      count++;
    } catch {
      /* 1 つ失敗しても控え全体は作る */
    }
  }
  if (!count) return null;

  try {
    fs.writeFileSync(
      path.join(dest, 'version.json'),
      JSON.stringify({ sha, note, savedAt: new Date().toISOString(), files: count }, null, 2),
      'utf8'
    );
  } catch {
    /* 覚書が書けなくても戻すことはできる */
  }
  return { name, path: dest, files: count };
}

function stampNow(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

/** 取ってある版の一覧。新しい順 */
function listVersions(root = rootDir()) {
  let names = [];
  try {
    names = fs
      .readdirSync(path.join(root, VERSIONS_DIR), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((name) => {
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(path.join(root, VERSIONS_DIR, name, 'version.json'), 'utf8'));
      } catch {
        /* 覚書が無くても一覧には出す */
      }
      return {
        name,
        sha: info.sha || null,
        note: info.note || '',
        savedAt: info.savedAt || null,
        files: info.files || null
      };
    });
}

/** 古い世代を消す。@returns 消した版の名前 */
function pruneVersions(root = rootDir(), keep = DEFAULT_KEEP) {
  const limit = Math.max(0, Number(keep) || 0);
  const removed = [];
  for (const entry of listVersions(root).slice(limit)) {
    try {
      fs.rmSync(path.join(root, VERSIONS_DIR, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      /* 消せなくても次の更新で改めて試す */
    }
  }
  return removed;
}

/**
 * 取ってある版に戻す。
 * 戻す前に今の中身も控えておくので、戻したこと自体をやり直せる。
 */
function restoreVersion(name, { root = rootDir() } = {}) {
  const from = path.join(root, VERSIONS_DIR, name);
  if (!fs.existsSync(from)) throw new UpdateError(`その版は見つかりません: ${name}`);

  backupCurrent(root, { note: `${name} に戻す前の状態` });

  const files = walk(from, from).filter((rel) => rel !== 'version.json');
  if (!files.length) throw new UpdateError('その版には中身がありません');

  const kept = new Set(files);
  for (const relPath of files) {
    const to = path.join(root, relPath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(from, relPath), to);
  }

  // 戻した版に無いファイルは、入れ替え対象のフォルダからだけ消す
  let removed = 0;
  for (const dir of REPLACE_DIRS) {
    for (const relPath of walk(path.join(root, dir), root)) {
      if (kept.has(relPath)) continue;
      try {
        fs.unlinkSync(path.join(root, relPath));
        removed++;
      } catch {
        /* 消せなくても戻した分は反映される */
      }
    }
  }

  let sha = null;
  try {
    sha = JSON.parse(fs.readFileSync(path.join(from, 'version.json'), 'utf8')).sha || null;
  } catch {
    /* 覚書が無ければ版は不明のまま */
  }
  if (sha) writeLocalCommit(sha, root);
  else {
    try {
      fs.unlinkSync(versionPath(root));
    } catch {
      /* 元から無ければそれでよい */
    }
  }

  return { name, restored: files.length, removed };
}

/* ---------------- 手元のフォルダから更新する ---------------- */

/**
 * パッチ置き場から、まだ当てていないものを探す。
 *
 * GitHub を経由せず、このフォルダにファイルを置くだけで更新できる。
 * 中身は「変わったファイルだけ」でよい。
 *
 *   パッチ置き場/
 *     20261118-01/
 *       patch.json            ← 任意。{"note": "...", "remove": ["消すファイル"]}
 *       app/src/main/engine.js
 *
 * 安全のため、patch.json の remove に書かれていないファイルは消さない。
 * 一部のファイルしか入っていないパッチで、他が全部消えては困る。
 */
function listPatches(dir, { root = rootDir() } = {}) {
  if (!dir) return [];
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort();
  } catch {
    return [];
  }

  const applied = new Set(appliedPatches(root));
  return names.map((name) => {
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, name, 'patch.json'), 'utf8'));
    } catch {
      /* 覚書は任意 */
    }
    const files = walk(path.join(dir, name), path.join(dir, name)).filter((f) => f !== 'patch.json');
    return {
      name,
      note: info.note || '',
      remove: Array.isArray(info.remove) ? info.remove : [],
      files,
      applied: applied.has(name)
    };
  });
}

/** まだ当てていないパッチだけ */
function pendingPatches(dir, options = {}) {
  return listPatches(dir, options).filter((patch) => !patch.applied && patch.files.length);
}

function appliedPatches(root = rootDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, APPLIED_FILE), 'utf8')).applied || [];
  } catch {
    return [];
  }
}

function markApplied(name, root = rootDir()) {
  const list = appliedPatches(root);
  if (!list.includes(name)) list.push(name);
  try {
    fs.writeFileSync(path.join(root, APPLIED_FILE), JSON.stringify({ applied: list }, null, 2), 'utf8');
  } catch {
    /* 記録できなければ、次回また候補に出るだけ */
  }
  return list;
}

/**
 * パッチを 1 つ当てる。
 * 書き換える前に今の中身を控えるのは GitHub 経由の更新と同じ。
 */
function applyPatch(dir, name, { root = rootDir(), keep = DEFAULT_KEEP } = {}) {
  const source = path.join(dir, name);
  const files = walk(source, source).filter((f) => f !== 'patch.json');
  if (!files.length) throw new UpdateError('そのパッチには中身がありません');

  let remove = [];
  try {
    const info = JSON.parse(fs.readFileSync(path.join(source, 'patch.json'), 'utf8'));
    if (Array.isArray(info.remove)) remove = info.remove;
  } catch {
    /* 覚書が無ければ何も消さない */
  }

  backupCurrent(root, { sha: localCommit(root), note: `パッチ ${name} を当てる前の状態` });

  let written = 0;
  for (const relPath of files) {
    if (isProtected(relPath)) continue;
    const to = path.join(root, relPath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(source, relPath), to);
    written++;
  }

  let deleted = 0;
  for (const relPath of remove) {
    const safe = zip.safePath(relPath);
    // パッチの中身も素性が確かとは限らないので、外へ出る指定は無視する
    if (!safe || isProtected(safe)) continue;
    try {
      fs.unlinkSync(path.join(root, safe));
      deleted++;
    } catch {
      /* 既に無ければそれでよい */
    }
  }

  markApplied(name, root);
  const pruned = pruneVersions(root, keep);

  return { name, written, deleted, pruned, depsChanged: files.includes('app/package.json') };
}

/* ---------------- 確認と適用 ---------------- */

/**
 * 更新があるか調べる。
 *
 * 版が分かっていて最新と同じなら、ソースは落とさずに済ませる。
 * 版が分からない場合（手で ZIP を落とした直後など）は中身を比べる。
 * ここで同じだと分かれば版を記録するので、次回からは軽くなる。
 */
async function check({ root = rootDir() } = {}) {
  const current = localCommit(root);
  const newest = await latest();

  if (current && current === newest.sha) {
    return { upToDate: true, current, latest: newest, changes: null };
  }

  const tree = await fetchTree();
  const changes = diff(tree, root);
  const hasChanges = changes.changed.length + changes.added.length + changes.removed.length > 0;

  if (!hasChanges) {
    // 中身は同じ。版だけ記録しておけば次回は通信 1 回で済む
    try {
      writeLocalCommit(newest.sha, root);
    } catch {
      /* 書けなくても判定には影響しない */
    }
    return { upToDate: true, current: newest.sha, latest: newest, changes };
  }

  return {
    upToDate: false,
    current,
    latest: newest,
    changes,
    depsChanged: dependenciesChanged(tree, root),
    tree
  };
}

/**
 * 実際に書き換える。
 *
 * 途中で失敗してもアプリが壊れないよう、先に全部を一時フォルダへ書いてから
 * 移す……のが理想だが、Windows でフォルダをまたぐ移動は失敗しやすい。
 * 代わりに、書き換える前のファイルを .bak として残し、失敗したら戻す。
 */
async function apply({ root = rootDir(), tree = null, version = null, keep = DEFAULT_KEEP } = {}) {
  const files = tree || (await fetchTree());
  // 確認のときに取った版をそのまま使う。無ければ聞きに行く
  const newest = version || (await latest());
  const changes = diff(files, root);
  // 書き換える前に調べる。書き換えた後では比較できなくなる
  const depsDiffered = dependenciesChanged(files, root);

  // 書き換える前に、今の中身を丸ごと控えておく
  backupCurrent(root, { sha: localCommit(root), note: `${newest.sha.slice(0, 7)} へ更新する前の状態` });

  /** @type {Array<{full: string, backup: string|null}>} 戻すための控え */
  const done = [];

  try {
    for (const relPath of [...changes.changed, ...changes.added]) {
      const content = files.get(relPath);
      if (!content) continue;
      const full = path.join(root, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });

      let backup = null;
      if (fs.existsSync(full)) {
        backup = `${full}.douga-bak`;
        fs.copyFileSync(full, backup);
      }
      fs.writeFileSync(full, content);
      done.push({ full, backup });
    }

    for (const relPath of changes.removed) {
      const full = path.join(root, relPath);
      const backup = `${full}.douga-bak`;
      try {
        fs.copyFileSync(full, backup);
        fs.unlinkSync(full);
        done.push({ full, backup });
      } catch {
        /* 消せなくても更新は続ける */
      }
    }
  } catch (err) {
    // 書き換えたところを元に戻す
    for (const item of done.reverse()) {
      try {
        if (item.backup) fs.copyFileSync(item.backup, item.full);
        else fs.unlinkSync(item.full);
      } catch {
        /* 戻せないものは諦める */
      }
    }
    cleanBackups(done);
    throw new UpdateError(`更新の書き込みに失敗しました: ${err.message}`);
  }

  cleanBackups(done);
  writeLocalCommit(newest.sha, root);

  // package.json は既に書き換わっているので、比較は入れ替え前の差分から判断する
  const depsChanged = changes.changed.includes('app/package.json') && depsDiffered;
  if (depsChanged) {
    try {
      fs.writeFileSync(path.join(root, STALE_DEPS_FILE), '依存パッケージの更新が必要です\n', 'utf8');
    } catch {
      /* 印を残せなくても、画面には案内を出す */
    }
  }

  const pruned = pruneVersions(root, keep);

  return {
    ok: true,
    version: newest,
    updated: changes.changed.length + changes.added.length,
    removed: changes.removed.length,
    pruned,
    depsChanged
  };
}

function cleanBackups(done) {
  for (const item of done) {
    if (!item.backup) continue;
    try {
      fs.unlinkSync(item.backup);
    } catch {
      /* 残っても動作には影響しない */
    }
  }
}

module.exports = {
  check,
  apply,
  latest,
  fetchTree,
  diff,
  walk,
  dependenciesChanged,
  localCommit,
  writeLocalCommit,
  rootDir,
  versionPath,
  isProtected,
  UpdateError,
  OWNER,
  REPO,
  BRANCH,
  REPLACE_DIRS,
  PROTECTED,
  VERSION_FILE,
  STALE_DEPS_FILE,
  TOKEN_HOSTS,
  tokenFor,
  backupCurrent,
  listVersions,
  pruneVersions,
  restoreVersion,
  listPatches,
  pendingPatches,
  appliedPatches,
  markApplied,
  applyPatch,
  stampNow,
  VERSIONS_DIR,
  APPLIED_FILE,
  DEFAULT_KEEP
};
