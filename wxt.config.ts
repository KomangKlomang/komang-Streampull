import { defineConfig } from 'wxt';

const ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  publicDir: 'public',
  manifest: {
    name: 'Komang-streampull (KSP)',
    description:
      'Detect and download HLS, DASH, and MP4 streams from the current tab — for media you have the right to save.',
    action: {
      default_title: 'Komang-streampull (KSP)',
      default_icon: ICONS,
    },
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
      'nativeMessaging',
    ],
    host_permissions: ['<all_urls>'],
    commands: {
      'download-primary': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Unduh stream utama di tab aktif',
      },
    },
    icons: ICONS,
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['content-scripts/0-hook.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
        world: 'MAIN',
      },
      {
        matches: ['<all_urls>'],
        js: ['content-scripts/1-detector.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
      },
    ],
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // WXT serve (npm run dev) sengaja tidak menulis content_scripts ke
      // manifest — hanya lewat WebSocket HMR. Vite 8 + SW sering gagal,
      // jadi popup/deteksi kosong. Tulis ke manifest supaya load unpacked jalan.
      const scripts = manifest.content_scripts || [];
      const hasHook = scripts.some((cs) => cs.js?.some((j) => String(j).includes('0-hook')));
      if (!hasHook) {
        manifest.content_scripts = [
          ...scripts,
          {
            matches: ['<all_urls>'],
            js: ['content-scripts/0-hook.js'],
            run_at: 'document_start',
            all_frames: true,
            match_about_blank: true,
            world: 'MAIN',
          },
          {
            matches: ['<all_urls>'],
            js: ['content-scripts/1-detector.js'],
            run_at: 'document_start',
            all_frames: true,
            match_about_blank: true,
          },
          {
            matches: ['*://*.instagram.com/*'],
            js: ['content-scripts/ig-react.js'],
            run_at: 'document_idle',
            all_frames: true,
            world: 'MAIN',
          },
          {
            matches: ['*://*.instagram.com/*'],
            js: ['content-scripts/ig-ui.js'],
            run_at: 'document_idle',
            all_frames: true,
          },
        ];
      }
    },
  },
  vite: () => ({
    server: {
      cors: true,
    },
    plugins: [
      {
        name: 'ksp-dev-index',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url?.split('?')[0];
            if (url !== '/' && url !== '/index.html') return next();
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>KSP WXT Dev</title>
<style>
  body{font:15px/1.5 system-ui;max-width:560px;margin:48px auto;padding:0 20px;background:#0f1117;color:#eaecf0}
  a{color:#2dd4bf} code{background:#1f2430;padding:2px 6px;border-radius:4px}
  .card{display:block;padding:14px 16px;margin:10px 0;border:1px solid #2a3040;border-radius:10px;background:#171b24;color:#eaecf0;text-decoration:none}
</style></head><body>
<h1>Komang-streampull — WXT dev</h1>
<p>Server Vite ini bukan popup. Tes extension-nya lewat Chrome:</p>
<ol>
  <li>Buka <code>chrome://extensions</code></li>
  <li>Load unpacked folder <code>.output/chrome-mv3-dev</code> <em>atau</em> root repo (yang ada <code>manifest.json</code> + <code>src/</code>)</li>
  <li>Refresh tab video (bukan <code>file://</code>)</li>
</ol>
<p>Preview UI tanpa extension: <code>npm run dev:preview</code> lalu buka <code>http://localhost:5173/dev/</code></p>
</body></html>`);
          });
        },
      },
    ],
  }),
});
