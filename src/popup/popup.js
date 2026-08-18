import { ffmpegCommand, formatBytes, formatDuration, hostOf } from '../lib/util.js';

const $ = (sel) => document.querySelector(sel);
const previewEl = $('#preview');
const diagEl = $('#diag');
const mediaEl = $('#media');
const jobsEl = $('#jobs');
const jobsWrap = $('#jobs-wrap');

let tabId = null;
let tabUrl = '';
/** entryId -> hasil probe */
const probes = new Map();
/** entryId -> boolean */
const expanded = new Set();
let lastRender = '';

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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

let lastThumbKey = '';

function renderPreview(thumb) {
  const key = thumb ? `${thumb.from}|${thumb.at}|${thumb.dataUrl?.length || thumb.url || ''}` : '';
  if (key === lastThumbKey) return;
  lastThumbKey = key;
  previewEl.replaceChildren();

  const frame = el('div', 'preview-frame');
  const src = thumb?.dataUrl || thumb?.url;

  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Pratinjau video';
    img.addEventListener('error', () => {
      img.replaceWith(el('div', 'preview-placeholder', 'Pratinjau tidak bisa dimuat.'));
    });
    frame.append(img);
    if (thumb.duration) {
      frame.append(el('span', 'stamp', formatDuration(thumb.duration)));
    }
  } else {
    frame.append(
      el(
        'div',
        'preview-placeholder',
        'Belum ada pratinjau. Tekan Putar agar player memuat frame pertama, lalu Ambil frame.'
      )
    );
  }
  previewEl.append(frame);

  const meta = el('div', 'preview-meta');
  if (thumb?.width && thumb?.height) {
    meta.append(el('span', null, `${thumb.width}×${thumb.height}`));
  }
  if (thumb?.from) {
    meta.append(el('span', null, thumb.from === 'frame' ? 'frame langsung' : 'poster halaman'));
  }
  meta.append(el('span', 'spacer'));

  const grab = el('button', 'ghost small', 'Ambil frame');
  grab.title = 'Tangkap frame yang sedang tampil di player';
  grab.addEventListener('click', async () => {
    grab.disabled = true;
    await send({ cmd: 'capture-thumb' });
    setTimeout(() => {
      grab.disabled = false;
      lastRender = '';
      refresh();
    }, 800);
  });
  meta.append(grab);
  previewEl.append(meta);
}

function renderMedia(list) {
  mediaEl.replaceChildren();

  if (!list.length) {
    const empty = el('div', 'empty');
    empty.append(
      'Belum ada stream terdeteksi.',
      el('br'),
      'Tekan Putar untuk memicu player, atau mainkan videonya sebentar lalu buka lagi panel ini.'
    );
    mediaEl.append(empty);
    return;
  }

  for (const entry of list) {
    mediaEl.append(renderEntry(entry));
  }
}

function renderEntry(entry) {
  const item = el('div', 'item');
  item.dataset.id = entry.id;

  const head = el('div', 'item-head');
  const kindLabel = entry.kind === 'hls' ? 'HLS' : entry.kind === 'dash' ? 'DASH' : 'FILE';
  head.append(el('span', `badge ${entry.kind}`, kindLabel));
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
    const approx = entry.estimatedSize || best?.estimated || entry.kind === 'hls';
    meta.append(el('span', 'size-tag', `${approx ? '~' : ''}${formatBytes(size)}`));
  } else if (entry.kind === 'hls' && probing.has(entry.id)) {
    meta.append(el('span', null, 'mengukur…'));
  }

  const duration = probe?.duration || entry.duration;
  if (duration) meta.append(el('span', null, formatDuration(duration)));
  if (best?.resolution) meta.append(el('span', null, best.resolution.replace('x', '×')));
  if (probe?.ok && probe.segments) meta.append(el('span', null, `${probe.segments} segmen`));
  meta.append(el('span', null, entry.source === 'network' ? 'jaringan' : 'halaman'));
  if (entry.verified === true) meta.append(el('span', 'ok-tag', 'terverifikasi'));
  else if (entry.verified === false) meta.append(el('span', 'dead-tag', 'tidak merespons'));
  item.append(meta);

  const actions = el('div', 'item-actions');

  if (entry.kind === 'hls') {
    const dl = el('button', 'primary', 'Unduh');
    dl.addEventListener('click', () =>
      startDownload(entry.id, best?.url || null, best?.label || null, 'engine', best?.size)
    );
    actions.append(dl);

    const hasVariants = (probe?.variants?.length || 0) > 1;
    const q = el('button', 'ghost', hasVariants ? `Kualitas (${probe.variants.length})` : 'Cek kualitas');
    q.addEventListener('click', async () => {
      if (probes.has(entry.id)) {
        if (expanded.has(entry.id)) expanded.delete(entry.id);
        else expanded.add(entry.id);
      } else {
        q.disabled = true;
        q.textContent = 'Memeriksa…';
        probes.set(entry.id, await send({ cmd: 'probe', entryId: entry.id }));
        expanded.add(entry.id);
      }
      lastRender = '';
      refresh();
    });
    actions.append(q);
  } else if (entry.kind === 'file') {
    const dl = el('button', 'primary', 'Unduh');
    dl.addEventListener('click', () => startDownload(entry.id, null, null, 'direct'));
    actions.append(dl);

    const alt = el('button', 'ghost', 'Unduh via engine');
    alt.title = 'Pakai kalau unduhan langsung ditolak server (403)';
    alt.addEventListener('click', () => startDownload(entry.id, null, null, 'engine'));
    actions.append(alt);
  }

  const info = el('button', 'ghost', expanded.has(entry.id) ? 'Tutup' : 'Detail');
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
        const label = el('span', null, v.label);
        row.append(label);
        if (v.size) {
          row.append(el('span', 'variant-size', `${v.estimated ? '~' : ''}${formatBytes(v.size)}`));
        }
        const b = el('button', 'primary', 'Unduh');
        b.addEventListener('click', () => startDownload(entry.id, v.url, v.label, 'engine', v.size));
        row.append(b);
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
    const copy = el('button', 'ghost small', 'Salin');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(value);
      copy.textContent = 'Tersalin';
      setTimeout(() => (copy.textContent = 'Salin'), 1200);
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
  const active = list.filter((j) => j.status !== 'hidden');
  jobsWrap.classList.toggle('hidden', active.length === 0);
  jobsEl.replaceChildren();

  for (const job of active) {
    const row = el('div', 'job');
    const top = el('div', 'job-top');
    top.append(el('span', 'job-name', job.nameBase));

    const statusText = {
      running: 'mengunduh',
      saving: 'menyimpan',
      done: 'selesai',
      error: 'gagal',
      canceled: 'dibatalkan',
    }[job.status] || job.status;
    top.append(el('span', `job-status ${job.status}`, statusText));

    if (job.status === 'running' || job.status === 'saving') {
      const cancel = el('button', 'ghost small', 'Batal');
      cancel.addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'cancel', jobId: job.id }));
      top.append(cancel);
    }
    row.append(top);

    const p = job.progress || {};
    const isHls = job.kind === 'hls';
    // HLS diukur dari jumlah segmen, file progresif dari jumlah byte.
    const ratio = isHls
      ? p.total
        ? p.completed / p.total
        : 0
      : p.total
        ? p.bytes / p.total
        : 0;

    if (job.status === 'running') {
      const bar = el('div', 'progress');
      const fill = el('i');
      fill.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
      bar.append(fill);
      row.append(bar);
    }

    const metaBits = [];
    if (isHls && p.total) metaBits.push(`${p.completed}/${p.total} segmen`);
    if (p.bytes) {
      // Untuk HLS pembanding byte-nya adalah estimasi hasil probe.
      const target = isHls ? job.estimatedBytes : p.total;
      metaBits.push(
        target
          ? `${formatBytes(p.bytes)} / ${isHls ? '~' : ''}${formatBytes(target)}`
          : formatBytes(p.bytes)
      );
    }
    if (job.status === 'running') {
      metaBits.push(formatSpeed(p.bps));
      if (p.connections) metaBits.push(`${p.connections} koneksi`);
      if (p.eta) metaBits.push(`sisa ${formatDuration(p.eta)}`);
    }
    if (job.error) metaBits.push(job.error);
    if (metaBits.length) row.append(el('div', 'job-meta', metaBits.join(' · ')));

    for (const w of job.warnings || []) row.append(el('div', 'note', w));

    jobsEl.append(row);
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
    (e) => e.kind === 'hls' && !probes.has(e.id) && !probing.has(e.id) && e.verified !== false
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

/**
 * Menerjemahkan angka mentah jadi satu kalimat penyebab. Ini bagian yang
 * berguna: tahu di lapisan mana rantainya putus, bukan sekadar "gagal".
 */
export function diagnose(d, mediaCount) {
  if (!d.frames.length) {
    return {
      level: 'bad',
      text: 'Content script tidak berjalan di tab ini. Muat ulang extension di chrome://extensions, lalu refresh halamannya. Halaman chrome:// dan Web Store memang selalu diblokir.',
    };
  }
  if (!d.hooks.length) {
    return {
      level: 'bad',
      text: 'Frame terdeteksi tapi tidak ada hook yang terpasang di konteks halaman. Biasanya berarti script MAIN world ditolak — periksa error di kartu extension.',
    };
  }
  if (d.responses === 0) {
    return {
      level: 'bad',
      text: 'Tidak ada satu pun respons jaringan terpantau. Izin webRequest kemungkinan tidak aktif; periksa spanduk error di atas.',
    };
  }
  if (mediaCount === 0) {
    return {
      level: 'warn',
      text:
        d.responses +
        ' respons terpantau, tidak satu pun berbentuk media. Videonya belum diputar, atau halaman mengirim datanya lewat jalur yang tidak terlihat sebagai berkas (mis. potongan biner via MSE). Tekan Putar dulu, lalu Pindai.',
    };
  }
  const failed = (d.reasons['verifikasi gagal'] || 0) + (d.reasons['probe playlist gagal'] || 0);
  if (failed) {
    return {
      level: 'warn',
      text: 'Media ditemukan tapi server menolak permintaan kita — kemungkinan proteksi Referer/Cookie. Lihat daftar kejadian di bawah untuk kode status persisnya.',
    };
  }
  return { level: 'good', text: mediaCount + ' media siap diunduh. Rantai deteksi berjalan normal.' };
}

async function renderDiagnostics(mediaCount) {
  if (!diagOpen) {
    diagEl.replaceChildren();
    return;
  }
  const d = await send({ cmd: 'diagnostics' });
  if (!d?.ok) return;
  diagEl.replaceChildren();

  const verdict = diagnose(d, mediaCount);
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
    renderBanner('Service worker tidak merespons. Buka chrome://extensions → tombol Errors pada kartu StreamGrab.');
    return;
  }
  renderBanner(state.startupErrors?.length ? `Gagal saat start: ${state.startupErrors.join(' | ')}` : '');

  renderPreview(state.thumb);
  void verifyPending(state.media).then(() => probePending(state.media));

  const signature = JSON.stringify({
    m: state.media.map((e) => [e.id, e.size, e.kind, e.verified, e.duration]),
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
    p: [...probes.keys()],
    x: [...expanded],
  });
  if (signature === lastRender) return;
  lastRender = signature;

  renderMedia(state.media);
  renderJobs(state.jobs);
  void renderDiagnostics(state.media.length);

  const conc = $('#conc');
  if (document.activeElement !== conc) conc.value = state.settings.concurrency;
}

// ------------------------------------------------------------------ init ---

(async () => {
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
    // Beri waktu player memuat frame pertama, lalu ambil pratinjaunya.
    setTimeout(() => send({ cmd: 'capture-thumb' }), 2000);
  });

  $('#btn-clear').addEventListener('click', async () => {
    probes.clear();
    expanded.clear();
    await send({ cmd: 'clear-media' });
    lastRender = '';
    refresh();
  });

  $('#btn-clear-jobs').addEventListener('click', async () => {
    await send({ cmd: 'clear-jobs' });
    lastRender = '';
    refresh();
  });

  $('#btn-diag').addEventListener('click', () => {
    diagOpen = !diagOpen;
    $('#btn-diag').textContent = diagOpen ? 'Tutup diagnostik' : 'Diagnostik';
    lastRender = '';
    refresh();
  });

  $('#conc').addEventListener('change', (ev) => {
    const value = Math.max(1, Math.min(16, parseInt(ev.target.value, 10) || 6));
    ev.target.value = value;
    send({ cmd: 'settings', patch: { concurrency: value } });
  });

  // Minta pratinjau segar setiap kali panel dibuka.
  send({ cmd: 'capture-thumb' });

  await refresh();
  setInterval(refresh, 700);
})();
