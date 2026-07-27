'use strict';

/**
 * テスト用のヘルパー。
 *
 * main プロセスのモジュールは electron の app.getPath に依存しているため、
 * require フックで electron を差し替えてから読み込む。これにより
 * Electron を起動せずに Node だけでロジックを検証できる。
 */

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'douga-test-'));

const fakeElectron = {
  app: {
    getPath: (key) => {
      const dir = path.join(tmpRoot, key === 'downloads' ? 'downloads' : 'userData');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    getAppPath: () => path.join(__dirname, '..'),
    isPackaged: false
  }
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, ...rest);
};

const fixture = (name) => path.join(__dirname, 'fixtures', name);

let failures = 0;
let total = 0;

function group(name) {
  console.log(`\n# ${name}`);
}

function check(name, condition, detail) {
  total++;
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log('        →', JSON.stringify(detail));
  }
}

function done(suiteName) {
  if (failures === 0) {
    console.log(`\n${suiteName}: ${total} 件すべて成功`);
    process.exit(0);
  }
  console.log(`\n${suiteName}: ${failures} / ${total} 件 失敗`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { fakeElectron, tmpRoot, fixture, group, check, done, sleep };
