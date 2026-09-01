// Ekstraksi media Instagram dari body GraphQL/API — pola hoaianle/Instagram-Downloader.

import { harvestStoryMedia, shouldHarvestStoryJson } from './story-scrape.js';

const IG_API_RE = /graphql\/query|\/api\/v1\//i;

/** @returns {string[]} */
export function harvestIgResponse(text, url = '') {
  if (!text || typeof text !== 'string') return [];
  if (text.length > 3_000_000) return [];
  if (!shouldHarvestStoryJson(text) && !IG_API_RE.test(String(url))) return [];
  try {
    return harvestStoryMedia(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Ambil csrftoken dari cookie string halaman. */
export function readCsrfToken(cookieHeader = '') {
  const m = /(?:^|;\s*)csrftoken=([^;]+)/i.exec(cookieHeader);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Header fetch Instagram API dari sesi tab (MAIN world / background).
 * @param {object} opts { referer, cookie, wwwClaim }
 */
export function igFetchHeaders(opts = {}) {
  const headers = {
    'x-ig-app-id': '936619743392459',
    'x-requested-with': 'XMLHttpRequest',
    accept: '*/*',
  };
  const csrf = readCsrfToken(opts.cookie || '');
  if (csrf) headers['x-csrftoken'] = csrf;
  if (opts.wwwClaim) headers['x-ig-www-claim'] = opts.wwwClaim;
  return headers;
}
