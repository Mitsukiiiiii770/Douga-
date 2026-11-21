'use strict';

/**
 * テストランナー。各テストは electron の差し替えとグローバル状態
 * （設定ファイル・キュー・ブリッジ）を持つため、独立したプロセスで動かす。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const suites = [
  'engine.test.js',
  'quality.test.js',
  'title.test.js',
  'postprocess.test.js',
  'site-hints.test.js',
  'fallback.test.js',
  'manifest-order.test.js',
  'hls.test.js',
  'stream-detect.test.js',
  'detect.test.js',
  'diagnostics.test.js',
  'update.test.js',
  'launcher.test.js',
  'outpath.test.js',
  'browse.test.js',
  'browse-store.test.js',
  'search.test.js',
  'extension.test.js',
  'extension-state.test.js',
  'bridge.test.js',
  'queue.test.js',
  'persistence.test.js'
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: 'inherit'
  });
  if (result.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} 個のテストスイートが失敗しました。`);
  process.exit(1);
}
console.log('\nすべてのテストスイートが成功しました。');
