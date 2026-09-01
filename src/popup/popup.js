import { diagnoseTab } from '../lib/diagnose.js';
import { ffmpegCommand, formatBytes, formatDuration, hostOf } from '../lib/util.js';
import { icon, iconBtn } from './icons.js';

const $ = (sel) => document.querySelector(sel);
const diagEl = $('#diag');
const mediaEl = $('#media');
const jobsEl = $('#jobs');
const jobsWrap = $('#jobs-wrap');
const historyEl = $('#history');
const panelMain = $('#panel-main');
const panelHistory = $('#panel-history');
const panelSettings = $('#panel-settings');

let activeTab = 'main';

let tabId = null;
let tabUrl = '';
/** entryId -> hasil probe */
const probes = new Map();
/** entryId -> boolean */
const expanded = new Set();
let lastRender = '';

function renderHistory(list) {
  historyEl.replaceChildren();
  if (!list?.length) {
    historyEl.append(el('div', 'empty', 'Belum ada riwayat unduhan.'));
    return;
  }
  for (const item of list) {
    const row = el('div', 'history-item');
    const top = el('div', 'history-top');
    const statusWrap = el('span', `history-status ${item.status}`);
    const statusIconName =
      item.status === 'done' ? 'CheckCircled' : item.status === 'error' ? 'CrossCircled' : 'Stop';
    statusWrap.append(icon(statusIconName, { size: 11 }));
    statusWrap.append(document.createTextNode(HISTORY_STATUS[item.status] || item.status));
    top.append(statusWrap);
    top.append(el('span', 'history-name', item.name));
    row.append(top);
    const bits = [];
    if (item.bytes) bits.push(formatBytes(item.bytes));
    if (item.kind) bits.push(item.kind.toUpperCase());
    if (item.path) bits.push(item.path);
    bits.push(formatWhen(item.finishedAt));
    if (item.error) bits.push(item.error);
    row.append(el('div', 'history-meta', bits.join(' · ')));
    if (item.status === 'done' && (item.downloadId != null || item.path)) {
      const actions = el('div', 'history-actions');
      const openFile = btnIcon('File', 'ghost small icon-btn', 'Buka berkas', 'Buka file');
      openFile.addEventListener('click', () =>
        send({ cmd: 'open-file', historyId: item.id, downloadId: item.downloadId, path: item.path })
      );
      const openFolder = btnIcon('Folder', 'ghost small icon-btn', 'Buka folder', 'Buka folder');
      openFolder.addEventListener('click', () =>
        send({ cmd: 'show-folder', historyId: item.id, downloadId: item.downloadId, path: item.path })
      );
      actions.append(openFile, openFolder);
      row.append(actions);
    }
    historyEl.append(row);
  }
}

function switchTab(name) {
  activeTab = name;
  for (const btn of document.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  panelMain.classList.toggle('hidden', name !== 'main');
  panelHistory.classList.toggle('hidden', name !== 'history');
  panelSettings.classList.toggle('hidden', name !== 'settings');
  $('#preview')?.classList.toggle('hidden', name !== 'main');
  lastRender = '';
  refresh();
}

function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function btnIcon(name, className, label, text) {
  return iconBtn(name, className, label, text);
}

const HISTORY_STATUS = {
  done: 'selesai',
  error: 'gagal',
  canceled: 'dibatalkan',
};

function mountLogo() {
  const box = document.querySelector('.logo-icon');
  if (!box) return;
  let img = box.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.width = 28;
    img.height = 28;
    img.alt = '';
    box.replaceChildren(img);
  }
  img.src = chrome.runtime.getURL('icons/ksp-logo.png');
}

function initChromeIcons() {
  const mount = (sel, name) => {
    const el = document.querySelector(sel);
    if (el && !el.querySelector('svg')) el.prepend(icon(name, { size: 14 }));
  };

  mount('#btn-scan', 'Update');
  mount('#btn-play', 'Play');
  mount('#btn-grab', 'Image');
  mount('#btn-clear', 'Trash');
  mount('#btn-clear-jobs', 'Trash');
  mount('#btn-clear-history', 'Trash');
  mount('#btn-diag', 'InfoCircled');
  mount('#btn-studio', 'Reader');
  document.querySelector('.jobs-head-icon')?.append(icon('Download', { size: 13 }));
  document.querySelector('.history-head-icon')?.append(icon('CounterClockwiseClock', { size: 13 }));

  const tabs = [
    ['main', 'Download', 'Unduh'],
    ['history', 'CounterClockwiseClock', 'Riwayat'],
    ['settings', 'Gear', 'Pengaturan'],
  ];
  for (const [id, ic, label] of tabs) {
    const btn = document.querySelector(`.tab[data-tab="${id}"]`);
    if (!btn || btn.dataset.ready) continue;
    btn.dataset.ready = '1';
    btn.append(icon(ic, { size: 14 }));
    btn.append(el('span', null, label));
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 42 ? `…${u.pathname.slice(-40)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

// ------------------------------------------------------------------ render ---

function formatSpeed(bps) {
  return bps > 0 ? `${formatBytes(bps)}/s` : '—';
}

let lastThumbKey = null;

function showPreview(res) {
  const video = $('#preview-player');
  const ph = $('#preview-ph');
  if (!video || !ph) return;

  const playUrl = res?.playUrl;
  const thumb = res?.thumb;
  const src = thumb?.dataUrl || thumb?.url;
  const key = playUrl || src || '';
  if (key && key === lastThumbKey) return;
  if (key) lastThumbKey = key;

  if (playUrl) {
    ph.classList.add('hidden');
    if (video.getAttribute('src') !== playUrl) video.src = playUrl;
    video.muted = true;
    const freeze = () => {
      try {
        if (video.readyState >= 2) video.pause();
      } catch {
        /* autoplay ditolak */
      }
    };
    video.addEventListener('loadeddata', freeze, { once: true });
    video.onerror = () => {
      lastThumbKey = null;
      ph.classList.remove('hidden');
    };
    video.play().then(() => setTimeout(freeze, 400)).catch(freeze);
    return;
  }

  if (src) {
    ph.classList.add('hidden');
    video.removeAttribute('src');
    video.poster = src;
    return;
  }
}

function placeholderFrame() {
  const ph = el('div', 'preview-placeholder');
  ph.append(el('p', 'preview-ph-copy', 'Klik Preview untuk memuat di KSP'));
  return ph;
}

let showAllStreams = false;
let showAllJobs = false;

function renderMedia(list) {
  mediaEl.replaceChildren();

  if (!list.length) {
    const empty = el('div', 'empty');
    empty.append('Belum ada stream terdeteksi.');
    mediaEl.append(empty);
    return;
  }

  const toolbar = el('div', 'media-toolbar');
  const all = btnIcon('Download', 'ghost small icon-btn', 'Unduh semua stream yang bisa', 'Unduh semua');
  all.addEventListener('click', async () => {
    all.disabled = true;
    const res = await send({ cmd: 'download-all' });
    if (!res?.ok) alert(`Gagal mengantrekan unduhan: ${res?.error || 'tidak diketahui'}`);
    lastRender = '';
    refresh();
  });
  toolbar.append(all);
  mediaEl.append(toolbar);

  const [primary, ...rest] = list;
  mediaEl.append(renderEntry(primary, true));
  if (!rest.length) return;
  if (showAllStreams) {
    for (const entry of rest) mediaEl.append(renderEntry(entry, false));
    return;
  }
  const more = btnIcon(
    'ChevronDown',
    'ghost small icon-btn more-streams',
    'Tampilkan stream lain',
    `${rest.length} stream lain terdeteksi`
  );
  more.addEventListener('click', () => {
    showAllStreams = true;
    lastRender = '';
    refresh();
  });
  mediaEl.append(more);
}

function renderEntry(entry, primary = false) {
  const item = el('div', primary ? 'item primary' : 'item');
  item.dataset.id = entry.id;
  item.dataset.kind = entry.kind;

  const head = el('div', 'item-head');
  const kindLabel = entry.kind === 'hls' ? 'HLS' : entry.kind === 'dash' ? 'DASH' : 'FILE';
  const kindIcon = entry.kind === 'hls' ? 'Video' : entry.kind === 'dash' ? 'Layers' : 'File';
  const badge = el('span', `badge ${entry.kind} badge-with-icon`);
  badge.append(icon(kindIcon, { size: 11 }));
  badge.append(document.createTextNode(kindLabel));
  head.append(badge);
  if (entry.drm) {
    const drm = el('span', 'badge drm badge-with-icon');
    drm.append(icon('CrossCircled', { size: 11 }));
    drm.append(document.createTextNode('DRM'));
    drm.title = entry.drmSystem ? `Terlindungi ${entry.drmSystem}` : 'Terlindungi DRM — tidak bisa diunduh';
    head.append(drm);
  }
  const title = el('span', 'item-title', shortUrl(entry.url));
  title.title = entry.url;
  head.append(title);
  item.append(head);

  const meta = el('div', 'item-meta');
  meta.append(el('span', null, hostOf(entry.url)));

  const probe = probes.get(entry.id);
  const best = probe?.ok ? probe.variants?.[0] : null;
  const size = best?.size || entry.size;
  if (size) {
    // HLS tidak punya Content-Length; angkanya hasil pengukuran sampel segmen.
    const approx = entry.estimatedSize || best?.estimated || entry.kind === 'hls' || entry.kind === 'dash';
    meta.append(el('span', 'size-tag', `${approx ? '~' : ''}${formatBytes(size)}`));
  } else if ((entry.kind === 'hls' || entry.kind === 'dash') && probing.has(entry.id)) {
    meta.append(el('span', null, 'mengukur…'));
  }

  const duration = probe?.duration || entry.duration;
  if (duration) meta.append(el('span', null, formatDuration(duration)));
  if (best?.resolution) meta.append(el('span', null, best.resolution.replace('x', '×')));
  if (probe?.ok && probe.segments) meta.append(el('span', null, `${probe.segments} segmen`));
  meta.append(el('span', null, entry.source === 'network' ? 'jaringan' : 'halaman'));
  if (entry.verified === true) {
    const ok = el('span', 'ok-tag status-inline');
    ok.append(icon('CheckCircled', { size: 11 }));
    ok.append(document.createTextNode('terverifikasi'));
    meta.append(ok);
  } else if (entry.verified === false) {
    const dead = el('span', 'dead-tag status-inline');
    dead.append(icon('CrossCircled', { size: 11 }));
    dead.append(document.createTextNode('tidak merespons'));
    meta.append(dead);
  }
  item.append(meta);

  const actions = el('div', 'item-actions');

  if (entry.drm) {
    const blocked = btnIcon('CrossCircled', 'ghost icon-btn', 'DRM — tidak bisa diunduh', 'DRM');
    blocked.disabled = true;
    actions.append(blocked);
  } else if (entry.kind === 'hls' || entry.kind === 'dash') {
    const dl = btnIcon(
      'Download',
      'primary icon-btn',
      'Unduh kualitas terbaik',
      primary ? 'Unduh terbaik' : 'Unduh'
    );
    dl.addEventListener('click', () =>
      startDownload(entry.id, best?.url || null, best?.label || null, 'engine', best?.size)
    );
    actions.append(dl);

    const hasVariants = (probe?.variants?.length || 0) > 1;
    const q = btnIcon(
      'MixerHorizontal',
      'ghost icon-btn',
      'Cek kualitas stream',
      hasVariants ? `Kualitas (${probe.variants.length})` : 'Kualitas'
    );
    q.addEventListener('click', async () => {
      if (probes.has(entry.id)) {
        if (expanded.has(entry.id)) expanded.delete(entry.id);
        else expanded.add(entry.id);
      } else {
        q.disabled = true;
        const lbl = q.querySelector('span');
        if (lbl) lbl.textContent = 'Memeriksa…';
        probes.set(entry.id, await send({ cmd: 'probe', entryId: entry.id }));
        expanded.add(entry.id);
      }
      lastRender = '';
      refresh();
    });
    actions.append(q);
  } else if (entry.kind === 'file') {
    const dl = btnIcon('Download', 'primary icon-btn', 'Unduh file', 'Unduh');
    dl.addEventListener('click', () => startDownload(entry.id, null, null, 'direct'));
    actions.append(dl);

    const alt = btnIcon('Enter', 'ghost icon-btn', 'Unduh via engine jika ditolak server', 'Via engine');
    alt.addEventListener('click', () => startDownload(entry.id, null, null, 'engine'));
    actions.append(alt);
  }

  const info = btnIcon(
    expanded.has(entry.id) ? 'ChevronUp' : 'ChevronDown',
    'ghost icon-btn',
    expanded.has(entry.id) ? 'Tutup detail' : 'Lihat detail',
    expanded.has(entry.id) ? 'Tutup' : 'Detail'
  );
  info.addEventListener('click', () => {
    if (expanded.has(entry.id)) expanded.delete(entry.id);
    else expanded.add(entry.id);
    lastRender = '';
    refresh();
  });
  actions.append(info);

  item.append(actions);

  if (probe && !probe.ok) {
    item.append(el('div', 'note', `Gagal membaca playlist: ${probe.error}`));
  }

  if (probe?.ok) {
    for (const w of probe.warnings || []) item.append(el('div', 'note', w));
    if (probe.variants?.length && expanded.has(entry.id)) {
      const box = el('div', 'variants');
      for (const v of probe.variants) {
        const row = el('div', 'variant');
        row.append(el('span', 'quality-label', v.label));
        if (v.size) {
          row.append(el('span', 'variant-size', `${v.estimated ? '~' : ''}${formatBytes(v.size)}`));
        }
        row.title = `Unduh ${v.label}`;
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        const go = () => startDownload(entry.id, v.url, v.label, 'engine', v.size);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            go();
          }
        });
        box.append(row);
      }
      item.append(box);
    }
  }

  if (expanded.has(entry.id)) {
    item.append(renderDetail(entry, probe));
  }

  return item;
}

function renderDetail(entry, probe) {
  const box = el('div', 'detail');

  const addField = (label, value) => {
    const row = el('div', 'row');
    row.append(el('label', null, label));
    const ta = el('textarea');
    ta.readOnly = true;
    ta.value = value;
    ta.addEventListener('focus', () => ta.select());
    row.append(ta);
    const copy = btnIcon('Copy', 'ghost small icon-btn', 'Salin ke clipboard', 'Salin');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(value);
      const span = copy.querySelector('span');
      if (span) span.textContent = 'Tersalin';
      setTimeout(() => {
        if (span) span.textContent = 'Salin';
      }, 1200);
    });
    row.append(copy);
    box.append(row);
  };

  addField('URL', entry.url);

  const headers = probe?.headers || entry.headers || {};
  if (headers.referer) addField('Referer', headers.referer);

  addField(
    'Perintah ffmpeg',
    ffmpegCommand({
      url: entry.url,
      referer: headers.referer,
      userAgent: headers.userAgent,
      out: 'output.mp4',
    })
  );

  return box;
}

function renderJobs(list) {
  const active = list.filter((j) => !['hidden', 'done', 'error', 'canceled'].includes(j.status));
  jobsWrap.classList.remove('hidden');
  jobsWrap.classList.toggle('is-empty', active.length === 0);
  jobsEl.replaceChildren();

  if (active.length === 0) {
    jobsEl.append(el('p', 'jobs-empty', 'Buruan download'));
    return;
  }

  const visible = showAllJobs ? active : active.slice(0, 2);

  for (const job of visible) {
    const row = el('div', 'job');
    const top = el('div', 'job-top');
    top.append(el('span', 'job-name', job.nameBase));

    const statusText = {
      pending: 'antrean',
      running: 'mengunduh',
      saving: 'menyimpan',
      paused: 'dijeda',
      done: 'selesai',
      error: 'gagal',
      canceled: 'dibatalkan',
    }[job.status] || job.status;
    top.append(el('span', `job-status ${job.status}`, statusText));

    const actions = el('div', 'job-actions');
    if (job.status === 'running' || (job.status === 'saving' && job.downloadId != null)) {
      const pauseBtn = btnIcon('Pause', 'ghost small icon-btn', 'Jeda unduhan', 'Jeda');
      pauseBtn.addEventListener('click', () => send({ cmd: 'pause', jobId: job.id }));
      actions.append(pauseBtn);
    }
    if (job.status === 'paused') {
      const resumeBtn = btnIcon('Resume', 'ghost small icon-btn', 'Lanjutkan unduhan', 'Lanjut');
      resumeBtn.addEventListener('click', () => send({ cmd: 'resume', jobId: job.id }));
      actions.append(resumeBtn);
    }
    if (job.status === 'running' || job.status === 'saving' || job.status === 'paused') {
      const cancel = btnIcon('Cross2', 'ghost small icon-btn', 'Batalkan unduhan', 'Batal');
      cancel.addEventListener('click', () => send({ cmd: 'cancel', jobId: job.id }));
      actions.append(cancel);
    }
    top.append(actions);
    row.append(top);

    const p = job.progress || {};
    const isSeg = job.kind === 'hls' || job.kind === 'dash';
    const ratio = isSeg
      ? p.total
        ? p.completed / p.total
        : 0
      : p.total
        ? p.bytes / p.total
        : 0;

    if (job.status === 'running' || job.status === 'paused') {
      const bar = el('div', `progress${job.status === 'paused' ? ' paused' : ''}`);
      const fill = el('i');
      fill.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
      bar.append(fill);
      row.append(bar);
    }

    const metaBits = [];
    if (isSeg && p.total) metaBits.push(`${p.completed}/${p.total} segmen`);
    if (p.bytes) {
      const target = isSeg ? job.estimatedBytes : p.total;
      metaBits.push(
        target
          ? `${formatBytes(p.bytes)} / ${isSeg ? '~' : ''}${formatBytes(target)}`
          : formatBytes(p.bytes)
      );
    }
    if (job.status === 'running') {
      metaBits.push(formatSpeed(p.bps));
      if (p.connections) metaBits.push(`${p.connections} koneksi`);
      if (p.eta) metaBits.push(`sisa ${formatDuration(p.eta)}`);
    } else if (job.status === 'paused') {
      metaBits.push('dijeda');
    }
    if (job.error) metaBits.push(job.error);
    if (job.status === 'done' && job.savedPath) {
      metaBits.push(`simpan: ${job.savedPath}`);
    }
    if (metaBits.length) row.append(el('div', 'job-meta', metaBits.join(' · ')));

    if (job.status === 'done' && job.savedPath) {
      const pathRow = el('div', 'job-path', job.savedPath);
      const openBtn = btnIcon('Enter', 'ghost small icon-btn', 'Buka berkas di folder', 'Buka');
      openBtn.addEventListener('click', () => send({ cmd: 'show-download', jobId: job.id }));
      pathRow.append(openBtn);
      row.append(pathRow);
    }

    for (const w of job.warnings || []) row.append(el('div', 'note', w));

    jobsEl.append(row);
  }

  if (active.length > 2) {
    const extra = active.length - 2;
    const more = el('button', 'ghost jobs-more', showAllJobs ? 'Tampilkan lebih sedikit' : `Muat lebih banyak (${extra})`);
    more.type = 'button';
    more.addEventListener('click', () => {
      showAllJobs = !showAllJobs;
      lastRender = '';
      refresh();
    });
    jobsEl.append(more);
  }
}

// ------------------------------------------------------------------ aksi ---

const verifying = new Set();
const probing = new Set();

/**
 * HLS tidak membawa ukuran di header mana pun, jadi kita ukur sendiri begitu
 * panel dibuka — hasilnya tampil seperti situs yang menyajikan MP4 biasa.
 */
async function probePending(media) {
  const pending = media.filter(
    (e) => (e.kind === 'hls' || e.kind === 'dash') && !probes.has(e.id) && !probing.has(e.id) && e.verified !== false
  );
  for (const entry of pending.slice(0, 3)) {
    probing.add(entry.id);
    lastRender = '';
    try {
      probes.set(entry.id, await send({ cmd: 'probe', entryId: entry.id }));
    } catch {
      /* dicoba lagi di siklus berikutnya */
      probes.delete(entry.id);
    } finally {
      probing.delete(entry.id);
    }
    lastRender = '';
  }
}

/**
 * URL hasil pemindaian halaman belum tentu hidup — cek satu per satu, pelan,
 * supaya tidak membanjiri server dengan permintaan bersamaan.
 */
async function verifyPending(media) {
  const pending = media.filter(
    (e) => e.source !== 'network' && e.verified === undefined && !verifying.has(e.id)
  );
  for (const entry of pending.slice(0, 6)) {
    verifying.add(entry.id);
    try {
      await send({ cmd: 'verify', entryId: entry.id });
    } catch {
      /* service worker sibuk; dicoba lagi di siklus berikutnya */
    } finally {
      verifying.delete(entry.id);
    }
    lastRender = '';
  }
}

let diagOpen = false;

async function renderDiagnostics(mediaCount) {
  if (!diagOpen) {
    diagEl.replaceChildren();
    return;
  }
  const d = await send({ cmd: 'diagnostics' });
  if (!d?.ok) return;
  diagEl.replaceChildren();

  const verdict = diagnoseTab(d, mediaCount);
  diagEl.append(el('div', 'diag-verdict ' + verdict.level, verdict.text));

  const rows = [
    ['Frame dengan content script', d.frames.length],
    ['Hook aktif di halaman', d.hooks.length ? d.hooks.join(', ') : 'tidak ada'],
    ['Respons jaringan terpantau', d.responses],
    ['Media tercatat', mediaCount],
    ['Host dengan header tersimpan', d.headerHosts.length],
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'diag-row');
    row.append(el('span', null, k));
    row.append(el('b', null, String(v)));
    diagEl.append(row);
  }

  if (d.frames.length) {
    diagEl.append(el('h3', null, 'Frame'));
    const box = el('div', 'diag-list');
    for (const f of d.frames) {
      box.append(el('div', null, (f.isTop ? '[utama] ' : '[iframe] ') + (f.url || '(kosong)')));
    }
    diagEl.append(box);
  }

  if (d.events.length) {
    diagEl.append(el('h3', null, 'Yang dilewati / gagal'));
    const box = el('div', 'diag-list');
    for (const ev of d.events.slice(0, 25)) {
      box.append(el('div', null, ev.reason + ': ' + ev.detail));
    }
    diagEl.append(box);
  }
}

async function startDownload(entryId, variantUrl, label, mode, estimatedBytes) {
  const res = await send({ cmd: 'download', entryId, variantUrl, label, mode, estimatedBytes });
  if (!res?.ok) {
    alert(`Gagal memulai unduhan: ${res?.error || 'tidak diketahui'}`);
  }
  lastRender = '';
  refresh();
}

function renderBanner(text) {
  let bar = document.getElementById('banner');
  if (!text) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = el('div', 'banner');
    bar.id = 'banner';
    document.body.insertBefore(bar, mediaEl);
  }
  bar.textContent = text;
}

async function refresh() {
  if (tabId == null) return;

  let state;
  try {
    state = await send({ cmd: 'state' });
  } catch (err) {
    renderBanner(`Service worker tidak merespons: ${err?.message || err}. Buka chrome://extensions → Errors.`);
    return;
  }
  if (!state) {
    renderBanner('Service worker tidak merespons. Buka chrome://extensions → tombol Errors pada kartu Komang-streampull.');
    return;
  }
  renderBanner(state.startupErrors?.length ? `Gagal saat start: ${state.startupErrors.join(' | ')}` : '');

  const pill = $('#found-pill');
  if (pill) {
    pill.classList.toggle('hidden', !state.media.length);
    pill.textContent = `${state.media.length} found`;
  }
  const foot = $('#save-foot');
  if (foot) foot.textContent = `Auto-save → ${state.settings.downloadFolder || 'KSP'}/`;

  if (!$('#preview-player')?.getAttribute('src')) showPreview({ thumb: state.thumb });
  void verifyPending(state.media).then(() => probePending(state.media));

  const signature = JSON.stringify({
    t: activeTab,
    m: state.media.map((e) => [e.id, e.size, e.kind, e.verified, e.duration, e.drm, e.rankScore]),
    b: [...probing],
    d: diagOpen,
    j: state.jobs.map((j) => [
      j.id,
      j.status,
      j.progress?.completed,
      j.progress?.bytes,
      Math.round((j.progress?.bps || 0) / 65536),
      j.progress?.connections,
    ]),
    h: (state.history || []).map((x) => [x.id, x.status, x.finishedAt]),
    s: [state.settings.downloadFolder, state.settings.askSaveLocation, state.settings.concurrency, state.settings.queueConcurrency],
    p: [...probes.keys()],
    x: [...expanded],
    a: showAllStreams,
    aj: showAllJobs,
  });
  if (signature === lastRender) return;
  lastRender = signature;

  renderJobs(state.jobs);

  if (activeTab === 'main') {
    renderMedia(state.media);
    void renderDiagnostics(state.media.length);
  } else if (activeTab === 'history') {
    renderHistory(state.history);
  } else if (activeTab === 'settings') {
    applySettings(state.settings);
  }
}

function applySettings(s) {
  const folder = $('#set-folder');
  const ask = $('#set-ask-save');
  const conc = $('#conc');
  const queueConc = $('#queue-conc');
  const hint = $('#save-hint');
  if (document.activeElement !== folder) folder.value = s.downloadFolder || 'KSP';
  if (document.activeElement !== ask) ask.checked = s.askSaveLocation === true;
  if (document.activeElement !== conc) conc.value = s.concurrency;
  if (queueConc && document.activeElement !== queueConc) queueConc.value = s.queueConcurrency || 3;
  if (hint) {
    const folder = s.downloadFolder || 'KSP';
    hint.classList.toggle('warn', s.askSaveLocation === true);
    hint.textContent =
      s.askSaveLocation === true
        ? `Dialog simpan selalu muncul; lokasi awal: ${folder}/`
        : `Unduhan dirakit di extension, lalu disimpan otomatis ke ${folder}/`;
  }
}

function saveSettings(patch) {
  send({ cmd: 'settings', patch });
}

// ------------------------------------------------------------------ init ---

(async () => {
  try {
    initChromeIcons();
    mountLogo();
  } catch (err) {
    console.error('[KSP popup]', err);
    const box = el('div', 'banner err');
    box.textContent = `UI gagal init: ${err?.message || err}`;
    document.body.prepend(box);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  tabUrl = tab?.url || '';
  $('#page-host').textContent = tabUrl ? shortUrl(tabUrl) : '';

  $('#btn-scan').addEventListener('click', async () => {
    await send({ cmd: 'scan' });
    setTimeout(() => {
      lastRender = '';
      refresh();
    }, 900);
  });

  $('#btn-play').addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tabId, { cmd: 'force-play' });
    } catch {
      /* frame tanpa content script */
    }
  });

  $('#btn-grab')?.addEventListener('click', async () => {
    const grab = $('#btn-grab');
    grab.disabled = true;
    try {
      const res = await send({ cmd: 'capture-thumb' });
      lastThumbKey = null;
      showPreview(res);
      lastRender = '';
      await refresh();
    } catch {
      lastThumbKey = null;
      lastRender = '';
      await refresh();
    } finally {
      grab.disabled = false;
    }
  });

  $('#btn-clear').addEventListener('click', async () => {
    probes.clear();
    expanded.clear();
    showAllStreams = false;
    await send({ cmd: 'clear-media' });
    lastRender = '';
    refresh();
  });

  $('#btn-clear-jobs').addEventListener('click', async () => {
    await send({ cmd: 'clear-jobs' });
    lastRender = '';
    refresh();
  });

  $('#btn-clear-history').addEventListener('click', async () => {
    if (!confirm('Hapus semua riwayat unduhan?')) return;
    await send({ cmd: 'clear-history' });
    lastRender = '';
    refresh();
  });

  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  $('#set-folder').addEventListener('change', (ev) => {
    saveSettings({ downloadFolder: ev.target.value.trim() || 'KSP' });
  });

  $('#set-ask-save').addEventListener('change', (ev) => {
    saveSettings({ askSaveLocation: ev.target.checked });
  });

  $('#conc').addEventListener('change', (ev) => {
    const value = Math.max(1, Math.min(16, parseInt(ev.target.value, 10) || 6));
    ev.target.value = value;
    saveSettings({ concurrency: value });
  });

  $('#queue-conc')?.addEventListener('change', (ev) => {
    const value = Math.max(1, Math.min(5, parseInt(ev.target.value, 10) || 3));
    ev.target.value = value;
    saveSettings({ queueConcurrency: value });
  });

  $('#btn-studio').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('#btn-diag').addEventListener('click', () => {
    diagOpen = !diagOpen;
    const btn = $('#btn-diag');
    btn.title = diagOpen ? 'Tutup diagnostik' : 'Diagnostik';
    btn.setAttribute('aria-label', btn.title);
    lastRender = '';
    refresh();
  });

  $('#btn-github')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    chrome.tabs.create({ url: 'https://github.com/KomangKlomang' });
  });

  // Minta pratinjau segar setiap kali panel dibuka.
  send({ cmd: 'capture-thumb' }).then((res) => {
    lastThumbKey = null;
    showPreview(res);
  });

  await refresh();
  setInterval(refresh, 700);
})();
