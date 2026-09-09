import {
  buildSocialFilename,
  parseSocialPageContext,
  sanitizeNamePart,
} from '../src/lib/social-filename.js';

export default function ({ check }) {
  check('sanitizeNamePart', sanitizeNamePart('User Name!') === 'User_Name');
  check('parse IG story', parseSocialPageContext('https://www.instagram.com/stories/john_doe/1234567890/')?.channel === 'john_doe');
  check(
    'parse IG highlight',
    parseSocialPageContext('https://www.instagram.com/stories/highlights/999/')?.channel === 'highlight'
  );
  check(
    'buildSocialFilename',
    buildSocialFilename({
      platform: 'ig',
      channel: 'john_doe',
      postId: 'story',
      order: 2,
      mediaType: 'video',
    }) === 'ig_john_doe_story_002_video'
  );
  check(
    'parse WA',
    parseSocialPageContext('https://web.whatsapp.com/')?.platform === 'wa'
  );
}
