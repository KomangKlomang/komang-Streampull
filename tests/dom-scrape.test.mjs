import { scrapeMediaFromDocument } from '../src/lib/dom-scrape.js';

export default async function run({ check }) {
  const doc = {
    title: 'Demo',
    baseURI: 'https://example.com/page',
    querySelectorAll(sel) {
      if (sel === 'video') {
        return [
          {
            paused: false,
            currentSrc: 'https://cdn.example.com/live/index.m3u8?sig=1',
            src: '',
            querySelectorAll: () => [],
          },
        ];
      }
      if (sel === 'a[href]') {
        return [{ getAttribute: () => '/files/clip.mp4', href: 'https://example.com/files/clip.mp4' }];
      }
      if (sel.startsWith('[data-src]')) return [];
      return [];
    },
  };

  const items = scrapeMediaFromDocument(doc);
  check('video m3u8 terdeteksi', items.some((i) => i.url.includes('.m3u8')));
  check('tautan mp4 terdeteksi', items.some((i) => i.url.includes('.mp4')));
  check('blob/data dilewati', !items.some((i) => i.url.startsWith('blob:')));
}
