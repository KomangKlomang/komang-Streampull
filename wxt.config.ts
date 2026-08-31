import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  publicDir: 'public',
  manifest: {
    name: 'StreamGrab',
    description:
      'Mendeteksi dan mengunduh stream video (HLS/m3u8, MP4 progresif) dari tab aktif, lengkap dengan spoofing Referer/Origin.',
    minimum_chrome_version: '116',
    permissions: [
      'webRequest',
      'declarativeNetRequest',
      'declarativeNetRequestWithHostAccess',
      'storage',
      'downloads',
      'offscreen',
      'scripting',
      'tabs',
      'cookies',
    ],
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
});
