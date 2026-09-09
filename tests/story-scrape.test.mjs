import {
  harvestStoryMedia,
  isBadIgVideoPart,
  isDirectIgVideoUrl,
  isSocialCdnUrl,
  isStoryMediaUrl,
  pickStoryEntry,
  shouldHarvestStoryJson,
  storyMediaRole,
} from '../src/lib/story-scrape.js';
import { kindFromUrl } from '../src/lib/util.js';

export default function ({ check }) {
  const igVideo =
    'https://scontent.cdninstagram.com/o1/v/t16/f2/m86/AQM123_n.mp4?_nc_ht=scontent.cdninstagram.com';
  const igPhoto =
    'https://scontent.cdninstagram.com/v/t51.2885-15/e35/123_n.jpg?stp=dst-jpg';
  const fbHd = 'https://video.xx.fbcdn.net/v/t42.1790-2/999.mp4?_nc_cat=1';

  check('CDN Instagram dikenali', isSocialCdnUrl(igVideo));
  check('foto IG dikenali', isStoryMediaUrl(igPhoto));
  check('video FB dikenali', isStoryMediaUrl(fbHd));
  check('situs biasa bukan CDN sosial', !isSocialCdnUrl('https://cdn.example.com/v.mp4'));
  check('peran video IG', storyMediaRole(igVideo) === 'video');
  check('peran foto IG', storyMediaRole(igPhoto) === 'image');
  check(
    'pilih video terbaru, bukan foto',
    pickStoryEntry(
      [
        { url: igPhoto, lastSeen: 20, size: 9e6 },
        { url: igVideo, lastSeen: 10, size: 1e6 },
      ],
      'video'
    )?.url === igVideo
  );
  check(
    'tanpa video jangan kasih foto',
    pickStoryEntry([{ url: igPhoto, lastSeen: 1, size: 9e6 }], 'video') == null
  );
  check('video IG .mp4 = file', kindFromUrl(igVideo) === 'file');
  check(
    'CDN tanpa ekstensi = file',
    kindFromUrl('https://scontent.cdninstagram.com/o1/v/t16/f2/m86/AQM123_n?_nc_ht=x') === 'file'
  );

  const json = {
    data: {
      items: [
        {
          video_versions: [
            { width: 640, url: 'https://scontent.cdninstagram.com/v/t50.2886-16/low.mp4' },
            { width: 1080, url: igVideo },
          ],
          image_versions2: {
            candidates: [
              { width: 320, url: 'https://scontent.cdninstagram.com/v/t51.2885-15/small.jpg' },
              { width: 1080, url: igPhoto },
            ],
          },
        },
      ],
    },
  };
  const urls = harvestStoryMedia(json);
  check('pilih video versi terlebar', urls.includes(igVideo));
  check('pilih foto versi terlebar', urls.includes(igPhoto));
  check('buang kandidat kecil', !urls.includes('https://scontent.cdninstagram.com/v/t51.2885-15/small.jpg'));

  check(
    'JSON GraphQL di-harvest',
    shouldHarvestStoryJson('{"video_versions":[{"url":"https://scontent.cdninstagram.com/v/t50/x.mp4","width":1}]}')
  );
  check('JSON biasa dilewati', !shouldHarvestStoryJson('{"ok":true}'));
  check(
    'segment audio ditolak',
    isBadIgVideoPart('https://video.cdninstagram.com/v/t16/audio_dashinit.mp4')
  );
  check('mp4 progressive diterima', isDirectIgVideoUrl(igVideo));
  check(
    'pickStoryEntry buang audio-only',
    pickStoryEntry(
      [
        {
          url: 'https://video.cdninstagram.com/v/t16/audio_dashinit.mp4',
          lastSeen: 99,
          size: 9e6,
        },
        { url: igVideo, lastSeen: 1, size: 1e6 },
      ],
      'video'
    )?.url === igVideo
  );
}
