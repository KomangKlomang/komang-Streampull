// Parser DASH MPD — VOD statis: SegmentTemplate (Number/Time) dan SegmentList.
// Live (type=dynamic) dan DRM (ContentProtection) ditandai, tidak diunduh.

import { absUrl, hostOf } from './util.js';

export function isoDuration(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  const m = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?/i.exec(s);
  if (!m) return 0;
  return (
    ((Number(m[1]) || 0) * 365 + (Number(m[2]) || 0) * 30 + (Number(m[3]) || 0)) * 86400 +
    (Number(m[4]) || 0) * 3600 +
    (Number(m[5]) || 0) * 60 +
    (Number(m[6]) || 0)
  );
}

function parseAttrs(raw) {
  const out = {};
  if (!raw) return out;
  const re = /([:\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw))) out[m[1]] = m[3] ?? m[4] ?? '';
  return out;
}

function blocks(xml, tag) {
  const out = [];
  const open = new RegExp(`<${tag}(\\s[^>]*)?\\s*(\\/>|>)`, 'gi');
  let m;
  while ((m = open.exec(xml))) {
    const attrs = parseAttrs(m[1] || '');
    if (m[2] === '/>' || m[0].endsWith('/>')) {
      out.push({ attrs, body: '' });
      continue;
    }
    const closeTag = `</${tag}>`;
    const close = xml.toLowerCase().indexOf(closeTag.toLowerCase(), m.index + m[0].length);
    if (close < 0) {
      out.push({ attrs, body: '' });
      continue;
    }
    out.push({ attrs, body: xml.slice(m.index + m[0].length, close) });
    open.lastIndex = close + closeTag.length;
  }
  return out;
}

function firstText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml || '');
  return m ? m[1].trim() : '';
}

function joinBase(parent, childXml) {
  const extra = firstText(childXml, 'BaseURL');
  return extra ? absUrl(extra, parent) : parent;
}

function fillTemplate(tpl, { id, bandwidth, number, time }) {
  return String(tpl || '')
    .replace(/\$RepresentationID\$/g, id)
    .replace(/\$Bandwidth\$/g, String(bandwidth || ''))
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => String(number).padStart(pad ? Number(pad) : 0, '0'))
    .replace(/\$Time\$/g, String(time ?? ''));
}

function segmentTemplate(body) {
  return blocks(body, 'SegmentTemplate')[0] || null;
}

function segmentList(body) {
  return blocks(body, 'SegmentList')[0] || null;
}

function expandTimeline(tplBody, startNumber) {
  const out = [];
  let number = startNumber;
  let t = 0;
  const re = /<S\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(tplBody))) {
    const a = parseAttrs(m[1]);
    if (a.t != null && a.t !== '') t = Number(a.t) || 0;
    const d = Number(a.d) || 0;
    const repeats = a.r != null && a.r !== '' ? Number(a.r) : 0;
    const times = repeats < 0 ? 1 : repeats + 1;
    for (let i = 0; i < times; i++) {
      out.push({ number, time: t });
      t += d;
      number++;
    }
  }
  return out;
}

function resolveRep(repBlock, base, periodDuration, contentType, mimeType, asBody) {
  const a = repBlock.attrs;
  const id = a.id || a.ID || String(a.bandwidth || '0');
  const bandwidth = Number(a.bandwidth) || 0;
  const width = Number(a.width) || 0;
  const height = Number(a.height) || 0;
  const codecs = a.codecs || '';
  const repBase = joinBase(base, repBlock.body);
  const tpl = segmentTemplate(repBlock.body) || segmentTemplate(asBody || '') || null;
  const list = segmentList(repBlock.body) || segmentList(asBody || '') || null;

  const segments = [];
  let init = null;
  const tokens = { id, bandwidth };

  if (list) {
    const initEl = blocks(list.body, 'Initialization')[0];
    if (initEl?.attrs.sourceURL) {
      init = { url: absUrl(initEl.attrs.sourceURL, joinBase(repBase, list.body)) };
    }
    for (const su of blocks(list.body, 'SegmentURL')) {
      const media = su.attrs.media || su.attrs.sourceURL;
      if (!media) continue;
      segments.push({ url: absUrl(media, joinBase(repBase, list.body)) });
    }
  } else if (tpl) {
    const tplBase = joinBase(repBase, tpl.body);
    const startNumber = Number(tpl.attrs.startNumber || 1) || 1;
    const timescale = Number(tpl.attrs.timescale || 1) || 1;
    const duration = Number(tpl.attrs.duration || 0) || 0;
    if (tpl.attrs.initialization) {
      init = {
        url: absUrl(fillTemplate(tpl.attrs.initialization, { ...tokens, number: startNumber, time: 0 }), tplBase),
      };
    }
    const timeline = expandTimeline(tpl.body, startNumber);
    if (timeline.length) {
      for (const step of timeline) {
        segments.push({
          url: absUrl(
            fillTemplate(tpl.attrs.media, { ...tokens, number: step.number, time: step.time }),
            tplBase
          ),
        });
      }
    } else if (duration > 0 && periodDuration > 0 && tpl.attrs.media) {
      const segDur = duration / timescale;
      const count = Math.min(20000, Math.max(1, Math.ceil(periodDuration / segDur)));
      for (let i = 0; i < count; i++) {
        const number = startNumber + i;
        const time = i * duration;
        segments.push({
          url: absUrl(fillTemplate(tpl.attrs.media, { ...tokens, number, time }), tplBase),
        });
      }
    }
  }

  return {
    id,
    bandwidth,
    width,
    height,
    resolution: width && height ? `${width}x${height}` : '',
    codecs,
    contentType,
    mimeType,
    init,
    segments,
  };
}

export function parseMpd(text, baseUrl) {
  const xml = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const mpd = blocks(xml, 'MPD')[0] || { attrs: parseAttrs(/<MPD\b([^>]*)>/i.exec(xml)?.[1] || ''), body: xml };
  const mpdBase = joinBase(baseUrl, mpd.body);
  const type = (mpd.attrs.type || 'static').toLowerCase();
  const duration = isoDuration(mpd.attrs.mediaPresentationDuration || mpd.attrs.maxSegmentDuration);
  const drm = /<ContentProtection\b/i.test(xml);
  const periods = blocks(mpd.body, 'Period');
  const period = periods[0] || { attrs: {}, body: mpd.body };
  const periodDur = isoDuration(period.attrs.duration) || duration;
  const periodBase = joinBase(mpdBase, period.body);

  const representations = [];
  for (const as of blocks(period.body, 'AdaptationSet')) {
    const mime = as.attrs.mimeType || as.attrs.mimeType || '';
    const contentType = (as.attrs.contentType || mime.split('/')[0] || 'video').toLowerCase();
    const asBase = joinBase(periodBase, as.body);
    for (const rep of blocks(as.body, 'Representation')) {
      representations.push(
        resolveRep(rep, asBase, periodDur, contentType, mime || as.attrs.mimeType || '', as.body)
      );
    }
  }

  return {
    live: type === 'dynamic',
    drm,
    duration: periodDur,
    multiPeriod: periods.length > 1,
    representations,
  };
}

/** Semua host segmen/init dari MPD. */
export function collectDashHosts(mpd) {
  const hosts = new Set();
  const add = (url) => {
    const h = hostOf(url);
    if (h) hosts.add(h);
  };
  for (const r of mpd?.representations || []) {
    if (r.init?.url) add(r.init.url);
    for (const s of r.segments || []) add(s.url);
  }
  return hosts;
}

export function dashLabel(rep) {
  const bits = [];
  if (rep.height) bits.push(`${rep.height}p`);
  else if (rep.contentType && rep.contentType !== 'video') bits.push(rep.contentType);
  if (rep.bandwidth) bits.push(`${Math.round(rep.bandwidth / 1000)} kbps`);
  return bits.join(' · ') || rep.id || 'stream';
}

export function pickDashRep(mpd, repId) {
  const reps = mpd.representations || [];
  if (repId) {
    const hit = reps.find((r) => r.id === repId);
    if (hit) return hit;
  }
  const videos = reps.filter((r) => r.contentType === 'video' || (!r.contentType && r.height));
  const pool = videos.length ? videos : reps.filter((r) => r.contentType !== 'audio' && r.contentType !== 'text');
  const ranked = [...(pool.length ? pool : reps)].sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  return ranked[0] || null;
}

export function dashVariantUrl(mpdUrl, repId) {
  const base = String(mpdUrl || '').replace(/#.*$/, '');
  return `${base}#rep=${encodeURIComponent(repId)}`;
}

export function dashRepIdFromUrl(url) {
  try {
    const hash = new URL(url).hash || '';
    const m = /^#rep=(.*)$/.exec(hash);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    const i = String(url).indexOf('#rep=');
    return i >= 0 ? decodeURIComponent(String(url).slice(i + 5)) : '';
  }
}
