// Lapisan fetch dengan retry + backoff. Dipakai di service worker dan offscreen.
// Referer/Origin TIDAK bisa di-set lewat fetch() (forbidden headers) — itu
// ditangani oleh aturan declarativeNetRequest di background.js.

import { sleep } from './util.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} — ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const RETRIABLE = new Set([0, 403, 408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(url, opts = {}) {
  const {
    retries = 4,
    signal,
    headers,
    timeout = 45000,
    baseDelay = 600,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      const res = await fetch(url, {
        headers,
        signal: ctrl.signal,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      if (!res.ok) {
        // Bodi error yang tidak dibaca menahan koneksi sampai GC — dengan
        // retry berlapis itu menumpuk cepat.
        try {
          await res.body?.cancel();
        } catch {
          /* sudah tertutup */
        }
        throw new HttpError(res.status, url);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const status = err instanceof HttpError ? err.status : 0;
      const retriable = err instanceof HttpError ? RETRIABLE.has(status) : true;
      if (!retriable || attempt === retries) throw err;
      await sleep(baseDelay * 2 ** attempt + Math.floor(Math.random() * 250), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

export async function fetchText(url, opts) {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export async function fetchBytes(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.byterange) {
    const { offset = 0, length } = opts.byterange;
    headers.Range = `bytes=${offset}-${offset + length - 1}`;
  }
  const res = await fetchWithRetry(url, { ...opts, headers });
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** HEAD request "best effort" untuk mengetahui ukuran file progresif. */
export async function probeSize(url, opts = {}) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      signal: opts.signal,
    });
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    return Number.isFinite(len) && len > 0 ? len : 0;
  } catch {
    return 0;
  }
}
