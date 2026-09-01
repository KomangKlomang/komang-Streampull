// Halaman extension: salin blob rakitan ke chrome.downloads, lalu tetap hidup
// sampai Chrome selesai — tutup terlalu cepat = berkas .crdownload + "Can't finish".

const q = new URLSearchParams(location.search);
const blobUrl = q.get('u');
const filename = q.get('f');
const saveAs = q.get('saveAs') === '1';
const statusEl = document.getElementById('status');

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

async function notify(payload) {
  try {
    await chrome.runtime.sendMessage({ type: 'blob-save-result', ...payload });
  } catch {
    /* service worker sedang tidur */
  }
}

if (!blobUrl || !filename) {
  setStatus('Parameter simpan tidak lengkap');
  void notify({ ok: false, blobUrl: blobUrl || '', error: 'Parameter simpan tidak lengkap' });
} else {
  (async () => {
    let objectUrl = '';
    try {
      const probe = await fetch(blobUrl);
      if (!probe.ok) throw new Error(`Blob tidak terbaca (${probe.status})`);
      const blob = await probe.blob();
      if (!blob.size) throw new Error('Berkas hasil rakitan kosong');

      objectUrl = URL.createObjectURL(blob);
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs,
      });
      await notify({ ok: true, blobUrl, downloadId });
      setStatus('Menulis ke folder unduhan…');

      const finish = () => {
        chrome.downloads.onChanged.removeListener(onChanged);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        window.close();
      };

      const onChanged = (delta) => {
        if (delta.id !== downloadId) return;
        const state = delta.state?.current;
        if (state === 'complete' || state === 'interrupted') finish();
      };

      let item;
      try {
        [item] = await chrome.downloads.search({ id: downloadId });
      } catch {
        item = null;
      }
      if (item?.state === 'complete' || item?.state === 'interrupted') {
        finish();
        return;
      }
      chrome.downloads.onChanged.addListener(onChanged);
    } catch (err) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setStatus(String(err?.message || err));
      await notify({ ok: false, blobUrl, error: String(err?.message || err) });
      setTimeout(() => window.close(), 1500);
    }
  })();
}
