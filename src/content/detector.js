// Berjalan di isolated world. Menjembatani temuan dari hook.js (MAIN world)
// ke service worker, dan meneruskan perintah scan/play dari popup.

import { resolveSocialMedia } from '../lib/social-fetch.js';

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
    if (root?.matches?.('video, audio, source, iframe, img')) nodes.push(root);
    try {
      nodes.push(...scope.querySelectorAll('video, audio, source'));
      if (isSocialPage()) nodes.push(...scope.querySelectorAll('img'));
    } catch {
      return;
    }
    for (const el of nodes) {
      if (el.tagName === 'IMG') {
        const w = el.naturalWidth || el.width || el.getBoundingClientRect?.().width || 0;
        const h = el.naturalHeight || el.height || el.getBoundingClientRect?.().height || 0;
        if (w < 160 || h < 90) continue;
      }
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
      return true;
    }
    if (msg?.cmd === 'tab-fetch') {
      void (async () => {
        try {
          const init = { credentials: 'include', cache: 'no-store' };
          if (msg.byterange) {
            const end = msg.byterange.offset + msg.byterange.length - 1;
            init.headers = { Range: `bytes=${msg.byterange.offset}-${end}` };
          }
          const res = await fetch(msg.url, init);
          if (!res.ok) {
            sendResponse({ ok: false, error: `HTTP ${res.status} — ${msg.url}` });
            return;
          }
          if (msg.mode === 'text') {
            sendResponse({ ok: true, text: await res.text() });
            return;
          }
          sendResponse({ ok: true, bytes: await res.arrayBuffer() });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    return false;
  });

  function isSocialPage() {
    try {
      return /(^|\.)(instagram\.com|facebook\.com|fb\.com|messenger\.com|whatsapp\.com)$/i.test(
        location.hostname
      );
    } catch {
      return false;
    }
  }

  function overlayTargets() {
    const nodes = [...document.querySelectorAll('video')];
    const imgs = [];
    for (const img of document.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 200 && r.bottom > 40 && r.top < window.innerHeight - 40) {
        imgs.push(img);
      }
    }
    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    // ponytail: max 4 chips; Story Saver-style visible story/photo only
    return nodes.concat(imgs.slice(0, 4));
  }

  function mediaSrc(el) {
    return el.currentSrc || el.src || el.getAttribute?.('src') || '';
  }

  async function sendOverlayDownload(el, btn, force) {
    btn.dataset.busy = '1';
    btn.style.opacity = '0.7';
    const hint = el.tagName === 'IMG' ? 'image' : 'video';
    let videoUrl = mediaSrc(el);
    if (/^blob:|^data:/i.test(videoUrl)) videoUrl = '';
    let nameBase = '';
    if (isSocialPage()) {
      try {
        window.postMessage({ channel: 'GOVIDEO_CMD', cmd: 'deep-scan' }, '*');
        await new Promise((r) => setTimeout(r, 350));
        const resolved = await resolveSocialMedia({
          pageUrl: location.href,
          hint,
          videoUrl,
          document,
        });
        if (resolved?.url) videoUrl = resolved.url;
        if (resolved?.nameBase) nameBase = resolved.nameBase;
      } catch {
        /* pakai URL dari elemen / registry */
      }
    }
    chrome.runtime.sendMessage(
      {
        cmd: 'overlay-download',
        videoUrl,
        nameBase,
        pageUrl: location.href,
        hint,
        force: Boolean(force),
      },
      (res) => {
        const err = chrome.runtime.lastError?.message || res?.error;
        if (err && /opt-out|DRM/i.test(err) && !force) {
          btn.dataset.busy = '';
          btn.style.opacity = '1';
          if (
            confirm(
              'Unduhan ini mungkin diblokir atau terlindungi DRM. Berkas bisa gagal diputar. Anda yakin ingin mengunduh?'
            )
          ) {
            sendOverlayDownload(el, btn, true);
          }
          return;
        }
        btn.dataset.busy = '';
        btn.style.opacity = '1';
        btn.title = res?.ok ? 'Mengunduh… cek panel KSP' : err || 'Gagal mengunduh';
      }
    );
  }

  const overlays = [];
  let overlayRoot = null;
  let overlayMoTimer = null;

  function overlayLayer() {
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    if (overlayRoot?.isConnected) {
      if (overlayRoot.parentNode !== parent) parent.appendChild(overlayRoot);
      return overlayRoot.shadowRoot;
    }
    overlays.length = 0;
    overlayRoot = document.createElement('div');
    overlayRoot.style.cssText =
      'position:absolute;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
    const shadow = overlayRoot.attachShadow({ mode: 'open' });
    parent.appendChild(overlayRoot);
    return shadow;
  }

  function makeOverlayBtn(layer) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Unduh';
    btn.setAttribute('aria-label', 'Unduh video');
    btn.textContent = '↓';
    btn.style.cssText =
      'position:fixed;z-index:2147483647;width:36px;height:36px;margin:0;padding:0;border:0;border-radius:10px;background:#0d9488;color:#fff;font:700 18px/36px sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgb(0 0 0 / 0.35);pointer-events:auto;';
    layer.appendChild(btn);
    return btn;
  }

  function mediaBox(el) {
    let r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) {
      const p = el.parentElement?.getBoundingClientRect();
      if (p && p.width >= 64 && p.height >= 64) r = p;
    }
    return r;
  }

  function placeOverlay(el, btn) {
    const r = mediaBox(el);
    const hide = r.width < 48 || r.height < 48;
    btn.style.display = hide ? 'none' : 'flex';
    if (hide) return;
    btn.style.top = `${Math.round(Math.max(6, Math.min(window.innerHeight - 42, r.top + 8)))}px`;
    btn.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - 42, r.right - 44)))}px`;
  }

  function syncOverlays() {
    if (!isSocialPage()) return;
    const layer = overlayLayer();
    if (!layer) return;
    for (let i = overlays.length - 1; i >= 0; i--) {
      if (!overlays[i].video.isConnected) {
        overlays[i].btn.remove();
        overlays.splice(i, 1);
      }
    }
    let media = [];
    try {
      media = overlayTargets();
    } catch {
      return;
    }
    for (const el of media) {
      let rec = overlays.find((o) => o.video === el);
      if (!rec) {
        const btn = makeOverlayBtn(layer);
        btn.addEventListener(
          'click',
          (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            if (btn.dataset.busy === '1') return;
            sendOverlayDownload(el, btn, false);
          },
          true
        );
        rec = { video: el, btn };
        overlays.push(rec);
      }
      placeOverlay(el, rec.btn);
    }
  }

  function startOverlay() {
    if (!isSocialPage()) return;
    syncOverlays();
    const mo = new MutationObserver(() => {
      if (overlayMoTimer) return;
      overlayMoTimer = setTimeout(() => {
        overlayMoTimer = null;
        syncOverlays();
      }, 400);
    });
    if (document.documentElement) mo.observe(document.documentElement, { subtree: true, childList: true });
    window.addEventListener('scroll', syncOverlays, true);
    window.addEventListener('resize', syncOverlays);
    setInterval(syncOverlays, 800);
  }

  if (document.documentElement) startOverlay();
  else document.addEventListener('DOMContentLoaded', startOverlay, { once: true });
})();
