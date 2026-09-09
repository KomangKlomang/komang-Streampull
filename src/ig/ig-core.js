/**
 * Modul unduh Instagram khusus KSP — pola inti Story Saver, tanpa registry generic.
 * Semua fetch memakai sesi tab (credentials:include); tidak ada server pihak ketiga.
 */

import { buildSocialFilename, sanitizeNamePart } from '../lib/social-filename.js';
import { isDirectIgVideoUrl, isBadIgVideoPart } from '../lib/story-scrape.js';

const IG_HEADERS_BASE = {
  'x-instagram-ajax': '1016349901',
  'x-asbd-id': '129477',
  'x-ig-app-id': '936619743392459',
  'x-requested-with': 'XMLHttpRequest',
  accept: '*/*',
};

export function normalizeIgUrl(url) {
  return String(url || '')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/')
    .trim();
}

export function normalizeIgVideoUrl(url) {
  url = normalizeIgUrl(url);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    for (const key of ['bytestart', 'byteend', 'range']) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return url
      .replace(/([?&])(?:bytestart|byteend|range)=[^&]+/gi, '$1')
      .replace(/[?&]+$/, '');
  }
}

export function readCsrf(doc) {
  if (!doc) return '';
  try {
    const m = /(?:^|;\s*)csrftoken=([^;]+)/i.exec(doc.cookie || '');
    if (m) return decodeURIComponent(m[1]);
  } catch {
    /* abaikan */
  }
  const html = doc.documentElement?.outerHTML || '';
  const t = /csrf_token":"([^"]+)"/.exec(html);
  return t ? t[1] : '';
}

function igHeaders(csrf) {
  return { ...IG_HEADERS_BASE, ...(csrf ? { 'x-csrftoken': csrf } : {}) };
}

export function currentStoryUsername(pageUrl = '') {
  try {
    const m = new URL(pageUrl || location.href).pathname.match(/\/stories\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

export function currentStoryId(pageUrl = '') {
  try {
    const m = new URL(pageUrl || location.href).pathname.match(/\/stories\/[^\/?#]+\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

export function currentHighlightId(pageUrl = '') {
  try {
    const m = new URL(pageUrl || location.href).pathname.match(/\/stories\/highlights\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

export function storyFilename(username, order, mediaType) {
  return buildSocialFilename({
    platform: 'ig',
    channel: username || 'unknown',
    postId: 'story',
    order: order || 1,
    mediaType: mediaType || 'media',
  });
}

export function bestImageCandidates(candidates) {
  if (!candidates?.length) return '';
  return [...candidates].sort(
    (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
  )[0]?.url || '';
}

function visibleRect(el, viewH) {
  if (!el || el.offsetParent === null) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 80 || r.height < 80) return null;
  if (r.bottom <= 0 || r.top >= viewH || r.right <= 0 || r.left >= (globalThis.innerWidth || 800))
    return null;
  return r;
}

export function bestVisibleImageUrl(doc) {
  const viewH = doc.defaultView?.innerHeight || 800;
  let best = null;
  let bestArea = 0;
  for (const img of doc.querySelectorAll('img')) {
    const r = visibleRect(img, viewH);
    if (!r) continue;
    const area = r.width * r.height;
    if (area < 30000 || area <= bestArea) continue;
    const src = img.currentSrc || img.src || '';
    const srcset = img.srcset || '';
    if (!/cdninstagram\.com|fbcdn\.net/i.test(`${src} ${srcset}`)) continue;
    best = img;
    bestArea = area;
  }
  if (!best) return '';
  if (best.srcset) {
    const parts = best.srcset.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return normalizeIgUrl(parts[parts.length - 1].split(/\s+/)[0]);
  }
  return normalizeIgUrl(best.currentSrc || best.src || '');
}

export function bestVisibleVideoUrl(doc) {
  const viewH = doc.defaultView?.innerHeight || 800;
  let bestVideo = null;
  let bestArea = 0;
  for (const v of doc.querySelectorAll('video')) {
    const r = visibleRect(v, viewH);
    if (!r) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      bestVideo = v;
      bestArea = area;
    }
  }
  if (bestVideo) {
    const candidates = [
      bestVideo.currentSrc,
      bestVideo.src,
      bestVideo.getAttribute?.('src'),
      ...(bestVideo.querySelectorAll?.('source[src]') || []).map(
        (s) => s.src || s.getAttribute('src')
      ),
    ];
    for (const c of candidates) {
      const u = normalizeIgVideoUrl(c);
      if (isDirectIgVideoUrl(u)) return u;
    }
  }
  try {
    const entries = doc.defaultView?.performance?.getEntriesByType?.('resource') || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const u = normalizeIgVideoUrl(entries[i]?.name);
      if (isDirectIgVideoUrl(u)) return u;
    }
  } catch {
    /* abaikan */
  }
  return '';
}

export function hasVisibleStoryVideo(doc) {
  const viewH = doc.defaultView?.innerHeight || 800;
  for (const v of doc.querySelectorAll('video')) {
    const r = visibleRect(v, viewH);
    if (r) return true;
  }
  return false;
}

export function pickStoryMediaItem(items, storyId, visibleImageUrl) {
  if (!items?.length) return null;
  if (storyId) {
    for (const item of items) {
      const id = String(item.id || item.pk || '');
      if (id === storyId || id.startsWith(`${storyId}_`)) return item;
    }
  }
  if (visibleImageUrl) {
    const visibleName = visibleImageUrl.split('?')[0].split('/').pop();
    for (const item of items) {
      for (const c of item.image_versions2?.candidates || []) {
        const n = String(c.url || '').split('?')[0].split('/').pop();
        if (n && n === visibleName) return item;
      }
    }
  }
  return items[0];
}

export function mediaFromStoryItem(item) {
  if (!item) return null;
  if (item.video_versions?.length) {
    const url = normalizeIgVideoUrl(item.video_versions[0].url);
    if (!isDirectIgVideoUrl(url)) return null;
    return { url, mediaType: 'video' };
  }
  const img = bestImageCandidates(item.image_versions2?.candidates);
  if (img) return { url: normalizeIgUrl(img), mediaType: 'image' };
  return null;
}

async function fetchJson(url, csrf) {
  const res = await fetch(url, {
    method: 'GET',
    headers: igHeaders(csrf),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchIgUserId(username, csrf) {
  const json = await fetchJson(
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    csrf
  );
  return json?.data?.user?.id || null;
}

export async function fetchIgStoryItems(userId, csrf) {
  const json = await fetchJson(
    `https://i.instagram.com/api/v1/feed/user/${userId}/story/`,
    csrf
  );
  return json?.reel?.items || [];
}

export async function fetchHighlightItems(highlightId, csrf) {
  const params = new URLSearchParams({ reel_ids: `highlight:${highlightId}` });
  const json = await fetchJson(
    `https://i.instagram.com/api/v1/feed/reels_media/?${params}`,
    csrf
  );
  const reel =
    json?.reels?.[`highlight:${highlightId}`] ||
    json?.reels?.[highlightId] ||
    json?.reels_media?.[0];
  return { items: reel?.items || [], username: reel?.user?.username || `highlight_${highlightId}` };
}

/** SSvideoURL dari ig-react.js (MAIN world) */
export function readSsVideoUrl(doc) {
  try {
    const u = doc.head?.getAttribute?.('SSvideoURL') || '';
    return u && u !== 'null' ? normalizeIgVideoUrl(u) : '';
  } catch {
    return '';
  }
}

/**
 * Resolve media story IG — urutan sama Story Saver instagram.js.
 * @returns {{ url: string, mediaType: string, filename: string } | null}
 */
export async function resolveIgStoryDownload(doc = document, pageUrl = location.href) {
  const csrf = readCsrf(doc);
  let username = currentStoryUsername(pageUrl);
  if (username === 'highlights') username = 'highlight';
  const storyId = currentStoryId(pageUrl);
  const highlightId = currentHighlightId(pageUrl);

  const pack = (url, mediaType, order = 1) => {
    if (!url || /^blob:/i.test(url)) return null;
    if (mediaType === 'video') {
      url = normalizeIgVideoUrl(url);
      if (!isDirectIgVideoUrl(url)) return null;
    } else {
      url = normalizeIgUrl(url);
    }
    return {
      url,
      mediaType,
      filename: storyFilename(username || 'instagram_story', order, mediaType),
      channel: username,
    };
  };

  if (highlightId) {
    try {
      const { items, username: hlUser } = await fetchHighlightItems(highlightId, csrf);
      const visibleImg = bestVisibleImageUrl(doc);
      const item = pickStoryMediaItem(items, storyId, visibleImg);
      const order = Math.max(1, items.indexOf(item) + 1);
      const media = mediaFromStoryItem(item);
      if (media) {
        const hit = pack(media.url, media.mediaType, order);
        if (hit) {
          return {
            ...hit,
            channel: hlUser,
            filename: storyFilename(hlUser, order, media.mediaType),
          };
        }
      }
    } catch {
      /* fallback DOM */
    }
  }

  const ssUrl = readSsVideoUrl(doc);
  if (ssUrl && isDirectIgVideoUrl(ssUrl)) {
    const hit = pack(ssUrl, 'video', 1);
    if (hit) return hit;
  }

  if (!hasVisibleStoryVideo(doc)) {
    const img = bestVisibleImageUrl(doc);
    const hit = pack(img, 'image', 1);
    if (hit) return hit;
  }

  if (username && username !== 'highlights' && username !== 'highlight') {
    try {
      const userId = await fetchIgUserId(username, csrf);
      if (userId) {
        const items = await fetchIgStoryItems(userId, csrf);
        if (items.length) {
          const visibleImg = bestVisibleImageUrl(doc);
          const item = pickStoryMediaItem(items, storyId, visibleImg);
          const order = Math.max(1, items.indexOf(item) + 1);
          const media = mediaFromStoryItem(item);
          if (media) return pack(media.url, media.mediaType, order);
        }
      }
    } catch {
      /* fallback DOM */
    }
  }

  const video = bestVisibleVideoUrl(doc);
  const vHit = pack(video, 'video', 1);
  if (vHit) return vHit;

  const image = bestVisibleImageUrl(doc);
  return pack(image, 'image', 1);
}

/** Post/reel: gambar langsung dari DOM */
export function resolveIgPostImage(doc, root) {
  const scope = root || doc.body;
  const rect = scope.getBoundingClientRect?.() || { left: 0, width: doc.defaultView?.innerWidth || 800 };
  const centerX = rect.left + rect.width / 2;
  let best = null;
  let bestDist = Infinity;
  for (const im of scope.querySelectorAll('img')) {
    if (im.offsetParent === null || im.offsetWidth < 200 || im.offsetHeight < 200) continue;
    const src = im.currentSrc || im.src || '';
    if (!/fbcdn\.net|cdninstagram\.com/.test(src) && !(im.srcset || '')) continue;
    const rr = im.getBoundingClientRect();
    const d = Math.abs(rr.left + rr.width / 2 - centerX);
    if (d < bestDist) {
      bestDist = d;
      best = im;
    }
  }
  if (!best) return null;
  let url = '';
  if (best.srcset) {
    const parts = best.srcset.split(',').map((x) => x.trim());
    url = parts[parts.length - 1]?.split(/\s+/)[0] || '';
  }
  if (!url) url = best.currentSrc || best.src;
  url = normalizeIgUrl(url);
  if (!url) return null;
  const shortcode =
    scope.querySelector('a[href*="/p/"], a[href*="/reel/"]')?.pathname?.split('/').filter(Boolean).pop() ||
    'post';
  return {
    url,
    mediaType: 'image',
    filename: buildSocialFilename({
      platform: 'ig',
      channel: sanitizeNamePart(shortcode, 'post'),
      postId: shortcode,
      order: 1,
      mediaType: 'image',
    }),
  };
}

export { isBadIgVideoPart, isDirectIgVideoUrl };
