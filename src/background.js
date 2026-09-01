// Service worker: pusat deteksi media, manajemen aturan header, dan koordinasi job.

import { parseM3U8, sortVariants, variantLabel } from './lib/m3u8.js';
import { dashLabel, dashVariantUrl, parseMpd } from './lib/mpd.js';
import { fetchText } from './lib/net.js';
import { rankEntries } from './lib/rank.js';
import {
  hostOf,
  kindFromContentType,
  kindFromUrl,
  isNonMediaContentType,
  looksLikeHtml,
  mediaUrlsFromPlayerHtml,
  preferPlayerMediaUrl,
  originOf,
  downloadPath,
  sanitizeDownloadFolder,
  sanitizeFilename,
  ensureExtension,
  SEGMENT_URL_RE,
  shortHash,
} from './lib/util.js';

const SETTINGS_DEFAULT = {
  concurrency: 6,
  queueConcurrency: 3,
  minFileSize: 200 * 1024,
  keepPerTab: 60,
  downloadFolder: 'KSP',
  askSaveLocation: false,
};

const HISTORY_MAX = 200;
/** @type {object[]} */
let history = [];

/** @type {Map<number, Map<string, object>>} tabId -> (entryId -> entry) */
const registry = new Map();
/** @type {Map<string, object>} jobId -> job */
const jobs = new Map();
/** URL -> header asli yang dipakai halaman saat meminta media itu. */
const headerMemo = new Map();
/** tabId -> pratinjau video { dataUrl|url, width, height, duration } — memori saja. */
const thumbs = new Map();
let previewRuleId = null;
/** tabId -> key system EME yang terdeteksi di halaman itu. */
const tabDrm = new Map();
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
    console.error('[KSP]', text);
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
    const local = await chrome.storage.local.get(['settings', 'history']);
    settings = normalizeSettings(local.settings);
    history = Array.isArray(local.history) ? local.history : [];
  } catch {
    /* pakai default */
  }
}

function normalizeSettings(raw) {
  const merged = { ...SETTINGS_DEFAULT, ...(raw || {}) };
  merged.askSaveLocation = raw?.askSaveLocation === true;
  merged.downloadFolder = sanitizeDownloadFolder(merged.downloadFolder);
  const n = Number(merged.concurrency);
  merged.concurrency = Number.isFinite(n) ? Math.max(1, Math.min(16, n)) : SETTINGS_DEFAULT.concurrency;
  const q = Number(merged.queueConcurrency);
  merged.queueConcurrency = Number.isFinite(q) ? Math.max(1, Math.min(5, q)) : SETTINGS_DEFAULT.queueConcurrency;
  return merged;
}

function shouldPromptSave() {
  return settings.askSaveLocation === true;
}

function downloadFilename(nameBase, ext) {
  return downloadPath(nameBase, ext, settings.downloadFolder);
}

/** URL → path relatif (untuk onDeterminingFilename sebelum downloadId ada). */
const pendingSavePaths = new Map();

function registerSavePath(url, path) {
  if (url && path) pendingSavePaths.set(url, path);
}

function resolveSavePath(item) {
  const pending = pendingSavePaths.get(item.url);
  if (pending) return pending;
  for (const job of jobs.values()) {
    if (job.savedPath && (job.downloadId === item.id || job.blobUrl === item.url || job.url === item.url)) {
      return job.savedPath;
    }
  }
  return null;
}

function inferExtFromJob(item) {
  for (const job of jobs.values()) {
    if (job.blobUrl === item.url || job.url === item.url || job.downloadId === item.id) {
      const m = /\.([a-z0-9]{1,5})$/i.exec(job.savedPath || '');
      if (m) return m[1].toLowerCase();
      if (job.kind === 'hls') return 'ts';
      if (job.kind === 'dash') return 'mp4';
      return 'mp4';
    }
  }
  return 'mp4';
}

/** Simpan URL HTTP langsung ke disk (unduhan direct). */
async function saveToDisk(url, savedPath) {
  registerSavePath(url, savedPath);
  const opts = {
    url,
    filename: savedPath,
    conflictAction: 'uniquify',
  };
  if (shouldPromptSave()) opts.saveAs = true;
  return chrome.downloads.download(opts);
}

const BLOB_SAVE_PATHS = ['blob-save.html', 'src/save/blob-save.html'];

async function blobSavePagePath() {
  for (const path of BLOB_SAVE_PATHS) {
    try {
      const res = await fetch(chrome.runtime.getURL(path));
      if (res.ok) return path;
    } catch {
      /* coba path berikutnya */
    }
  }
  return BLOB_SAVE_PATHS[BLOB_SAVE_PATHS.length - 1];
}

/** Simpan blob URL hasil rakitan offscreen — fallback lewat halaman extension bila SW gagal. */
async function saveBlobViaPage(blobUrl, savedPath) {
  registerSavePath(blobUrl, savedPath);
  const saveAs = shouldPromptSave();
  const pageUrl =
    chrome.runtime.getURL(await blobSavePagePath()) +
    `?u=${encodeURIComponent(blobUrl)}` +
    `&f=${encodeURIComponent(savedPath)}` +
    `&saveAs=${saveAs ? 1 : 0}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onResult);
      reject(new Error('Timeout menyimpan berkas — coba lagi'));
    }, 120_000);

    const onResult = (msg) => {
      if (!msg || msg.type !== 'blob-save-result' || msg.blobUrl !== blobUrl) return;
      chrome.runtime.onMessage.removeListener(onResult);
      clearTimeout(timeout);
      if (msg.ok) resolve(msg.downloadId);
      else reject(new Error(msg.error || 'Gagal menyimpan berkas'));
    };

    chrome.runtime.onMessage.addListener(onResult);
    chrome.tabs.create({ url: pageUrl, active: false }).catch((err) => {
      chrome.runtime.onMessage.removeListener(onResult);
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function saveBlobToDisk(blobUrl, savedPath) {
  registerSavePath(blobUrl, savedPath);
  // Jangan chrome.downloads.download(blobUrl) dari SW: URL offscreen putus
  // di tengah jalan → Chrome nyangkut di .crdownload / "Can't finish download".
  return saveBlobViaPage(blobUrl, savedPath);
}

async function resolveDownloadPath(downloadId) {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item?.filename || '';
  } catch {
    return '';
  }
}

function clearPendingSavePath(url) {
  if (url) pendingSavePaths.delete(url);
}

async function appendHistory(job) {
  if (!['done', 'error', 'canceled'].includes(job.status)) return;
  history.unshift({
    id: job.id,
    name: job.nameBase,
    url: job.url,
    kind: job.kind,
    bytes: job.progress?.bytes || job.estimatedBytes || 0,
    finishedAt: Date.now(),
    path: job.savedPath || '',
    downloadId: job.downloadId ?? null,
    status: job.status,
    error: job.error || '',
  });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  try {
    await chrome.storage.local.set({ history });
  } catch {
    /* kuota penuh */
  }
}

function escapeFilenameRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findDownloadId(msg) {
  const fromMsg = msg?.downloadId;
  if (fromMsg != null) return fromMsg;
  const job = jobs.get(msg?.historyId);
  if (job?.downloadId != null) return job.downloadId;
  const rec = history.find((h) => h.id === msg?.historyId);
  if (rec?.downloadId != null) return rec.downloadId;
  const path = msg?.path || rec?.path || job?.savedPath || '';
  const base = String(path).split(/[/\\]/).filter(Boolean).pop();
  if (!base) return null;
  try {
    const items = await chrome.downloads.search({
      filenameRegex: escapeFilenameRegex(base) + '$',
      orderBy: ['-startTime'],
      limit: 20,
    });
    const hit = items.find((i) => {
      const name = (i.filename || '').replace(/\\/g, '/');
      return name.endsWith('/' + base) || name.endsWith(base);
    });
    return hit?.id ?? items[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function resolvePlayUrl(tabId) {
  const list = rankEntries([...(registry.get(tabId)?.values() || [])]).filter(
    (e) => !e.drm && e.verified !== false
  );
  const entry = list.find((e) => e.kind === 'file') || list[0];
  if (!entry) return null;
  let url = pickDownloadUrl(entry, tabId);
  let headers = await headersForDownload(entry, url);
  if (previewRuleId != null) await removeHeaderRule(previewRuleId);
  previewRuleId = await addHeaderRule(url, headers);
  if (entry.kind === 'file') {
    const real = await unwrapPlayerPage(url);
    if (real !== url) {
      url = real;
      headers = await headersForDownload(entry, url);
      await removeHeaderRule(previewRuleId);
      previewRuleId = await addHeaderRule(url, headers);
    }
  }
  const kind = kindFromUrl(url) || entry.kind;
  if (kind === 'hls' || kind === 'dash') return null;
  return url;
}

async function pingFrames(tabId, cmd) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (c) => {
        window.postMessage({ channel: 'GOVIDEO_CMD', cmd: c }, '*');
      },
      args: [cmd],
    });
  } catch {
    try {
      await chrome.tabs.sendMessage(tabId, { cmd });
    } catch {
      /* tidak ada content script */
    }
  }
}

async function captureTabStill(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: 'jpeg', quality: 60 });
    if (!dataUrl) return null;
    const thumb = { dataUrl, from: 'tab', at: Date.now() };
    thumbs.set(tabId, thumb);
    return thumb;
  } catch {
    return null;
  }
}

const ready = loadState().then(() => pumpQueue().catch(() => {}));

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
    drm: Boolean(entry.drm || prev?.drm || tabDrm.has(entry.tabId)),
    drmSystem: entry.drmSystem || prev?.drmSystem || tabDrm.get(entry.tabId) || '',
    playing: Boolean(entry.playing || prev?.playing || entry.source === 'playing'),
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
  tabDrm.delete(tabId);
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
    ['requestHeaders']
  )
);

function memoHeaders(d) {
  const host = hostOf(d.url);
  if (!host) return;
  const referer = headerValue(d.requestHeaders, 'referer');
  const origin = headerValue(d.requestHeaders, 'origin');
  const userAgent = headerValue(d.requestHeaders, 'user-agent');
  let cookie = headerValue(d.requestHeaders, 'cookie');
  if (!referer && !cookie) return;

  const rec = { referer, origin, userAgent, cookie };
  headerMemo.set(host, rec);
  schedulePersist();

  // MV3 tidak mendukung extraHeaders — ambil Cookie lewat chrome.cookies API.
  if (!cookie) {
    chrome.cookies
      .getAll({ url: d.url })
      .then((cookies) => {
        if (!cookies.length) return;
        const existing = headerMemo.get(host);
        if (existing && !existing.cookie) {
          existing.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          schedulePersist();
        }
      })
      .catch(() => {});
  }
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
      // FILE ditunda ke onHeadersReceived — URL .mp4 bisa jadi halaman HTML.
      if (kind === 'file') return;
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
      if (isNonMediaContentType(ct)) {
        logDiag(d.tabId, 'bukan berkas media', `${ct} — ${d.url}`);
        return;
      }
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
        console.warn('[KSP] gagal memasang aturan header:', err);
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

/** Lengkapi Cookie dari chrome.cookies bila webRequest tidak menyediakannya (MV3). */
async function headersForDownload(entry, targetUrl = entry.url) {
  const headers = headersFor(entry, targetUrl);
  if (headers.cookie) return headers;
  try {
    const cookies = await chrome.cookies.getAll({ url: targetUrl });
    if (cookies.length) {
      headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
  } catch {
    /* abaikan */
  }
  return headers;
}

async function probeDash(entry) {
  const mpdUrl = String(entry.url || '').replace(/#.*$/, '');
  const headers = await headersForDownload(entry, mpdUrl);
  const ruleId = await addHeaderRule(mpdUrl, headers);
  try {
    const text = await fetchText(mpdUrl, { retries: 2 });
    const mpd = parseMpd(text, mpdUrl);
    const warnings = [];
    if (mpd.live) warnings.push('DASH live tidak didukung.');
    if (mpd.drm) {
      warnings.push('DRM terdeteksi — unduhan dinonaktifkan.');
      entry.drm = true;
    }
    if (mpd.multiPeriod) warnings.push('MPD multi-period — hanya period pertama.');
    if (mpd.representations.some((r) => r.contentType === 'audio')) {
      warnings.push('Audio berada di track terpisah — gunakan perintah ffmpeg agar tergabung.');
    }

    const videos = mpd.representations.filter((r) => r.contentType === 'video' || r.height);
    const pool = videos.length
      ? videos
      : mpd.representations.filter((r) => r.contentType !== 'audio' && r.contentType !== 'text');
    const sorted = [...pool].sort(
      (a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0)
    );
    const variants = sorted.map((r) => ({
      url: dashVariantUrl(mpdUrl, r.id),
      label: dashLabel(r),
      bandwidth: r.bandwidth,
      resolution: r.resolution,
      size: mpd.duration && r.bandwidth ? Math.round((r.bandwidth / 8) * mpd.duration) : 0,
      estimated: true,
      hasSeparateAudio: mpd.representations.some((x) => x.contentType === 'audio'),
      segments: (r.init ? 1 : 0) + r.segments.length,
    }));
    const best = variants[0];
    if (best?.size) {
      entry.size = best.size;
      entry.estimatedSize = true;
    }
    if (best?.resolution) entry.resolution = best.resolution;
    entry.duration = mpd.duration;
    entry.probed = true;
    schedulePersist();
    return {
      ok: true,
      isMaster: variants.length > 1,
      variants,
      segments: best?.segments || 0,
      duration: mpd.duration,
      headers,
      warnings,
    };
  } finally {
    await removeHeaderRule(ruleId);
  }
}

// ------------------------------------------------------ offscreen document ---

// WXT build → offscreen.html di root; manifest langsung → src/offscreen/offscreen.html
const OFFSCREEN_PATHS = ['offscreen.html', 'src/offscreen/offscreen.html'];
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

  creatingOffscreen = (async () => {
    let lastErr;
    for (const url of OFFSCREEN_PATHS) {
      try {
        await chrome.offscreen.createDocument({
          url,
          reasons: ['BLOBS'],
          justification: 'Merakit segmen video menjadi satu berkas sebelum disimpan.',
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Tidak bisa membuat dokumen offscreen.');
  })();

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

function activeJobCount() {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running' || j.status === 'saving') n++;
  }
  return n;
}

async function pumpQueue() {
  const limit = settings.queueConcurrency || 3;
  const waiting = [...jobs.values()]
    .filter((j) => j.status === 'pending')
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const job of waiting) {
    if (activeJobCount() >= limit) break;
    job.status = 'running';
    saveJob(job);
    try {
      if (job.mode === 'direct') await startDirectDownload(job);
      else await startEngineDownload(job);
    } catch (err) {
      job.status = 'error';
      job.error = String(err?.message || err);
      saveJob(job);
      await appendHistory(job);
    }
  }
}

function pickDownloadUrl(entry, tabId) {
  if (entry.playing) return entry.url;
  const all = [...(registry.get(tabId)?.values() || [])];
  const playing = all.find((e) => e.playing && !e.drm);
  if (playing && playing.url !== entry.url) {
    if (entry.verified === false || isNonMediaContentType(entry.contentType)) return playing.url;
    const pageHost = hostOf(entry.pageUrl || '');
    if (pageHost && hostOf(entry.url) === pageHost && hostOf(playing.url) !== pageHost) return playing.url;
  }
  let isDoc = false;
  try {
    isDoc = Boolean(entry.pageUrl && new URL(entry.url).href === new URL(entry.pageUrl).href);
  } catch {
    isDoc = Boolean(entry.pageUrl && entry.url === entry.pageUrl);
  }
  if (isDoc || entry.verified === false) {
    const picked = preferPlayerMediaUrl(
      all.filter((e) => e.url !== entry.url && !e.drm && e.kind === 'file').map((e) => e.url),
      entry.pageUrl || entry.url
    );
    if (picked) return picked;
  }
  return entry.url;
}

/** Kalau URL FILE ternyata halaman HTML, ambil src video di dalamnya. */
async function unwrapPlayerPage(url) {
  try {
    const peek = await fetch(url, {
      headers: { Range: 'bytes=0-8191' },
      credentials: 'omit',
      cache: 'no-store',
    });
    const ct = peek.headers.get('content-type') || '';
    let body = await peek.text();
    if (!looksLikeHtml(ct, body)) return url;
    if (body.length >= 8000 && !/<(?:video|source)\b/i.test(body)) {
      body = await (await fetch(url, { credentials: 'omit', cache: 'no-store' })).text();
    }
    return preferPlayerMediaUrl(mediaUrlsFromPlayerHtml(body, url), url) || url;
  } catch {
    return url;
  }
}

async function startDownload({ entryId, tabId, variantUrl, label, mode, estimatedBytes }) {
  const entry = registry.get(tabId)?.get(entryId);
  if (!entry) throw new Error('Media tidak ditemukan lagi — muat ulang halaman.');
  if (entry.drm) throw new Error('Stream terlindungi DRM — tidak bisa diunduh.');

  const existing = [...jobs.values()].find(
    (j) => j.entryId === entryId && ['pending', 'running', 'saving', 'paused'].includes(j.status)
  );
  if (existing) return existing.id;

  let targetUrl = variantUrl || pickDownloadUrl(entry, tabId);
  let headers = await headersForDownload(entry, targetUrl.replace(/#rep=.*$/, ''));
  if (!variantUrl && entry.kind === 'file') {
    const ruleId = await addHeaderRule(targetUrl, headers);
    try {
      const real = await unwrapPlayerPage(targetUrl);
      if (real !== targetUrl) {
        targetUrl = real;
        headers = await headersForDownload(entry, targetUrl);
        headers.referer = headers.referer || entry.pageUrl || entry.url;
        headers.origin = headers.origin || originOf(headers.referer);
      }
    } finally {
      await removeHeaderRule(ruleId);
    }
  }
  const already = [...jobs.values()].find(
    (j) => j.url === targetUrl && ['pending', 'running', 'saving', 'paused'].includes(j.status)
  );
  if (already) return already.id;
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
    mode: mode || (entry.kind === 'file' ? 'direct' : 'engine'),
    nameBase,
    status: 'pending',
    startedAt: Date.now(),
    estimatedBytes: estimatedBytes || entry.size || 0,
    progress: { completed: 0, total: 0, bytes: 0 },
    warnings: [],
    headers,
  };
  saveJob(job);
  await pumpQueue();
  return job.id;
}

/** Jalur cepat: chrome.downloads menstream langsung ke disk (tanpa batas memori). */
async function startDirectDownload(job) {
  job.ruleId = await addHeaderRule(job.url, job.headers);
  const ext = (job.url.match(/\.([a-z0-9]{2,4})(?:$|[?#])/i)?.[1] || 'mp4').toLowerCase();
  const savedPath = downloadFilename(job.nameBase, ext);
  job.savedPath = savedPath;
  try {
    job.downloadId = await saveToDisk(job.url, savedPath);
    job.status = 'saving';
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

safe('downloads.onDeterminingFilename', () =>
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const path = resolveSavePath(item);
    if (path) {
      suggest({ filename: ensureExtension(path), conflictAction: 'uniquify' });
      return;
    }
    const ext = inferExtFromJob(item);
    const fallback = ensureExtension(item.filename || `${settings.downloadFolder}/video`, ext);
    suggest({ filename: fallback, conflictAction: 'uniquify' });
  })
);

async function settleDownloadJob(job, state, errorCurrent) {
  if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') return;
  if (state === 'complete') {
    job.status = 'done';
    const actualPath = await resolveDownloadPath(job.downloadId);
    if (actualPath) job.savedPath = actualPath;
  } else if (state === 'interrupted') {
    job.status = 'error';
    job.error = errorCurrent || 'Unduhan terputus — hapus berkas .crdownload jika ada';
  } else {
    return;
  }
  await removeHeaderRule(job.ruleId);
  clearPendingSavePath(job.blobUrl || job.url);
  if (job.blobUrl) revokeBlob(job.blobUrl);
  saveJob(job);
  await appendHistory(job);
  await pumpQueue();
}

safe('downloads.onChanged', () =>
  chrome.downloads.onChanged.addListener(async (delta) => {
    const job = [...jobs.values()].find((j) => j.downloadId === delta.id);
    if (!job) return;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      await settleDownloadJob(job, delta.state.current, delta.error?.current);
    } else if (delta.state?.current === 'paused') {
      job.status = 'paused';
      saveJob(job);
    } else if (delta.state?.current === 'in_progress' && job.status === 'paused') {
      job.status = 'running';
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
            playing: found.source === 'playing',
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

      case 'drm-detected': {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: true });
          return;
        }
        tabDrm.set(tabId, msg.keySystem || '');
        const map = registry.get(tabId);
        if (map) {
          for (const e of map.values()) {
            e.drm = true;
            e.drmSystem = msg.keySystem || e.drmSystem;
          }
          schedulePersist();
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
          if (msg.paused) job.status = 'paused';
          else if (job.status !== 'paused' && job.status !== 'saving') job.status = 'running';
          saveJob(job);
        }
        sendResponse({ ok: true });
        return;
      }
      case 'job-done': {
        const job = jobs.get(msg.id);
        if (!job) {
          sendResponse({ ok: false, error: 'job hilang' });
          return;
        }
        job.blobUrl = msg.blobUrl;
        job.warnings = msg.warnings || [];
        job.progress = { ...job.progress, bytes: msg.bytes };
        const ext = /^[a-z0-9]{2,5}$/i.test(msg.ext || '') ? msg.ext.toLowerCase() : 'mp4';
        const savedPath = downloadFilename(job.nameBase, ext);
        job.savedPath = savedPath;
        saveJob(job);
        try {
          job.downloadId = await saveBlobToDisk(msg.blobUrl, savedPath);
          let item;
          try {
            [item] = await chrome.downloads.search({ id: job.downloadId });
          } catch {
            item = null;
          }
          if (item?.state === 'complete' || item?.state === 'interrupted') {
            await settleDownloadJob(job, item.state, item.error);
          } else {
            job.status = 'saving';
          }
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
          await appendHistory(job);
          await pumpQueue();
        }
        sendResponse({ ok: true });
        return;
      }

      // -- dari popup ------------------------------------------------------
      case 'state': {
        const tabId = msg.tabId;
        const list = rankEntries([...(registry.get(tabId)?.values() || [])]);
        sendResponse({
          media: list,
          jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20),
          settings,
          history: history.slice(0, 50),
          startupErrors,
          thumb: thumbs.get(tabId) || null,
        });
        return;
      }
      case 'probe': {
        try {
          const entry = registry.get(msg.tabId)?.get(msg.entryId);
          if (!entry) throw new Error('Entri tidak ditemukan.');
          if (entry.kind === 'dash') {
            sendResponse(await probeDash(entry));
            return;
          }
          const headers = await headersForDownload(entry);
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
        const headers = await headersForDownload(entry);
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
          if (looksLikeHtml(ct, head)) {
            entry.verified = false;
            entry.verifiedAt = Date.now();
            const nested = mediaUrlsFromPlayerHtml(head, entry.url);
            for (const url of nested) {
              addEntry({
                url,
                kind: kindFromUrl(url) || 'file',
                tabId: entry.tabId,
                source: 'dom',
                pageUrl: entry.pageUrl,
                pageTitle: entry.pageTitle,
                headers: entry.headers,
              });
            }
            if (nested.length) logDiag(msg.tabId, 'halaman pemutar — URL media di dalam', nested.join(' '));
            schedulePersist();
            sendResponse({ ok: true, alive: false, kind: entry.kind, nested });
            return;
          }
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
      case 'download-all': {
        const list = rankEntries(
          [...(registry.get(msg.tabId)?.values() || [])].filter((e) => !e.drm && e.verified !== false)
        );
        const jobIds = [];
        for (const e of list) {
          try {
            jobIds.push(
              await startDownload({
                entryId: e.id,
                tabId: msg.tabId,
                mode: e.kind === 'file' ? 'direct' : 'engine',
              })
            );
          } catch {
            /* satu gagal tidak membatalkan sisanya */
          }
        }
        sendResponse({ ok: true, jobIds });
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
          await appendHistory(job);
          await pumpQueue();
        }
        sendResponse({ ok: true });
        return;
      }
      case 'pause': {
        const job = jobs.get(msg.jobId);
        if (job && (job.status === 'running' || job.status === 'saving')) {
          if (job.downloadId != null) {
            await chrome.downloads.pause(job.downloadId).catch(() => {});
            job.status = 'paused';
          } else if (job.mode === 'engine') {
            await sendToOffscreen({ target: 'offscreen', cmd: 'pause', id: job.id });
            job.status = 'paused';
          }
          saveJob(job);
        }
        await pumpQueue();
        sendResponse({ ok: true });
        return;
      }
      case 'resume': {
        const job = jobs.get(msg.jobId);
        if (job && job.status === 'paused') {
          if (job.downloadId != null) {
            await chrome.downloads.resume(job.downloadId).catch(() => {});
            job.status = job.blobUrl ? 'saving' : 'running';
          } else if (job.mode === 'engine') {
            await sendToOffscreen({ target: 'offscreen', cmd: 'resume', id: job.id });
            job.status = 'running';
          }
          saveJob(job);
        }
        sendResponse({ ok: true });
        return;
      }
      case 'show-download': {
        const job = jobs.get(msg.jobId);
        if (job?.downloadId != null) {
          await chrome.downloads.show(job.downloadId).catch(() => {});
        }
        sendResponse({ ok: true });
        return;
      }
      case 'open-file': {
        const id = await findDownloadId(msg);
        if (id != null) await chrome.downloads.open(id).catch(() => chrome.downloads.show(id).catch(() => {}));
        sendResponse({ ok: true });
        return;
      }
      case 'show-folder': {
        const id = await findDownloadId(msg);
        if (id != null) await chrome.downloads.show(id).catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      case 'clear-history': {
        history = [];
        await chrome.storage.local.set({ history: [] });
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
      case 'scan': {
        try {
          await chrome.tabs.sendMessage(msg.tabId, { cmd: 'deep-scan' });
        } catch {
          /* frame tanpa content script */
        }
        sendResponse({ ok: true });
        return;
      }
      case 'capture-thumb': {
        const playUrl = await resolvePlayUrl(msg.tabId);
        if (playUrl) {
          sendResponse({ ok: true, playUrl });
          return;
        }
        const started = Date.now();
        await pingFrames(msg.tabId, 'capture-thumb');
        let thumb = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 800) {
          const t = thumbs.get(msg.tabId);
          if (t && (t.at || 0) >= started - 80) {
            thumb = t;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!thumb) thumb = thumbs.get(msg.tabId) || (await captureTabStill(msg.tabId));
        sendResponse({ ok: true, thumb, playUrl: null });
        return;
      }
      case 'settings': {
        const patch = { ...msg.patch };
        if ('downloadFolder' in patch) {
          patch.downloadFolder = sanitizeDownloadFolder(patch.downloadFolder);
        }
        if ('askSaveLocation' in patch) {
          patch.askSaveLocation = patch.askSaveLocation === true;
        }
        settings = normalizeSettings({ ...settings, ...patch });
        await chrome.storage.local.set({ settings });
        await pumpQueue();
        sendResponse({ ok: true, settings });
        return;
      }
      case 'dashboard': {
        const browserTabs = await chrome.tabs.query({});
        const tabSummaries = [];
        for (const t of browserTabs) {
          if (t.id == null || t.id < 0) continue;
          const media = [...(registry.get(t.id)?.values() || [])].map((e) => ({
            id: e.id,
            kind: e.kind,
            url: e.url,
            verified: e.verified,
            size: e.size,
            lastSeen: e.lastSeen,
          }));
          const d = diagnostics.get(t.id);
          tabSummaries.push({
            tabId: t.id,
            title: t.title,
            url: t.url,
            mediaCount: media.length,
            media,
            diag: d
              ? {
                  responses: d.responses,
                  recorded: d.recorded,
                  reasons: d.reasons,
                  events: d.events,
                  frames: d.frames,
                  hooks: d.hooks,
                }
              : null,
          });
        }
        let offscreen = false;
        try {
          const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
          offscreen = ctx.length > 0;
        } catch {
          /* abaikan */
        }
        sendResponse({
          ok: true,
          startupErrors: [...startupErrors],
          settings: { ...settings },
          jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt),
          history: history.slice(0, 100),
          tabs: tabSummaries,
          offscreen,
        });
        return;
      }
      default:
        return;
    }
  })();

  return true; // respons asinkron
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  try {
    const local = await chrome.storage.local.get('settings');
    if (local.settings) {
      await chrome.storage.local.set({ settings: normalizeSettings(local.settings) });
      settings = normalizeSettings(local.settings);
    }
  } catch {
    /* abaikan */
  }
});

safe('commands.onCommand', () =>
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'download-primary') return;
    await ready;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return;
    const list = rankEntries(
      [...(registry.get(tab.id)?.values() || [])].filter((e) => !e.drm && e.verified !== false)
    );
    const top = list[0];
    if (!top) return;
    try {
      await startDownload({
        entryId: top.id,
        tabId: tab.id,
        mode: top.kind === 'file' ? 'direct' : 'engine',
      });
    } catch (err) {
      console.warn('[KSP] shortcut unduh:', err);
    }
  })
);
