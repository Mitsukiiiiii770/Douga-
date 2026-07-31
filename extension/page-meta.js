'use strict';

/**
 * ページから動画のタイトル・サムネイル・再生時間を読み取る。
 *
 * yt-dlp がページ URL を解析できるサイトでは yt-dlp 側の情報のほうが正確なので、
 * ここで取るのはあくまで「マニフェスト URL へフォールバックしたとき」の保険。
 * その場合 yt-dlp は URL のファイル名からタイトルを作るため、
 * master.m3u8 なら全部 "master" になってしまう。
 *
 * サイトを列挙せずに済むよう、どのサイトでも使われている順に見ていく:
 *   1. JSON-LD の VideoObject（構造化データ。最も信頼できる）
 *   2. OpenGraph / Twitter Card（SNS 共有用。ほぼ全ての動画サイトが持つ）
 *   3. <title> からサイト名を除いたもの
 *   4. video 要素自身（poster と duration）
 */

(function (root) {
  /** ISO 8601 の継続時間（PT1H2M3S）を秒に直す */
  function parseIsoDuration(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i);
    if (!match) return null;
    const [, h, m, s] = match;
    const seconds = (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
    return seconds > 0 ? seconds : null;
  }

  function metaContent(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const value = el && (el.getAttribute('content') || el.getAttribute('href'));
      if (value && value.trim()) return value.trim();
    }
    return null;
  }

  /** JSON-LD を全部走査して、最初に見つかった VideoObject を返す */
  function findVideoObject() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      // @graph や配列で包まれていることが多いので、平らにして探す
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
  }

  /** "動画タイトル - サイト名" からサイト名部分を落とす */
  function cleanDocumentTitle() {
    const raw = (document.title || '').trim();
    if (!raw) return null;

    const siteName = metaContent(['meta[property="og:site_name"]']);
    if (siteName) {
      // 区切り文字はサイトによって様々なので、まとめて扱う
      const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = raw.replace(new RegExp(`\\s*[-–—|/·:]\\s*${escaped}\\s*$`, 'i'), '');
      if (stripped && stripped !== raw) return stripped.trim();
    }
    return raw;
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  /** JSON-LD の thumbnailUrl は文字列・配列・オブジェクトのいずれもありうる */
  function normalizeThumbnail(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return normalizeThumbnail(value[0]);
    if (typeof value === 'object') return normalizeThumbnail(value.url || value.contentUrl);
    return null;
  }

  function absolute(url) {
    if (!url) return null;
    try {
      return new URL(url, location.href).toString();
    } catch {
      return null;
    }
  }

  /**
   * @param {HTMLMediaElement|null} media 再生中のメディア要素（あれば）
   */
  function extract(media) {
    const video = findVideoObject() || {};

    const title = firstString(
      video.name,
      video.headline,
      metaContent([
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
        'meta[itemprop="name"]'
      ]),
      media && media.getAttribute('title'),
      media && media.getAttribute('aria-label'),
      cleanDocumentTitle()
    );

    const thumbnail = absolute(
      firstString(
        normalizeThumbnail(video.thumbnailUrl || video.thumbnail),
        metaContent([
          'meta[property="og:image:secure_url"]',
          'meta[property="og:image"]',
          'meta[name="twitter:image"]',
          'meta[itemprop="thumbnailUrl"]'
        ]),
        media && media.poster
      )
    );

    // 実際に読み込まれている要素の尺が一番正確なので最優先
    const elementDuration =
      media && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null;
    const metaDuration = Number(
      metaContent(['meta[property="og:video:duration"]', 'meta[itemprop="duration"]'])
    );
    const duration =
      elementDuration ||
      parseIsoDuration(video.duration) ||
      (Number.isFinite(metaDuration) && metaDuration > 0 ? metaDuration : null);

    const width = (media && media.videoWidth) || null;
    const height = (media && media.videoHeight) || null;

    return {
      title: title ? title.slice(0, 300) : null,
      thumbnail,
      duration,
      width,
      height,
      siteName: metaContent(['meta[property="og:site_name"]'])
    };
  }

  root.DougaPageMeta = { extract, parseIsoDuration, cleanDocumentTitle };
})(typeof self !== 'undefined' ? self : globalThis);
