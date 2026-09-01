export const BLOCKED_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'googlevideo.com',
  'netflix.com',
  'disneyplus.com',
  'hulu.com',
  'max.com',
  'hbomax.com',
  'primevideo.com',
  'spotify.com',
  'twitch.tv',
];

export function isBlockedHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return false;
  return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

export function isBlockedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    return isBlockedHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
