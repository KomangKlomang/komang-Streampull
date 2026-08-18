// Parser HLS: master playlist, media playlist, kunci AES, byte-range.
import { parseM3U8, sortVariants, variantLabel } from '../src/lib/m3u8.js';

export default async function run({ check }) {
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080/index.m3u8
`;
  const mp = parseM3U8(master, 'https://cdn.example.com/hls/abc/master.m3u8');
  check('master playlist dikenali', mp.isMaster === true);
  check('semua varian terbaca', mp.variants.length === 3, String(mp.variants.length));
  check(
    'URL relatif diselesaikan terhadap playlist',
    mp.variants[0].url === 'https://cdn.example.com/hls/abc/360/index.m3u8',
    mp.variants[0].url
  );
  const sorted = sortVariants(mp.variants);
  check('kualitas tertinggi lebih dulu', sorted[0].resolution === '1920x1080');
  check('label varian terbaca manusia', variantLabel(sorted[1]) === '720p · 2400 kbps', variantLabel(sorted[1]));

  const media = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x0123456789abcdef0123456789abcdef
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
#EXT-X-BYTERANGE:1024@0
big.ts
#EXT-X-BYTERANGE:2048
#EXTINF:5.0,
big.ts
#EXT-X-ENDLIST
`;
  const pl = parseM3U8(media, 'https://cdn.example.com/hls/abc/720/index.m3u8');
  check('bukan master', pl.isMaster === false);
  check('jumlah segmen benar', pl.segments.length === 3, String(pl.segments.length));
  check('durasi total dijumlahkan', Math.abs(pl.duration - 23.018) < 0.001, String(pl.duration));
  check('VOD dikenali dari ENDLIST', pl.live === false);
  check('enkripsi AES-128 tercatat', pl.encryption === 'AES-128');
  check(
    'URI kunci relatif naik satu level',
    pl.segments[0].key.url === 'https://cdn.example.com/hls/abc/key.bin',
    pl.segments[0].key.url
  );
  check('media-sequence jadi nomor urut awal', pl.segments[0].seq === 5, String(pl.segments[0].seq));
  check(
    'byterange eksplisit terbaca',
    pl.segments[1].byterange.offset === 0 && pl.segments[1].byterange.length === 1024
  );
  // BYTERANGE boleh muncul sebelum maupun sesudah EXTINF — pernah jadi bug.
  check(
    'byterange tanpa @offset melanjutkan offset sebelumnya',
    pl.segments[2].byterange.offset === 1024,
    JSON.stringify(pl.segments[2].byterange)
  );

  const live = parseM3U8('#EXTM3U\n#EXTINF:10,\na.ts\n', 'https://x.test/l.m3u8');
  check('tanpa ENDLIST dianggap live', live.live === true);

  const fmp4 = parseM3U8(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\n1.m4s\n#EXT-X-ENDLIST\n',
    'https://x.test/p.m3u8'
  );
  check('EXT-X-MAP terbaca untuk fMP4', fmp4.map?.url === 'https://x.test/init.mp4', fmp4.map?.url);

  const empty = parseM3U8('#EXTM3U\n#EXT-X-ENDLIST\n', 'https://x.test/e.m3u8');
  check('playlist kosong tidak melempar error', empty.segments.length === 0);
}
