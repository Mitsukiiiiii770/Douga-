'use strict';

/**
 * ページ内の <video> / <audio> を走査し、実際に再生中のソースを background に送る。
 *
 * MediaSource (blob:) 経由で再生されている場合、その blob URL は
 * 拡張機能側からは取得できない。その事実だけを伝えて、
 * ポップアップ側で「マニフェストを使ってください」と案内する。
 */

let lastPayload = '';

function collect() {
  const sources = [];
  let usesMediaSource = false;

  for (const media of document.querySelectorAll('video, audio')) {
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

  return { sources, usesMediaSource };
}

function report() {
  const payload = collect();
  if (!payload.sources.length && !payload.usesMediaSource) return;

  const signature = JSON.stringify(payload);
  if (signature === lastPayload) return;
  lastPayload = signature;

  chrome.runtime
    .sendMessage({ type: 'video-elements', ...payload })
    .catch(() => { /* service worker 停止中などは次回に任せる */ });
}

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
