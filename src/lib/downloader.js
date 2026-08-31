// Mesin unduhan: HLS (segmen paralel adaptif + AES-128) dan file progresif
// (multi-koneksi Range ala IDM). Berjalan di offscreen document.

import { downloadRanged } from './accel.js';
import { parseM3U8, sortVariants } from './m3u8.js';
import { fetchBytes, fetchText } from './net.js';
import { createSink } from './sink.js';
import { AdaptiveConcurrency, SpeedMeter, etaSeconds } from './speed.js';
import { createPauseGate, hexToBytes, pathExt, sleep } from './util.js';

// ---------------------------------------------------------------- AES-128 ---

const keyCache = new Map();

async function loadKey(url, opts) {
  if (keyCache.has(url)) return keyCache.get(url);
  const promise = (async () => {
    const raw = await fetchBytes(url, opts);
    if (raw.byteLength !== 16) {
      throw new Error(`Panjang kunci AES tidak valid (${raw.byteLength} byte)`);
    }
    return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt', 'encrypt']);
  })();
  keyCache.set(url, promise);
  return promise;
}

function ivForSegment(seg) {
  if (seg.key?.iv) return hexToBytes(seg.key.iv);
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seg.seq >>> 0, false);
  return iv;
}

/**
 * WebCrypto AES-CBC selalu menuntut padding PKCS#7. Sebagian encoder HLS
 * mengirim ciphertext tanpa padding, jadi kalau decrypt gagal kita tempelkan
 * satu blok padding sintetis: E(K, lastBlock XOR 0x10*16).
 */
async function aesDecrypt(data, key, iv) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data));
  } catch {
    if (data.byteLength < 16 || data.byteLength % 16 !== 0) throw new Error('Dekripsi AES-128 gagal');
    const last = data.subarray(data.byteLength - 16);
    const xored = new Uint8Array(16);
    for (let i = 0; i < 16; i++) xored[i] = last[i] ^ 0x10;
    const enc = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, xored)
    );
    const padded = new Uint8Array(data.byteLength + 16);
    padded.set(data, 0);
    padded.set(enc.subarray(0, 16), data.byteLength);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, padded));
  }
}

// -------------------------------------------------------------------- HLS ---

function outputFormat(playlist) {
  if (playlist.map) return { ext: 'mp4', mime: 'video/mp4' };
  const ext = pathExt(playlist.segments[0]?.url || '');
  if (ext === 'mp4' || ext === 'm4s') return { ext: 'mp4', mime: 'video/mp4' };
  if (ext === 'aac') return { ext: 'aac', mime: 'audio/aac' };
  return { ext: 'ts', mime: 'video/mp2t' };
}

/**
 * @param {object} job { url, signal, concurrency, onProgress, sinkFactory }
 * @returns {Promise<{blob: Blob, ext: string, warnings: string[], cleanup: Function}>}
 */
export async function downloadHls(job) {
  const {
    url,
    signal,
    concurrency = 6,
    onProgress = () => {},
    sinkFactory = createSink,
    pauseGate = createPauseGate(),
  } = job;
  const warnings = [];

  let playlistUrl = url;
  let text = await fetchText(playlistUrl, { signal });
  let playlist = parseM3U8(text, playlistUrl);

  if (playlist.isMaster && playlist.variants.length) {
    const best = sortVariants(playlist.variants)[0];
    warnings.push('Master playlist terdeteksi — memakai kualitas tertinggi.');
    playlistUrl = best.url;
    text = await fetchText(playlistUrl, { signal });
    playlist = parseM3U8(text, playlistUrl);
  }

  if (!playlist.segments.length) throw new Error('Playlist tidak berisi segmen.');
  if (playlist.live) {
    warnings.push('Playlist live — hanya segmen yang tercantum saat ini yang diunduh.');
  }
  if (playlist.encryption && playlist.encryption !== 'AES-128') {
    throw new Error(`Enkripsi ${playlist.encryption} tidak didukung (hanya AES-128 clear-key).`);
  }

  const { ext, mime } = outputFormat(playlist);
  const sink = await sinkFactory({ mime, name: `hls-${Date.now()}.${ext}` });
  const segments = playlist.segments;
  const total = segments.length;

  const meter = new SpeedMeter();
  const maxConc = Math.max(1, Math.min(concurrency, 16));
  const controller = new AdaptiveConcurrency({
    meter,
    start: Math.min(3, maxConc),
    max: maxConc,
  });
  controller.start();

  if (playlist.map) {
    const init = await fetchBytes(playlist.map.url, { signal, byterange: playlist.map.byterange });
    await sink.append(init);
    meter.add(init.byteLength);
  }

  const results = new Array(total);
  let writeIndex = 0;
  let completed = 0;
  let cursor = 0;
  let active = 0;
  let finished = false;

  const report = () => {
    const bps = meter.bps;
    const avgBytes = completed > 0 ? sink.bytes / completed : 0;
    onProgress({
      completed,
      total,
      bytes: sink.bytes,
      bps,
      eta: etaSeconds(avgBytes * (total - completed), bps),
      connections: active,
      duration: playlist.duration,
    });
  };
  const ticker = setInterval(report, 400);

  const drain = async () => {
    while (writeIndex < total && results[writeIndex] !== undefined) {
      const data = results[writeIndex];
      results[writeIndex] = undefined; // lepas referensi agar bisa di-GC
      writeIndex++;
      await sink.append(data);
    }
  };

  // Penulisan harus berurutan walau segmen selesai tidak berurutan.
  let drainChain = Promise.resolve();
  const scheduleDrain = () => {
    drainChain = drainChain.then(drain, drain);
    return drainChain;
  };

  const fetchSegment = async (i) => {
    const seg = segments[i];
    let data = await fetchBytes(seg.url, { signal, byterange: seg.byterange });
    meter.add(data.byteLength);
    if (seg.key?.method === 'AES-128' && seg.key.url) {
      const key = await loadKey(seg.key.url, { signal });
      data = await aesDecrypt(data, key, ivForSegment(seg));
    }
    return data;
  };

  const pump = async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await pauseGate.wait(signal);
      const i = cursor++;
      if (i >= total) return;
      active++;
      try {
        results[i] = await fetchSegment(i);
      } catch (err) {
        controller.onError(err?.status);
        throw err;
      } finally {
        active--;
      }
      completed++;
      await scheduleDrain();
    }
  };

  const gatedPump = async (index) => {
    while (index >= controller.target) {
      if (signal?.aborted || finished || cursor >= total) return;
      await pauseGate.wait(signal);
      await sleep(300, signal).catch(() => {});
    }
    return pump();
  };

  try {
    await Promise.all(Array.from({ length: maxConc }, (_, i) => gatedPump(i)));
    finished = true;
    await scheduleDrain();
  } finally {
    finished = true;
    controller.stop();
    clearInterval(ticker);
  }

  report();
  const { blob, cleanup } = await sink.finish();
  return { blob, ext, warnings, cleanup, duration: playlist.duration };
}

// -------------------------------------------------------- File progresif ---

export async function downloadFile(job) {
  const {
    url,
    signal,
    concurrency = 8,
    onProgress = () => {},
    sinkFactory = createSink,
    pauseGate = createPauseGate(),
  } = job;

  const ext = pathExt(url) || 'mp4';
  const mime = ext === 'webm' ? 'video/webm' : ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';
  const sink = await sinkFactory({ mime, name: `file-${Date.now()}.${ext}` });

  const warnings = [];
  const stats = await downloadRanged({
    url,
    sink,
    signal,
    maxConnections: Math.max(1, Math.min(concurrency, 16)),
    onProgress,
    pauseGate,
  });
  if (!stats.ranged) {
    warnings.push('Server tidak mendukung HTTP Range — unduhan berjalan satu koneksi.');
  }

  const { blob, cleanup } = await sink.finish();
  return { blob, ext, warnings, cleanup };
}
