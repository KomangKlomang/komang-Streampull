// Native host dipanggil lewat host.bat → satu proses Python per pesan, dan
// popup menanyakan status tiap 700 ms. Tes ini menjaga cachenya tetap bekerja.
import { pingYtdlp, recordWithYtdlp, resetYtdlpPing } from '../src/lib/ytdlp.js';

export default async function ({ check }) {
  let calls = [];
  let reply = { success: true, version: 'yt-dlp 2025.01.01' };
  let failWith = null;

  const chromeStub = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(_host, payload, cb) {
        calls.push(payload.action);
        setTimeout(() => {
          if (failWith) {
            chromeStub.runtime.lastError = { message: failWith };
            cb(undefined);
            chromeStub.runtime.lastError = undefined;
          } else {
            cb(reply);
          }
        }, 0);
      },
    },
  };
  const savedChrome = globalThis.chrome;
  globalThis.chrome = chromeStub;

  try {
    resetYtdlpPing();

    // --------------------------------------------------------- cache ping ---
    const [a, b] = await Promise.all([pingYtdlp(), pingYtdlp()]);
    check('ping paralel hanya sekali memanggil host', calls.length === 1, String(calls.length));
    check('kedua pemanggil dapat hasil yang sama', a === b && a?.success === true);

    await pingYtdlp();
    check('ping berikutnya dilayani dari cache', calls.length === 1, String(calls.length));

    resetYtdlpPing();
    await pingYtdlp();
    check('reset memaksa ping baru', calls.length === 2, String(calls.length));

    // ------------------------------------------------------ host tidak ada ---
    failWith = 'Specified native messaging host not found.';
    resetYtdlpPing();
    check('host hilang menghasilkan null', (await pingYtdlp()) === null);
    const afterFail = calls.length;
    await pingYtdlp();
    check('kegagalan juga di-cache', calls.length === afterFail, String(calls.length));

    // ---------------------------------------------------------- perekaman ---
    const failed = await recordWithYtdlp({ url: 'https://x.example/live.m3u8' });
    check('perekaman gagal melaporkan error', failed.success === false && !!failed.error);
    const beforePing = calls.length;
    await pingYtdlp();
    check(
      'kegagalan perekaman membatalkan cache ping',
      calls.length === beforePing + 1,
      String(calls.length)
    );

    failWith = null;
    resetYtdlpPing();
    check('perekaman sukses', (await recordWithYtdlp({ url: 'https://x.example/l.m3u8' })).success);

    reply = { success: false, error: 'format tidak didukung' };
    const rejected = await recordWithYtdlp({ url: 'https://x.example/l.m3u8' });
    check('alasan penolakan host diteruskan', rejected.error === 'format tidak didukung');
  } finally {
    if (savedChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = savedChrome;
    resetYtdlpPing();
  }
}
