// Penyusun aturan declarativeNetRequest. Dipisah dari background.js supaya
// bentuk aturannya bisa diuji tanpa API chrome.
//
// Semua aturan hanya mengenai permintaan yang lahir di extension sendiri
// (tabIds: [-1]) — lalu lintas tab biasa tidak pernah tersentuh.

export const RULE_ID_MIN = 20000;
export const RULE_ID_MAX = 29000;

/** Penghasil id aturan yang berputar di dalam rentang milik KSP. */
export function createRuleIdPool(min = RULE_ID_MIN, max = RULE_ID_MAX) {
  const span = max - min;
  let seq = 0;
  return () => {
    seq = seq >= span ? 1 : seq + 1;
    return min + seq;
  };
}

/** Header asli halaman → daftar operasi modifyHeaders. */
export function headerOps(headers = {}, { withCookie = true } = {}) {
  const ops = [];
  if (headers.referer) ops.push({ header: 'referer', operation: 'set', value: headers.referer });
  if (headers.origin) ops.push({ header: 'origin', operation: 'set', value: headers.origin });
  if (headers.userAgent) ops.push({ header: 'user-agent', operation: 'set', value: headers.userAgent });
  if (withCookie && headers.cookie) ops.push({ header: 'cookie', operation: 'set', value: headers.cookie });
  return ops;
}

const TAB_ID_NONE = -1;

export function hostRule(id, host, requestHeaders) {
  return {
    id,
    priority: 100,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: { urlFilter: `||${host}`, tabIds: [TAB_ID_NONE] },
  };
}

export function catchAllRule(id, requestHeaders) {
  return {
    id,
    priority: 110,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: {
      regexFilter: '^https?://',
      tabIds: [TAB_ID_NONE],
      resourceTypes: ['xmlhttprequest', 'media', 'other'],
    },
  };
}

/**
 * Satu aturan per host, id diambil dari pool. Host duplikat/kosong dibuang.
 * @returns {Array<object>} siap dikirim sebagai satu addRules
 */
export function buildHostRules(hosts, headers, nextId, opts) {
  const requestHeaders = headerOps(headers, opts);
  if (!requestHeaders.length) return [];
  return [...new Set((hosts || []).filter(Boolean))].map((host) =>
    hostRule(nextId(), host, requestHeaders)
  );
}
