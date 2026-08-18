// Parser M3U8 (HLS) — cukup lengkap untuk master playlist, media playlist,
// AES-128, byte-range, dan fMP4 (EXT-X-MAP).

import { absUrl } from './util.js';

/** Parse daftar atribut ala `KEY=VAL,KEY2="VAL 2"`. */
export function parseAttrList(str) {
  const out = {};
  let i = 0;
  while (i < str.length) {
    const eq = str.indexOf('=', i);
    if (eq === -1) break;
    const key = str.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let value;
    if (str[i] === '"') {
      const end = str.indexOf('"', i + 1);
      value = str.slice(i + 1, end === -1 ? str.length : end);
      i = end === -1 ? str.length : end + 1;
      const comma = str.indexOf(',', i);
      i = comma === -1 ? str.length : comma + 1;
    } else {
      const comma = str.indexOf(',', i);
      const end = comma === -1 ? str.length : comma;
      value = str.slice(i, end).trim();
      i = end + 1;
    }
    if (key) out[key] = value;
  }
  return out;
}

function parseByteRange(raw) {
  if (!raw) return null;
  const [lenStr, offStr] = String(raw).split('@');
  const length = parseInt(lenStr, 10);
  if (!Number.isFinite(length)) return null;
  const offset = offStr != null ? parseInt(offStr, 10) : null;
  return { length, offset: Number.isFinite(offset) ? offset : null };
}

/**
 * @returns {{
 *   isMaster: boolean,
 *   variants: Array<object>,
 *   renditions: Array<object>,
 *   segments: Array<object>,
 *   map: {url: string, byterange: object|null}|null,
 *   duration: number,
 *   targetDuration: number,
 *   mediaSequence: number,
 *   live: boolean,
 *   encryption: string|null
 * }}
 */
export function parseM3U8(text, baseUrl) {
  const res = {
    isMaster: false,
    variants: [],
    renditions: [],
    segments: [],
    map: null,
    duration: 0,
    targetDuration: 0,
    mediaSequence: 0,
    live: true,
    encryption: null,
  };

  const abs = (u) => absUrl(u, baseUrl);
  const lines = String(text).split(/\r?\n/);

  let pendingVariant = null;
  let pendingSegment = null;
  let currentKey = null;
  let seq = 0;
  let sawExplicitSeq = false;
  const nextOffsetByUrl = new Map();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        res.isMaster = true;
        pendingVariant = parseAttrList(line.slice('#EXT-X-STREAM-INF:'.length));
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrList(line.slice('#EXT-X-MEDIA:'.length));
        res.renditions.push({
          type: a.TYPE || '',
          group: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          url: a.URI ? abs(a.URI) : null,
          isDefault: a.DEFAULT === 'YES',
        });
      } else if (line.startsWith('#EXTINF:')) {
        const d = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
        // BYTERANGE boleh muncul sebelum maupun sesudah EXTINF — jangan sampai hilang.
        pendingSegment = {
          duration: Number.isFinite(d) ? d : 0,
          byterange: pendingSegment?.byterange ?? null,
        };
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const br = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
        if (!pendingSegment) pendingSegment = { duration: 0, byterange: null };
        pendingSegment.byterange = br;
      } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
        const a = parseAttrList(line.slice(line.indexOf(':') + 1));
        const method = (a.METHOD || 'NONE').toUpperCase();
        currentKey =
          method === 'NONE'
            ? null
            : {
                method,
                url: a.URI ? abs(a.URI) : null,
                iv: a.IV || null,
                format: a.KEYFORMAT || 'identity',
              };
        if (currentKey) res.encryption = method;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrList(line.slice('#EXT-X-MAP:'.length));
        if (a.URI) res.map = { url: abs(a.URI), byterange: parseByteRange(a.BYTERANGE) };
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        res.targetDuration = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const n = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
        if (Number.isFinite(n)) {
          res.mediaSequence = n;
          seq = n;
          sawExplicitSeq = true;
        }
      } else if (line === '#EXT-X-ENDLIST') {
        res.live = false;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        if (/VOD/i.test(line)) res.live = false;
      }
      continue;
    }

    // Baris tanpa '#' selalu berupa URI.
    const url = abs(line);

    if (pendingVariant) {
      res.variants.push({
        url,
        bandwidth: parseInt(pendingVariant.BANDWIDTH || pendingVariant['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
        resolution: pendingVariant.RESOLUTION || '',
        codecs: pendingVariant.CODECS || '',
        frameRate: pendingVariant['FRAME-RATE'] || '',
        audioGroup: pendingVariant.AUDIO || '',
        name: pendingVariant.NAME || '',
      });
      pendingVariant = null;
      continue;
    }

    if (pendingSegment) {
      const br = pendingSegment.byterange;
      if (br) {
        if (br.offset == null) br.offset = nextOffsetByUrl.get(url) || 0;
        nextOffsetByUrl.set(url, br.offset + br.length);
      }
      res.segments.push({
        url,
        duration: pendingSegment.duration,
        byterange: br,
        key: currentKey,
        seq: seq++,
      });
      res.duration += pendingSegment.duration;
      pendingSegment = null;
    }
  }

  if (!sawExplicitSeq) res.mediaSequence = 0;
  if (!res.isMaster && res.segments.length === 0 && res.variants.length === 0) {
    // Bukan playlist yang bisa dipakai.
    res.invalid = !/#EXTM3U/i.test(text);
  }
  return res;
}

/** Label ramah untuk satu variant master playlist. */
export function variantLabel(v) {
  const height = /\d+x(\d+)/.exec(v.resolution || '')?.[1];
  const bits = [];
  if (height) bits.push(`${height}p`);
  else if (v.name) bits.push(v.name);
  if (v.bandwidth) bits.push(`${Math.round(v.bandwidth / 1000)} kbps`);
  return bits.join(' · ') || 'stream';
}

/** Urut dari kualitas tertinggi ke terendah. */
export function sortVariants(variants) {
  return [...variants].sort((a, b) => {
    const ha = parseInt(/\d+x(\d+)/.exec(a.resolution || '')?.[1] || '0', 10);
    const hb = parseInt(/\d+x(\d+)/.exec(b.resolution || '')?.[1] || '0', 10);
    if (ha !== hb) return hb - ha;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
}
