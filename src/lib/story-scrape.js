/** URL CDN Instagram / Facebook yang tampil saat user membuka story/reel/post. */

const SOCIAL_HOST_RE =
  /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com|instagram\.com|facebook\.com|fb\.com|whatsapp\.net|whatsapp\.com)$/i;

const STORY_HINT_RE =
  /video_versions|image_versions2|playable_url|browser_native_|cdninstagram\.com|fbcdn\.net\/v\//;

export function isSocialHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return SOCIAL_HOST_RE.test(h);
}

export function isSocialCdnUrl(url) {
  if (!url || typeof url !== 'string' || !/^https?:/i.test(url)) return false;
  try {
    return isSocialHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isStoryMediaUrl(url) {
  if (!isSocialCdnUrl(url)) return false;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* biarkan */
  }
  if (/\.(jpe?g|png|webp|gif|mp4|m4v|mov|webm)(?:$)/i.test(path)) return true;
  if (/\/(?:v|o1)\/t\d+/i.test(path)) return true;
  return false;
}

/** Segment DASH audio-only / init — unduhan ini cuma suara, tanpa gambar (PotPlayer error). */
export function isBadIgVideoPart(url) {
  let raw = String(url || '')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');
  try {
    const parsed = new URL(raw);
    const path = decodeURIComponent(parsed.pathname || '');
    const tag = parsed.searchParams.get('tag') || '';
    const efg = parsed.searchParams.get('efg') || '';
    if (efg) {
      try {
        const decoded = atob(efg.replace(/-/g, '+').replace(/_/g, '/'));
        if (/audio/i.test(decoded)) return true;
      } catch {
        /* abaikan */
      }
    }
    return /dashinit|init\.mp4|(?:^|[_\/.-])audio(?:[_\/.-]|$)|audio_dashinit|_audio_/i.test(
      `${path} ${tag}`
    );
  } catch {
    return /dashinit|init\.mp4|(?:^|[_\/.-])audio(?:[_\/.-]|$)|audio_dashinit|_audio_/i.test(raw);
  }
}

/** Mp4 progressive IG/FB yang aman diunduh — bukan blob, bukan segment audio. */
export function isDirectIgVideoUrl(url) {
  let raw = String(url || '')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');
  try {
    const parsed = new URL(raw);
    for (const key of ['bytestart', 'byteend', 'range']) parsed.searchParams.delete(key);
    raw = parsed.toString();
  } catch {
    raw = raw
      .replace(/([?&])(?:bytestart|byteend|range)=[^&]+/gi, '$1')
      .replace(/[?&]+$/, '');
  }
  return (
    !!raw &&
    !/^blob:/i.test(raw) &&
    !isBadIgVideoPart(raw) &&
    (/\.(?:mp4|m4v)(?:[?#]|$)/i.test(raw) || /video\.[^/]+fbcdn\.net/i.test(raw))
  );
}

/** video vs image — blob/MSE bukan ini; yang itu sampah. */
export function storyMediaRole(url) {
  if (!isStoryMediaUrl(url)) return '';
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* biarkan */
  }
  if (/\.(mp4|m4v|mov|webm)$/i.test(path)) return 'video';
  if (/\.(jpe?g|png|webp|gif)$/i.test(path)) return 'image';
  if (/\/o1\/v\/|\/v\/t(16|39|42|50)\b/i.test(path)) return 'video';
  if (/\/v\/t51\b|t15\./i.test(path)) return 'image';
  return 'video';
}

export function pickStoryEntry(entries, hint) {
  const list = [...(entries || [])]
    .filter((e) => isStoryMediaUrl(e?.url))
    .filter((e) => storyMediaRole(e.url) !== 'video' || isDirectIgVideoUrl(e.url));
  const want = hint === 'image' ? 'image' : hint === 'video' ? 'video' : '';
  let pool = want ? list.filter((e) => storyMediaRole(e.url) === want) : list;
  if (!pool.length && want === 'video') return null;
  if (!pool.length) pool = list.filter((e) => storyMediaRole(e.url) === 'video');
  if (!pool.length) pool = list;
  pool.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || (b.size || 0) - (a.size || 0));
  return pool[0] || null;
}

export function shouldHarvestStoryJson(text) {
  return typeof text === 'string' && text.length < 2_000_000 && STORY_HINT_RE.test(text);
}

export function harvestStoryMedia(node) {
  const out = [];
  const seen = new Set();
  let steps = 0;

  function add(url) {
    if (!isStoryMediaUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  }

  function walk(x, depth) {
    if (out.length >= 30 || steps++ > 8000 || x == null || depth > 14) return;
    if (typeof x === 'string') {
      add(x);
      return;
    }
    if (Array.isArray(x)) {
      if (x.length && x[0] && typeof x[0] === 'object' && (x[0].url || x[0].src) && typeof x[0].width === 'number') {
        const top = [...x].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        add(top.url || top.src);
        return;
      }
      for (const item of x) walk(item, depth + 1);
      return;
    }
    if (typeof x !== 'object') return;
    for (const v of Object.values(x)) walk(v, depth + 1);
  }

  walk(node, 0);
  return out;
}
