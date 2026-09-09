// Resolver media sosial (IG story API, WA DOM) — pola Story Saver, tanpa extractor per-situs penuh.

import { igFetchHeaders } from './ig-media.js';
import { isSocialCdnUrl, storyMediaRole } from './story-scrape.js';
import { buildSocialFilename, parseSocialPageContext } from './social-filename.js';

export function readCsrfFromHtml(html) {
  const m = /csrf_token":"([^"]+)"/.exec(html || '');
  return m ? m[1] : '';
}

export function readCsrfFromDocument(doc) {
  if (!doc) return '';
  try {
    const fromCookie = /(?:^|;\s*)csrftoken=([^;]+)/i.exec(doc.cookie || '');
    if (fromCookie) return decodeURIComponent(fromCookie[1]);
  } catch {
    /* abaikan */
  }
  return readCsrfFromHtml(doc.documentElement?.outerHTML || '');
}

export function normalizeIgMediaUrl(url) {
  return String(url || '')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/')
    .trim();
}

/** Buang parameter range/byte — segment audio-only sering tanpa gambar. */
export function normalizeIgVideoUrl(url) {
  url = normalizeIgMediaUrl(url);
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

export function bestImageUrl(candidates) {
  if (!candidates?.length) return '';
  return (
    [...candidates].sort(
      (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    )[0]?.url || ''
  );
}

export function extractStoryItemMedia(item) {
  if (!item) return null;
  if (item.video_versions?.length) {
    return {
      url: normalizeIgVideoUrl(item.video_versions[0].url),
      mediaType: 'video',
    };
  }
  const img = bestImageUrl(item.image_versions2?.candidates);
  if (img) return { url: normalizeIgMediaUrl(img), mediaType: 'image' };
  return null;
}

export function pickIgStoryItem(items, storyId, visibleImageUrl) {
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
        const candidateName = String(c.url || '').split('?')[0].split('/').pop();
        if (candidateName && candidateName === visibleName) return item;
      }
    }
  }
  return items[0];
}

function igApiHeaders(csrfToken) {
  return {
    ...igFetchHeaders({ cookie: csrfToken ? `csrftoken=${csrfToken}` : '' }),
    'x-instagram-ajax': '1016349901',
    'x-asbd-id': '129477',
  };
}

export async function fetchIgUserId(username, csrfToken) {
  const res = await fetch(
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    { method: 'GET', headers: igApiHeaders(csrfToken), credentials: 'include' }
  );
  if (!res.ok) throw new Error(`IG profile HTTP ${res.status}`);
  const json = await res.json();
  return json?.data?.user?.id || null;
}

export async function fetchIgStoryFeed(userId, csrfToken) {
  const res = await fetch(`https://i.instagram.com/api/v1/feed/user/${userId}/story/`, {
    method: 'GET',
    headers: igApiHeaders(csrfToken),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`IG story HTTP ${res.status}`);
  return res.json();
}

export function bestVisibleImageUrl(doc) {
  if (!doc?.querySelectorAll) return '';
  const viewH = doc.defaultView?.innerHeight || 800;
  const imgs = [...doc.querySelectorAll('img')].filter((img) => {
    const r = img.getBoundingClientRect();
    return r.width >= 200 && r.height >= 200 && r.bottom > 0 && r.top < viewH;
  });
  imgs.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  });
  for (const img of imgs) {
    const src = img.currentSrc || img.src;
    if (src && isSocialCdnUrl(src)) return src;
  }
  return '';
}

export function scrapeWhatsAppStory(doc) {
  if (!doc?.querySelectorAll) return null;
  const imgs = doc.querySelectorAll('div[data-animate-status-v3-viewer="true"] img');
  if (imgs.length < 3) return null;
  const storyUrl = imgs[imgs.length - 1]?.src;
  return storyUrl ? { url: storyUrl, mediaType: 'image' } : null;
}

function filenameFromCtx(ctx, order, mediaType) {
  if (!ctx) return '';
  return buildSocialFilename({
    platform: ctx.platform,
    channel: ctx.channel,
    postId: ctx.postId,
    order,
    mediaType,
  });
}

/**
 * Sebelum overlay-download: perkuat URL + nama berkas dari API/DOM bila perlu.
 * @returns {{ url: string, mediaType: string, nameBase: string } | null}
 */
export async function resolveSocialMedia({
  pageUrl,
  hint = 'video',
  videoUrl = '',
  document: doc = null,
} = {}) {
  const ctx = parseSocialPageContext(pageUrl);
  let url = normalizeIgMediaUrl(videoUrl);
  const want = hint === 'image' ? 'image' : 'video';

  const role = url ? storyMediaRole(url) : '';
  if (url && isSocialCdnUrl(url) && role && (want === 'image' ? role === 'image' : role === 'video')) {
    if (role === 'video') url = normalizeIgVideoUrl(url);
    return {
      url,
      mediaType: role,
      nameBase: filenameFromCtx(ctx, 1, role),
    };
  }

  if (!doc) return url && isSocialCdnUrl(url) ? { url, mediaType: role || want, nameBase: '' } : null;

  if (ctx?.platform === 'wa') {
    const wa = scrapeWhatsAppStory(doc);
    if (wa?.url) {
      return {
        url: wa.url,
        mediaType: wa.mediaType,
        nameBase: buildSocialFilename({
          platform: 'wa',
          channel: 'story',
          postId: 'story',
          order: 1,
          mediaType: 'image',
        }),
      };
    }
  }

  if (ctx?.platform === 'ig' && /\/stories\//.test(pageUrl)) {
    const csrf = readCsrfFromDocument(doc);
    const username = ctx.channel;
    const storyId =
      ctx.postId && ctx.postId !== 'story' && ctx.postId !== username ? ctx.postId : '';

    if (want === 'video') {
      try {
        const ssUrl = doc.head?.getAttribute?.('SSvideoURL');
        if (ssUrl && ssUrl !== 'null') {
          const normalized = normalizeIgVideoUrl(ssUrl);
          if (normalized && isSocialCdnUrl(normalized)) {
            return {
              url: normalized,
              mediaType: 'video',
              nameBase: filenameFromCtx({ ...ctx, postId: storyId || 'story' }, 1, 'video'),
            };
          }
        }
      } catch {
        /* abaikan */
      }
    }

    if (want === 'image') {
      const img = bestVisibleImageUrl(doc);
      if (img) {
        return {
          url: img,
          mediaType: 'image',
          nameBase: filenameFromCtx(
            { ...ctx, postId: storyId || 'story' },
            1,
            'image'
          ),
        };
      }
    }

    if (username && username !== 'highlights' && username !== 'highlight') {
      try {
        const userId = await fetchIgUserId(username, csrf);
        if (userId) {
          const storyJson = await fetchIgStoryFeed(userId, csrf);
          const items = storyJson?.reel?.items || [];
          const visibleImg = bestVisibleImageUrl(doc);
          const item = pickIgStoryItem(items, storyId, visibleImg);
          const order = Math.max(1, items.indexOf(item) + 1);
          const media = extractStoryItemMedia(item);
          if (media?.url) {
            return {
              url: media.url,
              mediaType: media.mediaType,
              nameBase: filenameFromCtx(
                { ...ctx, postId: storyId || 'story' },
                order,
                media.mediaType
              ),
            };
          }
        }
      } catch {
        /* fallback ke registry CDN di background */
      }
    }

    const fallbackImg = bestVisibleImageUrl(doc);
    if (fallbackImg) {
      return {
        url: fallbackImg,
        mediaType: 'image',
        nameBase: filenameFromCtx({ ...ctx, postId: storyId || 'story' }, 1, 'image'),
      };
    }
  }

  if (url && isSocialCdnUrl(url)) {
    const mt = storyMediaRole(url) || want;
    if (mt === 'video') url = normalizeIgVideoUrl(url);
    return { url, mediaType: mt, nameBase: filenameFromCtx(ctx, 1, mt) };
  }

  return null;
}
