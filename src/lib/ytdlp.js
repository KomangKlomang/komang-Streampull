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

export async function pingYtdlp() {
  try {
    const res = await sendNative({ action: 'ping' });
    return res?.success ? res : null;
  } catch {
    return null;
  }
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
    return { success: false, error: String(err?.message || err) };
  }
}
