// Grep inside app.asar without dumping whole files.
// usage: node asar-grep.mjs <regex> [pathSubstringFilter] [maxHits]
import { listAll, readFile } from './asar.mjs';

const rx = new RegExp(process.argv[2], 'i');
const pathFilter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const maxHits = Number(process.argv[4] || 200);

const all = listAll().filter((e) => /\.(js|mjs|cjs|ts|json|yaml|yml|md)$/i.test(e.path));
const files = pathFilter ? all.filter((e) => pathFilter.test(e.path)) : all;
console.error(`[scan] ${files.length} files (of ${all.length} text-ish entries)`);

let hits = 0;
for (const e of files) {
  let text;
  try {
    text = readFile(e).toString('utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (rx.test(lines[i])) {
      hits++;
      const line = lines[i].length > 400 ? lines[i].slice(0, 400) + ' …' : lines[i];
      console.log(`${e.path}:${i + 1}: ${line.trim()}`);
      if (hits >= maxHits) {
        console.log(`[truncated at ${maxHits} hits]`);
        process.exit(0);
      }
    }
  }
}
console.error(`[done] ${hits} hits`);
