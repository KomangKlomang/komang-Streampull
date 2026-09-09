/**
 * Content script khusus instagram.com — tombol unduh + kirim ke background KSP.
 * Tidak memakai registry stream generic. Tidak ada analytics/iklan pihak ketiga.
 */

import { resolveIgPostImage, resolveIgStoryDownload } from './ig-core.js';

(() => {
  'use strict';
  if (window.__kspIgContent) return;
  window.__kspIgContent = true;

  const BTN_ID = 'ksp-ig-download-btn';
  const BTN_STYLE =
    'position:fixed;z-index:2147483647;top:14px;left:14px;width:40px;height:40px;margin:0;padding:0;border:0;border-radius:12px;background:#0d9488;color:#fff;font:700 20px/40px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 12px rgb(0 0 0 / 0.4);display:flex;align-items:center;justify-content:center;';

  let busy = false;

  function isStoryPage() {
    return /\/stories\//.test(location.pathname);
  }

  function ensureButton() {
    if (!isStoryPage() && !document.querySelector('article, div[role="dialog"]')) return;
    let btn = document.getElementById(BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.title = 'Unduh (KSP Instagram)';
      btn.setAttribute('aria-label', 'Unduh media Instagram');
      btn.textContent = '↓';
      btn.style.cssText = BTN_STYLE;
      btn.addEventListener(
        'click',
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          ev.stopImmediatePropagation();
          void onDownloadClick(btn);
        },
        true
      );
      (document.body || document.documentElement).appendChild(btn);
    }
    btn.style.display = isStoryPage() || location.pathname.match(/\/(p|reel|reels)\//) ? 'flex' : 'none';
  }

  async function onDownloadClick(btn) {
    if (busy) return;
    busy = true;
    btn.style.opacity = '0.65';
    btn.title = 'Mencari media…';

    try {
      let payload = null;
      if (isStoryPage()) {
        payload = await resolveIgStoryDownload(document, location.href);
      } else {
        const root =
          document.querySelector('div[role="dialog"]') ||
          document.querySelector('article') ||
          document.body;
        payload = resolveIgPostImage(document, root);
        if (!payload) payload = await resolveIgStoryDownload(document, location.href);
      }

      if (!payload?.url) {
        btn.title = 'Media tidak ditemukan — putar story dulu';
        return;
      }

      chrome.runtime.sendMessage(
        {
          cmd: 'ig-download',
          url: payload.url,
          mediaType: payload.mediaType,
          filename: payload.filename,
          pageUrl: location.href,
          channel: payload.channel || '',
        },
        (res) => {
          const err = chrome.runtime.lastError?.message || res?.error;
          btn.title = res?.ok ? 'Mengunduh… cek Downloads/KSP' : err || 'Gagal unduh';
        }
      );
    } catch (err) {
      btn.title = String(err?.message || err);
    } finally {
      busy = false;
      btn.style.opacity = '1';
    }
  }

  function boot() {
    ensureButton();
    setInterval(ensureButton, 2000);
    try {
      new MutationObserver(() => ensureButton()).observe(document.documentElement, {
        subtree: true,
        childList: true,
      });
    } catch {
      /* abaikan */
    }
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
