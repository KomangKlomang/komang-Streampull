// Tiruan Origin Private File System untuk Node.
//
// Tanpa ini, OpfsSink tidak pernah diuji sama sekali — dan justru di jalur
// itulah bug ".txt" bersembunyi: File hasil OPFS tidak membawa tipe MIME.
// getFile() di sini sengaja mengembalikan type kosong, meniru kasus terburuk.

class FakeWritable {
  constructor(entry) {
    this.entry = entry;
    this.closed = false;
  }

  async write(chunk) {
    if (this.closed) throw new Error('stream sudah ditutup');
    const { position = this.entry.data.length, data } = chunk;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const end = position + bytes.byteLength;
    if (end > this.entry.data.length) {
      const grown = new Uint8Array(end);
      grown.set(this.entry.data, 0);
      this.entry.data = grown;
    }
    this.entry.data.set(bytes, position);
    this.entry.lastModified = this.entry.clock();
  }

  async close() {
    this.closed = true;
  }

  async abort() {
    this.closed = true;
  }
}

class FakeFileHandle {
  constructor(name, entry) {
    this.kind = 'file';
    this.name = name;
    this.entry = entry;
  }

  async createWritable({ keepExistingData = false } = {}) {
    if (!keepExistingData) this.entry.data = new Uint8Array(0);
    return new FakeWritable(this.entry);
  }

  async getFile() {
    // Persis seperti Chrome pada berkas tanpa ekstensi dikenal: type kosong.
    return new File([this.entry.data], this.name, { lastModified: this.entry.lastModified });
  }
}

class FakeDirHandle {
  constructor(name, store, clock) {
    this.kind = 'directory';
    this.name = name;
    this.store = store;
    this.clock = clock;
    this.dirs = new Map();
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.dirs.has(name)) {
      if (!create) {
        const err = new Error('NotFoundError');
        err.name = 'NotFoundError';
        throw err;
      }
      this.dirs.set(name, new FakeDirHandle(name, new Map(), this.clock));
    }
    return this.dirs.get(name);
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.store.has(name)) {
      if (!create) {
        const err = new Error('NotFoundError');
        err.name = 'NotFoundError';
        throw err;
      }
      this.store.set(name, { data: new Uint8Array(0), lastModified: this.clock(), clock: this.clock });
    }
    return new FakeFileHandle(name, this.store.get(name));
  }

  async removeEntry(name) {
    if (!this.store.has(name)) {
      const err = new Error('NotFoundError');
      err.name = 'NotFoundError';
      throw err;
    }
    this.store.delete(name);
  }

  async *entries() {
    for (const name of [...this.store.keys()]) {
      yield [name, new FakeFileHandle(name, this.store.get(name))];
    }
  }

  names() {
    return [...this.store.keys()];
  }
}

/**
 * Pasang navigator.storage tiruan. Mengembalikan pegangan untuk inspeksi
 * dan fungsi untuk melepasnya kembali.
 */
export function installFakeOpfs({ now = () => Date.now() } = {}) {
  const root = new FakeDirHandle('', new Map(), now);
  const previous = globalThis.navigator;
  const storage = { getDirectory: async () => root };

  // Node punya navigator bawaan. Catat cara pemasangannya supaya
  // uninstall() benar-benar mengembalikan keadaan semula.
  let restore;
  if (previous && !('storage' in previous)) {
    Object.defineProperty(previous, 'storage', { value: storage, configurable: true });
    restore = () => {
      delete previous.storage;
    };
  } else if (previous) {
    const original = Object.getOwnPropertyDescriptor(previous, 'storage');
    Object.defineProperty(previous, 'storage', { value: storage, configurable: true });
    restore = () => {
      if (original) Object.defineProperty(previous, 'storage', original);
      else delete previous.storage;
    };
  } else {
    globalThis.navigator = { storage };
    restore = () => {
      delete globalThis.navigator;
    };
  }

  return {
    root,
    dir: async () => root.getDirectoryHandle('govideo', { create: true }),
    uninstall: () => restore(),
  };
}
