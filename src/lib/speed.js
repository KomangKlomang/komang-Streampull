// Pengukur throughput + pengendali jumlah koneksi adaptif.

export class SpeedMeter {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.samples = [];
    this.total = 0;
  }

  add(bytes) {
    this.total += bytes;
    this.samples.push([Date.now(), bytes]);
    this.#trim();
  }

  #trim() {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i][0] < cutoff) i++;
    if (i) this.samples.splice(0, i);
  }

  /** byte per detik dalam jendela pengamatan terakhir */
  get bps() {
    this.#trim();
    if (this.samples.length < 2) return 0;
    const span = (Date.now() - this.samples[0][0]) / 1000;
    if (span < 0.25) return 0;
    let sum = 0;
    for (const [, b] of this.samples) sum += b;
    return sum / span;
  }
}

/**
 * Menaikkan jumlah koneksi selama throughput masih ikut naik — mirip cara
 * congestion control mencari titik jenuh, bukan langsung membuka koneksi
 * sebanyak-banyaknya (yang justru memancing 429 dan malah melambat).
 *
 * Target hanya tumbuh, tidak pernah menyusut: menghentikan koneksi yang sedang
 * membaca rentang di tengah jalan lebih mahal daripada manfaatnya. Saat server
 * mulai menolak, pertumbuhan dibekukan dan backoff yang bekerja.
 */
export class AdaptiveConcurrency {
  constructor({ meter, start = 3, max = 8, probeMs = 2500 }) {
    this.meter = meter;
    this.target = Math.max(1, Math.min(start, max));
    this.max = Math.max(1, max);
    this.probeMs = probeMs;
    this.prev = 0;
    this.frozen = false;
    this.errors = 0;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.probeMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = this.meter.bps;
    if (this.frozen || this.target >= this.max) {
      this.prev = now;
      return;
    }
    // Naikkan bila jendela ini setidaknya 6% lebih cepat dari sebelumnya,
    // atau saat belum ada pembanding sama sekali.
    if (this.prev === 0 || now > this.prev * 1.06) this.target++;
    this.prev = now;
  }

  /** Server menolak/melambat — berhenti menambah koneksi. */
  onError(status) {
    this.errors++;
    if (status === 429 || status === 503 || this.errors >= 3) this.frozen = true;
  }
}

export function etaSeconds(remainingBytes, bps) {
  if (!bps || bps <= 0 || !Number.isFinite(remainingBytes) || remainingBytes <= 0) return 0;
  return remainingBytes / bps;
}
