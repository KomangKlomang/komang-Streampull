# Komang-streampull (KSP)

[![tests](https://github.com/KomangKlomang/govideo/actions/workflows/tests.yml/badge.svg)](https://github.com/KomangKlomang/govideo/actions/workflows/tests.yml)

Chromium extension (Manifest V3) that **detects and downloads media streams from the current tab** — HLS (`.m3u8`), DASH (`.mpd`), and progressive MP4 — for content you have the right to save.

[Bahasa Indonesia → README.id.md](README.id.md)

---

## Authorized use

KSP is a learning project. The authors do not distribute copyrighted media, do not monetize this extension, and are not responsible for how you use it. Use it only for study and only on streams you have the right to save.

Use KSP only on streams you own, have a license to download, or that the site operator has made freely available. Circumventing DRM, paywalls, or access controls is not supported and will not be added.

A **store blocklist** disables detection and download on major commercial platforms (YouTube, Netflix, Disney+, and similar). Site operators can request more domains via an **[opt-out issue](https://github.com/KomangKlomang/govideo/issues/new?template=opt-out-request.yml)**.

---

## Install (unpacked)

1. Open `chrome://extensions` (Chrome, Edge, Brave, Opera — Chromium 116+).
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select **this repository folder** — the one that contains `manifest.json` (not `.output`).

You do not need `npm run build` to try it. A WXT zip is only for packaging.

5. **Pin the icon** — puzzle menu → Komang-streampull → pin.
6. **Refresh** any already-open video tab (F5) so content scripts reload.

Chrome has blocked `--load-extension` from the command line since version 137. Use **Load unpacked**.

### Optional zip build

```bash
npm install
npm run pack
```

Load the unpacked output under `.output/chrome-mv3`, or install the zip Chrome produces.

---

## Usage

1. Open a page that plays a stream you are allowed to save.
2. Click the KSP icon. If the list is empty: press **Play** in the popup, press **Scan**, or start playback on the page for a few seconds and reopen the popup.
3. Choose quality, or download the listed stream. Files go to `Downloads/KSP/` (changeable in Settings).

A public HLS fixture you can use without a commercial site is documented in [docs/DEMO.md](docs/DEMO.md).

### Convert `.ts` to `.mp4`

HLS Transport Stream files play in VLC as-is. If you need an `.mp4` container (remux, no re-encode):

```bash
ffmpeg -i "input.ts" -c copy -bsf:a aac_adtstoasc "output.mp4"
```

**ffmpeg.wasm is not bundled.** In-browser remux would remove the CLI step, but it is a large download and a later product decision — fMP4 / CMAF streams already save as `.mp4`.

---

## How it works (short)

KSP does not ship per-site extractors. It watches the same places a player must use: network responses, `fetch` / `XHR`, `video.src`, and common player APIs (hls.js, Video.js, JW Player, and similar). Playlists and files are verified before they are treated as media.

Extension-initiated fetches reuse request headers the page already sent, scoped to the extension (`tabIds: [-1]`), so ordinary tab traffic is unchanged.

### Diagnostics

The **Diagnostics** control in the popup shows which frames received the content script, which hooks ran, how many network responses were seen versus recorded as media, and why candidates were skipped.

---

## Tests and CI

```bash
npm test
```

No extra dependencies. GitHub Actions runs the same command on every push and pull request.

```bash
node tests/run.mjs sink
```

runs a single suite. The `sink` suite uses a fake OPFS helper because Node has no Origin Private File System.

---

## Permissions

| Permission | Why |
|---|---|
| `webRequest` + `<all_urls>` | See media URLs and the headers the page used |
| `declarativeNetRequest` | Apply those headers to extension-only download requests |
| `downloads` | Save the file |
| `offscreen` | Keep the download engine alive outside the service worker |
| `storage` | Per-tab detections and settings |
| `tabs` | Page title for filenames; map detections to a tab |
| `cookies` | Keep the site session when fetching segments |

Nothing is sent to a KSP server. Work stays in the browser.

---

## Limits

| Situation | What happens |
|---|---|
| Separate audio playlist (`#EXT-X-MEDIA:TYPE=AUDIO`) | Warning; use ffmpeg to mux |
| Live HLS without `#EXT-X-ENDLIST` | Only segments listed at that moment |
| Widevine / SAMPLE-AES / DRM | Download still offered, with a confirm dialog; the file may not play |
| Blocklisted site | Empty media list and a popup notice |
| Very large files | Written via OPFS (disk), not a giant in-memory Blob |

---

## License

[MIT](LICENSE) © 2026 KomangKlomang

## Dev preview (no extension reload)

```bash
npm run dev:preview
```

Then open `http://localhost:5173/dev/` for the live popup mock.

## Layout

```
manifest.json
src/background.js          service worker
src/content/               page hooks + isolated bridge
src/lib/                   playlist parsers, downloader, blocklist
src/popup/                 toolbar UI
tests/                     node tests/run.mjs
```
