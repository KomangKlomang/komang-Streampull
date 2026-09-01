// Relay fetch lewat tab (content script) — cookie/referer sama seperti pemutar.
// Dipakai offscreen → background → detector untuk live HLS.

/** @param {number} tabId */
export function createTabFetch(tabId) {
  if (tabId == null || tabId < 0) return null;

  const relay = (payload) =>
    chrome.runtime.sendMessage({ type: 'ksp-tab-fetch', tabId, ...payload });

  return {
    async fetchText(url, opts = {}) {
      const res = await relay({ url, mode: 'text' });
      if (!res?.ok) throw new Error(res?.error || `Tab fetch gagal — ${url}`);
      return res.text;
    },
    async fetchBytes(url, opts = {}) {
      const res = await relay({ url, mode: 'bytes', byterange: opts.byterange || null });
      if (!res?.ok) throw new Error(res?.error || `Tab fetch gagal — ${url}`);
      const bytes = res.bytes;
      return new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes);
    },
  };
}
