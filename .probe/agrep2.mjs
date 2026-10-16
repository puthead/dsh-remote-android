import fs from 'node:fs';

const ASAR = 'D:\\DSH\\resources\\app.asar';
const UNPACKED = 'D:\\DSH\\resources\\app.asar.unpacked';
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

const packed = [];
const unpackedPaths = [];
function walk(node, prefix) {
  if (node.files) { for (const [n, c] of Object.entries(node.files)) walk(c, prefix + '/' + n); return; }
  const off = Number(node.offset);
  if (node.unpacked || !Number.isFinite(off)) { unpackedPaths.push(prefix); return; }
  packed.push({ path: prefix, size: Number(node.size), offset: baseOffset + off });
}
walk(header, '');
packed.sort((a, b) => a.offset - b.offset);

function ownerOf(pos) {
  let lo = 0, hi = packed.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, f = packed[mid];
    if (f.offset <= pos && pos < f.offset + f.size) return f;
    if (pos < f.offset) hi = mid - 1; else lo = mid + 1;
  }
  return null;
}

const pat = new RegExp(process.argv[2], process.argv[3] === 'i' ? 'gi' : 'g');
const scopePrefix = process.argv[4] || null;

const buf = fs.readFileSync(ASAR);
const text = buf.toString('latin1');
const counts = new Map();
let raw = 0, owned = 0, orphan = 0;
let m;
pat.lastIndex = 0;
while ((m = pat.exec(text)) !== null) {
  raw++;
  const f = ownerOf(m.index);
  if (!f) { orphan++; }
  else { owned++; if (!scopePrefix || f.path.startsWith(scopePrefix)) counts.set(f.path, (counts.get(f.path) || 0) + 1); }
  if (m[0].length === 0) pat.lastIndex++;
}

// search unpacked payload separately
const upCounts = new Map();
let upRaw = 0;
function scanFile(p) {
  let s;
  try { s = fs.readFileSync(p).toString('latin1'); } catch { return; }
  pat.lastIndex = 0;
  let k = 0;
  while (pat.exec(s) !== null) { k++; if (pat.lastIndex === 0) break; }
  if (k) { upRaw += k; upCounts.set(p, k); }
}
function walkDir(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = dir + '\\' + e.name;
    if (e.isDirectory()) walkDir(full);
    else if (e.isFile()) {
      let sz = 0; try { sz = fs.statSync(full).size; } catch { continue; }
      if (sz < 8 * 1024 * 1024) scanFile(full);
    }
  }
}
walkDir(UNPACKED);

console.log('PATTERN "' + process.argv[2] + '" | packedRaw=' + raw + ' owned=' + owned + ' orphan=' + orphan
  + ' | unpackedHits=' + upRaw + ' | packedFiles=' + counts.size + ' unpackedFiles=' + upCounts.size);
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [p, c] of rows.slice(0, 50)) console.log('  P ' + c + '\t' + p);
const urows = [...upCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [p, c] of urows.slice(0, 25)) console.log('  U ' + c + '\t' + p);
