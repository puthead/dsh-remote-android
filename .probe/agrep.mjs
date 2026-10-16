import fs from 'node:fs';

const ASAR = 'D:\\DSH\\resources\\app.asar';
const fd = fs.openSync(ASAR, 'r');
function readAt(pos, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}
const h0 = readAt(0, 16);
const headerSize = h0.readUInt32LE(12);
const header = JSON.parse(readAt(16, headerSize).toString('utf8'));
const baseOffset = 16 + headerSize;

const files = [];
function walk(node, prefix) {
  if (node.files) for (const [n, c] of Object.entries(node.files)) walk(c, prefix + '/' + n);
  else files.push({ path: prefix, size: Number(node.size), offset: baseOffset + Number(node.offset) });
}
walk(header, '');
files.sort((a, b) => a.offset - b.offset);

// find owning file for a data offset
function ownerOf(pos) {
  let lo = 0, hi = files.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = files[mid];
    if (f.offset <= pos && pos < f.offset + f.size) return f;
    if (pos < f.offset) hi = mid - 1; else lo = mid + 1;
  }
  return best;
}

const pattern = new RegExp(process.argv[2], process.argv[3] === 'i' ? 'gi' : 'g');
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null;
const scopePrefix = process.argv[5] || null;

const buf = fs.readFileSync(ASAR);
const counts = new Map();
let total = 0;
let m;
pattern.lastIndex = 0;
while ((m = pattern.exec(buf.toString('latin1'))) !== null) {
  const pos = m.index;
  const f = ownerOf(pos);
  if (f) {
    if (filter && !filter.test(f.path)) { if (m.index === pattern.lastIndex) pattern.lastIndex++; continue; }
    if (scopePrefix && !f.path.startsWith(scopePrefix)) { if (m.index === pattern.lastIndex) pattern.lastIndex++; continue; }
    counts.set(f.path, (counts.get(f.path) || 0) + 1);
    total++;
  }
  if (m[0].length === 0) pattern.lastIndex++;
}
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log('PATTERN: ' + process.argv[2] + '  totalHits=' + total + '  files=' + rows.length);
for (const [p, c] of rows.slice(0, 60)) console.log('  ' + c + '\t' + p);
