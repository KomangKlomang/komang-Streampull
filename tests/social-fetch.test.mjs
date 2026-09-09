import {
  extractStoryItemMedia,
  normalizeIgVideoUrl,
  pickIgStoryItem,
  readCsrfFromDocument,
} from '../src/lib/social-fetch.js';

export default function ({ check }) {
  const igVideo =
    'https://scontent.cdninstagram.com/o1/v/t16/f2/m86/AQM123_n.mp4?bytestart=0&byteend=999';
  check('normalizeIgVideoUrl buang range', !normalizeIgVideoUrl(igVideo).includes('bytestart'));

  const item = {
    id: 'abc123',
    video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/x.mp4' }],
  };
  check('extractStoryItemMedia video', extractStoryItemMedia(item)?.mediaType === 'video');

  const items = [
    { id: 'first', image_versions2: { candidates: [{ width: 100, url: 'https://x/a.jpg' }] } },
    { id: 'abc123', video_versions: [{ url: 'https://x/b.mp4' }] },
  ];
  check('pickIgStoryItem by id', pickIgStoryItem(items, 'abc123', '')?.id === 'abc123');
  check(
    'readCsrfFromDocument cookie',
    readCsrfFromDocument({ cookie: 'a=1; csrftoken=xyz99; b=2' }) === 'xyz99'
  );
}
