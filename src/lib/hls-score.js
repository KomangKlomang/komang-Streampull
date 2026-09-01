// Skor stream HLS — pola z1nc0r3/m3u8-grabber (master/ad/duplikat/kualitas).

const RESOLUTION_PATTERNS = [
  { regex: /[/_\-.](\d{3,4})p[/_\-.\?]/i, group: 1 },
  { regex: /(\d{3,4})x(\d{3,4})/i, group: 2 },
  {
    regex: /\/(\d{3,4})\//,
    group: 1,
    validate: (n) => [240, 360, 480, 540, 576, 720, 1080, 1440, 2160, 4320].includes(n),
  },
];

const MASTER_INDICATORS = [
  'master',
  'index',
  'playlist',
  'variant',
  'manifest',
  'chunklist_w',
  'level',
  'multivariant',
  'hls.m3u8',
  'main.m3u8',
];

const AD_INDICATORS = [
  'preroll',
  'midroll',
  'postroll',
  '/ads/',
  '/ad/',
  'vast',
  'vpaid',
  'doubleclick',
  'googlesyndication',
  'adserver',
  'adbreak',
  'imasdk',
  'admanager',
  'spotx',
  'ad-',
  '-ad.',
  '_ad.',
  '_ad_',
];

/** @returns {{ quality: string|null, qualityNum: number, type: string, score: number, isDuplicate: boolean }} */
export function analyzeHlsUrl(url) {
  const urlLower = String(url || '').toLowerCase();
  let pathOnly = urlLower;
  try {
    pathOnly = new URL(url).pathname.toLowerCase();
  } catch {
    /* biarkan */
  }

  const analysis = {
    quality: null,
    qualityNum: 0,
    type: 'media',
    score: 60,
    isDuplicate: false,
  };

  for (const pattern of RESOLUTION_PATTERNS) {
    const match = urlLower.match(pattern.regex);
    if (!match) continue;
    const num = parseInt(match[pattern.group], 10);
    if (pattern.validate && !pattern.validate(num)) continue;
    if (num >= 100 && num <= 8640) {
      analysis.quality = `${num}p`;
      analysis.qualityNum = num;
      break;
    }
  }

  const isMaster = MASTER_INDICATORS.some((kw) => pathOnly.includes(kw));
  const isAd = AD_INDICATORS.some((kw) => urlLower.includes(kw));
  const isAudio = /audio[\-_\/.]|\/audio\//i.test(urlLower) && !/video/i.test(pathOnly);

  if (isAd) {
    analysis.type = 'ad';
    analysis.score = 5;
  } else if (isMaster) {
    analysis.type = 'master';
    analysis.score = 90;
  } else if (isAudio) {
    analysis.type = 'audio';
    analysis.score = 30;
  }

  if (analysis.type === 'media' && analysis.qualityNum > 0) {
    analysis.score += Math.min(35, Math.floor(analysis.qualityNum / 60));
  }

  return analysis;
}

export function hlsBasePath(url) {
  try {
    const parsed = new URL(url);
    const tokenMatch = parsed.pathname.match(/\/([a-zA-Z0-9_\-]{20,})/);
    if (tokenMatch) return tokenMatch[1].toLowerCase();
    let path = parsed.pathname.toLowerCase().replace(/\/\d{3,4}p?\//g, '/*/');
    path = path.replace(/\/[a-f0-9]{32,}\//g, '/*/');
    return parsed.hostname + path;
  } catch {
    return String(url || '');
  }
}

/** Tandai duplikat & urut skor tertinggi. */
export function rankHlsEntries(entries) {
  const list = [...(entries || [])].filter((e) => e?.kind === 'hls' && e.url);
  const scored = list.map((e) => ({
    ...e,
    hlsScore: e.hlsScore ?? analyzeHlsUrl(e.url).score,
    hlsAnalysis: e.hlsAnalysis ?? analyzeHlsUrl(e.url),
  }));

  const seen = new Map();
  for (const e of scored) {
    const token = hlsBasePath(e.url);
    const prev = seen.get(token);
    if (!prev) {
      seen.set(token, e);
      continue;
    }
    if (e.hlsScore > prev.hlsScore) {
      prev.hlsAnalysis = { ...prev.hlsAnalysis, isDuplicate: true };
      prev.hlsScore -= 20;
      seen.set(token, e);
    } else {
      e.hlsAnalysis = { ...e.hlsAnalysis, isDuplicate: true };
      e.hlsScore -= 20;
    }
  }

  return scored.sort((a, b) => (b.hlsScore || 0) - (a.hlsScore || 0) || (b.lastSeen || 0) - (a.lastSeen || 0));
}

export function isJunkHls(entry) {
  const a = entry?.hlsAnalysis || analyzeHlsUrl(entry?.url);
  return a.type === 'ad' || a.type === 'audio';
}

/** ID stabil per stream — signed URL baru tidak menambah badge. */
export function hlsStableId(url, hashFn) {
  return hashFn(`hls:${hlsBasePath(url)}`);
}

/** Satu entri per stream live; sembunyikan FILE mati kalau HLS ada. */
export function collapseMediaForDisplay(entries) {
  const list = (entries || []).filter((e) => !isJunkHls(e));
  const hasHls = list.some((e) => e.kind === 'hls');
  const filtered = hasHls ? list.filter((e) => e.kind !== 'file' || e.playing) : list;
  const byHls = new Map();
  const rest = [];
  for (const e of filtered) {
    if (e.kind !== 'hls') {
      rest.push(e);
      continue;
    }
    const key = hlsBasePath(e.url);
    const prev = byHls.get(key);
    if (!prev || (e.lastSeen || 0) >= (prev.lastSeen || 0)) byHls.set(key, e);
  }
  return [...byHls.values(), ...rest];
}
