'use strict';

/**
 * Douga デスクトップアプリ（127.0.0.1 で待ち受け）との通信。
 * popup / options の両方から使う。
 */

const DEFAULTS = { port: 47615, token: '', sendCookies: false };

async function config() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function base(port) {
  return `http://127.0.0.1:${port}`;
}

async function request(path, { method = 'GET', body, token, port, timeout = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(base(port) + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Douga-Token': token } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      data: {},
      error: err.name === 'AbortError' ? 'タイムアウトしました' : 'アプリに接続できません'
    };
  } finally {
    clearTimeout(timer);
  }
}

/** アプリが起動しているか / ペアリング済みかを確認 */
async function ping() {
  const cfg = await config();
  const result = await request('/ping', { port: cfg.port, token: cfg.token, timeout: 2500 });
  if (!result.ok) {
    return { running: false, paired: false, error: result.error || 'アプリが応答しません' };
  }
  return {
    running: true,
    paired: !!result.data.paired,
    version: result.data.version || null,
    port: cfg.port
  };
}

/** ユーザーがアプリ側のダイアログで許可すればトークンが返る */
async function pair() {
  const cfg = await config();
  const result = await request('/pair', {
    method: 'POST',
    port: cfg.port,
    body: { name: chrome.runtime.getManifest().name }
  });
  if (!result.ok || !result.data.token) {
    return { ok: false, error: result.data.error || result.error || 'ペアリングに失敗しました' };
  }
  await chrome.storage.local.set({ token: result.data.token });
  return { ok: true, version: result.data.version };
}

/** 検出結果をアプリへ送る */
async function capture(payload) {
  const cfg = await config();
  if (!cfg.token) return { ok: false, error: 'アプリとペアリングされていません' };
  const result = await request('/capture', {
    method: 'POST',
    port: cfg.port,
    token: cfg.token,
    body: payload,
    timeout: 15000
  });
  if (result.status === 401) {
    await chrome.storage.local.set({ token: '' });
    return { ok: false, error: 'ペアリングが解除されています。再接続してください。' };
  }
  if (!result.ok) return { ok: false, error: result.data.error || result.error || '送信に失敗しました' };
  return { ok: true };
}

/**
 * 対象 URL に送られる Cookie を集める。
 * ログインが必要なサイトの動画を取得するために使う（設定でオプトイン）。
 */
async function collectCookies(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls.filter(Boolean)) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ url });
    } catch {
      continue;
    }
    for (const cookie of list) {
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        hostOnly: cookie.hostOnly,
        session: cookie.session,
        expirationDate: cookie.expirationDate || null
      });
    }
  }
  return out;
}

export { config, ping, pair, capture, collectCookies, DEFAULTS };
