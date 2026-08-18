// Penampung hasil unduhan.
//
// OpfsSink menulis langsung ke disk (Origin Private File System) sehingga file
// besar tidak pernah melewati RAM dan mendukung tulis acak — syarat mutlak untuk
// unduhan multi-koneksi ala IDM. MemorySink dipakai sebagai cadangan bila OPFS
// tidak tersedia (dan di lingkungan uji Node).

const FLUSH_THRESHOLD = 48 * 1024 * 1024;

export class MemorySink {
  constructor(mime = 'application/octet-stream') {
    this.mime = mime;
    this.parts = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.sparse = [];
    this.sequential = true;
    this.cursor = 0;
    this.bytes = 0;
  }

  async append(data) {
    this.pending.push(data);
    this.pendingBytes += data.byteLength;
    this.bytes += data.byteLength;
    this.cursor += data.byteLength;
    if (this.pendingBytes >= FLUSH_THRESHOLD) this.#flush();
  }

  async writeAt(pos, data) {
    if (this.sequential && pos === this.cursor) return this.append(data);
    this.sequential = false;
    this.sparse.push({ pos, data: data.slice() });
    this.bytes += data.byteLength;
  }

  #flush() {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  async finish() {
    if (this.sequential) {
      this.#flush();
      const blob = new Blob(this.parts, { type: this.mime });
      return { blob, size: blob.size, cleanup: async () => {} };
    }
    // Rakit ulang tulisan acak sesuai posisinya.
    this.#flush();
    const head = this.parts.length ? await new Blob(this.parts).arrayBuffer() : new ArrayBuffer(0);
    let end = head.byteLength;
    for (const s of this.sparse) end = Math.max(end, s.pos + s.data.byteLength);
    const out = new Uint8Array(end);
    out.set(new Uint8Array(head), 0);
    for (const s of this.sparse) out.set(s.data, s.pos);
    const blob = new Blob([out], { type: this.mime });
    return { blob, size: blob.size, cleanup: async () => {} };
  }
}

export class OpfsSink {
  constructor(dir, name, handle, stream, mime) {
    this.dir = dir;
    this.name = name;
    this.handle = handle;
    this.stream = stream;
    this.mime = mime;
    this.cursor = 0;
    this.bytes = 0;
    this.tail = Promise.resolve();
  }

  static async create(name, mime) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('streamgrab', { create: true });
    // Sisa dari job yang gagal sebelumnya tidak boleh ikut terbawa.
    await dir.removeEntry(name).catch(() => {});
    const handle = await dir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable({ keepExistingData: false });
    return new OpfsSink(dir, name, handle, stream, mime);
  }

  /** Tulisan diserialkan: satu FileSystemWritableFileStream per file. */
  #enqueue(fn) {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }

  async append(data) {
    const pos = this.cursor;
    this.cursor += data.byteLength;
    return this.writeAt(pos, data);
  }

  async writeAt(pos, data) {
    this.bytes += data.byteLength;
    return this.#enqueue(() => this.stream.write({ type: 'write', position: pos, data }));
  }

  async finish() {
    await this.tail;
    await this.stream.close();
    const file = await this.handle.getFile();
    return {
      blob: file,
      size: file.size,
      cleanup: async () => {
        try {
          await this.dir.removeEntry(this.name);
        } catch {
          /* sudah hilang */
        }
      },
    };
  }

  async abort() {
    try {
      await this.stream.abort();
    } catch {
      /* abaikan */
    }
    try {
      await this.dir.removeEntry(this.name);
    } catch {
      /* abaikan */
    }
  }
}

export function opfsAvailable() {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

/**
 * @param {{ mime?: string, name?: string, preferDisk?: boolean }} opts
 */
export async function createSink(opts = {}) {
  const { mime = 'application/octet-stream', name, preferDisk = true } = opts;
  if (preferDisk && opfsAvailable()) {
    try {
      return await OpfsSink.create(name || `sg-${Date.now()}-${Math.random().toString(36).slice(2)}.part`, mime);
    } catch {
      /* jatuh ke memori */
    }
  }
  return new MemorySink(mime);
}
