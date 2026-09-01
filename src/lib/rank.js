// Skor intent stream (PRD §5.1). Dipakai saat merender daftar, bukan saat deteksi.

const AD_RE = /doubleclick|googlesyndication|adsystem|adnxs|adservice|pagead|advert/i;
const CDN_RE = /akamai|cloudfront|fastly|\.cdn\.|cdn\d*\./i;
const HOOK_SRC = /^(hls\.js|jwplayer|videojs|dplayer|clappr|plyr|fluidplayer|player)$/i;

function durationScore(entry, maxDuration) {
  const d = Number(entry.duration) || 0;
  if (d <= 0) return 0.4;
  if (d < 15) return 0.1;
  return Math.min(1, d / Math.max(maxDuration, 1));
}

function resolutionScore(entry) {
  const h = parseInt(/\d+x(\d+)/.exec(entry.resolution || '')?.[1] || entry.height || '0', 10);
  if (h >= 1080) return 1;
  if (h >= 720) return 0.7;
  if (h >= 480) return 0.4;
  if (h >= 360) return 0.2;
  if (!h) return 0.5;
  return 0.15;
}

function domainScore(entry, pageUrl) {
  let host = '';
  try {
    host = new URL(entry.url).host;
  } catch {
    return 0.3;
  }
  if (AD_RE.test(host) || AD_RE.test(entry.url)) return 0;
  if (CDN_RE.test(host)) return 0.8;
  try {
    const pageHost = pageUrl ? new URL(pageUrl).host : '';
    if (pageHost && host === pageHost) return 0.6;
  } catch {
    /* abaikan */
  }
  return 0.4;
}

function methodScore(entry) {
  const src = String(entry.source || '');
  if (entry.playing || src === 'playing') return 1;
  if (HOOK_SRC.test(src) || src === 'hook') return 1;
  if (src === 'network' || src === 'fetch' || src === 'xhr') return 0.7;
  if (src === 'dom' || src === 'element' || src === 'attr') return 0.5;
  return 0.55;
}

export function rankScore(entry, ctx = {}) {
  const maxDuration = ctx.maxDuration || 1;
  const playing = entry.playing || entry.source === 'playing' ? 1 : 0;
  const verified = entry.verified === true ? 1 : entry.verified === false ? 0 : 0.4;
  return (
    durationScore(entry, maxDuration) * 0.35 +
    resolutionScore(entry) * 0.2 +
    domainScore(entry, ctx.pageUrl || entry.pageUrl) * 0.15 +
    methodScore(entry) * 0.15 +
    playing * 0.1 +
    verified * 0.05
  );
}

export function rankEntries(entries) {
  const list = [...(entries || [])];
  const maxDuration = Math.max(1, ...list.map((e) => Number(e.duration) || 0));
  const pageUrl = list[0]?.pageUrl || '';
  for (const e of list) e.rankScore = rankScore(e, { maxDuration, pageUrl });
  list.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (a.verified !== b.verified) {
      if (a.verified === true) return -1;
      if (b.verified === true) return 1;
    }
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
  return list;
}
