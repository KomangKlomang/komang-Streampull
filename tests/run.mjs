#!/usr/bin/env node
// Penjalan tes Komang-streampull (KSP). Tanpa dependensi — cukup: node tests/run.mjs
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];

let pass = 0;
let fail = 0;
const failures = [];

function makeCheck(suite) {
  return (name, cond, extra = '') => {
    if (cond) {
      pass++;
      console.log(`  ok   ${name}`);
    } else {
      fail++;
      failures.push(`${suite}: ${name}${extra ? ` — ${extra}` : ''}`);
      console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
    }
  };
}

const files = (await readdir(here))
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !only || f.includes(only))
  .sort();

for (const file of files) {
  const suite = file.replace('.test.mjs', '');
  console.log(`\n=== ${suite} ===`);
  try {
    const mod = await import(pathToFileURL(path.join(here, file)).href);
    await mod.default({ check: makeCheck(suite) });
  } catch (err) {
    fail++;
    failures.push(`${suite}: suite gagal dijalankan — ${err?.message || err}`);
    console.log(`  FAIL suite tidak bisa dijalankan: ${err?.stack || err}`);
  }
}

console.log(`\n${pass} lulus, ${fail} gagal`);
if (failures.length) {
  console.log('\nYang gagal:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
