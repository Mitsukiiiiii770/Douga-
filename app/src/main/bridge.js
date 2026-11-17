'use strict';

const http = require('http');
const { EventEmitter } = require('events');
const settings = require('./settings');

const MAX_BODY = 2 * 1024 * 1024; // 2MB（Cookie 込みでも十分）
const APP_VERSION = require('../../package.json').version;

/**
 * 拡張機能がページから読み取ったメタ情報を検証する。
 * ファイル名に使うので、型と長さをここで確定させておく。
 */
function sanitizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (value, max) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
  const positive = (value) =>
    Number.isFinite(value) && value > 0 ? value : null;

  const thumbnail = text(raw.thumbnail, 2000);
  return {
    title: text(raw.title, 300),
    // http(s) 以外は表示に使わない（data: などを弾く）
    thumbnail: thumbnail && /^https?:\/\//i.test(thumbnail) ? thumbnail : null,
    duration: positive(Number(raw.duration)),
    width: positive(Number(raw.width)),
    height: positive(Number(raw.height)),
    siteName: text(raw.siteName, 100)
  };
}

/**
 * ブラウザ拡張からの接続を受ける localhost 専用サーバー。
 *
 * セキュリティ方針:
 *  - 127.0.0.1 にのみバインドする（LAN からは見えない）
 *  - /pair は chrome-extension:// / moz-extension:// 由来のみ受け付け、
 *    ユーザーがアプリ側のダイアログで許可した場合だけトークンを返す
 *  - それ以外のエンドポイントはトークン必須。普通の Web ページからは叩けない
 */
class Bridge extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = null;
    this.error = null;
    /** @type {null | ((origin: string, name: string) => Promise<boolean>)} */
    this.onPairRequest = null;
  }

  status() {
    return {
      running: !!this.server && this.server.listening,
      port: this.port,
      error: this.error,
      pairedClients: settings.get().pairedClients
    };
  }

  isExtensionOrigin(origin) {
    return typeof origin === 'string' && /^(chrome|moz|safari-web)-extension:\/\//.test(origin);
  }

  cors(req, res) {
    const origin = req.headers.origin;
    if (this.isExtensionOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Douga-Token');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  send(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('リクエストが大きすぎます'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('JSON を解析できませんでした'));
        }
      });
      req.on('error', reject);
    });
  }

  authorized(req) {
    const token = req.headers['x-douga-token'];
    const expected = settings.get().token;
    return !!token && !!expected && token === expected;
  }

  async handle(req, res) {
    this.cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

    if (url.pathname === '/ping') {
      return this.send(res, 200, {
        ok: true,
        app: 'douga',
        version: APP_VERSION,
        paired: this.authorized(req)
      });
    }

    if (url.pathname === '/pair' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (!this.isExtensionOrigin(origin)) {
        return this.send(res, 403, { ok: false, error: '拡張機能からのみ接続できます' });
      }
      let body = {};
      try {
        body = await this.readBody(req);
      } catch {
        /* 空ボディでも許容 */
      }
      const name = String(body.name || '不明な拡張機能').slice(0, 80);
      const cfg = settings.get();
      const already = cfg.pairedClients.some((c) => c.origin === origin);
      if (!already) {
        const approved = this.onPairRequest ? await this.onPairRequest(origin, name) : false;
        if (!approved) {
          return this.send(res, 403, { ok: false, error: 'ユーザーが接続を拒否しました' });
        }
        settings.set({
          pairedClients: [...cfg.pairedClients, { origin, name, pairedAt: Date.now() }]
        });
        this.emit('paired', { origin, name });
      }
      return this.send(res, 200, { ok: true, token: settings.get().token, version: APP_VERSION });
    }

    if (!this.authorized(req)) {
      return this.send(res, 401, { ok: false, error: 'ペアリングされていません' });
    }

    if (url.pathname === '/capture' && req.method === 'POST') {
      let body;
      try {
        body = await this.readBody(req);
      } catch (err) {
        return this.send(res, 400, { ok: false, error: err.message });
      }
      const capture = {
        pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl : '',
        pageTitle: typeof body.pageTitle === 'string' ? body.pageTitle.slice(0, 300) : '',
        target: typeof body.target === 'string' ? body.target : '',
        headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
        cookies: settings.get().acceptCookies && Array.isArray(body.cookies) ? body.cookies : [],
        meta: sanitizeMeta(body.meta),
        candidates: Array.isArray(body.candidates)
          ? body.candidates
              .filter((c) => c && typeof c.url === 'string')
              .slice(0, 100)
              .map((c) => ({
                url: c.url,
                kind: typeof c.kind === 'string' ? c.kind : '',
                label: typeof c.label === 'string' ? c.label.slice(0, 300) : '',
                size: Number.isFinite(c.size) ? c.size : null,
                noise: !!c.noise
              }))
          : [],
        // 検出ログ用。拡張機能が拾わなかった URL とその理由
        rejected: Array.isArray(body.rejected)
          ? body.rejected
              .filter((r) => r && typeof r.url === 'string')
              .slice(0, 100)
              .map((r) => ({
                url: r.url.slice(0, 400),
                reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : '',
                mime: typeof r.mime === 'string' ? r.mime.slice(0, 100) : '',
                size: Number.isFinite(r.size) ? r.size : null,
                resourceType: typeof r.resourceType === 'string' ? r.resourceType.slice(0, 40) : ''
              }))
          : [],
        uninteresting: Number.isFinite(body.uninteresting) ? body.uninteresting : 0,
        segments: Number.isFinite(body.segments) ? body.segments : 0,
        usesMediaSource: !!body.usesMediaSource,
        receivedAt: Date.now()
      };
      if (!capture.target && !capture.pageUrl) {
        return this.send(res, 400, { ok: false, error: 'URL が指定されていません' });
      }
      this.emit('capture', capture);
      return this.send(res, 200, { ok: true });
    }

    return this.send(res, 404, { ok: false, error: 'not found' });
  }

  start() {
    return new Promise((resolve) => {
      const cfg = settings.get();
      if (!cfg.bridgeEnabled) {
        this.error = null;
        return resolve(this.status());
      }
      this.stop();
      this.port = Number(cfg.bridgePort) || 47615;
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          try {
            this.send(res, 500, { ok: false, error: err.message });
          } catch { /* レスポンス済み */ }
        });
      });
      server.on('error', (err) => {
        this.error =
          err.code === 'EADDRINUSE'
            ? `ポート ${this.port} は既に使用されています。設定で別のポートを指定してください。`
            : err.message;
        this.server = null;
        this.emit('status', this.status());
        resolve(this.status());
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        this.error = null;
        this.emit('status', this.status());
        resolve(this.status());
      });
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch { /* すでに閉じている */ }
      this.server = null;
    }
  }
}

module.exports = new Bridge();
