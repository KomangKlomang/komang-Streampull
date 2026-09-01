import { pickPrimaryEntry, rankEntries, rankScore } from '../src/lib/rank.js';

export default async function run({ check }) {
  const long = {
    url: 'https://cdn.akamaihd.net/main.m3u8',
    duration: 600,
    resolution: '1920x1080',
    source: 'hls.js',
    verified: true,
    playing: true,
    pageUrl: 'https://watch.example.com/v/1',
  };
  const ad = {
    url: 'https://pagead.googlesyndication.com/ad.mp4',
    duration: 8,
    resolution: '640x360',
    source: 'network',
    verified: true,
    pageUrl: long.pageUrl,
  };
  const ranked = rankEntries([ad, long]);
  check('konten utama di atas iklan', ranked[0].url === long.url, ranked.map((e) => e.url).join(' | '));
  check('iklan skor lebih rendah', ranked[1].rankScore < ranked[0].rankScore);

  const short = { url: 'https://cdn.example.com/a.m3u8', duration: 5, source: 'network', verified: true };
  const feature = { url: 'https://cdn.example.com/b.m3u8', duration: 120, source: 'network', verified: true };
  check(
    'durasi <15s di-cap',
    rankScore(short, { maxDuration: 120 }) < rankScore(feature, { maxDuration: 120 })
  );

  const page = {
    url: 'https://vceyy.de/HK6O35Og1.mp4',
    source: 'network',
    verified: false,
    pageUrl: 'https://vceyy.de/HK6O35Og1.mp4',
  };
  const playingCdn = {
    url: 'https://cdn2.videy.co/HK6O35Og1.mp4',
    source: 'playing',
    playing: true,
    verified: true,
    pageUrl: page.pageUrl,
  };
  const videy = rankEntries([page, playingCdn]);
  check('video yang diputar di atas halaman .mp4', videy[0].url === playingCdn.url);

  const fileAd = { url: 'https://cdn.example.com/preroll.mp4', kind: 'file', source: 'network', verified: true, duration: 6 };
  const hlsMain = {
    url: 'https://cdn.example.com/main.m3u8',
    kind: 'hls',
    source: 'playing',
    playing: true,
    verified: true,
    duration: 600,
  };
  check('preview memakai yang diputar, bukan file iklan', pickPrimaryEntry([fileAd, hlsMain])?.url === hlsMain.url);

  const deadMp4 = {
    url: 'https://pull-fcdn.tiktokcdn.com/stale.mp4?expire=1',
    kind: 'file',
    source: 'network',
    verified: true,
    duration: 300,
    lastSeen: Date.now() - 60_000,
  };
  const liveHls = {
    url: 'https://pull-hls.tiktokcdn.com/live.m3u8?expire=999',
    kind: 'hls',
    source: 'network',
    verified: true,
    duration: 0,
    lastSeen: Date.now(),
  };
  check(
    'HLS di atas FILE mati (TikTok live)',
    pickPrimaryEntry([deadMp4, liveHls])?.url === liveHls.url
  );
}
