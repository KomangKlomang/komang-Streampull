import {
  isNonMediaContentType,
  looksLikeHtml,
  mediaUrlsFromPlayerHtml,
  preferPlayerMediaUrl,
  kindFromUrl,
} from '../src/lib/util.js';

export default async function run({ check }) {
  check('html content-type bukan media', isNonMediaContentType('text/html; charset=UTF-8'));
  check('video/mp4 tetap media', !isNonMediaContentType('video/mp4'));
  check('doctype = html', looksLikeHtml('', '<!DOCTYPE html>\n<html>'));
  check('ftyp bukan html', !looksLikeHtml('video/mp4', '\x00\x00\x00 ftypisom'));

  const html = `<video data-fallback="https://cdn2.slicedrive.com/HK6O35Og1.mp4">
    <source src="https://cdn2.videy.co/HK6O35Og1.mp4" type="video/mp4">
  </video>`;
  const urls = mediaUrlsFromPlayerHtml(html, 'https://vceyy.de/HK6O35Og1.mp4');
  check('ambil source CDN', urls.includes('https://cdn2.videy.co/HK6O35Og1.mp4'));
  check('ambil data-fallback', urls.includes('https://cdn2.slicedrive.com/HK6O35Og1.mp4'));
  check('halaman .mp4 tetap file menurut path', kindFromUrl('https://vceyy.de/HK6O35Og1.mp4') === 'file');
  check(
    'pilih CDN bukan halaman pemutar',
    preferPlayerMediaUrl(
      ['https://vceyy.de/HK6O35Og1.mp4', 'https://cdn2.videy.co/HK6O35Og1.mp4'],
      'https://vceyy.de/HK6O35Og1.mp4'
    ) === 'https://cdn2.videy.co/HK6O35Og1.mp4'
  );
}
