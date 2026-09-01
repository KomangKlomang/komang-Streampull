// Berjalan di isolated world. Menjembatani temuan dari hook.js (MAIN world)
// ke service worker, dan meneruskan perintah scan/play dari popup.

(() => {
  'use strict';
  if (window.__kspDetector) return;
  window.__kspDetector = true;

  const queue = new Map(); // url -> source
  let flushTimer = null;

  function pageTitle() {
    return (
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title ||
      ''
    );
  }

  function flush() {
    flushTimer = null;
    if (!queue.size) return;
    const items = [...queue.entries()].map(([url, source]) => ({ url, source }));
    queue.clear();
    try {
      chrome.runtime.sendMessage({
        type: 'media-found',
        items,
        title: pageTitle(),
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
    if (!data || data.channel !== 'GOVIDEO_PAGE') return;

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

    if (data.drm) {
      try {
        chrome.runtime.sendMessage({
          type: 'drm-detected',
          keySystem: data.keySystem || '',
          pageUrl: location.href,
        });
      } catch {
        /* konteks extension sudah tidak valid */
      }
      return;
    }

    enqueue(data.url, data.source === 'playing' ? 'playing' : data.source);
  });

  // Lapor keberadaan frame ini walaupun MAIN world gagal memasang hook.
  try {
    chrome.runtime.sendMessage({ type: 'frame-alive', hooks: [] });
  } catch {
    /* konteks extension sudah tidak valid */
  }

  const seenEls = new WeakSet();
  let moTimer = null;

  function scanDom(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const nodes = [];
    if (root?.matches?.('video, audio, source, iframe')) nodes.push(root);
    try {
      nodes.push(...scope.querySelectorAll('video, audio, source'));
    } catch {
      return;
    }
    for (const el of nodes) {
      if (seenEls.has(el)) {
        const src = el.currentSrc || el.src || el.getAttribute?.('src');
        if (src) enqueue(src, el.paused === false ? 'playing' : 'dom');
        continue;
      }
      seenEls.add(el);
      const src =
        el.currentSrc ||
        el.src ||
        el.getAttribute?.('src') ||
        el.getAttribute?.('data-src') ||
        el.getAttribute?.('data-url');
      if (src) enqueue(src, !el.paused && el.tagName === 'VIDEO' ? 'playing' : 'dom');
    }
  }

  function startObserver() {
    if (!document.documentElement) return;
    scanDom(document);
    const mo = new MutationObserver(() => {
      if (moTimer) return;
      moTimer = setTimeout(() => {
        moTimer = null;
        scanDom(document);
      }, 200);
    });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'data-src', 'data-url'],
    });
  }

  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.cmd === 'deep-scan' || msg?.cmd === 'force-play' || msg?.cmd === 'capture-thumb') {
      window.postMessage({ channel: 'GOVIDEO_CMD', cmd: msg.cmd }, '*');
      // beri waktu hook.js menyapu, lalu kirimkan hasilnya
      setTimeout(flush, 700);
      sendResponse({ ok: true });
    }
    return true;
  });
})();
