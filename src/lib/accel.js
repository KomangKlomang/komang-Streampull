// Unduhan multi-koneksi ala IDM/XDM.
//
// Inti percepatannya: banyak permintaan HTTP Range berjalan bersamaan atas satu
// file. Server video umumnya membatasi laju *per koneksi*, jadi delapan koneksi
// bisa mendekati delapan kali laju satu koneksi sampai batas jaringan tercapai.
//
// Bagian yang membuatnya lebih cepat daripada sekadar "bagi rata di awal":
// dynamic segmentation. Begitu satu koneksi selesai, ia mencuri separuh sisa
// pekerjaan milik koneksi yang paling tertinggal. Tanpa ini, satu koneksi lambat
// menahan seluruh unduhan di ekornya.

import { sleep } from './util.js';
import { AdaptiveConcurrency, SpeedMeter, etaSeconds } from './speed.js';

const MIN_CHUNK = 1 << 20; // 1 MB — di bawah ini overhead permintaan tidak sepadan

function parseTotalFromContentRange(value) {
  const m = /\/(\d+)\s*$/.exec(String(value || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Cari tahu apakah server mendukung Range dan berapa ukuran totalnya.
 * @returns {Promise<{total: number, ranged: boolean, mime: string}>}
 */
export async function probeRange(url, { signal } = {}) {
  const res = await fetch(url, {
    headers: { Range: 'bytes=0-0' },
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  try {
    if (res.status === 206) {
      const total = parseTotalFromContentRange(res.headers.get('content-range'));
      return { total, ranged: total > 0, mime };
    }
    if (res.status === 200) {
      // Server mengabaikan Range — hanya bisa satu aliran.
      const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      return { total, ranged: false, mime };
    }
    throw new Error(`HTTP ${res.status} saat memeriksa file`);
  } finally {
    // Jangan biarkan bodi probe menggantung dan memakan koneksi.
    try {
      await res.body?.cancel();
    } catch {
      /* sudah tertutup */
    }
  }
}

/**
 * @param {object} job
 * @param {string} job.url
 * @param {object} job.sink        objek dengan writeAt(pos, bytes)
 * @param {AbortSignal} [job.signal]
 * @param {number} [job.maxConnections]
 * @param {(p: object) => void} [job.onProgress]
 */
export async function downloadRanged(job) {
  const {
    url,
    sink,
    signal,
    maxConnections = 8,
    minChunkBytes = MIN_CHUNK,
    onProgress = () => {},
  } = job;

  const meter = new SpeedMeter();
  const { total, ranged } = await probeRange(url, { signal });

  let written = 0;
  let activeConnections = 0;
  let peakConnections = 0;
  let done = false;

  const report = (extra = {}) => {
    const bps = meter.bps;
    onProgress({
      bytes: written,
      total,
      bps,
      eta: etaSeconds(total - written, bps),
      // Saat unduhan sudah selesai, angka sesaat 0 tidak informatif —
      // laporkan puncak koneksi yang benar-benar terpakai.
      connections: activeConnections || peakConnections,
      peak: peakConnections,
      ranged,
      ...extra,
    });
  };

  const ticker = setInterval(report, 400);

  try {
    if (!ranged || !total) {
      // Tidak ada dukungan Range: satu aliran, tetap dilaporkan kecepatannya.
      activeConnections = 1;
      peakConnections = 1;
      report();
      await singleStream({ url, sink, signal, onBytes: (n) => {
        written += n;
        meter.add(n);
      } });
      activeConnections = 0;
      report();
      return { total: written, connections: 1, peak: 1, ranged: false };
    }

    const controller = new AdaptiveConcurrency({
      meter,
      start: Math.min(3, maxConnections),
      max: maxConnections,
    });
    controller.start();

    /** @type {Array<{start:number,pos:number,end:number}>} */
    const chunks = [];
    const initial = Math.max(1, Math.min(maxConnections, Math.floor(total / minChunkBytes) || 1));
    const span = Math.ceil(total / initial);
    for (let i = 0; i < initial; i++) {
      const start = i * span;
      if (start >= total) break;
      chunks.push({ start, pos: start, end: Math.min(total - 1, start + span - 1) });
    }

    const queue = [...chunks];
    report(); // laporan pertama langsung, jangan biarkan UI kosong 400 ms

    /** Ambil separuh sisa pekerjaan koneksi yang paling tertinggal. */
    const steal = () => {
      let victim = null;
      let biggest = 0;
      for (const c of chunks) {
        const remaining = c.end - c.pos + 1;
        if (remaining > biggest) {
          biggest = remaining;
          victim = c;
        }
      }
      if (!victim || biggest < minChunkBytes * 2) return null;
      const mid = victim.pos + Math.floor(biggest / 2);
      const fresh = { start: mid, pos: mid, end: victim.end };
      // Pemilik lama berhenti sendiri begitu pos-nya melewati end yang baru.
      victim.end = mid - 1;
      chunks.push(fresh);
      return fresh;
    };

    const allChunksDone = () => chunks.every((c) => c.pos > c.end);

    const runChunk = async (chunk) => {
      let attempt = 0;
      while (chunk.pos <= chunk.end) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const res = await fetch(url, {
            headers: { Range: `bytes=${chunk.pos}-${chunk.end}` },
            credentials: 'include',
            cache: 'no-store',
            signal: ctrl.signal,
          });
          if (res.status !== 206) {
            const err = new Error(`Rentang ditolak (HTTP ${res.status})`);
            err.status = res.status;
            throw err;
          }
          const reader = res.body.getReader();
          for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) break;
            const room = chunk.end - chunk.pos + 1;
            if (room <= 0) break;
            const data = value.byteLength > room ? value.subarray(0, room) : value;
            await sink.writeAt(chunk.pos, data);
            chunk.pos += data.byteLength;
            written += data.byteLength;
            meter.add(data.byteLength);
            if (chunk.pos > chunk.end) break; // rentang ini beres (atau dicuri)
          }
          if (chunk.pos > chunk.end) return;
          // Aliran berhenti sebelum rentang habis — ulangi dari posisi terakhir.
          throw new Error('Koneksi terputus sebelum rentang selesai');
        } catch (err) {
          if (chunk.pos > chunk.end) return; // batal karena dicuri: itu sukses
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          controller.onError(err?.status);
          if (++attempt > 5) throw err;
          await sleep(Math.min(8000, 500 * 2 ** attempt), signal);
        } finally {
          signal?.removeEventListener('abort', onAbort);
          try {
            ctrl.abort();
          } catch {
            /* abaikan */
          }
        }
      }
    };

    const pump = async () => {
      for (;;) {
        if (signal?.aborted || done) return;
        const chunk = queue.shift() || steal();
        if (!chunk) return;
        activeConnections++;
        if (activeConnections > peakConnections) peakConnections = activeConnections;
        try {
          await runChunk(chunk);
        } finally {
          activeConnections--;
        }
      }
    };

    // Koneksi ke-i baru boleh mulai setelah pengendali menaikkan target ke situ.
    const gatedPump = async (index) => {
      while (index >= controller.target) {
        if (signal?.aborted || done || (queue.length === 0 && allChunksDone())) return;
        await sleep(300, signal).catch(() => {});
      }
      return pump();
    };

    try {
      await Promise.all(
        Array.from({ length: maxConnections }, (_, i) => gatedPump(i))
      );
      done = true;
      if (!allChunksDone()) throw new Error('Sebagian rentang gagal diunduh.');
    } finally {
      done = true;
      controller.stop();
    }

    report();
    return { total, connections: chunks.length, peak: peakConnections, ranged: true };
  } finally {
    clearInterval(ticker);
  }
}

async function singleStream({ url, sink, signal, onBytes }) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} saat mengambil file.`);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    await sink.append(buf);
    onBytes(buf.byteLength);
    return;
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await sink.append(value);
    onBytes(value.byteLength);
  }
}
