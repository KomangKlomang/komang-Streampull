# Komang-streampull (KSP)

[English README →](README.md)

Extension Chromium (Manifest V3) untuk **mendeteksi dan mengunduh stream media dari tab aktif** — HLS (`.m3u8`), DASH (`.mpd`), dan MP4 progresif — untuk materi yang kamu berhak simpan.

---

## Penggunaan yang diizinkan

KSP adalah proyek pembelajaran. Penulis tidak mendistribusikan materi berhak cipta, tidak memonetisasi extension ini, dan tidak bertanggung jawab atas cara kamu memakainya. Pakai hanya untuk belajar, dan hanya pada stream yang kamu berhak simpan.

Pakai KSP hanya pada stream yang kamu miliki, yang dilisensikan untuk diunduh, atau yang operator situsnya memang sediakan secara bebas. Melewati DRM, paywall, atau kontrol akses **tidak didukung** dan tidak akan ditambahkan.

**Daftar opt-out (blocklist)** menonaktifkan deteksi dan unduhan di platform komersial besar (YouTube, Netflix, Disney+, dan sejenisnya). Operator situs bisa meminta domain tambahan lewat **[issue opt-out](https://github.com/KomangKlomang/govideo/issues/new?template=opt-out-request.yml)**.

---

## Pasang (unpacked)

1. Buka `chrome://extensions` (Chrome, Edge, Brave, Opera — Chromium ≥ 116).
2. Nyalakan **Developer mode**.
3. **Load unpacked**.
4. Pilih **folder repositori ini** — yang berisi `manifest.json` (bukan `.output`).

Tidak perlu `npm run build` untuk dipakai. Build WXT hanya untuk zip/distribusi.

5. **Pin ikonnya** — menu puzzle → Komang-streampull → pin.
6. **Refresh** tab video yang sudah terbuka (F5) supaya content script ikut reload.

Flag `--load-extension` dari command line **sudah diblokir Chrome sejak versi 137**. Satu-satunya jalur yang bekerja adalah **Load unpacked**.

### Zip / build (opsional)

```bash
npm install
npm run pack
```

---

## Pakai

1. Buka halaman yang memutar stream yang kamu boleh simpan.
2. Klik ikon KSP. Kalau daftarnya kosong: tekan **Putar** di panel, **Pindai**, atau mainkan videonya 2–3 detik lalu buka lagi panelnya.
3. Pilih kualitas atau unduh stream yang tampil. Berkas masuk `Downloads/KSP/` (bisa diubah di Pengaturan).

Contoh stream publik untuk demo (bukan situs komersial) ada di [docs/DEMO.md](docs/DEMO.md).

### Ubah `.ts` jadi `.mp4`

Hasil HLS-TS diputar normal di VLC. Kalau butuh wadah `.mp4` (remux, tanpa encode ulang):

```bash
ffmpeg -i "input.ts" -c copy -bsf:a aac_adtstoasc "output.mp4"
```

**ffmpeg.wasm tidak disertakan.** Remux di dalam browser menghapus langkah command line, tapi bundlenya besar — itu keputusan produk belakangan. Stream fMP4/CMAF sudah tersimpan sebagai `.mp4`.

---

## Cara kerjanya (singkat)

KSP tidak memakai extractor per situs. Ia mengamati titik yang player mana pun harus lewati: respons jaringan, `fetch` / `XHR`, `video.src`, dan API player umum (hls.js, Video.js, JW Player, dan sejenisnya). Playlist dan berkas diverifikasi sebelum diperlakukan sebagai media.

Permintaan unduhan dari extension memakai header yang halaman sudah kirim, terbatas pada trafik extension (`tabIds: [-1]`), jadi tab biasa tidak tersentuh.

Panel **Diagnostik** menampilkan frame yang terpasangi script, hook yang aktif, dan alasan kandidat dilewati.

---

## Tes dan CI

```bash
npm test
```

Tanpa dependensi tambahan. GitHub Actions menjalankan perintah yang sama di setiap push dan pull request.

---

## Izin

| Izin | Alasan |
|---|---|
| `webRequest` + `<all_urls>` | Melihat URL media dan header yang dipakai halaman |
| `declarativeNetRequest` | Menerapkan header itu hanya untuk permintaan unduhan dari extension |
| `downloads` | Menyimpan hasil |
| `offscreen` | Menjalankan mesin unduhan di luar service worker |
| `storage` | Daftar deteksi per tab + pengaturan |
| `tabs` | Judul halaman untuk nama berkas |
| `cookies` | Mempertahankan sesi saat mengambil segmen |

Tidak ada data yang dikirim ke server KSP; semuanya lokal di browser.

---

## Batasan

Widevine / SAMPLE-AES tetap bisa diklik **Unduh**, dengan konfirmasi dulu — berkasnya mungkin tidak bisa diputar. Situs di blocklist menampilkan daftar kosong di popup; tombol di video tetap bisa memaksa unduhan setelah peringatan. Stream live tanpa `#EXT-X-ENDLIST` hanya mengambil segmen yang tercantum saat itu.

---

## Lisensi

[MIT](LICENSE) © 2026 KomangKlomang
