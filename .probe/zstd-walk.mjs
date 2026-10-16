// Probe: walk concatenated zstd frames in a DSH session log.
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const raw = readFileSync(file);
console.log('bytes =', raw.length);
console.log('head hex =', raw.subarray(0, 24).toString('hex'));

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
let i = 0;
while (true) {
  const at = raw.indexOf(MAGIC, i);
  if (at === -1) break;
  offsets.push(at);
  i = at + 4;
}
console.log('magic offsets =', offsets.length, offsets.slice(0, 12));

const parts = [];
let ok = 0;
let bad = 0;
for (let k = 0; k < offsets.length; k += 1) {
  const start = offsets[k];
  const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length;
  try {
    parts.push(zstdDecompressSync(raw.subarray(start, end)).toString('utf8'));
    ok += 1;
  } catch (err) {
    bad += 1;
    if (bad <= 3) console.log(`frame ${k} @${start} failed:`, String(err.message).slice(0, 100));
  }
}
const text = parts.join('');
console.log(`frames ok=${ok} bad=${bad} chars=${text.length}`);
const out = process.argv[3] ?? file + '.jsonl';
writeFileSync(out, text);
console.log('wrote', out);
