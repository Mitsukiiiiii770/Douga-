'use strict';

/**
 * アプリ内ブラウザのキーボード操作。
 *
 * webview の中にフォーカスがあると、画面側の keydown には届かない。
 * そのため主処理の before-input-event からも同じ判定を使う必要がある。
 * 二か所で別々に書くとずれるので、判定はここに一つだけ置く。
 *
 * 入力の形は Electron の before-input-event と DOM の KeyboardEvent で
 * 名前が違うため、呼ぶ側で揃えてから渡す。
 */

/**
 * @param {{key: string, control?: boolean, meta?: boolean, shift?: boolean, alt?: boolean}} input
 * @returns {string|null} 操作の名前
 */
function shortcutFor(input) {
  if (!input || !input.key) return null;
  const key = String(input.key).toLowerCase();
  const mod = !!input.control || !!input.meta;
  const shift = !!input.shift;
  const alt = !!input.alt;

  if (mod && !shift && !alt) {
    if (key === 't') return 'new-tab';
    if (key === 'w') return 'close-tab';
    if (key === 'l') return 'focus-url';
    if (key === 'r') return 'reload';
    if (key === 'd') return 'bookmark';
    if (key === 'h') return 'history';
    if (key === 'tab') return 'next-tab';
    // 数字で直接そのタブへ
    if (/^[1-9]$/.test(key)) return `tab-${key}`;
  }
  if (mod && shift && !alt && key === 'tab') return 'prev-tab';

  if (alt && !mod) {
    if (key === 'arrowleft') return 'back';
    if (key === 'arrowright') return 'forward';
  }

  if (!mod && !alt && !shift) {
    if (key === 'f5') return 'reload';
  }

  return null;
}

/** Electron の before-input-event をこの形に揃える */
function fromElectron(input) {
  return shortcutFor({
    key: input.key,
    control: input.control,
    meta: input.meta,
    shift: input.shift,
    alt: input.alt
  });
}

/** DOM の KeyboardEvent をこの形に揃える */
function fromDom(event) {
  return shortcutFor({
    key: event.key,
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey
  });
}

module.exports = { shortcutFor, fromElectron, fromDom };
