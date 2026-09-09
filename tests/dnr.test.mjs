import {
  RULE_ID_MAX,
  RULE_ID_MIN,
  buildHostRules,
  catchAllRule,
  createRuleIdPool,
  headerOps,
} from '../src/lib/dnr.js';

const HEADERS = {
  referer: 'https://situs.example/tonton',
  origin: 'https://situs.example',
  userAgent: 'KSP/2.0',
  cookie: 'sid=abc',
};

export default function ({ check }) {
  // ------------------------------------------------------------- id pool ---
  const nextId = createRuleIdPool();
  const first = nextId();
  check('id mulai di dalam rentang KSP', first > RULE_ID_MIN && first <= RULE_ID_MAX);
  check('id berikutnya naik', nextId() === first + 1);

  const tiny = createRuleIdPool(100, 102);
  const seq = [tiny(), tiny(), tiny(), tiny()];
  check('id berputar saat rentang habis', seq[3] === seq[1], seq.join(','));
  check('id tidak pernah keluar rentang', seq.every((id) => id > 100 && id <= 102));

  // ----------------------------------------------------------- headerOps ---
  const full = headerOps(HEADERS);
  check('empat header ditulis ulang', full.length === 4, String(full.length));
  check(
    'cookie ikut saat diizinkan',
    full.some((o) => o.header === 'cookie' && o.value === 'sid=abc')
  );
  check('cookie dibuang saat withCookie false', headerOps(HEADERS, { withCookie: false }).length === 3);
  check('header kosong tidak menghasilkan operasi', headerOps({}).length === 0);
  check('semua operasi bertipe set', full.every((o) => o.operation === 'set'));

  // --------------------------------------------------------- buildHostRules ---
  const pool = createRuleIdPool();
  const rules = buildHostRules(['a.example', 'b.example', 'a.example', ''], HEADERS, pool);
  check('host duplikat dan kosong dibuang', rules.length === 2, String(rules.length));
  check('id tiap aturan unik', rules[0].id !== rules[1].id);
  check('urlFilter memakai anchor host', rules[0].condition.urlFilter === '||a.example');
  check(
    'hanya permintaan extension yang kena',
    rules.every((r) => r.condition.tabIds.length === 1 && r.condition.tabIds[0] === -1)
  );
  check('tanpa header tidak ada aturan', buildHostRules(['a.example'], {}, pool).length === 0);
  check('daftar host kosong aman', buildHostRules(null, HEADERS, pool).length === 0);

  // ---------------------------------------------------------- catchAllRule ---
  const cat = catchAllRule(pool(), headerOps(HEADERS));
  check('catch-all prioritasnya di atas aturan host', cat.priority > rules[0].priority);
  check('catch-all cocok http dan https', cat.condition.regexFilter === '^https?://');
  check('catch-all juga dibatasi tabId -1', cat.condition.tabIds[0] === -1);
  check(
    'catch-all hanya untuk tipe media',
    cat.condition.resourceTypes.includes('media') && !cat.condition.resourceTypes.includes('sub_frame')
  );
}
