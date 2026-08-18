# StreamGrab

Extension Chromium (Manifest V3) untuk **mendeteksi dan mengunduh stream video** dari tab
yang sedang dibuka — termasuk situs hosting yang memakai player ter-obfuscate,
playlist HLS, dan proteksi hotlink berbasis `Referer`.

Dibuat khusus untuk kasus seperti `https://streamrizz.com/d/<id>`, tapi bekerja generik
di situs mana pun yang menyajikan `.m3u8` atau file video progresif.

---

## Cara kerjanya

Alih-alih membongkar enkripsi/obfuscation JavaScript situs (yang berubah tiap minggu),
StreamGrab **membiarkan player situs itu sendiri yang membuka URL aslinya**, lalu menangkapnya
dari tiga arah sekaligus:

| Lapisan | Berkas | Yang ditangkap |
|---|---|---|
| Sniffer jaringan | `src/background.js` | Semua request `.m3u8`/`.mpd`/`.mp4` beserta header aslinya (`Referer`, `Origin`, `Cookie`, `User-Agent`) lewat `chrome.webRequest` |
| Hook halaman (MAIN world) | `src/content/hook.js` | Patch `fetch`, `XMLHttpRequest.open`, setter `video.src`, `Element.setAttribute` |
| Hook player | `src/content/hook.js` | `Hls.prototype.loadSource` (hls.js), `jwplayer`, `videojs`, `DPlayer`, `Clappr`, `Plyr`, `fluidPlayer` |
| Hook deobfuscation | `src/content/hook.js` | `atob()` dan `JSON.parse()` — apa pun yang dibuka script saat runtime ikut terbaca |
| Pemindai statis | `src/content/hook.js` | P.A.C.K.E.R., escape `\xNN`/`\uNNNN`, literal base64, penggabungan string, dan blok JSON tertanam (`__NEXT_DATA__`, `application/json`) |

### Panel diagnostik

Tombol **Diagnostik** di bagian bawah panel menunjukkan apa yang sebenarnya dilihat
engine di tab ini, supaya "tidak jalan" bisa dipersempit jadi penyebab yang konkret:

- berapa frame yang berhasil dipasangi content script, beserta URL-nya
- hook mana saja yang benar-benar aktif di konteks halaman (`fetch`, `atob`,
  `JSON.parse`, `hls.js`, dan seterusnya)
- berapa respons jaringan terpantau versus berapa yang tercatat sebagai media
- daftar respons yang **dilewati beserta alasannya** — tipe tidak dikenali, dianggap
  potongan segmen, di bawah ukuran minimum, verifikasi ditolak server

Di atasnya ada satu kalimat kesimpulan yang menunjuk lapisan tempat rantainya putus:
content script tidak jalan, hook gagal terpasang, webRequest bisu, lalu lintas ada tapi
tak berbentuk media, atau server menolak permintaan kita. Penyebab paling dasar selalu
diprioritaskan, bukan gejala hilirnya.

### Situs dengan URL yang disembunyikan

Situs streaming modern jarang menaruh URL video apa adanya. Pola yang lazim: URL
disimpan base64, dipecah jadi escape heksadesimal, dirangkai dari potongan string,
atau ditaruh di JSON server-rendered — lalu diserahkan ke `hls.js`.

StreamGrab tidak memakai aturan khusus per situs (extractor hardcoded patah begitu
situsnya ganti bundler). Pendekatannya: **cegat di titik yang tidak bisa dihindari
situs mana pun**. Seobfuscated apa pun kodenya, pada akhirnya URL asli harus melewati
`atob`, `JSON.parse`, `fetch`, atau `loadSource` — dan semuanya sudah dipasangi hook.
Sniffer jaringan menjadi jaring terakhir: begitu videonya diputar, URL-nya terlihat.

Karena pemindaian ini agresif, sebagian kandidat bisa saja bukan video hidup.
Setiap URL hasil pemindaian halaman **diverifikasi otomatis** (ambil 2 KB pertama,
periksa apakah benar `#EXTM3U`/MPD/kontainer video). Yang lolos ditandai
*terverifikasi* dan naik ke atas daftar; yang gagal ditandai *tidak merespons*.

Content script berjalan di **semua frame** (`all_frames: true`), jadi video yang dipasang lewat
`<iframe>` embed lintas-domain tetap terbaca.

### Melewati proteksi hotlink

CDN situs-situs ini biasanya menolak request yang `Referer`-nya bukan halaman aslinya.
Fetch dari extension tidak boleh menyetel `Referer` (header terlarang di `fetch()`), jadi
StreamGrab memasang aturan **`declarativeNetRequest` sesi** yang menulis ulang
`Referer` / `Origin` / `Cookie` khusus untuk request yang berasal dari extension
(`tabIds: [-1]`, jadi trafik tab biasa tidak tersentuh). Aturan itu dicabut lagi
begitu job selesai.

Nilai header yang dipakai bukan tebakan — persis yang tadi dikirim halaman saat memutar video.

### Pratinjau video

Panel menampilkan **frame asli** dari video sebelum kamu mengunduhnya. Frame diambil
dengan menggambar elemen `<video>` yang sedang termuat ke `<canvas>`, jadi yang terlihat
benar-benar isi videonya — bukan tebakan. Kalau kanvasnya ter-*taint* (sumber lintas-domain
tanpa CORS), otomatis jatuh ke `poster` / `og:image` halaman. Resolusi dan durasi ikut
ditampilkan. Tombol **Ambil frame** menangkap ulang kapan saja.

### Ukuran video untuk stream HLS

Situs yang menyajikan MP4 biasa memberi tahu ukurannya lewat header `Content-Length`.
HLS tidak: playlist `.m3u8` hanya berisi daftar segmen, tanpa satu pun angka ukuran.
Itu sebabnya stream HLS dulu tampil tanpa ukuran sementara situs lain menampilkannya.

Sekarang ukurannya diukur sendiri, otomatis begitu panel dibuka:

1. Ambil tiga segmen contoh di posisi 25%, 50%, dan 75% playlist — sengaja menghindari
   segmen pertama dan terakhir yang biasanya lebih pendek.
2. Ukurannya didapat lewat permintaan **satu byte**: header `Content-Range` membocorkan
   ukuran penuh tanpa perlu mengunduh segmennya.
3. Hitung laju byte per detik dari sampel (bukan rata-rata per segmen, karena durasi
   segmen sering tidak seragam), lalu kalikan durasi total playlist.
4. Untuk master playlist, kualitas tertinggi diukur langsung, sisanya diskalakan menurut
   `BANDWIDTH` masing-masing — dikalibrasi dengan hasil pengukuran tadi, karena
   `BANDWIDTH` yang ditulis encoder kerap dilebihkan.

Hasilnya meleset sekitar 4% dari ukuran sebenarnya, dengan tiga permintaan 1 byte.
Angka estimasi ditandai `~`. Kalau semua segmen memakai `#EXT-X-BYTERANGE`, ukurannya
dihitung persis tanpa permintaan jaringan sama sekali.

Durasi dan resolusi ikut tampil, dan progres unduhan HLS memakai estimasi ini sebagai
pembanding byte.

### Kecepatan: multi-koneksi ala IDM

Unduhan file progresif memakai **banyak permintaan HTTP `Range` paralel** atas satu file.
Ini inti trik IDM/XDM: server video hampir selalu membatasi laju *per koneksi*, jadi
delapan koneksi mendekati delapan kali laju satu koneksi sampai batas jaringan tercapai.

Dua hal yang membuatnya lebih baik daripada sekadar membagi rata di awal:

- **Dynamic segmentation** — begitu satu koneksi selesai, ia mencuri separuh sisa
  pekerjaan koneksi yang paling tertinggal. Tanpa ini, satu koneksi lambat menahan
  seluruh unduhan di ekornya. (Ini persis fitur yang bikin IDM terasa cepat.)
- **Koneksi adaptif** — jumlah koneksi dinaikkan bertahap selama throughput masih ikut
  naik, lalu berhenti di titik jenuh. Membuka 16 koneksi sekaligus justru memancing
  `429 Too Many Requests` dan berakhir lebih lambat.

Untuk HLS, segmen sudah paralel sejak awal; yang ditambahkan adalah ramp adaptif yang sama
plus laporan kecepatan/ETA/jumlah koneksi.

**Adakah yang lebih cepat dari IDM/XDM?** Jujur: tidak ada trik ajaib. Batas sesungguhnya
adalah throttle server dan bandwidth kamu — semua akselerator (IDM, XDM, aria2) menang dari
hal yang sama, yaitu paralelisme. Yang bisa ditambahkan di atas itu: retry per-rentang yang
melanjutkan dari posisi terakhir (bukan mengulang dari nol), dan menulis langsung ke disk
sehingga file besar tidak tercekik RAM. Keduanya sudah ada di sini. HTTP/3 ditangani Chrome
sendiri kalau server mendukungnya.

### Perakitan berkas

Unduhan berjalan di **offscreen document**, bukan di service worker, supaya tidak ikut mati
saat Chrome men-suspend worker di tengah unduhan.

- **HLS TS** → segmen digabung berurutan jadi satu `.ts` (bisa langsung diputar di VLC/mpv/MPC).
- **HLS fMP4** (`#EXT-X-MAP`) → init segment + fragmen digabung jadi `.mp4` yang valid.
- **AES-128** (`#EXT-X-KEY`) → kunci diambil, IV diturunkan dari atribut `IV` atau nomor urut
  media sequence, lalu didekripsi dengan WebCrypto. Ada jalur cadangan untuk segmen tanpa
  padding PKCS#7.
- **`#EXT-X-BYTERANGE`** → diambil dengan header `Range`.
- **MP4 progresif** → multi-koneksi Range, ditulis acak sesuai offset masing-masing.

Hasil ditulis ke **OPFS** (Origin Private File System) — file di disk, bukan di RAM. Itu yang
memungkinkan tulis acak dari banyak koneksi sekaligus sekaligus menghapus plafon `Blob`
~2 GB. Bila OPFS tidak tersedia, mesin jatuh ke penampung memori yang memindahkan tiap
~48 MB ke `Blob`. File sementara dihapus otomatis setelah unduhan tersimpan.

---

## Pasang

1. Buka `chrome://extensions` (Chrome, Edge, Brave, Opera — semua Chromium ≥ 116).
2. Nyalakan **Developer mode** di pojok kanan atas.
3. Klik **Load unpacked**, pilih folder `D:\web 2.0\streamgrab`.
4. **Pin ikonnya** — lihat di bawah.

Tidak ada proses build. Tidak ada dependensi npm.

### Ikonnya tidak muncul di toolbar

Ini normal, bukan kerusakan: **extension unpacked tidak pernah otomatis di-pin.**
Chrome menaruhnya di menu Extensions, bukan langsung di toolbar.

1. Klik ikon **puzzle 🧩** di kanan address bar.
2. Cari **StreamGrab** di daftar.
3. Klik ikon **pin 📌** di sebelahnya — barulah ikonnya nangkring di toolbar.

Kalau StreamGrab **tidak ada** di daftar puzzle itu:

- Pastikan folder yang dipilih adalah folder yang **berisi `manifest.json` langsung**
  (`D:\web 2.0\streamgrab`), bukan folder induknya.
- Lihat kartu StreamGrab di `chrome://extensions` — kalau ada tombol **Errors**
  (kuning/merah), klik dan baca isinya.
- Tombol **service worker** di kartu itu membuka DevTools background; tab Console
  di situ menampilkan error runtime.
- Popup juga menampilkan spanduk merah sendiri kalau service worker gagal start
  atau ada API yang tidak tersedia di browser tersebut.

> Catatan: memuat extension lewat flag `--load-extension` dari command line **sudah
> diblokir Chrome sejak versi 137**. Satu-satunya jalur yang bekerja adalah tombol
> **Load unpacked** di `chrome://extensions`.

---

## Pakai

1. Buka halaman videonya, misal `https://streamrizz.com/d/zxsuoute1j1q`.
2. Klik ikon StreamGrab. Kalau daftarnya masih kosong:
   - tekan **Putar** — extension memaksa `<video>`/tombol play supaya player memuat stream, atau
   - tekan **Pindai** — memindai ulang script halaman, atau
   - mainkan videonya sendiri 2–3 detik lalu buka lagi panelnya.
3. Entri **HLS** akan muncul. Tekan **Cek kualitas** untuk melihat daftar resolusi
   (kalau URL tersebut master playlist), lalu **Unduh** pada kualitas yang diinginkan.
4. Berkas tersimpan di `Downloads/StreamGrab/<judul halaman>.<ext>`.

Angka **Paralel** di bawah mengatur berapa segmen diunduh bersamaan (default 6).
Turunkan ke 2–3 kalau server mulai membalas 403/429.

### Ubah `.ts` jadi `.mp4`

Hasil HLS-TS diputar normal di VLC. Kalau butuh `.mp4` (remux, tanpa encode ulang):

```bash
ffmpeg -i "input.ts" -c copy -bsf:a aac_adtstoasc "output.mp4"
```

---

## Kalau mentok

Tombol **Detail** di tiap entri menampilkan URL asli, `Referer` yang terdeteksi, dan
**perintah `ffmpeg` siap tempel** dengan header yang benar. Itu jalur cadangan untuk kasus
yang tidak ditangani extension:

| Situasi | Solusi |
|---|---|
| Audio ada di track terpisah (`#EXT-X-MEDIA:TYPE=AUDIO` punya URI sendiri) | Pakai perintah ffmpeg — penggabungan track butuh muxer sungguhan. Extension akan memberi peringatan bila ini terdeteksi. |
| Berkas sangat besar | Sudah ditangani lewat OPFS (tulis ke disk). Kalau OPFS tidak tersedia dan file > ~2 GB, pakai perintah ffmpeg. |
| Stream live tanpa `#EXT-X-ENDLIST` | Extension hanya mengambil segmen yang tercantum saat itu. Untuk merekam terus, pakai ffmpeg. |
| DASH (`.mpd`) | Hanya dideteksi, tidak diunduh. Pakai perintah ffmpeg / `yt-dlp`. |
| Widevine / SAMPLE-AES | **Tidak didukung dan tidak akan ditambahkan.** |
| Situs yang stream-nya tetap tidak muncul | Pakai perintah ffmpeg bila kamu sudah punya URL-nya. Penyadapan `SourceBuffer.appendBuffer` dan perekaman ulang layar **sengaja tidak disertakan** — keduanya khusus untuk melumpuhkan mekanisme anti-unduh, bukan kemampuan umum. |
| Unduhan langsung MP4 kena 403 | Tekan **Unduh via engine** — jalur ini memakai fetch bersama aturan header. |

---

## Struktur berkas

```
manifest.json
icons/                     ikon 16/32/48/128
src/
  background.js            service worker: deteksi, aturan DNR, koordinasi job
  content/
    hook.js                MAIN world: patch player, unpacker, deep scan
    detector.js            isolated world: jembatan ke service worker
  offscreen/
    offscreen.html/.js     mesin unduhan berumur panjang
  lib/
    m3u8.js                parser HLS (master, media, KEY, MAP, BYTERANGE)
    accel.js               multi-koneksi Range + dynamic segmentation
    speed.js               pengukur throughput + pengendali koneksi adaptif
    sink.js                penampung hasil: OPFS (disk) / memori
    downloader.js          engine HLS + file, AES-128
    net.js                 fetch + retry/backoff
    util.js                helper bersama
  popup/
    popup.html/.css/.js    antarmuka
```

## Izin yang diminta, dan alasannya

| Izin | Alasan |
|---|---|
| `webRequest` + `<all_urls>` | Melihat URL media dan header asli yang dipakai halaman |
| `declarativeNetRequest` | Menulis ulang `Referer`/`Origin`/`Cookie` untuk request extension sendiri |
| `downloads` | Menyimpan hasil |
| `offscreen` | Menjalankan unduhan di luar service worker |
| `storage` | Menyimpan daftar deteksi per tab + preferensi |
| `tabs` | Judul halaman untuk nama berkas, dan memetakan deteksi ke tab |
| `cookies` | Mempertahankan sesi saat mengambil segmen |

Tidak ada data yang dikirim ke mana pun; semuanya lokal di browser.

---

Pastikan kamu memang berhak mengunduh materi yang bersangkutan.
