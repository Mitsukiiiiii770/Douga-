'use strict';

/**
 * アプリ内ブラウザのページに注入して、タイトル・サムネイル・再生時間を読む。
 *
 * webview.executeJavaScript() へ文字列として渡すため、モジュールではなく
 * 「評価すると結果を返す式」を文字列で持つ。こうしておけば、拡張機能側と
 * 同じ判定を 1 箇所で管理できる。
 *
 * 探す順序はどのサイトでも共通で使われているものから:
 *   1. JSON-LD の VideoObject（構造化データ。最も信頼できる）
 *   2. OpenGraph / Twitter Card（SNS 共有用。ほぼ全ての動画サイトが持つ）
 *   3. <title> からサイト名を除いたもの
 *   4. video 要素自身（poster と duration）
 */

const SOURCE = `(() => {
  const parseIsoDuration = (value) => {
    if (typeof value !== 'string') return null;
    const m = value.match(/^P(?:\\d+D)?T(?:(\\d+)H)?(?:(\\d+)M)?(?:([\\d.]+)S)?$/i);
    if (!m) return null;
    const s = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
    return s > 0 ? s : null;
  };

  const metaContent = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const v = el && (el.getAttribute('content') || el.getAttribute('href'));
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  const findVideoObject = () => {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      const queue = Array.isArray(data) ? [...data] : [data];
      let guard = 0;
      while (queue.length && guard++ < 200) {
        const node = queue.shift();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
        const type = node['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.includes('VideoObject')) return node;
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') queue.push(value);
        }
      }
    }
    return null;
  };

  const cleanTitle = () => {
    const raw = (document.title || '').trim();
    if (!raw) return null;
    const site = metaContent(['meta[property="og:site_name"]']);
    if (site) {
      const escaped = site.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const stripped = raw.replace(new RegExp('\\\\s*[-–—|/·:]\\\\s*' + escaped + '\\\\s*$', 'i'), '');
      if (stripped && stripped !== raw) return stripped.trim();
    }
    return raw;
  };

  const first = (...values) => {
    for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
    return null;
  };

  const thumbOf = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return thumbOf(value[0]);
    if (typeof value === 'object') return thumbOf(value.url || value.contentUrl);
    return null;
  };

  const absolute = (url) => {
    if (!url) return null;
    try { return new URL(url, location.href).toString(); } catch { return null; }
  };

  // 再生中のものを優先して選ぶ
  const videos = [...document.querySelectorAll('video')];
  const media =
    videos.find((v) => !v.paused && !v.ended) ||
    videos.find((v) => v.currentTime > 0) ||
    videos[0] ||
    null;

  const video = findVideoObject() || {};

  const title = first(
    video.name,
    video.headline,
    metaContent([
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[itemprop="name"]'
    ]),
    media && media.getAttribute('title'),
    media && media.getAttribute('aria-label'),
    cleanTitle()
  );

  const thumbnail = absolute(first(
    thumbOf(video.thumbnailUrl || video.thumbnail),
    metaContent([
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'meta[itemprop="thumbnailUrl"]'
    ]),
    media && media.poster
  ));

  // 実際に読み込まれている要素の尺が一番正確
  const elementDuration =
    media && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null;
  const metaDuration = Number(
    metaContent(['meta[property="og:video:duration"]', 'meta[itemprop="duration"]'])
  );

  return {
    title: title ? title.slice(0, 300) : null,
    thumbnail,
    duration:
      elementDuration ||
      parseIsoDuration(video.duration) ||
      (Number.isFinite(metaDuration) && metaDuration > 0 ? metaDuration : null),
    width: (media && media.videoWidth) || null,
    height: (media && media.videoHeight) || null,
    siteName: metaContent(['meta[property="og:site_name"]']),
    // 再生が始まっていないと配信 URL が出ないサイトがあるため、状態を伝える
    hasVideoElement: videos.length > 0,
    isPlaying: !!(media && !media.paused && !media.ended)
  };
})()`;

module.exports = { SOURCE };
