// Berjalan di MAIN world (konteks halaman) sejak document_start.
// Tugasnya: menangkap URL media yang dipakai player — termasuk yang lahir dari
// script terkompresi/obfuscated — lalu meneruskannya lewat window.postMessage.
// Semua patch dibungkus try/catch agar tidak pernah merusak halaman.

(() => {
  'use strict';
  if (window.__govideoHooked) return;
  window.__govideoHooked = true;

  const CHANNEL = 'GOVIDEO_PAGE';
  const MEDIA_RE = /\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv)(?:$|[?#])/i;
  const HINT_RE = /m3u8|\.mpd|\.mp4|\/hls\/|playlist/i;
  const STORY_HINT_RE =
    /video_versions|image_versions2|playable_url|browser_native_|cdninstagram\.com|fbcdn\.net\/v\//;
  const STORY_HOST_RE = /(cdninstagram\.com|fbcdn\.net|fbsbx\.com)$/i;
  const seen = new Set();
  // Dicatat supaya panel diagnostik bisa menunjukkan apa yang aktif di halaman ini.
  const installed = [];
  const mark = (name) => installed.push(name);

  function isStoryMediaUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (!STORY_HOST_RE.test(u.hostname)) return false;
      const path = u.pathname;
      return (
        /\.(jpe?g|png|webp|gif|mp4|m4v|mov|webm)(?:$)/i.test(path) || /\/(?:v|o1)\/t\d+/i.test(path)
      );
    } catch {
      return false;
    }
  }

  function harvestStoryMedia(node) {
    const out = [];
    const known = new Set();
    let steps = 0;
    function add(url) {
      if (!isStoryMediaUrl(url) || known.has(url)) return;
      known.add(url);
      out.push(url);
    }
    function walk(x, depth) {
      if (out.length >= 30 || steps++ > 8000 || x == null || depth > 14) return;
      if (typeof x === 'string') {
        add(x);
        return;
      }
      if (Array.isArray(x)) {
        if (x.length && x[0] && typeof x[0] === 'object' && (x[0].url || x[0].src) && typeof x[0].width === 'number') {
          const top = [...x].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
          add(top.url || top.src);
          return;
        }
        for (const item of x) walk(item, depth + 1);
        return;
      }
      if (typeof x !== 'object') return;
      for (const v of Object.values(x)) walk(v, depth + 1);
    }
    walk(node, 0);
    return out;
  }

  function report(url, source) {
    try {
      if (!url || typeof url !== 'string') return;
      if (url.startsWith('blob:') || url.startsWith('data:')) return;
      const abs = new URL(url, location.href).href;
      if (!MEDIA_RE.test(abs) && !isStoryMediaUrl(abs)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      window.postMessage({ channel: CHANNEL, url: abs, source }, '*');
    } catch {
      /* URL tidak valid */
    }
  }

  function reportAll(text, source) {
    if (typeof text !== 'string' || !text) return;
    const re = /https?:\/\/[^\s"'`\\<>()]+?\.(?:m3u8|m3u|mpd|mp4|m4v|webm|mkv|flv)(?:\?[^\s"'`\\<>()]*)?/gi;
    let m;
    let n = 0;
    while ((m = re.exec(text)) && n++ < 60) report(m[0], source);

    // Bentuk umum di player: file:"//cdn/x.m3u8" atau "hls":"\/\/cdn\/x.m3u8"
    const rel = /["'](?:file|src|hls|source|url|playlist|video)["']?\s*[:=]\s*["']((?:https?:)?\\?\/\\?\/[^"']+?\.(?:m3u8|mp4|mpd))["']/gi;
    while ((m = rel.exec(text)) && n++ < 120) report(m[1].replace(/\\\//g, '/'), source);
  }

  function keepNativeToString(patched, original) {
    try {
      Object.defineProperty(patched, 'toString', {
        value: () => Function.prototype.toString.call(original),
        writable: true,
        configurable: true,
      });
    } catch {
      /* abaikan */
    }
  }

  /** Pasang jebakan pada global yang belum tentu sudah ada saat ini. */
  function trapGlobal(name, onValue) {
    try {
      let stored = window[name];
      if (stored !== undefined) stored = onValue(stored) ?? stored;
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          return stored;
        },
        set(v) {
          try {
            stored = onValue(v) ?? v;
          } catch {
            stored = v;
          }
        },
      });
    } catch {
      /* properti tidak bisa didefinisikan ulang */
    }
  }

  function reportDrm(keySystem) {
    try {
      window.postMessage({ channel: CHANNEL, drm: true, keySystem: String(keySystem || '') }, '*');
    } catch {
      /* abaikan */
    }
  }

  try {
    if (typeof navigator.requestMediaKeySystemAccess === 'function') {
      const nativeEme = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function requestMediaKeySystemAccess(keySystem) {
        reportDrm(keySystem);
        return nativeEme.apply(navigator, arguments);
      };
      mark('eme');
    }
  } catch {
    /* abaikan */
  }

  // ---------------------------------------------------------------- fetch ---
  function harvestApiResponse(text, url, source) {
    try {
      if (!text || text.length > 3_000_000) return;
      if (!STORY_HINT_RE.test(text) && !/video_versions|image_versions2|graphql/i.test(String(url))) return;
      const json = JSON.parse(text);
      for (const u of harvestStoryMedia(json)) report(u, source);
    } catch {
      /* bukan JSON */
    }
  }

  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      const patched = function fetch(input, init) {
        try {
          report(typeof input === 'string' ? input : input?.url, 'fetch');
        } catch {
          /* abaikan */
        }
        const resPromise = nativeFetch.apply(this, arguments);
        try {
          const reqUrl = typeof input === 'string' ? input : input?.url || '';
          if (/graphql|\/api\/v1\//i.test(reqUrl)) {
            resPromise
              .then((res) => {
                try {
                  res
                    .clone()
                    .text()
                    .then((text) => harvestApiResponse(text, reqUrl, 'ig-api'))
                    .catch(() => {});
                } catch {
                  /* abaikan */
                }
                return res;
              })
              .catch(() => {});
          }
        } catch {
          /* abaikan */
        }
        return resPromise;
      };
      keepNativeToString(patched, nativeFetch);
      window.fetch = patched;
      mark('fetch');
    }
  } catch {
    /* abaikan */
  }

  // ------------------------------------------------------ XMLHttpRequest ---
  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const patchedOpen = function open(method, url) {
      try {
        this.__sgUrl = url;
        report(url, 'xhr');
      } catch {
        /* abaikan */
      }
      return nativeOpen.apply(this, arguments);
    };
    keepNativeToString(patchedOpen, nativeOpen);
    XMLHttpRequest.prototype.open = patchedOpen;

    const nativeSend = XMLHttpRequest.prototype.send;
    const patchedSend = function send() {
      try {
        this.addEventListener('load', function onLoad() {
          try {
            if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
            harvestApiResponse(this.responseText, this.__sgUrl, 'ig-api');
          } catch {
            /* abaikan */
          }
        });
      } catch {
        /* abaikan */
      }
      return nativeSend.apply(this, arguments);
    };
    keepNativeToString(patchedSend, nativeSend);
    XMLHttpRequest.prototype.send = patchedSend;
    mark('xhr');
  } catch {
    /* abaikan */
  }

  // -------------------------------------------------------------- atob ---
  // Situs ter-obfuscate sering menyimpan URL dalam base64 dan membukanya saat
  // runtime. Membaca hasil atob jauh lebih tahan banting daripada menebak
  // bentuk obfuscation-nya secara statis.
  try {
    const nativeAtob = window.atob;
    if (typeof nativeAtob === 'function') {
      const patched = function atob(data) {
        const out = nativeAtob.apply(this, arguments);
        try {
          if (typeof out === 'string' && out.length < 300000 && HINT_RE.test(out)) {
            reportAll(out, 'atob');
          }
        } catch {
          /* abaikan */
        }
        return out;
      };
      keepNativeToString(patched, nativeAtob);
      window.atob = patched;
      mark('atob');
    }
  } catch {
    /* abaikan */
  }

  // ---------------------------------------------------------- JSON.parse ---
  // Konfigurasi player kerap datang sebagai JSON (termasuk __NEXT_DATA__).
  try {
    const nativeParse = JSON.parse;
    const patched = function parse(text) {
      const out = nativeParse.apply(this, arguments);
      try {
        if (typeof text === 'string' && text.length < 2e6 && STORY_HINT_RE.test(text)) {
          for (const url of harvestStoryMedia(out)) report(url, 'story');
        }
        if (typeof text === 'string' && text.length < 500000 && HINT_RE.test(text)) {
          reportAll(text, 'json');
        }
      } catch {
        /* abaikan */
      }
      return out;
    };
    keepNativeToString(patched, nativeParse);
    JSON.parse = patched;
    mark('JSON.parse');
  } catch {
    /* abaikan */
  }

  // -------------------------------------------------- <video>/<source> src ---
  try {
    for (const proto of [HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!desc?.set) continue;
      Object.defineProperty(proto, 'src', {
        ...desc,
        set(value) {
          try {
            report(value, 'element');
          } catch {
            /* abaikan */
          }
          return desc.set.call(this, value);
        },
      });
    }
    const nativeSetAttr = Element.prototype.setAttribute;
    const patchedSetAttr = function setAttribute(name, value) {
      try {
        if (typeof name === 'string' && /^(src|data-src|data-file)$/i.test(name)) {
          report(value, 'attr');
        }
      } catch {
        /* abaikan */
      }
      return nativeSetAttr.apply(this, arguments);
    };
    keepNativeToString(patchedSetAttr, nativeSetAttr);
    Element.prototype.setAttribute = patchedSetAttr;
    mark('element.src');
  } catch {
    /* abaikan */
  }

  // ------------------------------------------------------------- hls.js ---
  // Mayoritas situs streaming modern memakai hls.js; loadSource() menerima URL
  // playlist yang sudah jadi, apa pun cara halaman menyembunyikannya.
  trapGlobal('Hls', (Hls) => {
    try {
      const proto = Hls?.prototype;
      if (proto && typeof proto.loadSource === 'function' && !proto.__sgPatched) {
        const native = proto.loadSource;
        proto.loadSource = function loadSource(url) {
          try {
            report(url, 'hls.js');
          } catch {
            /* abaikan */
          }
          return native.apply(this, arguments);
        };
        proto.__sgPatched = true;
        mark('hls.js');
      }
    } catch {
      /* abaikan */
    }
    return Hls;
  });

  // ---------------------------------------------------- player berbasis fungsi ---
  // jwplayer('x').setup({...}), videojs('x', {...}), DPlayer/Clappr/Plyr:
  // semuanya menerima konfigurasi berisi URL sumber.
  function wrapPlayerFactory(factory, label) {
    if (typeof factory !== 'function' || factory.__sgWrapped) return factory;
    const wrapped = function (...args) {
      for (const arg of args) harvestConfig(arg);
      const inst = factory.apply(this, args);
      try {
        patchInstance(inst, label);
      } catch {
        /* abaikan */
      }
      return inst;
    };
    try {
      Object.setPrototypeOf(wrapped, factory);
      Object.assign(wrapped, factory);
    } catch {
      /* abaikan */
    }
    wrapped.__sgWrapped = true;
    mark(label);
    return wrapped;
  }

  function patchInstance(inst, label) {
    if (!inst || typeof inst !== 'object') return;
    for (const method of ['setup', 'src', 'load', 'loadSource', 'switchVideo']) {
      const native = inst[method];
      if (typeof native !== 'function' || native.__sgWrapped) continue;
      const patched = function (...args) {
        for (const arg of args) harvestConfig(arg);
        return native.apply(this, args);
      };
      patched.__sgWrapped = true;
      try {
        inst[method] = patched;
      } catch {
        /* properti hanya-baca */
      }
    }
  }

  for (const name of ['jwplayer', 'videojs', 'DPlayer', 'Clappr', 'Plyr', 'fluidPlayer']) {
    trapGlobal(name, (v) => wrapPlayerFactory(v, name));
  }

  function harvestConfig(config, depth = 0) {
    if (!config || depth > 5) return;
    if (typeof config === 'string') {
      report(config, 'player');
      return;
    }
    if (Array.isArray(config)) {
      for (const item of config) harvestConfig(item, depth + 1);
      return;
    }
    if (typeof config !== 'object') return;
    for (const key of ['file', 'src', 'url', 'sources', 'source', 'playlist', 'hls', 'video', 'streams']) {
      if (key in config) harvestConfig(config[key], depth + 1);
    }
  }

  // ------------------------------------------------ P.A.C.K.E.R. unpacker ---
  // eval(function(p,a,c,k,e,d){...}('...',N,M,'a|b|c'.split('|'),0,{}))
  function unpack(source) {
    const m =
      /}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\s*\.split\(\s*'\|'\s*\)/s.exec(
        source
      );
    if (!m) return '';
    let [, payload, radixStr, countStr, dict] = m;
    const radix = parseInt(radixStr, 10);
    const count = parseInt(countStr, 10);
    const words = dict.split('|');
    if (!Number.isFinite(radix) || !Number.isFinite(count)) return '';

    payload = payload.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

    const toBase = (n) => {
      const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let out = '';
      let v = n;
      do {
        out = digits[v % radix] + out;
        v = Math.floor(v / radix);
      } while (v > 0);
      return out;
    };

    const map = new Map();
    for (let i = 0; i < count; i++) map.set(toBase(i), words[i] || toBase(i));
    return payload.replace(/\b\w+\b/g, (w) => map.get(w) ?? w);
  }

  // ------------------------------------------------- dekoder statis lain ---

  /** "\x68\x74\x74\x70" dan "h" → teks biasa. */
  function decodeEscapes(text) {
    if (!/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i.test(text)) return '';
    try {
      return text
        .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    } catch {
      return '';
    }
  }

  /** Buka literal base64 yang isinya ternyata URL. */
  function decodeBase64Literals(text) {
    const found = [];
    try {
      const re = /['"]([A-Za-z0-9+/]{24,}={0,2})['"]/g;
      let m;
      let n = 0;
      while ((m = re.exec(text)) && n++ < 80) {
        try {
          const decoded = atob(m[1]);
          if (/https?:\/\//i.test(decoded) || HINT_RE.test(decoded)) found.push(decoded);
        } catch {
          /* bukan base64 valid */
        }
      }
    } catch {
      /* abaikan */
    }
    return found.join('\n');
  }

  /** "https://a" + "b/x.m3u8" → "https://ab/x.m3u8" (diulang untuk rantai panjang). */
  function joinConcats(text) {
    if (!text.includes('+')) return '';
    let out = text;
    const re = /(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1\s*\+\s*(['"])((?:\\.|(?!\3)[^\\\r\n])*)\3/g;
    for (let i = 0; i < 6; i++) {
      const next = out.replace(re, (_, q, a, __, b) => `${q}${a}${b}${q}`);
      if (next === out) break;
      out = next;
    }
    return out === text ? '' : out;
  }

  function scanText(text, source) {
    if (!text) return;
    reportAll(text, source);
    if (text.includes('eval(function(p,a,c,k,e')) reportAll(unpack(text), `${source}:unpacked`);
    reportAll(decodeEscapes(text), `${source}:escapes`);
    reportAll(decodeBase64Literals(text), `${source}:base64`);
    reportAll(joinConcats(text), `${source}:concat`);
  }

  function deepScan() {
    try {
      for (const el of document.querySelectorAll('video, source, [data-src], [data-file]')) {
        const vid = el.tagName === 'VIDEO' ? el : el.closest?.('video');
        const playing = vid && vid.paused === false;
        report(
          el.getAttribute('src') ||
            el.getAttribute('data-src') ||
            el.getAttribute('data-file') ||
            el.getAttribute('data-url') ||
            el.getAttribute('data-fallback'),
          playing ? 'playing' : 'dom'
        );
        if (el.currentSrc) report(el.currentSrc, playing ? 'playing' : 'dom');
      }
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const base = href.split('?')[0].toLowerCase();
        if (/\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv|ogv|ogg)$/.test(base)) report(a.href, 'dom-link');
      }
      try {
        const host = location.hostname;
        if (/(^|\.)(instagram\.com|facebook\.com|fb\.com|messenger\.com|whatsapp\.com)$/i.test(host)) {
          for (const img of document.querySelectorAll('img')) {
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w < 160 || h < 90) continue;
            report(img.currentSrc || img.src, 'story');
          }
        }
      } catch {
        /* abaikan */
      }
      for (const script of document.querySelectorAll('script')) {
        scanText(script.textContent || '', 'inline-script');
      }
      // Data JSON tertanam (Next.js/Nuxt/props server-rendered).
      for (const node of document.querySelectorAll(
        'script[type="application/json"], script[type="application/ld+json"], #__NEXT_DATA__'
      )) {
        scanText(node.textContent || '', 'json-block');
      }
      // Sapuan terakhir atas seluruh markup (menangkap atribut/JSON tertanam).
      scanText(document.documentElement?.outerHTML?.slice(0, 2000000) || '', 'html');
    } catch {
      /* abaikan */
    }
  }

  // ------------------------------------------------------------- preview ---
  // Ambil still di extension tanpa memutar video halaman.
  // Frame dari <video> yang sudah punya piksel (boleh paused). Kalau kanvas
  // ter-taint, atau belum ada frame, jatuh ke poster/og:image.
  function videoMeta(v) {
    return {
      width: v.videoWidth,
      height: v.videoHeight,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
    };
  }

  function grabFrame(v) {
    if (!v || v.videoWidth <= 0 || v.videoHeight <= 0) return false;
    try {
      const scale = Math.min(1, 480 / v.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      postThumb({ ...videoMeta(v), dataUrl, from: 'frame' });
      return true;
    } catch {
      return false;
    }
  }

  function pickPreviewVideo() {
    const list = [];
    try {
      for (const v of document.querySelectorAll('video')) {
        if (v.videoWidth > 0 && v.videoHeight > 0) list.push(v);
      }
    } catch {
      return null;
    }
    const playing = list.find((v) => !v.paused && !v.ended);
    if (playing) return playing;
    list.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    return list[0] || null;
  }

  function captureThumb() {
    const best = pickPreviewVideo();

    if (best) {
      if (grabFrame(best)) return;
      const url = posterUrl();
      if (url) {
        postThumb({ ...videoMeta(best), url, from: 'poster' });
        return;
      }
    }

    const url = posterUrl();
    if (url) {
      postThumb({ url, from: 'poster' });
      return;
    }

    // Decode satu still lewat seek, tanpa play().
    try {
      const v = [...document.querySelectorAll('video')].find((el) => el.readyState >= 1);
      if (!v || v.videoWidth > 0 || !v.paused) return;
      const finish = () => {
        grabFrame(v);
      };
      v.addEventListener('seeked', finish, { once: true });
      v.addEventListener('loadeddata', finish, { once: true });
      if (Number.isFinite(v.duration) && v.duration > 0 && v.duration !== Infinity && v.currentTime === 0) {
        v.currentTime = Math.min(0.2, v.duration / 20);
      }
    } catch {
      /* abaikan */
    }
  }

  function posterUrl() {
    try {
      const raw =
        document.querySelector('video[poster]')?.getAttribute('poster') ||
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
        document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
        document.querySelector('link[rel="image_src"]')?.getAttribute('href') ||
        '';
      return raw ? new URL(raw, location.href).href : '';
    } catch {
      return '';
    }
  }

  function postThumb(thumb) {
    try {
      window.postMessage({ channel: CHANNEL, thumb }, '*');
    } catch {
      /* abaikan */
    }
  }

  function forcePlay() {
    try {
      for (const v of document.querySelectorAll('video')) {
        v.muted = true;
        const p = v.play();
        if (p?.catch) p.catch(() => {});
      }
      const btn = document.querySelector(
        '.jw-icon-display, .vjs-big-play-button, .play, #player, .plyr__control--overlaid, [class*="play-button"]'
      );
      btn?.click?.();
    } catch {
      /* abaikan */
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.channel !== 'GOVIDEO_CMD') return;
    if (ev.data.cmd === 'deep-scan') deepScan();
    if (ev.data.cmd === 'force-play') forcePlay();
    if (ev.data.cmd === 'capture-thumb') captureThumb();
  });

  // Sapuan otomatis ringan setelah halaman & player sempat memasang diri.
  const autoScans = [1200, 3500, 8000];
  for (const delay of autoScans) setTimeout(deepScan, delay);
  // Begitu player punya frame pertama, ambil pratinjaunya.
  for (const delay of [2500, 6000]) setTimeout(captureThumb, delay);
  document.addEventListener('DOMContentLoaded', () => setTimeout(deepScan, 300), { once: true });

  // Beri tahu lapisan isolated world hook apa saja yang aktif di frame ini.
  const announce = () => {
    try {
      window.postMessage({ channel: CHANNEL, status: { hooks: [...new Set(installed)] } }, '*');
    } catch {
      /* abaikan */
    }
  };
  announce();
  setTimeout(announce, 4000);
})();
