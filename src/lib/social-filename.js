/** Nama berkas terbaca untuk media sosial — pola Story Saver (ig_user_story_001_video). */

export function sanitizeNamePart(value, fallback = 'unknown') {
  return (
    String(value || fallback)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_{2,}/g, '_') || fallback
  );
}

/** Konteks dari URL halaman IG/FB/WA untuk penamaan berkas. */
export function parseSocialPageContext(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();

    if (host === 'instagram.com') {
      const storyMatch = u.pathname.match(/\/stories\/([^/?#]+)(?:\/([^/?#]+))?/);
      if (storyMatch) {
        const channel = decodeURIComponent(storyMatch[1]);
        const seg2 = storyMatch[2] ? decodeURIComponent(storyMatch[2]) : 'story';
        if (channel === 'highlights') {
          return { platform: 'ig', channel: 'highlight', postId: seg2 };
        }
        return { platform: 'ig', channel, postId: seg2 };
      }
      const postMatch = u.pathname.match(/\/(?:p|reel|reels)\/([^/?#]+)/);
      if (postMatch) {
        return { platform: 'ig', channel: 'unknown', postId: postMatch[1] };
      }
    }

    if (host === 'facebook.com' || host === 'fb.com' || host === 'm.facebook.com') {
      const fbStory = u.pathname.match(/\/stories\/(\d+)/);
      if (fbStory) return { platform: 'fb', channel: 'story', postId: fbStory[1] };
    }

    if (host === 'web.whatsapp.com' || host.endsWith('.whatsapp.com')) {
      return { platform: 'wa', channel: 'story', postId: 'story' };
    }
  } catch {
    /* URL tidak valid */
  }
  return null;
}

export function buildSocialFilename({
  platform = 'social',
  channel,
  postId = 'post',
  order = 1,
  mediaType = 'media',
}) {
  return [
    platform,
    sanitizeNamePart(channel, 'unknown'),
    sanitizeNamePart(postId, 'post'),
    String(order).padStart(3, '0'),
    mediaType,
  ].join('_');
}
