'use strict';

/**
 * ページ内の <video> / <audio> を走査し、実際に再生中のソースを background に送る。
 *
 * MediaSource (blob:) 経由で再生されている場合、その blob URL は
 * 拡張機能側からは取得できない。その事実だけを伝えて、
 * ポップアップ側で「マニフェストを使ってください」と案内する。
 */

let lastPayload = '';

const hints = self.DougaSiteHints;
const pageMeta = self.DougaPageMeta;

/** 再生中（または再生されたことのある）メディアを優先して選ぶ */
function primaryMedia(list) {
  return (
    list.find((media) => !media.paused && !media.ended) ||
    list.find((media) => media.currentTime > 0) ||
    list[0] ||
    null
  );
}

function collect() {
  const sources = [];
  let usesMediaSource = false;
  const mediaElements = [...document.querySelectorAll('video, audio')];

  // X のようにタイムライン上で再生するサイトでは、ページ URL ではなく
  // 再生中の投稿の個別 URL を対象にしないと yt-dlp が解析できない
  const primary = primaryMedia(mediaElements.filter((m) => m.tagName === 'VIDEO'));
  const pageTarget = hints ? hints.targetForMedia(location.href, primary) : null;

  // マニフェスト URL へフォールバックすると yt-dlp はファイル名からタイトルを
  // 作ってしまう（master.m3u8 → "master"）。ページ側の情報を保険として渡す
  const meta = pageMeta ? pageMeta.extract(primary) : null;

  for (const media of mediaElements) {
    const urls = new Set();
    if (media.currentSrc) urls.add(media.currentSrc);
    if (media.src) urls.add(media.src);
    for (const source of media.querySelectorAll('source')) {
      if (source.src) urls.add(source.src);
    }

    for (const url of urls) {
      if (!url) continue;
      if (url.startsWith('blob:')) {
        usesMediaSource = true;
        continue;
      }
      sources.push({
        src: url,
        width: media.videoWidth || null,
        height: media.videoHeight || null,
        duration: Number.isFinite(media.duration) ? media.duration : null,
        poster: media.poster || null
      });
    }
  }

  return { sources, usesMediaSource, pageTarget, meta };
}

function report() {
  const payload = collect();
  if (
    !payload.sources.length &&
    !payload.usesMediaSource &&
    !payload.pageTarget &&
    !(payload.meta && payload.meta.title)
  ) {
    return;
  }

  const signature = JSON.stringify(payload);
  if (signature === lastPayload) return;
  lastPayload = signature;

  chrome.runtime
    .sendMessage({ type: 'video-elements', ...payload })
    .catch(() => { /* service worker 停止中などは次回に任せる */ });
}

/**
 * net-hook.js（ページと同じ世界で動く）が見つけた URL を受け取る。
 *
 * postMessage はページからも投げられるため、素性を確かめる:
 *   - このウィンドウ自身から来たものに限る
 *   - 文字列の配列であることと、http(s) であることを確認する
 * ここで通した URL は「候補」に並ぶだけで、実際に取得するかは
 * ユーザーが選ぶので、多少の紛れ込みがあっても実害はない。
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'douga:media-urls' || !Array.isArray(data.urls)) return;

  const urls = data.urls
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
    .slice(0, 30);
  if (!urls.length) return;

  chrome.runtime
    .sendMessage({
      type: 'video-elements',
      sources: urls.map((src) => ({ src, origin: 'network' })),
      meta: pageMeta ? pageMeta.extract(primaryMedia([...document.querySelectorAll('video')])) : null
    })
    .catch(() => { /* service worker 停止中などは次回に任せる */ });
});

report();

const observer = new MutationObserver(() => report());
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src']
});

// 再生開始時にソースが確定するプレイヤーが多いため、イベントでも拾う
for (const event of ['play', 'loadedmetadata', 'loadeddata', 'canplay']) {
  document.addEventListener(event, report, true);
}

// 動的に差し替わるプレイヤー向けの保険（10秒間だけ定期チェック）
let ticks = 0;
const timer = setInterval(() => {
  report();
  if (++ticks >= 10) clearInterval(timer);
}, 1000);
