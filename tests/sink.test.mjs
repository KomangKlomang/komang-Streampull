// Regresi untuk penampung hasil unduhan.
//
// Bug yang ditangkap berkas ini: OpfsSink mengembalikan File mentah dari OPFS,
// yang tidak membawa tipe MIME. chrome.downloads lalu menebak jenisnya dan
// menyimpan video sebagai .txt. Seluruh tes sebelumnya lolos karena Node tidak
// punya OPFS, jadi hanya MemorySink yang pernah dijalankan.

import { installFakeOpfs } from './helpers/fake-opfs.mjs';

export default async function run({ check }) {
  const fake = installFakeOpfs();
  const { MemorySink, OpfsSink, createSink, opfsAvailable, sweepOpfs } = await import(
    '../src/lib/sink.js'
  );

  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const enc = (s) => new TextEncoder().encode(s);

  // -------------------------------------------------- bug utama: tipe MIME ---
  check('OPFS terdeteksi tersedia', opfsAvailable() === true);

  const sink = await createSink({ mime: 'video/mp2t', name: 'uji.ts' });
  check('createSink memilih OpfsSink saat OPFS ada', sink instanceof OpfsSink);

  await sink.append(enc('AAAA'));
  await sink.append(enc('BBBB'));
  const res = await sink.finish();

  check(
    'hasil unduhan membawa tipe MIME, bukan kosong',
    res.blob.type === 'video/mp2t',
    `type="${res.blob.type}" — inilah yang bikin Chrome menyimpannya sebagai .txt`
  );
  check('isi berkas utuh dan berurutan', new TextDecoder().decode(await bytesOf(res.blob)) === 'AAAABBBB');
  check('ukuran dilaporkan benar', res.size === 8, String(res.size));

  // ------------------------------------------------------- tulis acak ---
  // Jalur ini dipakai unduhan multi-koneksi dan belum pernah teruji di OPFS.
  const rand = await createSink({ mime: 'video/mp4', name: 'acak.mp4' });
  await rand.writeAt(8, enc('CCCC'));
  await rand.writeAt(0, enc('AAAA'));
  await rand.writeAt(4, enc('BBBB'));
  const randRes = await rand.finish();
  check(
    'tulisan tidak berurutan tersusun sesuai posisinya',
    new TextDecoder().decode(await bytesOf(randRes.blob)) === 'AAAABBBBCCCC',
    new TextDecoder().decode(await bytesOf(randRes.blob))
  );
  check('tipe MIME juga benar pada jalur tulis acak', randRes.blob.type === 'video/mp4');

  // tulisan tumpang tindih harus idempoten (bisa terjadi saat work stealing)
  const dup = await createSink({ mime: 'video/mp4', name: 'dup.mp4' });
  await dup.writeAt(0, enc('AAAABBBB'));
  await dup.writeAt(4, enc('BBBB'));
  const dupRes = await dup.finish();
  check(
    'menulis ulang byte yang sama tidak merusak hasil',
    new TextDecoder().decode(await bytesOf(dupRes.blob)) === 'AAAABBBB'
  );

  // ---------------------------------------------------------- pembersihan ---
  const dir = await fake.dir();
  check('berkas sementara ada sebelum dibersihkan', dir.names().includes('uji.ts'), dir.names().join(','));
  await res.cleanup();
  check('cleanup menghapus berkas sementara', !dir.names().includes('uji.ts'), dir.names().join(','));

  const aborted = await createSink({ mime: 'video/mp4', name: 'batal.mp4' });
  await aborted.append(enc('X'));
  await aborted.abort();
  check('abort() ikut menghapus berkas sementara', !dir.names().includes('batal.mp4'), dir.names().join(','));

  // ------------------------------------------------------------- sweep ---
  const stale = await dir.getFileHandle('lama.ts', { create: true });
  const w = await stale.createWritable();
  await w.write({ position: 0, data: enc('sisa job yang mati') });
  await w.close();
  // paksa berkas ini terlihat tua
  dir.store.get('lama.ts').lastModified = Date.now() - 5 * 60 * 60 * 1000;

  const fresh = await createSink({ mime: 'video/mp4', name: 'baru.mp4' });
  await fresh.append(enc('sedang dipakai'));

  const removed = await sweepOpfs(2 * 60 * 60 * 1000);
  check('sweep membuang sisa job lama', removed === 1, `${removed} dibuang`);
  check('sweep tidak menyentuh berkas yang masih baru', dir.names().includes('baru.mp4'), dir.names().join(','));
  check('berkas lama benar-benar hilang', !dir.names().includes('lama.ts'));

  // -------------------------------------------- MemorySink (regresi) ---
  const mem = new MemorySink('video/mp2t');
  await mem.append(enc('AA'));
  await mem.append(enc('BB'));
  const memRes = await mem.finish();
  check('MemorySink membawa tipe MIME', memRes.blob.type === 'video/mp2t');
  check('MemorySink isinya benar', new TextDecoder().decode(await bytesOf(memRes.blob)) === 'AABB');

  const memRand = new MemorySink('video/mp4');
  await memRand.writeAt(4, enc('BBBB'));
  await memRand.writeAt(0, enc('AAAA'));
  const memRandRes = await memRand.finish();
  check(
    'MemorySink menyusun tulisan acak sesuai posisi',
    new TextDecoder().decode(await bytesOf(memRandRes.blob)) === 'AAAABBBB'
  );

  // ---------------------------------------------- cadangan tanpa OPFS ---
  fake.uninstall();
  check('tanpa OPFS, opfsAvailable() false', opfsAvailable() === false);
  const fallback = await createSink({ mime: 'video/mp4', name: 'x.mp4' });
  check('createSink jatuh ke MemorySink', fallback instanceof MemorySink);
  check('cadangan tetap membawa MIME yang benar', (await fallback.finish()).blob.type === 'video/mp4');
}
