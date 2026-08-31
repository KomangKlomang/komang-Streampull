/**
 * Mock chrome.* untuk preview UI di browser IDE (tanpa install extension).
 * Load sebagai module pertama sebelum popup.js / dashboard.js.
 */

const store = {
  settings: {
    concurrency: 6,
    downloadFolder: 'StreamGrab',
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
      id: 'job_demo2',
      nameBase: 'Sample Clip',
      kind: 'file',
      status: 'done',
      savedPath: 'StreamGrab/Sample Clip.mp4',
      progress: { bytes: 12_000_000 },
    },
  ],
  history: [
    {
      id: 'h1',
      name: 'Video Kemarin',
      status: 'done',
      bytes: 89000000,
      path: 'StreamGrab/Video Kemarin.ts',
      kind: 'hls',
      finishedAt: Date.now() - 86400000,
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
        thumb: null,
      };
    case 'diagnostics':
      return mockDiag();
    case 'dashboard':
      return mockDashboard();
    case 'settings':
      Object.assign(store.settings, msg.patch || {});
      return { ok: true, settings: store.settings };
    case 'download':
      store.jobs.unshift({
        id: 'job_' + Date.now(),
        nameBase: 'Unduhan baru',
        kind: 'hls',
        status: 'running',
        progress: { completed: 0, total: 10, bytes: 0 },
      });
      return { ok: true };
    case 'scan':
    case 'capture-thumb':
    case 'clear-media':
    case 'clear-jobs':
    case 'clear-history':
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'probe':
      return { ok: true };
    default:
      return { ok: true };
  }
}

globalThis.chrome = {
  runtime: {
    id: 'dev-preview-local',
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

console.info('[StreamGrab DEV] chrome API dimock — preview UI di browser IDE');
