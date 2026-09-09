export default defineContentScript({
  matches: ['*://*.instagram.com/*'],
  allFrames: true,
  runAt: 'document_idle',
  world: 'MAIN',
  main() {
    import('../src/ig/ig-react.js');
  },
});
