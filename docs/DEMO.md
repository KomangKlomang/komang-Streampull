# Demo recording

Do **not** record downloads from commercial or third-party hosting sites. A GIF of those flows is a takedown magnet and often copyrighted.

Use a **public test stream** that is meant for playback demos:

- Mux HLS fixture: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`
- [Big Buck Bunny](https://peach.blender.org/) (Creative Commons) via a player page you control, or a local `index.html` that points `<video>` / hls.js at a CC-licensed playlist.

## Record the extension (1–2 minutes)

1. Load KSP unpacked from the folder that contains `manifest.json`.
2. Open a **local or public** player page that uses the Mux fixture (or another CC-licensed playlist).
3. Open the KSP popup, wait until an HLS row appears, start a download.
4. Capture the popup + a completed file in `Downloads/KSP/` with ScreenToGif, ShareX, or `ffmpeg` from a region of the screen.
5. Drop the file in `docs/demo/` (for example `docs/demo/hls-mux.gif`) and link it from the README.

Until that file exists, the README links here instead of embedding a placeholder GIF.
