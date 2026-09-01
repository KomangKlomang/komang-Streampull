/**
 * Mock chrome.* untuk preview UI di browser IDE (tanpa install extension).
 * Load sebagai module pertama sebelum popup.js / dashboard.js.
 */

const store = {
  settings: {
    concurrency: 6,
    downloadFolder: 'KSP',
    askSaveLocation: false,
    minFileSize: 204800,
    keepPerTab: 60,
  },
  jobs: [
    {
      id: 'job_demo1',
      nameBase: 'Demo Video [1080p]',
      kind: 'hls',
      status: 'running',
      mode: 'engine',
      progress: { completed: 12, total: 48, bytes: 45_000_000, bps: 3_200_000, connections: 4, eta: 120 },
      warnings: [],
    },
    {
      id: 'job_demo3',
      nameBase: 'Episode 02 [720p]',
      kind: 'hls',
      status: 'running',
      mode: 'engine',
      progress: { completed: 6, total: 32, bytes: 18_000_000, bps: 1_800_000, connections: 3, eta: 90 },
      warnings: [],
    },
    {
      id: 'job_demo4',
      nameBase: 'Trailer',
      kind: 'file',
      status: 'pending',
      progress: { bytes: 0 },
    },
    {
      id: 'job_demo2',
      nameBase: 'Sample Clip',
      kind: 'file',
      status: 'done',
      savedPath: 'KSP/Sample Clip.mp4',
      progress: { bytes: 12_000_000 },
    },
  ],
  history: [
    {
      id: 'h1',
      name: 'Video Kemarin',
      status: 'done',
      bytes: 89000000,
      path: 'KSP/Video Kemarin.ts',
      kind: 'hls',
      finishedAt: Date.now() - 86400000,
      downloadId: 1,
    },
  ],
  media: [
    {
      id: 'abc123',
      kind: 'hls',
      url: 'https://example.com/stream/playlist.m3u8',
      verified: true,
      size: 95000000,
      duration: 720,
      label: '1080p',
    },
    {
      id: 'def456',
      kind: 'file',
      url: 'https://example.com/video.mp4',
      verified: null,
      size: 15000000,
    },
  ],
  startupErrors: [],
  thumb: null,
};

function mockDiag() {
  return {
    ok: true,
    responses: 42,
    recorded: 2,
    reasons: {},
    events: [],
    frames: [{ frameId: 0, url: 'https://example.com/watch', isTop: true, hooks: ['hls.js'] }],
    hooks: ['hls.js', 'fetch'],
    headerHosts: ['example.com'],
  };
}

function mockDashboard() {
  return {
    ok: true,
    startupErrors: store.startupErrors,
    settings: { ...store.settings },
    jobs: [...store.jobs],
    history: [...store.history],
    offscreen: true,
    tabs: [
      {
        tabId: 1,
        title: 'Demo Video — example.com',
        url: 'https://example.com/watch?v=demo',
        mediaCount: store.media.length,
        media: store.media.map((m) => ({ ...m })),
        blocked: false,
        diag: mockDiag(),
      },
    ],
  };
}

function handleMessage(msg) {
  const cmd = msg?.cmd || msg?.type;
  switch (cmd) {
    case 'state':
      return {
        media: store.media.map((m) => ({ ...m })),
        jobs: store.jobs.map((j) => ({ ...j })),
        settings: { ...store.settings },
        history: store.history.map((h) => ({ ...h })),
        startupErrors: store.startupErrors,
        thumb: store.thumb,
        blocked: false,
      };
    case 'diagnostics':
      return mockDiag();
    case 'dashboard':
      return mockDashboard();
    case 'settings':
      Object.assign(store.settings, msg.patch || {});
      return { ok: true, settings: store.settings };
    case 'overlay-download':
      store.jobs.unshift({
        id: 'job_' + Date.now(),
        nameBase: 'Unduhan overlay',
        kind: 'hls',
        status: 'running',
        progress: { completed: 0, total: 10, bytes: 0 },
      });
      return { ok: true, id: 'job_overlay' };
    case 'scan':
    case 'clear-media':
    case 'clear-jobs':
    case 'clear-history':
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'open-file':
    case 'show-folder':
    case 'probe':
      return {
        ok: true,
        duration: 720,
        segments: 48,
        warnings: [],
        variants: [
          { url: 'https://example.com/stream/1080.m3u8', label: '1080p', size: 90600000, estimated: true, resolution: '1920x1080' },
          { url: 'https://example.com/stream/720.m3u8', label: '720p', size: 42000000, estimated: true, resolution: '1280x720' },
          { url: 'https://example.com/stream/480.m3u8', label: '480p', size: 18000000, estimated: true },
          { url: 'https://example.com/stream/360.m3u8', label: '360p', size: 9000000, estimated: true },
        ],
      };
    case 'capture-thumb':
      store.thumb = {
        from: 'poster',
        at: Date.now(),
        width: 1920,
        height: 1080,
        duration: 720,
        url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#0f172a"/><rect x="118" y="64" width="84" height="52" rx="10" fill="#0d9488"/><polygon points="148,78 148,102 176,90" fill="#042f2e"/></svg>`
        ),
      };
      return { ok: true, playUrl: null, thumb: store.thumb };
    default:
      return { ok: true };
  }
}

globalThis.chrome = {
  runtime: {
    id: 'dev-preview-local',
    getURL: (path) => '/' + String(path || '').replace(/^\//, ''),
    sendMessage: (msg) => Promise.resolve(handleMessage(msg)),
    openOptionsPage: () => {
      window.open('/dev/live/studio', '_blank');
    },
    onMessage: { addListener: () => {} },
  },
  tabs: {
    query: () =>
      Promise.resolve([
        { id: 1, url: 'https://example.com/watch?v=demo', title: 'Demo Video — example.com' },
      ]),
    sendMessage: () => Promise.reject(new Error('content script tidak ada di dev preview')),
    create: ({ url }) => {
      window.open(url, '_blank');
      return Promise.resolve({});
    },
  },
  action: { openPopup: () => Promise.resolve() },
};

console.info('[KSP DEV] chrome API dimock — preview UI di browser IDE');
