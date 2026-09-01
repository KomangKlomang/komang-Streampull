// Mesin unduhan: HLS (segmen paralel adaptif + AES-128) dan file progresif
// (multi-koneksi Range ala IDM). Berjalan di offscreen document.

import { downloadRanged } from './accel.js';
import { parseM3U8, sortVariants } from './m3u8.js';
import { dashRepIdFromUrl, parseMpd, pickDashRep } from './mpd.js';
import { fetchBytes, fetchText } from './net.js';
import { createSink } from './sink.js';
import { AdaptiveConcurrency, SpeedMeter, etaSeconds } from './speed.js';
import { createPauseGate, hexToBytes, pathExt, sleep } from './util.js';

// ---------------------------------------------------------------- AES-128 ---

const keyCache = new Map();

async function loadKey(url, opts) {
  const fb = opts?.fetchBytes || fetchBytes;
  if (keyCache.has(url)) return keyCache.get(url);
  const promise = (async () => {
    const raw = await fb(url, opts);
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
  const fetchTextFn = job.fetchText || ((u, o) => fetchText(u, o));
  const fetchBytesFn = job.fetchBytes || ((u, o) => fetchBytes(u, o));
  const warnings = [];

  let playlistUrl = url;
  let text = await fetchTextFn(playlistUrl, { signal });
  let playlist = parseM3U8(text, playlistUrl);

  if (playlist.isMaster && playlist.variants.length) {
    const best = sortVariants(playlist.variants)[0];
    warnings.push('Master playlist terdeteksi — memakai kualitas tertinggi.');
    playlistUrl = best.url;
    text = await fetchTextFn(playlistUrl, { signal });
    playlist = parseM3U8(text, playlistUrl);
  }

  if (playlist.live) {
    return downloadHlsLive({
      playlistUrl,
      playlist,
      warnings,
      signal,
      onProgress,
      sinkFactory,
      pauseGate,
      liveMaxMs: job.liveMaxMs,
      fetchText: fetchTextFn,
      fetchBytes: fetchBytesFn,
      refreshUrl: job.refreshUrl,
    });
  }

  if (!playlist.segments.length) throw new Error('Playlist tidak berisi segmen.');
  if (playlist.encryption && playlist.encryption !== 'AES-128') {
    throw new Error(`Enkripsi ${playlist.encryption} tidak didukung (hanya AES-128).`);
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
    const init = await fetchBytesFn(playlist.map.url, { signal, byterange: playlist.map.byterange });
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
    let data = await fetchBytesFn(seg.url, { signal, byterange: seg.byterange });
    meter.add(data.byteLength);
    if (seg.key?.method === 'AES-128' && seg.key.url) {
      const key = await loadKey(seg.key.url, { signal, fetchBytes: fetchBytesFn });
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

async function fetchHlsSegment(seg, signal, fetchBytesFn = fetchBytes) {
  let data = await fetchBytesFn(seg.url, { signal, byterange: seg.byterange });
  if (seg.key?.method === 'AES-128' && seg.key.url) {
    const key = await loadKey(seg.key.url, { signal, fetchBytes: fetchBytesFn });
    data = await aesDecrypt(data, key, ivForSegment(seg));
  }
  return data;
}

/**
 * Live IDM-style: part baru digabung; berhenti saat idle ~24s, ENDLIST, atau batal.
 * ponytail: liveMaxMs=0 = tanpa cap waktu; set >0 di settings kalau mau fuse manual.
 */
async function downloadHlsLive({
  playlistUrl: startUrl,
  playlist,
  warnings,
  signal,
  onProgress,
  sinkFactory,
  pauseGate,
  liveMaxMs = 0,
  fetchText: fetchTextFn = fetchText,
  fetchBytes: fetchBytesFn = fetchBytes,
  refreshUrl,
}) {
  let playlistUrl = startUrl;
  warnings.push(
    'Rekaman live — part baru digabung otomatis. Berhenti saat stream habis atau kamu klik Batal.'
  );
  if (playlist.encryption && playlist.encryption !== 'AES-128') {
    warnings.push(`Enkripsi ${playlist.encryption} — berkas mungkin tidak bisa diputar.`);
  }

  const pullPlaylist = async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const text = await fetchTextFn(playlistUrl, { signal });
        return parseM3U8(text, playlistUrl);
      } catch (err) {
        const msg = String(err?.message || err);
        if (refreshUrl && /404|403|410|HTTP|Gagal/i.test(msg)) {
          const next = await refreshUrl();
          if (next && next !== playlistUrl) {
            playlistUrl = next;
            warnings.push('URL playlist diperbarui (CDN signed).');
            continue;
          }
        }
        throw err;
      }
    }
    throw new Error('Playlist live tidak bisa diambil');
  };

  for (let i = 0; i < 12 && !playlist.segments.length && !signal?.aborted; i++) {
    await pauseGate.wait(signal);
    await sleep(400, signal).catch(() => {});
    playlist = await pullPlaylist();
  }
  if (!playlist.segments.length) throw new Error('Playlist live tidak berisi segmen.');

  const { ext, mime } = outputFormat(playlist);
  const sink = await sinkFactory({ mime, name: `hls-live-${Date.now()}.${ext}` });
  if (playlist.map) {
    const init = await fetchBytesFn(playlist.map.url, { signal, byterange: playlist.map.byterange });
    await sink.append(init);
  }

  const seen = new Set();
  const meter = new SpeedMeter();
  let completed = 0;
  let idlePolls = 0;
  const started = Date.now();
  const hasCap = liveMaxMs > 0;
  // ponytail: 8 poll idle ≈ 24s tanpa part baru
  const idleLimit = 8;

  const report = () => {
    onProgress({
      completed,
      total: completed,
      bytes: sink.bytes,
      bps: meter.bps,
      eta: 0,
      connections: 1,
      duration: playlist.duration,
      live: true,
    });
  };

  try {
    while (!signal?.aborted && (!hasCap || Date.now() - started < liveMaxMs)) {
      await pauseGate.wait(signal);
      let added = 0;
      for (const seg of playlist.segments) {
        const id = `${seg.seq}\0${seg.url}\0${seg.byterange?.offset ?? ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const data = await fetchHlsSegment(seg, signal, fetchBytesFn);
          meter.add(data.byteLength);
          await sink.append(data);
          completed++;
          added++;
          report();
        } catch (err) {
          if (/404|403|410|HTTP/i.test(String(err?.message || err))) continue;
          throw err;
        }
      }
      if (!playlist.live && completed > 0) break;
      if (added === 0) {
        idlePolls++;
        if (idlePolls >= idleLimit && completed > 0) break;
      } else {
        idlePolls = 0;
      }
      const wait = Math.max(500, Math.min(2500, (playlist.targetDuration || 2) * 500));
      await sleep(wait, signal).catch(() => {});
      if (signal?.aborted) break;
      playlist = await pullPlaylist();
    }
  } catch (err) {
    if (!(err?.name === 'AbortError' && completed > 0)) throw err;
    warnings.push('Rekaman dihentikan — menyimpan file gabungan.');
  }

  report();
  const { blob, cleanup } = await sink.finish();
  if (!blob.size) throw new Error('Playlist live tidak berisi segmen.');
  if (idlePolls >= idleLimit) warnings.push('Live berhenti — file final disimpan.');
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

// ---------------------------------------------------------------- DASH ---

export async function downloadDash(job) {
  const {
    url,
    signal,
    concurrency = 6,
    onProgress = () => {},
    sinkFactory = createSink,
    pauseGate = createPauseGate(),
  } = job;
  const warnings = [];

  const text = await fetchText(url, { signal });
  const mpd = parseMpd(text, url);
  if (mpd.live) throw new Error('DASH live tidak didukung.');
  if (mpd.drm) throw new Error('Stream terlindungi DRM — tidak bisa diunduh.');
  if (mpd.multiPeriod) warnings.push('MPD multi-period — hanya period pertama yang diunduh.');

  const rep = pickDashRep(mpd, job.repId || dashRepIdFromUrl(url));
  if (!rep) throw new Error('Tidak ada Representation DASH yang bisa diunduh.');

  const parts = [];
  if (rep.init?.url) parts.push(rep.init);
  parts.push(...rep.segments);
  if (!parts.length) throw new Error('DASH tidak berisi segmen.');

  if (mpd.representations.some((r) => r.contentType === 'audio') && rep.contentType !== 'audio') {
    warnings.push('Audio berada di track terpisah — gunakan perintah ffmpeg agar tergabung.');
  }

  const sink = await sinkFactory({ mime: 'video/mp4', name: `dash-${Date.now()}.mp4` });
  const total = parts.length;
  const meter = new SpeedMeter();
  const maxConc = Math.max(1, Math.min(concurrency, 16));
  const controller = new AdaptiveConcurrency({
    meter,
    start: Math.min(3, maxConc),
    max: maxConc,
  });
  controller.start();

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
      duration: mpd.duration,
    });
  };
  const ticker = setInterval(report, 400);

  const drain = async () => {
    while (writeIndex < total && results[writeIndex] !== undefined) {
      const data = results[writeIndex];
      results[writeIndex] = undefined;
      writeIndex++;
      await sink.append(data);
    }
  };

  let drainChain = Promise.resolve();
  const scheduleDrain = () => {
    drainChain = drainChain.then(drain, drain);
    return drainChain;
  };

  const fetchSegment = async (i) => {
    const seg = parts[i];
    const data = await fetchBytes(seg.url, { signal, byterange: seg.byterange });
    meter.add(data.byteLength);
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
  return { blob, ext: 'mp4', warnings, cleanup, duration: mpd.duration };
}
