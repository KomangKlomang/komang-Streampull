import { buildProblems, diagnoseTab } from '../lib/diagnose.js';
import { formatBytes } from '../lib/util.js';

const $ = (s) => document.querySelector(s);

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function switchPanel(name) {
  for (const btn of document.querySelectorAll('.nav')) {
    btn.classList.toggle('active', btn.dataset.panel === name);
  }
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.id === `panel-${name}`);
  }
}

function renderProblems(problems) {
  const root = $('#problems');
  $('#problems-count').textContent = problems.length
    ? `${problems.filter((p) => p.severity === 'error').length} error · ${problems.filter((p) => p.severity === 'warn').length} warn`
    : 'Tidak ada masalah';

  root.replaceChildren();
  if (!problems.length) {
    root.append(el('div', 'empty', 'Semua sistem normal. Tidak ada yang perlu diperbaiki.'));
    return;
  }
  for (const p of problems) {
    const row = el('div', `problem ${p.severity}`);
    row.append(el('span', 'sev', p.severity));
    row.append(el('span', 'area', p.area));
    const body = el('div');
    body.append(el('div', 'msg', p.message));
    if (p.detail) body.append(el('div', 'detail', p.detail));
    row.append(body);
    root.append(row);
  }
}

function renderJobs(jobs) {
  const root = $('#jobs');
  root.replaceChildren();
  if (!jobs.length) {
    root.append(el('div', 'empty', 'Belum ada unduhan.'));
    return;
  }
  const table = el('table');
  table.innerHTML =
    '<thead><tr><th>Nama</th><th>Status</th><th>Progres</th><th>Path</th><th>Error</th></tr></thead>';
  const tb = el('tbody');
  for (const j of jobs) {
    const tr = el('tr');
    const p = j.progress || {};
    const prog =
      j.kind === 'hls' && p.total
        ? `${p.completed || 0}/${p.total} segmen`
        : p.bytes
          ? formatBytes(p.bytes)
          : '—';
    tr.innerHTML = `<td>${esc(j.nameBase)}</td><td>${esc(j.status)}</td><td>${esc(prog)}</td><td>${esc(j.savedPath || '—')}</td><td>${esc(j.error || '—')}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  root.append(table);
}

function renderTabs(tabs) {
  const root = $('#tabs');
  root.replaceChildren();
  if (!tabs.length) {
    root.append(el('div', 'empty', 'Tidak ada tab browser.'));
    return;
  }
  for (const tab of tabs) {
    const card = el('div', 'tab-card');
    const head = el('div', 'tab-card-head');
    const verdict = diagnoseTab(tab.diag, tab.mediaCount);
    head.append(el('strong', null, tab.title || '(tanpa judul)'));
    head.append(el('span', `pill ${verdict.level === 'good' ? 'ok' : verdict.level}`, verdict.level));
    card.append(head);
    const body = el('div', 'tab-card-body');
    body.append(el('div', 'muted', tab.url || ''));
    body.append(el('div', 'muted', `${tab.mediaCount} media · ${tab.diag?.responses || 0} respons`));
    if (!tab.media.length) {
      body.append(el('div', 'media-row', '— tidak ada media —'));
    } else {
      for (const m of tab.media) {
        const row = el('div', 'media-row');
        const flag = m.verified === true ? '✓' : m.verified === false ? '✗' : '?';
        row.textContent = `[${flag}] ${m.kind?.toUpperCase() || '?'} · ${m.url}`;
        body.append(row);
      }
    }
    card.append(body);
    root.append(card);
  }
}

function renderHistory(history) {
  const root = $('#history');
  root.replaceChildren();
  if (!history.length) {
    root.append(el('div', 'empty', 'Belum ada riwayat.'));
    return;
  }
  const table = el('table');
  table.innerHTML = '<thead><tr><th>Status</th><th>Nama</th><th>Bytes</th><th>Path</th><th>Waktu</th></tr></thead>';
  const tb = el('tbody');
  for (const h of history) {
    const tr = el('tr');
    tr.innerHTML = `<td>${esc(h.status)}</td><td>${esc(h.name)}</td><td>${esc(formatBytes(h.bytes))}</td><td>${esc(h.path || '—')}</td><td>${esc(fmtTime(h.finishedAt))}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  root.append(table);
}

function renderSettings(s) {
  const root = $('#settings');
  root.replaceChildren();
  const rows = [
    ['Folder simpan', s.downloadFolder || 'StreamGrab'],
    ['Dialog simpan', s.askSaveLocation ? 'Ya' : 'Tidak (otomatis)'],
    ['Koneksi paralel', String(s.concurrency)],
    ['Min file size', formatBytes(s.minFileSize)],
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'kv');
    row.append(el('span', null, k));
    row.append(el('span', null, v));
    root.append(row);
  }
  root.append(
    el('p', 'muted', 'Ubah pengaturan lewat popup extension (tab Pengaturan) atau reload halaman ini setelah mengubah.')
  );
}

function renderSystem(data) {
  const root = $('#system');
  root.replaceChildren();
  const rows = [
    ['Offscreen worker', data.offscreen ? 'Aktif' : 'Tidak berjalan'],
    ['Job aktif', String(data.jobs.filter((j) => !['done', 'error', 'canceled', 'hidden'].includes(j.status)).length)],
    ['Tab terpantau', String(data.tabs.length)],
    ['Startup errors', String(data.startupErrors.length)],
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'kv');
    row.append(el('span', null, k));
    row.append(el('span', null, v));
    root.append(row);
  }
  if (data.startupErrors.length) {
    for (const e of data.startupErrors) {
      const row = el('div', 'kv');
      row.style.borderColor = 'var(--err)';
      row.append(el('span', null, 'Error'));
      row.append(el('span', null, e));
      root.append(row);
    }
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('id-ID');
}

function setStatusPill(problems) {
  const pill = $('#status-pill');
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warns = problems.filter((p) => p.severity === 'warn').length;
  pill.classList.remove('ok', 'warn', 'bad');
  if (errors) {
    pill.className = 'pill bad';
    pill.textContent = `${errors} error`;
  } else if (warns) {
    pill.className = 'pill warn';
    pill.textContent = `${warns} peringatan`;
  } else {
    pill.className = 'pill ok';
    pill.textContent = 'Sehat';
  }
}

async function refresh() {
  const data = await send({ cmd: 'dashboard' });
  if (!data?.ok) return;

  const problems = buildProblems(data);
  setStatusPill(problems);
  renderProblems(problems);
  renderJobs(data.jobs);
  renderTabs(data.tabs);
  renderHistory(data.history);
  renderSettings(data.settings);
  renderSystem(data);
  $('#last-sync').textContent = `Terakhir sync: ${new Date().toLocaleTimeString('id-ID')}`;
}

for (const btn of document.querySelectorAll('.nav')) {
  btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
}

$('#btn-refresh').addEventListener('click', () => refresh());
$('#btn-popup').addEventListener('click', () => chrome.action.openPopup?.().catch(() => {}));
$('#btn-ext').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/?errors=' + chrome.runtime.id });
});

await refresh();
setInterval(refresh, 2000);
