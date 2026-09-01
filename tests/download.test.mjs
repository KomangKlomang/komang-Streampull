// Mesin unduhan lawan server HTTP sungguhan: HLS + AES-128, dan unduhan
// multi-koneksi dengan dynamic segmentation.
import http from 'node:http';
import nodeCrypto from 'node:crypto';
import { downloadDash, downloadFile, downloadHls } from '../src/lib/downloader.js';
import { downloadRanged, probeRange } from '../src/lib/accel.js';
import { MemorySink } from '../src/lib/sink.js';

const memSink = ({ mime } = {}) => new MemorySink(mime || 'video/mp4');

export default async function run({ check }) {
  const KEY = nodeCrypto.randomBytes(16);
  const IV = nodeCrypto.randomBytes(16);
  const plain = [
    nodeCrypto.randomBytes(64 * 1024),
    nodeCrypto.randomBytes(48 * 1024 + 7), // panjang bukan kelipatan 16
    nodeCrypto.randomBytes(16 * 1024),
  ];
  const encPadded = (buf) => {
    const c = nodeCrypto.createCipheriv('aes-128-cbc', KEY, IV);
    return Buffer.concat([c.update(buf), c.final()]);
  };
  const encRaw = (buf) => {
    const c = nodeCrypto.createCipheriv('aes-128-cbc', KEY, IV);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(buf), c.final()]);
  };
  const unpadded = nodeCrypto.randomBytes(32 * 1024);

  const FILE = nodeCrypto.randomBytes(3 * 1024 * 1024 + 12345);
  let rangeReqs = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let slowFirst = false;
  let supportRange = true;

  const routes = new Map();
  routes.set('/key.bin', KEY);
  plain.forEach((p, i) => routes.set('/seg' + i + '.ts', encPadded(p)));
  routes.set('/nopad.ts', encRaw(unpadded));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/video.mp4' || p === '/norange') {
      const range = supportRange && p === '/video.mp4' ? req.headers.range : null;
      if (!range) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': FILE.length });
        res.end(FILE);
        return;
      }
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : FILE.length - 1;
      if (end - start > 0) {
        rangeReqs.push([start, end]);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        res.on('close', () => {
          inFlight--;
        });
      }
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': 'bytes ' + start + '-' + end + '/' + FILE.length,
        'content-length': end - start + 1,
      });
      const body = FILE.subarray(start, end + 1);
      // Koneksi pertama sengaja dibuat merangkak agar work stealing terpicu.
      if (slowFirst && start === 0 && body.length > 200000) {
        res.write(body.subarray(0, 32768));
        let off = 32768;
        const t = setInterval(() => {
          if (res.writableEnded || off >= body.length) {
            clearInterval(t);
            try {
              res.end();
            } catch {
              /* sudah tertutup */
            }
            return;
          }
          res.write(body.subarray(off, off + 8192));
          off += 8192;
        }, 50);
        res.on('close', () => clearInterval(t));
        return;
      }
      res.end(body);
      return;
    }

    const hit = routes.get(p);
    if (hit) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': hit.length,
      });
      res.end(hit);
      return;
    }

    if (p === '/media.m3u8' || p === '/master.m3u8' || p === '/nopad.m3u8' || p === '/live.m3u8') {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const ivHex = '0x' + IV.toString('hex');
      let body;
      if (p === '/master.m3u8') {
        body =
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720\n' +
          origin +
          '/media.m3u8\n';
      } else if (p === '/nopad.m3u8') {
        body =
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="' +
          origin +
          '/key.bin",IV=' +
          ivHex +
          '\n#EXTINF:10,\nnopad.ts\n#EXT-X-ENDLIST\n';
      } else if (p === '/live.m3u8') {
        body =
          '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI="' +
          origin +
          '/key.bin",IV=' +
          ivHex +
          '\n#EXTINF:10,\nseg0.ts\n';
      } else {
        body =
          '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI="' +
          origin +
          '/key.bin",IV=' +
          ivHex +
          '\n' +
          plain.map((_, i) => '#EXTINF:10,\nseg' + i + '.ts\n').join('') +
          '#EXT-X-ENDLIST\n';
      }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(body);
      return;
    }

    if (p === '/manifest.mpd') {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const body =
        '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT20S"><Period>' +
        '<AdaptationSet contentType="video" mimeType="video/mp4">' +
        '<Representation id="v" bandwidth="1000" width="640" height="360">' +
        `<SegmentTemplate timescale="1" duration="10" startNumber="1" initialization="${origin}/dinit.mp4" media="${origin}/dseg-$Number$.m4s"/>` +
        '</Representation></AdaptationSet></Period></MPD>';
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      res.end(body);
      return;
    }

    if (p === '/dinit.mp4' || p === '/dseg-1.m4s' || p === '/dseg-2.m4s') {
      const buf = Buffer.from(p === '/dinit.mp4' ? 'INIT' : p.includes('1') ? 'SEG1' : 'SEG2');
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': buf.length });
      res.end(buf);
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    // ------------------------------------------------------ HLS + AES-128 ---
    let lastProgress = null;
    const hls = await downloadHls({
      url: base + '/master.m3u8',
      concurrency: 3,
      sinkFactory: memSink,
      onProgress: (p) => (lastProgress = p),
    });
    const got = Buffer.from(await hls.blob.arrayBuffer());
    const want = Buffer.concat(plain);
    check('master otomatis diresolusi ke media playlist', hls.warnings.some((w) => w.includes('Master')));
    check('ekstensi keluaran .ts', hls.ext === 'ts', hls.ext);
    check('hasil HLS identik byte-per-byte', got.equals(want), got.length + ' vs ' + want.length);
    check('segmen tersusun berurutan meski diunduh paralel', got.subarray(0, 65536).equals(plain[0]));
    check('MIME hasil HLS benar', hls.blob.type === 'video/mp2t', hls.blob.type);
    check('progres terlapor sampai tuntas', lastProgress?.completed === 3 && lastProgress?.total === 3);

    const nopad = await downloadHls({
      url: base + '/nopad.m3u8',
      concurrency: 1,
      sinkFactory: memSink,
    });
    check(
      'segmen AES tanpa padding PKCS#7 tetap terdekripsi',
      Buffer.from(await nopad.blob.arrayBuffer()).equals(unpadded)
    );

    const live = await downloadHls({
      url: base + '/live.m3u8',
      concurrency: 1,
      sinkFactory: memSink,
    });
    check('live tanpa ENDLIST tetap terunduh', live.blob.size > 0);
    check(
      'live hanya snapshot segmen saat klik',
      live.warnings.some((w) => /live/i.test(w))
    );

    // ---------------------------------------------------------- probe Range ---
    const p1 = await probeRange(base + '/video.mp4');
    check('ukuran total terbaca dari Content-Range', p1.total === FILE.length, String(p1.total));
    check('dukungan Range terdeteksi', p1.ranged === true);

    supportRange = false;
    const p2 = await probeRange(base + '/norange');
    check('server tanpa Range dikenali', p2.ranged === false && p2.total === FILE.length);
    supportRange = true;

    // -------------------------------------------------------- multi-koneksi ---
    rangeReqs = [];
    const sink1 = new MemorySink('video/mp4');
    const stats = await downloadRanged({
      url: base + '/video.mp4',
      sink: sink1,
      maxConnections: 8,
      minChunkBytes: 256 * 1024,
    });
    const out1 = Buffer.from(await (await sink1.finish()).blob.arrayBuffer());
    check('unduhan multi-koneksi utuh', out1.equals(FILE), out1.length + ' vs ' + FILE.length);
    check('memakai lebih dari satu rentang', rangeReqs.length > 1, String(rangeReqs.length));
    check('puncak koneksi lebih dari satu', stats.peak >= 2, String(stats.peak));
    check(
      'rentang awal tidak tumpang tindih',
      (() => {
        const s = [...rangeReqs].sort((a, b) => a[0] - b[0]);
        return s.every((r, i) => i === 0 || r[0] > s[i - 1][0]);
      })()
    );

    // -------------------------------------------------------- work stealing ---
    slowFirst = true;
    rangeReqs = [];
    maxInFlight = 0;
    const sink2 = new MemorySink('video/mp4');
    await downloadRanged({
      url: base + '/video.mp4',
      sink: sink2,
      maxConnections: 6,
      minChunkBytes: 64 * 1024,
    });
    const out2 = Buffer.from(await (await sink2.finish()).blob.arrayBuffer());
    slowFirst = false;
    check('hasil tetap utuh walau rentang dicuri di tengah jalan', out2.equals(FILE));
    check('muncul rentang tambahan (bukti work stealing)', rangeReqs.length > 6, String(rangeReqs.length));
    check('server melihat koneksi benar-benar paralel', maxInFlight >= 2, 'maxInFlight=' + maxInFlight);

    // ---------------------------------------------------- fallback non-Range ---
    supportRange = false;
    const noRange = await downloadFile({ url: base + '/norange', sinkFactory: memSink });
    check(
      'server tanpa Range tetap terunduh utuh',
      Buffer.from(await noRange.blob.arrayBuffer()).equals(FILE)
    );
    check('diberi peringatan saat Range tidak didukung', noRange.warnings.some((w) => w.includes('Range')));
    check('MIME file progresif benar', noRange.blob.type === 'video/mp4', noRange.blob.type);
    supportRange = true;

    const dash = await downloadDash({ url: base + '/manifest.mpd', concurrency: 2, sinkFactory: memSink });
    check('DASH jadi mp4', dash.ext === 'mp4', dash.ext);
    check(
      'segmen DASH tersusun init+media',
      Buffer.from(await dash.blob.arrayBuffer()).equals(Buffer.from('INITSEG1SEG2'))
    );

    // ------------------------------------------------------------ pembatalan ---
    slowFirst = true;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 250);
    let aborted = false;
    try {
      await downloadRanged({
        url: base + '/video.mp4',
        sink: new MemorySink('video/mp4'),
        signal: ctrl.signal,
        maxConnections: 4,
        minChunkBytes: 64 * 1024,
      });
    } catch (err) {
      aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message));
    }
    slowFirst = false;
    check('pembatalan menghentikan unduhan', aborted);
  } finally {
    server.close();
  }
}
