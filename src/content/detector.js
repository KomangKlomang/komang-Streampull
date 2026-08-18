// Berjalan di isolated world. Menjembatani temuan dari hook.js (MAIN world)
// ke service worker, dan meneruskan perintah scan/play dari popup.

(() => {
  'use strict';

  const queue = new Map(); // url -> source
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!queue.size) return;
    const items = [...queue.entries()].map(([url, source]) => ({ url, source }));
    queue.clear();
    try {
      chrome.runtime.sendMessage({
        type: 'media-found',
        items,
        title: document.title || '',
        pageUrl: location.href,
      });
    } catch {
      /* konteks extension sudah tidak valid (reload extension) */
    }
  }

  function enqueue(url, source) {
    if (!url || queue.has(url)) return;
    queue.set(url, source);
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.channel !== 'STREAMGRAB_PAGE') return;

    if (data.status) {
      try {
        chrome.runtime.sendMessage({ type: 'frame-alive', hooks: data.status.hooks || [] });
      } catch {
        /* konteks extension sudah tidak valid */
      }
      return;
    }

    if (data.thumb) {
      try {
        chrome.runtime.sendMessage({
          type: 'thumb-found',
          thumb: data.thumb,
          pageUrl: location.href,
          title: document.title || '',
        });
      } catch {
        /* konteks extension sudah tidak valid */
      }
      return;
    }

    enqueue(data.url, data.source);
  });

  // Lapor keberadaan frame ini walaupun MAIN world gagal memasang hook.
  try {
    chrome.runtime.sendMessage({ type: 'frame-alive', hooks: [] });
  } catch {
    /* konteks extension sudah tidak valid */
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.cmd === 'deep-scan' || msg?.cmd === 'force-play' || msg?.cmd === 'capture-thumb') {
      window.postMessage({ channel: 'STREAMGRAB_CMD', cmd: msg.cmd }, '*');
      // beri waktu hook.js menyapu, lalu kirimkan hasilnya
      setTimeout(flush, 700);
      sendResponse({ ok: true });
    }
    return true;
  });
})();
