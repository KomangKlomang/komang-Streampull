import { analyzeHlsUrl, isJunkHls, rankHlsEntries, collapseMediaForDisplay, hlsStableId } from '../src/lib/hls-score.js';
import { shortHash } from '../src/lib/util.js';

export default async function run({ check }) {
  const ad = analyzeHlsUrl('https://cdn.example.com/ads/preroll.m3u8');
  check('iklan skor rendah', ad.type === 'ad' && ad.score < 20);

  const master = analyzeHlsUrl('https://cdn.example.com/hls/master.m3u8');
  check('master skor tinggi', master.type === 'master' && master.score >= 85);

  const hd = analyzeHlsUrl('https://pull-hls.example.com/1080p/playlist.m3u8');
  check('1080p terdeteksi', hd.quality === '1080p');

  const ranked = rankHlsEntries([
    { url: 'https://x.com/hls/a/11111111111111111111/index.m3u8', kind: 'hls', lastSeen: 1 },
    { url: 'https://x.com/hls/a/11111111111111111111/720/index.m3u8', kind: 'hls', lastSeen: 2 },
  ]);
  check('duplikat ditandai', ranked.some((e) => e.hlsAnalysis?.isDuplicate));

  check('isJunkHls iklan', isJunkHls({ url: 'https://x.com/ads/vast.m3u8', kind: 'hls' }));

  const id1 = hlsStableId('https://pull.example.com/live/abc123456789012345678/index.m3u8?sign=1', shortHash);
  const id2 = hlsStableId('https://pull.example.com/live/abc123456789012345678/index.m3u8?sign=2', shortHash);
  check('hlsStableId sama untuk signed URL baru', id1 === id2);

  const collapsed = collapseMediaForDisplay([
    { kind: 'hls', url: 'https://x.com/a/11111111111111111111/index.m3u8', lastSeen: 1 },
    { kind: 'hls', url: 'https://x.com/a/11111111111111111111/720/index.m3u8?x=1', lastSeen: 2 },
    { kind: 'file', url: 'https://x.com/dead.mp4', lastSeen: 3 },
  ]);
  check('collapse: satu HLS', collapsed.filter((e) => e.kind === 'hls').length === 1);
  check('collapse: FILE mati disembunyikan', !collapsed.some((e) => e.url.includes('dead.mp4')));
}
