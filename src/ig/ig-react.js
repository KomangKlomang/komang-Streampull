// MAIN world — ekstrak hdSrc/sdSrc dari React (pola Story Saver instagram-video.js).
// Menulis SSvideoURL ke <head> supaya ig-content.js bisa baca.

(() => {
  'use strict';
  if (window.__kspIgReact) return;
  window.__kspIgReact = true;

  function extractReactVideoUrl() {
    try {
      const videos = document.querySelectorAll('video');
      for (let i = videos.length - 1; i >= 0; i--) {
        const v = videos[i];
        if (!v.offsetHeight) continue;
        let reactKey = '';
        for (const k of Object.keys(v)) {
          if (k.includes('__reactFiber')) {
            reactKey = k.split('__reactFiber')[1];
            break;
          }
        }
        if (!reactKey) continue;
        const root = v.parentElement?.parentElement?.parentElement?.parentElement;
        const props = root?.[`__reactProps${reactKey}`];
        const fiber = v[`__reactFiber${reactKey}`];
        const candidates = [
          props?.children?.props?.children?.props?.implementations?.[0]?.data?.hdSrc,
          props?.children?.[0]?.props?.children?.props?.implementations?.[1]?.data?.hdSrc,
          props?.children?.props?.children?.props?.implementations?.[0]?.data?.sdSrc,
          props?.children?.[0]?.props?.children?.props?.implementations?.[1]?.data?.sdSrc,
          props?.children?.props?.children?.props?.implementations?.[1]?.data?.hdSrc,
          props?.children?.props?.children?.props?.implementations?.[1]?.data?.sdSrc,
          fiber?.return?.stateNode?.props?.videoData?.$1?.hd_src,
          fiber?.return?.stateNode?.props?.videoData?.$1?.sd_src,
        ];
        for (const u of candidates) {
          if (typeof u === 'string' && /^https?:/i.test(u)) return u;
        }
      }
    } catch {
      /* abaikan */
    }
    return null;
  }

  function sync() {
    if (!location.pathname.includes('stories')) return;
    try {
      const url = extractReactVideoUrl();
      document.head.setAttribute('SSvideoURL', url || 'null');
    } catch {
      /* abaikan */
    }
  }

  sync();
  setInterval(sync, 1200);
  try {
    new MutationObserver(sync).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  } catch {
    /* abaikan */
  }
})();
