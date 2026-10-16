// Read-only: dump a slice of one file inside DSH app.asar.
import fs from 'node:fs';

const file = process.argv[2];
const needle = process.argv[3];
const before = Number(process.argv[4] ?? 400);
const after = Number(process.argv[5] ?? 1600);
const all = process.argv[6] === 'all';

const text = fs.readFileSync(file, 'utf8');
if (all) {
  console.log(text);
} else {
  let i = text.indexOf(needle);
  if (i === -1) { console.log(`NOT FOUND: ${needle}`); process.exit(0); }
  let n = 0;
  while (i !== -1 && n < 8) {
    console.log(`\n===== hit ${++n} @${i} =====`);
    console.log(text.slice(Math.max(0, i - before), i + after));
    i = text.indexOf(needle, i + 1);
  }
}
