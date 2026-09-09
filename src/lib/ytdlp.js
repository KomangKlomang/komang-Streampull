// Native Messaging → yt-dlp (pola m3u8-grabber). Opsional; fallback ke engine in-browser.

const HOST = 'com.ksp.ytdlp';

function sendNative(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

// Setiap sendNativeMessage menjalankan host.bat → satu proses Python baru.
// Popup menanyakan status tiap 700 ms, jadi hasilnya wajib di-cache.
const PING_TTL_OK = 60_000;
const PING_TTL_FAIL = 10_000;
let pingCache = null;
let pingInFlight = null;

export async function pingYtdlp() {
  if (pingCache && Date.now() < pingCache.until) return pingCache.value;
  if (pingInFlight) return pingInFlight;

  pingInFlight = (async () => {
    let value = null;
    try {
      const res = await sendNative({ action: 'ping' });
      value = res?.success ? res : null;
    } catch {
      value = null;
    }
    pingCache = { value, until: Date.now() + (value ? PING_TTL_OK : PING_TTL_FAIL) };
    pingInFlight = null;
    return value;
  })();

  return pingInFlight;
}

/** Lupakan hasil ping — dipakai setelah pengguna baru mendaftarkan native host. */
export function resetYtdlpPing() {
  pingCache = null;
}

/** @returns {Promise<{ success: boolean, error?: string }>} */
export async function recordWithYtdlp({ url, filename, outputDir, headers = {} }) {
  try {
    const res = await sendNative({
      action: 'download',
      url,
      filename: filename || '',
      output_dir: outputDir || '',
      format: 'best',
      headers: {
        referer: headers.referer || '',
        userAgent: headers.userAgent || '',
        cookie: headers.cookie || '',
        origin: headers.origin || '',
      },
    });
    if (res?.success) return { success: true };
    return { success: false, error: res?.error || 'yt-dlp menolak permintaan' };
  } catch (err) {
    resetYtdlpPing(); // host hilang sejak ping terakhir — jangan pakai hasil lama
    return { success: false, error: String(err?.message || err) };
  }
}
