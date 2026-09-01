// Sapuan DOM — pola dari blob video downloader: video/src + tautan langsung.
// Dipakai via chrome.scripting.executeScript(func) dan unit test.

import { kindFromUrl } from './util.js';

const MEDIA_PATH_RE = /\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv|ogv|ogg)(?:$|[?#])/i;

/**
 * @param {Document} doc
 * @returns {Array<{url: string, source: string, title: string, kind: string|null}>}
 */
export function scrapeMediaFromDocument(doc) {
  const out = [];
  const seen = new Set();
  const base = doc.baseURI || 'https://local.invalid/';
  const title = doc.title || '';

  const add = (raw, source) => {
    if (!raw || typeof raw !== 'string') return;
    if (raw.startsWith('blob:') || raw.startsWith('data:')) return;
    let abs;
    try {
      abs = new URL(raw, base).href;
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    if (!MEDIA_PATH_RE.test(abs) && !/\/m3u8|\/hls\//i.test(abs)) return;
    seen.add(abs);
    out.push({
      url: abs,
      source,
      title,
      kind: kindFromUrl(abs),
    });
  };

  for (const video of doc.querySelectorAll('video')) {
    add(video.currentSrc || video.src, video.paused === false ? 'playing' : 'dom');
    for (const source of video.querySelectorAll('source')) {
      add(source.src, 'dom');
    }
  }

  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (MEDIA_PATH_RE.test(href.split('?')[0])) add(a.href, 'dom-link');
  }

  for (const el of doc.querySelectorAll('[data-src],[data-file],[data-url]')) {
    for (const attr of ['data-src', 'data-file', 'data-url']) {
      add(el.getAttribute(attr), 'dom-attr');
    }
  }

  return out;
}

/** Versi tanpa import — untuk executeScript di tab (harus self-contained). */
export function scrapeMediaInPage() {
  const out = [];
  const seen = new Set();
  const title = document.title || '';

  const add = (raw, source) => {
    if (!raw || typeof raw !== 'string') return;
    if (raw.startsWith('blob:') || raw.startsWith('data:')) return;
    let abs;
    try {
      abs = new URL(raw, location.href).href;
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    if (!/\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv|ogv|ogg)(?:$|[?#])/i.test(abs) && !/\/m3u8|\/hls\//i.test(abs)) return;
    seen.add(abs);
    out.push({ url: abs, source, title });
  };

  for (const video of document.querySelectorAll('video')) {
    add(video.currentSrc || video.src, video.paused === false ? 'playing' : 'dom');
    for (const source of video.querySelectorAll('source')) add(source.src, 'dom');
  }
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv|ogv|ogg)$/i.test(href.split('?')[0])) add(a.href, 'dom-link');
  }
  for (const el of document.querySelectorAll('[data-src],[data-file],[data-url]')) {
    for (const attr of ['data-src', 'data-file', 'data-url']) add(el.getAttribute(attr), 'dom-attr');
  }
  return out;
}
