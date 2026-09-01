// Offscreen document: menjalankan unduhan yang berumur panjang.
// Service worker boleh mati; dokumen ini tetap hidup sampai job selesai.

import { downloadDash, downloadFile, downloadHls } from '../lib/downloader.js';
import { sweepOpfs } from '../lib/sink.js';
import { createPauseGate } from '../lib/util.js';

void sweepOpfs().then((n) => {
  if (n) console.info('[KSP] membersihkan', n, 'berkas sementara');
});

/** @type {Map<string, { ctrl: AbortController, pause: ReturnType<typeof createPauseGate> }>} */
const running = new Map();
/** blobUrl -> pembersih file sementara OPFS */
const cleanups = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.cmd === 'run') {
    void run(msg.job);
  } else if (msg.cmd === 'cancel') {
    running.get(msg.id)?.ctrl.abort();
    running.delete(msg.id);
  } else if (msg.cmd === 'pause') {
    running.get(msg.id)?.pause.pause();
  } else if (msg.cmd === 'resume') {
    running.get(msg.id)?.pause.resume();
  } else if (msg.cmd === 'revoke') {
    try {
      URL.revokeObjectURL(msg.blobUrl);
    } catch {
      /* sudah dilepas */
    }
    const cleanup = cleanups.get(msg.blobUrl);
    cleanups.delete(msg.blobUrl);
    void cleanup?.();
  }
});

function send(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    /* service worker sedang tidur */
  });
}

async function run(job) {
  const ctrl = new AbortController();
  const pause = createPauseGate();
  running.set(job.id, { ctrl, pause });

  let lastTick = 0;
  const onProgress = (progress) => {
    const now = Date.now();
    if (now - lastTick < 350) return;
    lastTick = now;
    send({ type: 'job-progress', id: job.id, progress, paused: pause.paused });
  };

  try {
    const runner = job.kind === 'hls' ? downloadHls : job.kind === 'dash' ? downloadDash : downloadFile;
    const { blob, ext, warnings, cleanup } = await runner({
      url: job.url,
      concurrency: job.concurrency,
      signal: ctrl.signal,
      onProgress,
      pauseGate: pause,
    });

    const blobUrl = URL.createObjectURL(blob);
    if (cleanup) cleanups.set(blobUrl, cleanup);
    send({
      type: 'job-done',
      id: job.id,
      blobUrl,
      ext,
      bytes: blob.size,
      warnings,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    send({
      type: 'job-error',
      id: job.id,
      aborted,
      error: aborted ? 'Dibatalkan' : String(err?.message || err),
    });
  } finally {
    running.delete(job.id);
  }
}
