// Service worker: pusat deteksi media, manajemen aturan header, dan koordinasi job.

import { parseM3U8, sortVariants, variantLabel } from './lib/m3u8.js';
import { fetchText } from './lib/net.js';
import {
  hostOf,
  kindFromContentType,
  kindFromUrl,
  originOf,
  sanitizeFilename,
  SEGMENT_URL_RE,
  shortHash,
} from './lib/util.js';

const SETTINGS_DEFAULT = {
  concurrency: 6,
  minFileSize: 200 * 1024, // abaikan mp4 mungil (biasanya iklan/preview)
  keepPerTab: 60,
};

/** @type {Map<number, Map<string, object>>} tabId -> (entryId -> entry) */
const registry = new Map();
/** @type {Map<string, object>} jobId -> job */
const jobs = new Map();
/** URL -> header asli yang dipakai halaman saat meminta media itu. */
const headerMemo = new Map();
/** tabId -> pratinjau video { dataUrl|url, width, height, duration } — memori saja. */
const thumbs = new Map();
/** tabId -> catatan diagnostik: apa yang dilihat engine dan apa yang dibuang. */
const diagnostics = new Map();

function diagFor(tabId) {
  let d = diagnostics.get(tabId);
  if (!d) {
    d = { responses: 0, recorded: 0, reasons: {}, events: [], frames: [], hooks: [] };
    diagnostics.set(tabId, d);
  }
  return d;
}

/** Catat kenapa sebuah respons yang tampak seperti media tidak jadi dipakai. */
function logDiag(tabId, reason, detail) {
  if (tabId == null || tabId < 0) return;
  const d = diagFor(tabId);
  d.reasons[reason] = (d.reasons[reason] || 0) + 1;
  d.events.unshift({ reason, detail: String(detail).slice(0, 300), at: Date.now() });
  if (d.events.length > 40) d.events.length = 40;
}

let settings = { ...SETTINGS_DEFAULT };
let persistTimer = null;

// --------------------------------------------------------------- diagnosa ---
// Satu API yang tidak tersedia tidak boleh menjatuhkan seluruh service worker.
// Kegagalan dicatat dan ditampilkan di popup supaya kelihatan, bukan diam-diam.
const startupErrors = [];

function safe(label, fn) {
  try {
    fn();
  } catch (err) {
    const text = `${label}: ${String(err?.message || err)}`;
    startupErrors.push(text);
    console.error('[StreamGrab]', text);
  }
}

for (const [label, present] of [
  ['chrome.action', typeof chrome.action?.setBadgeText === 'function'],
  ['chrome.webRequest', typeof chrome.webRequest?.onSendHeaders?.addListener === 'function'],
  ['chrome.declarativeNetRequest', typeof chrome.declarativeNetRequest?.updateSessionRules === 'function'],
  ['chrome.offscreen', typeof chrome.offscreen?.createDocument === 'function'],
  ['chrome.runtime.getContexts', typeof chrome.runtime?.getContexts === 'function'],
  ['chrome.downloads', typeof chrome.downloads?.download === 'function'],
  ['chrome.storage.session', typeof chrome.storage?.session?.get === 'function'],
]) {
  if (!present) startupErrors.push(`${label} tidak tersedia di browser ini`);
}

// ------------------------------------------------------------ persistence ---

async function loadState() {
  try {
    const stored = await chrome.storage.session.get(['registry', 'jobs', 'headerMemo']);
    if (stored.registry) {
      for (const [tabId, entries] of Object.entries(stored.registry)) {
        registry.set(Number(tabId), new Map(Object.entries(entries)));
      }
    }
    if (stored.jobs) for (const j of stored.jobs) jobs.set(j.id, j);
    if (stored.headerMemo) for (const [k, v] of Object.entries(stored.headerMemo)) headerMemo.set(k, v);
  } catch {
    /* storage.session belum siap — abaikan */
  }
  try {
    const local = await chrome.storage.local.get('settings');
    settings = { ...SETTINGS_DEFAULT, ...(local.settings || {}) };
  } catch {
    /* pakai default */
  }
}

const ready = loadState();

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const reg = {};
    for (const [tabId, entries] of registry) reg[tabId] = Object.fromEntries(entries);
    const memo = {};
    let n = 0;
    for (const [k, v] of headerMemo) {
      if (n++ > 400) break;
      memo[k] = v;
    }
    try {
      await chrome.storage.session.set({
        registry: reg,
        jobs: [...jobs.values()],
        headerMemo: memo,
      });
    } catch {
      /* kuota penuh — tidak fatal */
    }
  }, 300);
}

// ---------------------------------------------------------------- registry ---

function entriesFor(tabId) {
  let m = registry.get(tabId);
  if (!m) {
    m = new Map();
    registry.set(tabId, m);
  }
  return m;
}

function updateBadge(tabId) {
  const n = registry.get(tabId)?.size || 0;
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  chrome.action.setBadgeText({ tabId, text: n ? String(Math.min(n, 99)) : '' }).catch(() => {});
}

function addEntry(entry) {
  if (entry.tabId == null || entry.tabId < 0) return;
  const map = entriesFor(entry.tabId);
  const id = shortHash(entry.url);
  const prev = map.get(id);
  const merged = {
    id,
    firstSeen: prev?.firstSeen ?? Date.now(),
    ...prev,
    ...entry,
    // jangan turunkan info yang sudah kaya dengan nilai kosong
    size: entry.size || prev?.size || 0,
    contentType: entry.contentType || prev?.contentType || '',
    frameUrl: entry.frameUrl || prev?.frameUrl || '',
    pageTitle: entry.pageTitle || prev?.pageTitle || '',
    pageUrl: entry.pageUrl || prev?.pageUrl || '',
    headers: { ...(prev?.headers || {}), ...(entry.headers || {}) },
    lastSeen: Date.now(),
  };
  map.set(id, merged);

  // batasi jumlah entri per tab
  if (map.size > settings.keepPerTab) {
    const oldest = [...map.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (oldest) map.delete(oldest.id);
  }

  updateBadge(entry.tabId);
  schedulePersist();
}

function clearTab(tabId) {
  registry.delete(tabId);
  thumbs.delete(tabId);
  diagnostics.delete(tabId);
  updateBadge(tabId);
  schedulePersist();
}

// -------------------------------------------------------------- webRequest ---

const WATCHED_TYPES = ['xmlhttprequest', 'media', 'other', 'object', 'sub_frame'];

function headerValue(list, name) {
  const found = list?.find((h) => h.name.toLowerCase() === name);
  return found?.value || '';
}

// Header asli dicatat per-host — termasuk host segmen, karena saat mengunduh
// potongan .ts kita perlu meniru Referer/Cookie yang sama persis.
safe('webRequest.onSendHeaders', () =>
  chrome.webRequest.onSendHeaders.addListener(
    memoHeaders,
    { urls: ['<all_urls>'], types: WATCHED_TYPES },
    ['requestHeaders', 'extraHeaders']
  )
);

function memoHeaders(d) {
  const host = hostOf(d.url);
  if (!host) return;
  const rec = {
    referer: headerValue(d.requestHeaders, 'referer'),
    origin: headerValue(d.requestHeaders, 'origin'),
    userAgent: headerValue(d.requestHeaders, 'user-agent'),
    cookie: headerValue(d.requestHeaders, 'cookie'),
  };
  if (!rec.referer && !rec.cookie) return;
  headerMemo.set(host, rec);
  schedulePersist();
}

// Permintaan yang lahir di dalam Worker/SharedWorker/service worker sering
// dilaporkan tanpa tabId. Membuangnya begitu saja membuat situs yang mengambil
// medianya dari worker tidak pernah terdeteksi — jadi kita cocokkan lewat
// origin pemrakarsanya. Permintaan extension sendiri tetap harus diabaikan.
/** @type {Map<string, number>} origin -> tabId */
const originToTab = new Map();

function indexTab(tab) {
  if (!tab || tab.id == null || tab.id < 0) return;
  const origin = originOf(tab.url || '');
  if (origin && /^https?:/.test(origin)) originToTab.set(origin, tab.id);
}

safe('tabs index', () => {
  chrome.tabs.query({}).then((tabs) => tabs.forEach(indexTab)).catch(() => {});
  chrome.tabs.onUpdated.addListener((_id, _info, tab) => indexTab(tab));
});

/** Pure: dipisah agar bisa diuji tanpa API chrome. */
function resolveTabId(details, index) {
  if (details.tabId != null && details.tabId >= 0) return details.tabId;
  const initiator = details.initiator || details.documentUrl || '';
  if (!initiator || !/^https?:/.test(initiator)) return -1; // termasuk chrome-extension://
  const origin = originOf(initiator);
  const tabId = index.get(origin);
  return tabId == null ? -1 : tabId;
}

safe('webRequest.onBeforeRequest', () =>
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      d = { ...d, tabId: resolveTabId(d, originToTab) };
      if (d.tabId < 0) return;
      if (SEGMENT_URL_RE.test(d.url)) return;
      const kind = kindFromUrl(d.url);
      if (!kind) return;
      diagFor(d.tabId).recorded++;
      record(d, kind, '', 0);
    },
    { urls: ['<all_urls>'], types: WATCHED_TYPES }
  )
);

safe('webRequest.onHeadersReceived', () =>
  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      d = { ...d, tabId: resolveTabId(d, originToTab) };
      if (d.tabId < 0) return;
      const diag = diagFor(d.tabId);
      diag.responses++;
      const ct = headerValue(d.responseHeaders, 'content-type');
      const kind = kindFromContentType(ct) || kindFromUrl(d.url);
      if (!kind) {
        // Tipe yang samar sering menyembunyikan playlist — layak dilaporkan.
        if (/video|mpegurl|octet-stream|dash|mp2t/i.test(ct)) {
          logDiag(d.tabId, 'tipe tidak dikenali', `${ct} — ${d.url}`);
        }
        return;
      }
      if (kind === 'file' && SEGMENT_URL_RE.test(d.url)) {
        logDiag(d.tabId, 'dianggap potongan segmen', d.url);
        return;
      }
      const size = parseInt(headerValue(d.responseHeaders, 'content-length') || '0', 10) || 0;
      if (kind === 'file' && size && size < settings.minFileSize) {
        logDiag(d.tabId, 'di bawah ukuran minimum', `${size} B — ${d.url}`);
        return;
      }
      record(d, kind, ct, size);
      diag.recorded++;
    },
    { urls: ['<all_urls>'], types: WATCHED_TYPES },
    ['responseHeaders']
  )
);

function record(d, kind, contentType, size) {
  const host = hostOf(d.url);
  addEntry({
    url: d.url,
    kind,
    tabId: d.tabId,
    frameUrl: d.documentUrl || d.initiator || '',
    contentType,
    size,
    source: 'network',
    headers: headerMemo.get(host) || {},
  });
}

// Bersihkan daftar saat tab pindah halaman.
safe('tabs.onUpdated', () =>
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) clearTab(tabId);
  })
);
safe('tabs.onRemoved', () => chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId)));

// --------------------------------------------------- header spoofing (DNR) ---

let ruleSeq = 1;
const RULE_ID_MIN = 20000;
const RULE_ID_MAX = 29000;

function nextRuleId() {
  ruleSeq = ruleSeq >= RULE_ID_MAX - RULE_ID_MIN ? 1 : ruleSeq + 1;
  return RULE_ID_MIN + ruleSeq;
}

/**
 * Pasang aturan yang menulis ulang Referer/Origin/Cookie untuk permintaan
 * yang berasal dari extension sendiri (tabId -1), bukan dari tab manapun.
 */
async function addHeaderRule(url, headers = {}) {
  const host = hostOf(url);
  if (!host) return null;

  const build = (withCookie) => {
    const requestHeaders = [];
    if (headers.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: headers.referer });
    if (headers.origin) requestHeaders.push({ header: 'origin', operation: 'set', value: headers.origin });
    if (withCookie && headers.cookie) requestHeaders.push({ header: 'cookie', operation: 'set', value: headers.cookie });
    return requestHeaders;
  };

  for (const withCookie of [true, false]) {
    const requestHeaders = build(withCookie);
    if (!requestHeaders.length) return null;
    const id = nextRuleId();
    const rule = {
      id,
      priority: 100,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: {
        urlFilter: `||${host}`,
        tabIds: [chrome.tabs.TAB_ID_NONE],
      },
    };
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [rule],
      });
      return id;
    } catch (err) {
      if (!withCookie) {
        console.warn('[StreamGrab] gagal memasang aturan header:', err);
        return null;
      }
    }
  }
  return null;
}

async function removeHeaderRule(id) {
  if (id == null) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  } catch {
    /* sudah hilang */
  }
}

// ------------------------------------------------- estimasi ukuran HLS ---
// Playlist HLS tidak menyebut ukuran total di mana pun. Satu-satunya cara
// mengetahuinya tanpa mengunduh semuanya: ambil ukuran beberapa segmen contoh,
// hitung laju byte/detik, lalu kalikan durasi playlist.

/** Ukuran sebuah URL lewat satu permintaan 1 byte (Content-Range menyebut total). */
async function remoteSize(url) {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      credentials: 'include',
      cache: 'no-store',
    });
    let size = 0;
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (m) size = parseInt(m[1], 10);
    }
    if (!size) size = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    try {
      await res.body?.cancel();
    } catch {
      /* sudah tertutup */
    }
    return Number.isFinite(size) ? size : 0;
  } catch {
    return 0;
  }
}

async function estimatePlaylistBytes(playlist) {
  const segs = playlist.segments;
  if (!segs.length) return 0;

  // Kalau semua segmen memakai byterange, ukurannya sudah pasti.
  if (segs.every((s) => s.byterange)) {
    return segs.reduce((sum, s) => sum + s.byterange.length, 0);
  }

  // Hindari segmen pertama dan terakhir — keduanya kerap lebih pendek.
  const picks = segs.length <= 3
    ? segs.map((_, i) => i)
    : [0.25, 0.5, 0.75].map((f) => Math.floor(segs.length * f));

  let sampledBytes = 0;
  let sampledSeconds = 0;
  for (const i of [...new Set(picks)]) {
    const seg = segs[i];
    if (!seg) continue;
    const size = await remoteSize(seg.url);
    if (!size) continue;
    sampledBytes += size;
    sampledSeconds += seg.duration || 0;
  }
  if (!sampledBytes) return 0;

  // Durasi segmen bisa berbeda-beda, jadi hitung lewat laju, bukan rata-rata per segmen.
  if (sampledSeconds > 0 && playlist.duration > 0) {
    return Math.round((sampledBytes / sampledSeconds) * playlist.duration);
  }
  const perSegment = sampledBytes / [...new Set(picks)].length;
  return Math.round(perSegment * segs.length);
}

/** Header terbaik yang kita ketahui untuk sebuah URL media. */
function headersFor(entry, targetUrl = entry.url) {
  const host = hostOf(targetUrl);
  const memo = headerMemo.get(host) || {};
  const referer =
    entry.headers?.referer || memo.referer || entry.frameUrl || entry.pageUrl || '';
  return {
    referer,
    origin: entry.headers?.origin || memo.origin || (referer ? originOf(referer) : ''),
    cookie: memo.cookie || entry.headers?.cookie || '',
    userAgent: entry.headers?.userAgent || memo.userAgent || navigator.userAgent,
  };
}

// ------------------------------------------------------ offscreen document ---

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: 'Merakit segmen video menjadi satu berkas sebelum disimpan.',
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

/**
 * sendMessage menolak dengan "Could not establish connection" bila belum ada
 * penerima — dokumen offscreen bisa saja baru saja dibuat. Coba beberapa kali.
 */
async function sendToOffscreen(payload, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      await chrome.runtime.sendMessage(payload);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  return false;
}

// -------------------------------------------------------------------- jobs ---

function newJobId() {
  return `job_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function saveJob(job) {
  jobs.set(job.id, job);
  schedulePersist();
}

async function startDownload({ entryId, tabId, variantUrl, label, mode, estimatedBytes }) {
  const entry = registry.get(tabId)?.get(entryId);
  if (!entry) throw new Error('Media tidak ditemukan lagi — muat ulang halaman.');

  const targetUrl = variantUrl || entry.url;
  const headers = headersFor(entry, targetUrl);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const base = sanitizeFilename(
    tab?.title || entry.pageTitle || hostOf(entry.frameUrl || entry.url),
    'video'
  );
  const nameBase = label ? `${base} [${label}]` : base;

  const job = {
    id: newJobId(),
    entryId,
    tabId,
    url: targetUrl,
    kind: entry.kind,
    mode: mode || (entry.kind === 'hls' ? 'engine' : 'direct'),
    nameBase,
    status: 'running',
    startedAt: Date.now(),
    estimatedBytes: estimatedBytes || entry.size || 0,
    progress: { completed: 0, total: 0, bytes: 0 },
    warnings: [],
    headers,
  };
  saveJob(job);

  if (job.mode === 'direct') {
    await startDirectDownload(job);
  } else {
    await startEngineDownload(job);
  }
  return job.id;
}

/** Jalur cepat: chrome.downloads menstream langsung ke disk (tanpa batas memori). */
async function startDirectDownload(job) {
  job.ruleId = await addHeaderRule(job.url, job.headers);
  const ext = (job.url.match(/\.([a-z0-9]{2,4})(?:$|[?#])/i)?.[1] || 'mp4').toLowerCase();
  try {
    const downloadId = await chrome.downloads.download({
      url: job.url,
      filename: `StreamGrab/${job.nameBase}.${ext}`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    job.downloadId = downloadId;
    saveJob(job);
  } catch (err) {
    await removeHeaderRule(job.ruleId);
    job.status = 'error';
    job.error = String(err?.message || err);
    saveJob(job);
  }
}

/** Jalur engine: unduh + rakit di offscreen document. */
async function startEngineDownload(job) {
  job.ruleId = await addHeaderRule(job.url, job.headers);
  await ensureOffscreen();
  const delivered = await sendToOffscreen({
    target: 'offscreen',
    cmd: 'run',
    job: {
      id: job.id,
      url: job.url,
      kind: job.kind,
      concurrency: settings.concurrency,
    },
  });
  if (!delivered) {
    job.status = 'error';
    job.error = 'Mesin unduhan tidak merespons — coba muat ulang extension.';
    await removeHeaderRule(job.ruleId);
  }
  saveJob(job);
}

safe('downloads.onChanged', () =>
  chrome.downloads.onChanged.addListener(async (delta) => {
    const job = [...jobs.values()].find((j) => j.downloadId === delta.id);
    if (!job) return;
    if (delta.state?.current === 'complete') {
      job.status = 'done';
      await removeHeaderRule(job.ruleId);
      if (job.blobUrl) revokeBlob(job.blobUrl);
      saveJob(job);
    } else if (delta.state?.current === 'interrupted') {
      job.status = 'error';
      job.error = delta.error?.current || 'Unduhan terputus';
      await removeHeaderRule(job.ruleId);
      if (job.blobUrl) revokeBlob(job.blobUrl);
      saveJob(job);
    }
  })
);

function revokeBlob(blobUrl) {
  chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'revoke', blobUrl }).catch(() => {});
}

// --------------------------------------------------------------- messaging ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;

  (async () => {
    await ready;
    switch (msg.type || msg.cmd) {
      // -- dari content script -------------------------------------------
      case 'media-found': {
        const tabId = sender.tab?.id;
        if (tabId == null) return;
        for (const found of msg.items || []) {
          const kind = kindFromUrl(found.url) || found.kind;
          if (!kind) continue;
          addEntry({
            url: found.url,
            kind,
            tabId,
            frameUrl: sender.url || '',
            pageTitle: msg.title || '',
            pageUrl: msg.pageUrl || '',
            source: found.source || 'page',
            headers: headerMemo.get(hostOf(found.url)) || {
              referer: sender.url || '',
              origin: originOf(sender.url || ''),
            },
          });
        }
        sendResponse({ ok: true });
        return;
      }

      case 'frame-alive': {
        const tabId = sender.tab?.id;
        if (tabId != null && tabId >= 0) {
          const d = diagFor(tabId);
          const frameId = sender.frameId ?? 0;
          const existing = d.frames.findIndex((f) => f.frameId === frameId);
          const rec = {
            frameId,
            url: sender.url || '',
            isTop: frameId === 0,
            hooks: msg.hooks?.length ? msg.hooks : existing >= 0 ? d.frames[existing].hooks : [],
            at: Date.now(),
          };
          if (existing >= 0) d.frames[existing] = rec;
          else d.frames.push(rec);
          if (d.frames.length > 20) d.frames.length = 20;
          d.hooks = [...new Set(d.frames.flatMap((f) => f.hooks))];
        }
        sendResponse({ ok: true });
        return;
      }

      case 'diagnostics': {
        const d = diagnostics.get(msg.tabId);
        const entries = [...(registry.get(msg.tabId)?.values() || [])];
        sendResponse({
          ok: true,
          responses: d?.responses || 0,
          recorded: entries.length,
          reasons: d?.reasons || {},
          events: d?.events || [],
          frames: d?.frames || [],
          hooks: d?.hooks || [],
          headerHosts: [...headerMemo.keys()].slice(0, 12),
        });
        return;
      }

      case 'thumb-found': {
        const tabId = sender.tab?.id;
        if (tabId == null || !msg.thumb) return;
        const prev = thumbs.get(tabId);
        // Frame asli selalu mengalahkan poster statis.
        if (prev?.from === 'frame' && msg.thumb.from !== 'frame') {
          sendResponse({ ok: true });
          return;
        }
        thumbs.set(tabId, { ...msg.thumb, at: Date.now() });
        sendResponse({ ok: true });
        return;
      }

      // -- dari offscreen -------------------------------------------------
      case 'job-progress': {
        const job = jobs.get(msg.id);
        if (job) {
          job.progress = msg.progress;
          job.status = 'running';
          saveJob(job);
        }
        sendResponse({ ok: true });
        return;
      }
      case 'job-done': {
        const job = jobs.get(msg.id);
        if (!job) return;
        job.blobUrl = msg.blobUrl;
        job.warnings = msg.warnings || [];
        job.progress = { ...job.progress, bytes: msg.bytes };
        try {
          job.downloadId = await chrome.downloads.download({
            url: msg.blobUrl,
            filename: `StreamGrab/${job.nameBase}.${msg.ext}`,
            saveAs: false,
            conflictAction: 'uniquify',
          });
          job.status = 'saving';
        } catch (err) {
          job.status = 'error';
          job.error = String(err?.message || err);
          revokeBlob(msg.blobUrl);
        }
        await removeHeaderRule(job.ruleId);
        saveJob(job);
        sendResponse({ ok: true });
        return;
      }
      case 'job-error': {
        const job = jobs.get(msg.id);
        if (job) {
          job.status = msg.aborted ? 'canceled' : 'error';
          job.error = msg.error;
          await removeHeaderRule(job.ruleId);
          saveJob(job);
        }
        sendResponse({ ok: true });
        return;
      }

      // -- dari popup ------------------------------------------------------
      case 'state': {
        const tabId = msg.tabId;
        const rank = (e) => {
          // Yang terbukti hidup naik ke atas; yang gagal verifikasi turun.
          if (e.verified === true) return 0;
          if (e.verified === false) return 2;
          return 1;
        };
        const list = [...(registry.get(tabId)?.values() || [])].sort((a, b) => {
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          if (a.kind !== b.kind) return a.kind === 'hls' ? -1 : 1;
          return b.lastSeen - a.lastSeen;
        });
        sendResponse({
          media: list,
          jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20),
          settings,
          startupErrors,
          thumb: thumbs.get(tabId) || null,
        });
        return;
      }
      case 'probe': {
        try {
          const entry = registry.get(msg.tabId)?.get(msg.entryId);
          if (!entry) throw new Error('Entri tidak ditemukan.');
          const headers = headersFor(entry);
          const ruleId = await addHeaderRule(entry.url, headers);
          try {
            const text = await fetchText(entry.url, { retries: 2 });
            const pl = parseM3U8(text, entry.url);
            const warnings = [];
            if (pl.live) warnings.push('Playlist live/berjalan.');
            if (pl.encryption && pl.encryption !== 'AES-128') {
              warnings.push(`Enkripsi ${pl.encryption} tidak didukung.`);
            }

            let variants = [];
            let duration = pl.duration;
            let segments = pl.segments.length;

            if (pl.isMaster && pl.variants.length) {
              // Durasi sama untuk semua kualitas, jadi cukup ukur yang tertinggi
              // lalu skalakan sisanya menurut BANDWIDTH masing-masing.
              const sorted = sortVariants(pl.variants);
              const top = sorted[0];
              const topPlaylist = parseM3U8(
                await fetchText(top.url, { retries: 2 }),
                top.url
              );
              duration = topPlaylist.duration;
              segments = topPlaylist.segments.length;
              if (topPlaylist.live) warnings.push('Playlist live/berjalan.');

              const measured = await estimatePlaylistBytes(topPlaylist);
              const baseline = top.bandwidth && duration ? (top.bandwidth / 8) * duration : 0;
              // BANDWIDTH sering dilebihkan encoder — kalibrasi dengan ukuran nyata.
              const calibration = measured && baseline ? measured / baseline : 1;

              variants = sorted.map((v) => ({
                url: v.url,
                label: variantLabel(v),
                bandwidth: v.bandwidth,
                resolution: v.resolution,
                size:
                  v.url === top.url
                    ? measured
                    : v.bandwidth && duration
                      ? Math.round((v.bandwidth / 8) * duration * calibration)
                      : 0,
                estimated: v.url !== top.url || !measured,
                hasSeparateAudio: Boolean(v.audioGroup),
              }));
            } else if (pl.segments.length) {
              const measured = await estimatePlaylistBytes(pl);
              variants = [
                {
                  url: entry.url,
                  label: 'stream tunggal',
                  bandwidth: 0,
                  resolution: '',
                  size: measured,
                  estimated: true,
                  hasSeparateAudio: false,
                },
              ];
            }

            if (pl.variants.some((v) => v.audioGroup)) {
              warnings.push('Audio berada di track terpisah — gunakan perintah ffmpeg agar tergabung.');
            }

            const best = variants[0];
            if (best?.size) {
              // Tampilkan ukuran di daftar utama tanpa perlu membuka detail.
              entry.size = best.size;
              entry.estimatedSize = true;
            }
            entry.duration = duration;
            entry.probed = true;
            schedulePersist();

            sendResponse({
              ok: true,
              isMaster: pl.isMaster,
              variants,
              segments,
              duration,
              headers,
              warnings,
            });
          } finally {
            await removeHeaderRule(ruleId);
          }
        } catch (err) {
          logDiag(msg.tabId, 'probe playlist gagal', String(err?.message || err));
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        return;
      }
      // Pemindaian halaman yang agresif bisa memungut URL yang tidak hidup.
      // Ambil beberapa KB pertama untuk memastikan isinya memang media.
      case 'verify': {
        const entry = registry.get(msg.tabId)?.get(msg.entryId);
        if (!entry) {
          sendResponse({ ok: false, error: 'Entri tidak ditemukan.' });
          return;
        }
        const headers = headersFor(entry);
        const ruleId = await addHeaderRule(entry.url, headers);
        try {
          const res = await fetch(entry.url, {
            headers: { Range: 'bytes=0-2047' },
            credentials: 'include',
            cache: 'no-store',
          });
          if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          const head = await res.text();
          const looksHls = head.trimStart().startsWith('#EXTM3U') || ct.includes('mpegurl');
          const looksDash = head.includes('<MPD') || ct.includes('dash+xml');
          const looksVideo = ct.startsWith('video/') || /ftyp|moov|mdat/.test(head.slice(0, 64));
          const alive = looksHls || looksDash || looksVideo;
          entry.verified = alive;
          entry.verifiedAt = Date.now();
          if (looksHls && entry.kind !== 'hls') entry.kind = 'hls';
          schedulePersist();
          sendResponse({ ok: true, alive, kind: entry.kind });
        } catch (err) {
          entry.verified = false;
          entry.verifiedAt = Date.now();
          entry.verifyError = String(err?.message || err);
          logDiag(msg.tabId, 'verifikasi gagal', `${entry.verifyError} — ${entry.url}`);
          schedulePersist();
          sendResponse({ ok: true, alive: false, error: entry.verifyError });
        } finally {
          await removeHeaderRule(ruleId);
        }
        return;
      }
      case 'headers': {
        const entry = registry.get(msg.tabId)?.get(msg.entryId);
        sendResponse(entry ? headersFor(entry) : {});
        return;
      }
      case 'download': {
        try {
          const id = await startDownload(msg);
          sendResponse({ ok: true, jobId: id });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        return;
      }
      case 'cancel': {
        const job = jobs.get(msg.jobId);
        if (job) {
          if (job.downloadId != null) chrome.downloads.cancel(job.downloadId).catch(() => {});
          chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'cancel', id: job.id }).catch(() => {});
          job.status = 'canceled';
          await removeHeaderRule(job.ruleId);
          saveJob(job);
        }
        sendResponse({ ok: true });
        return;
      }
      case 'clear-jobs': {
        for (const [id, job] of jobs) {
          if (['done', 'error', 'canceled'].includes(job.status)) jobs.delete(id);
        }
        schedulePersist();
        sendResponse({ ok: true });
        return;
      }
      case 'clear-media': {
        clearTab(msg.tabId);
        sendResponse({ ok: true });
        return;
      }
      case 'scan':
      case 'capture-thumb': {
        const cmd = (msg.type || msg.cmd) === 'scan' ? 'deep-scan' : 'capture-thumb';
        try {
          await chrome.tabs.sendMessage(msg.tabId, { cmd });
        } catch {
          /* frame tanpa content script */
        }
        sendResponse({ ok: true });
        return;
      }
      case 'settings': {
        settings = { ...settings, ...msg.patch };
        await chrome.storage.local.set({ settings });
        sendResponse({ ok: true, settings });
        return;
      }
      default:
        return;
    }
  })();

  return true; // respons asinkron
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
});
