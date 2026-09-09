import {
  currentStoryId,
  currentStoryUsername,
  isDirectIgVideoUrl,
  mediaFromStoryItem,
  normalizeIgVideoUrl,
  pickStoryMediaItem,
  storyFilename,
} from '../src/ig/ig-core.js';

export default function ({ check }) {
  check(
    'currentStoryUsername',
    currentStoryUsername('https://www.instagram.com/stories/john_doe/123/') === 'john_doe'
  );
  check(
    'currentStoryId',
    currentStoryId('https://www.instagram.com/stories/john_doe/999888/') === '999888'
  );
  check(
    'storyFilename',
    storyFilename('john', 2, 'video') === 'ig_john_story_002_video'
  );
  const igVideo =
    'https://scontent.cdninstagram.com/o1/v/t16/f2/m86/AQM123_n.mp4?bytestart=0';
  check('normalizeIgVideoUrl', !normalizeIgVideoUrl(igVideo).includes('bytestart'));
  check('isDirectIgVideoUrl', isDirectIgVideoUrl(igVideo));
  const item = {
    id: 'abc',
    video_versions: [{ url: igVideo }],
  };
  check('mediaFromStoryItem', mediaFromStoryItem(item)?.mediaType === 'video');
  check(
    'pickStoryMediaItem by id',
    pickStoryMediaItem(
      [{ id: 'x' }, { id: 'abc', image_versions2: { candidates: [{ width: 1, url: 'u' }] } }],
      'abc',
      ''
    )?.id === 'abc'
  );
}
