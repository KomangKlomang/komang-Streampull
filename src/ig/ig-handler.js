/**
 * Handler background untuk unduhan IG langsung — tanpa registry, tanpa server eksternal.
 */

import { isDirectIgVideoUrl, normalizeIgVideoUrl } from './ig-core.js';
import { originOf, sanitizeFilename } from '../lib/util.js';

/**
 * @param {object} msg { url, mediaType, filename, pageUrl }
 * @param {object} ctx { settings, saveJob, startDirectDownload, newJobId, headersForDownload, headerMemo }
 */
export async function handleIgDownload(msg, sender, ctx) {
  const pageUrl = msg.pageUrl || sender.tab?.url || '';
  let url = String(msg.url || '').trim();
  if (!/^https?:/i.test(url)) throw new Error('URL media tidak valid');

  const mediaType = msg.mediaType === 'video' ? 'video' : 'image';
  if (mediaType === 'video') {
    url = normalizeIgVideoUrl(url);
    if (!isDirectIgVideoUrl(url)) {
      throw new Error('Bukan mp4 video utuh — coba putar story lalu unduh lagi.');
    }
  }

  const nameBase = sanitizeFilename(
    String(msg.filename || 'ig_story').replace(/\.[a-z0-9]+$/i, ''),
    'ig_story'
  );

  const headers = await ctx.headersForDownload(
    { url, pageUrl, frameUrl: pageUrl, headers: ctx.headerMemo?.get?.(url) || {} },
    url
  );
  headers.referer = headers.referer || pageUrl;
  headers.origin = headers.origin || originOf(pageUrl);

  const job = {
    id: ctx.newJobId(),
    tabId: sender.tab?.id ?? -1,
    url,
    kind: 'file',
    mode: 'direct',
    nameBase,
    status: 'pending',
    startedAt: Date.now(),
    estimatedBytes: 0,
    progress: { completed: 0, total: 0, bytes: 0 },
    warnings: [],
    headers,
    igDirect: true,
  };

  ctx.saveJob(job);
  await ctx.startDirectDownload(job);
  return job.id;
}
