/** Diagnosa rantai deteksi — dipakai popup & dashboard. */

export function diagnoseTab(d, mediaCount) {
  const frames = d?.frames?.length || 0;
  const hooks = d?.hooks?.length || 0;
  const responses = d?.responses || 0;

  if (!frames) {
    return {
      level: 'bad',
      text: 'Content script tidak berjalan. Muat ulang extension, lalu refresh halaman. chrome:// dan Web Store diblokir.',
    };
  }
  if (!hooks) {
    return {
      level: 'bad',
      text: 'Frame terdeteksi tapi hook MAIN world tidak terpasang — cek Errors di chrome://extensions.',
    };
  }
  if (responses === 0) {
    return {
      level: 'bad',
      text: 'Tidak ada respons jaringan terpantau. Izin webRequest mungkin tidak aktif.',
    };
  }
  if (mediaCount === 0) {
    return {
      level: 'warn',
      text: `${responses} respons terpantau, tidak ada media. Tekan Putar lalu Pindai.`,
    };
  }
  const failed = (d.reasons?.['verifikasi gagal'] || 0) + (d.reasons?.['probe playlist gagal'] || 0);
  if (failed) {
    return {
      level: 'warn',
      text: 'Media ditemukan tapi server menolak — cek Referer/Cookie.',
    };
  }
  return { level: 'good', text: `${mediaCount} media siap diunduh.` };
}

export function buildProblems({ startupErrors, tabs, jobs }) {
  const problems = [];
  const rank = { error: 0, warn: 1, info: 2 };

  for (const err of startupErrors || []) {
    problems.push({ severity: 'error', area: 'Extension', message: err });
  }

  for (const job of jobs || []) {
    if (job.status === 'error') {
      problems.push({
        severity: 'error',
        area: 'Unduhan',
        message: job.error || 'Unduhan gagal',
        detail: job.nameBase,
      });
    }
    for (const w of job.warnings || []) {
      problems.push({ severity: 'warn', area: 'Unduhan', message: w, detail: job.nameBase });
    }
  }

  for (const tab of tabs || []) {
    const title = tab.title || tab.url || `Tab ${tab.tabId}`;
    const verdict = diagnoseTab(tab.diag, tab.mediaCount);
    if (verdict.level !== 'good') {
      problems.push({
        severity: verdict.level === 'bad' ? 'error' : 'warn',
        area: 'Tab',
        message: verdict.text,
        detail: title,
        tabId: tab.tabId,
      });
    }
    for (const m of tab.media || []) {
      if (m.verified === false) {
        problems.push({
          severity: 'warn',
          area: 'Media',
          message: 'Verifikasi gagal — server menolak',
          detail: m.url,
          tabId: tab.tabId,
        });
      }
    }
    for (const ev of (tab.diag?.events || []).slice(0, 15)) {
      problems.push({
        severity: 'info',
        area: 'Log',
        message: `${ev.reason}: ${ev.detail}`,
        detail: title,
        tabId: tab.tabId,
      });
    }
  }

  problems.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return problems;
}
