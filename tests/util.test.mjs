import { lruSet } from '../src/lib/util.js';

export default function ({ check }) {
  const m = new Map();
  for (const k of ['a', 'b', 'c']) lruSet(m, k, k.toUpperCase(), 2);
  check('ukuran map tidak melewati batas', m.size === 2, String(m.size));
  check('entri terlama dibuang', !m.has('a'));
  check('entri terbaru bertahan', m.get('c') === 'C');

  const lru = new Map();
  lruSet(lru, 'x', 1, 2);
  lruSet(lru, 'y', 2, 2);
  lruSet(lru, 'x', 9, 2); // sentuh lagi → 'x' jadi yang terbaru
  lruSet(lru, 'z', 3, 2);
  check('kunci yang dipakai ulang tidak ikut dibuang', lru.has('x') && lru.get('x') === 9);
  check('yang dibuang adalah yang paling lama tak tersentuh', !lru.has('y'));

  const one = new Map([['lama', 1]]);
  lruSet(one, 'baru', 2, 1);
  check('batas 1 hanya menyisakan yang terakhir', one.size === 1 && one.has('baru'));
}
