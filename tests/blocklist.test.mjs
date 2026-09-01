import { isBlockedHost, isBlockedUrl } from '../src/lib/blocklist.js';

export default function ({ check }) {
  check('youtube.com diblokir', isBlockedHost('youtube.com'));
  check('subdomain youtube diblokir', isBlockedHost('www.youtube.com'));
  check('youtu.be diblokir', isBlockedUrl('https://youtu.be/dQw4w9WgXcQ'));
  check('CDN YouTube diblokir', isBlockedHost('rr1---sn-abc.googlevideo.com'));
  check('situs biasa lolos', !isBlockedHost('example.com'));
  check('URL kosong tidak melempar', !isBlockedUrl(''));
  check('bukan URL tidak melempar', !isBlockedUrl('bukan-url'));
}
