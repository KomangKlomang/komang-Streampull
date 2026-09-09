export default defineContentScript({
  matches: ['*://*.instagram.com/*'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    import('../src/ig/ig-content.js');
  },
});
