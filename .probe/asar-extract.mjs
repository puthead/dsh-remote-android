// Extract an asar entry to a local file for reading.
// usage: node asar-extract.mjs <asarPath> <outPath>
import fs from 'node:fs';
import path from 'node:path';
import { listAll, findNode, readFile } from './asar.mjs';

const p = process.argv[2];
const out = process.argv[3];
let entry = listAll().find((e) => e.path === p);
if (!entry) {
  const node = findNode(p);
  if (node) console.error('found as node (dir?):', JSON.stringify(Object.keys(node.files || {})).slice(0, 300));
  console.error('NOT FOUND:', p);
  process.exit(2);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, readFile(entry));
console.log(`wrote ${out} (${entry.size} bytes)`);
