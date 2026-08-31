import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'text/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const DEV_BANNER = `
<style id="sg-dev-banner-style">
  .sg-dev-banner {
    position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 8px 14px; font: 12px/1.4 system-ui, sans-serif;
    background: #14532d; color: #bbf7d0; border-bottom: 1px solid #166534;
  }
  .sg-dev-banner a { color: #7dd3fc; }
  .sg-dev-banner b { color: #fff; }
  body.sg-dev-preview { padding-top: 40px !important; }
</style>
<div class="sg-dev-banner">
  <b>DEV PREVIEW</b>
  <span>UI StreamGrab di browser IDE — data mock, bukan extension asli</span>
  <a href="/dev/">Index</a>
  <a href="/dev/live/popup">Popup</a>
  <a href="/dev/live/studio">Studio</a>
</div>
`;

function injectLive(html, assetBase, scriptName) {
  const withBase = html.replace('<head>', `<head><base href="${assetBase}">`);
  const mock = '<script type="module" src="/dev/mock-chrome.js"></script>';
  const out = withBase.replace(
    `<script type="module" src="${scriptName}"></script>`,
    `${mock}\n    <script type="module" src="${scriptName}"></script>`
  );
  return out.replace('<body>', `<body class="sg-dev-preview">${DEV_BANNER}`);
}

function livePage(route) {
  if (route === '/dev/live/popup') {
    const raw = readFileSync(join(ROOT, 'src/popup/popup.html'), 'utf8');
    return injectLive(raw, '/src/popup/', 'popup.js');
  }
  if (route === '/dev/live/studio') {
    const raw = readFileSync(join(ROOT, 'src/dashboard/dashboard.html'), 'utf8');
    return injectLive(raw, '/src/dashboard/', 'dashboard.js');
  }
  return null;
}

function indexPage() {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>StreamGrab Dev</title>
<style>
  body { font: 15px/1.5 system-ui; max-width: 520px; margin: 48px auto; padding: 0 20px;
    background: #0f172a; color: #f1f5f9; }
  h1 { font-size: 20px; }
  a.card { display: block; padding: 16px; margin: 10px 0; border-radius: 8px;
    background: #1e293b; color: #38bdf8; text-decoration: none; border: 1px solid #334155; }
  a.card:hover { border-color: #22c55e; }
  code { background: #334155; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  p { color: #94a3b8; }
</style></head><body>
  <h1>StreamGrab — Dev Preview</h1>
  <p>Buka UI extension di browser IDE (Cursor / VS Code Simple Browser) tanpa reload extension Chrome.</p>
  <a class="card" href="/dev/live/popup"><strong>Popup</strong><br><span style="color:#94a3b8">Panel unduh 400px</span></a>
  <a class="card" href="/dev/live/studio"><strong>Studio</strong><br><span style="color:#94a3b8">Dashboard full-page</span></a>
  <p>Jalankan: <code>npm run dev</code> lalu buka <code>http://localhost:${PORT}/dev/</code></p>
</body></html>`;
}

function serveStatic(urlPath, res) {
  const rel = urlPath.replace(/^\//, '').split('?')[0];
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

createServer((req, res) => {
  const url = req.url?.split('?')[0] || '/';

  if (url === '/dev' || url === '/dev/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexPage());
    return;
  }

  const live = livePage(url);
  if (live) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(live);
    return;
  }

  serveStatic(url, res);
}).listen(PORT, () => {
  console.log(`StreamGrab dev preview: http://localhost:${PORT}/dev/`);
  console.log(`  Popup:  http://localhost:${PORT}/dev/live/popup`);
  console.log(`  Studio: http://localhost:${PORT}/dev/live/studio`);
});
