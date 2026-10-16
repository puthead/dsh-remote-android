import fs from 'node:fs';

const ASAR = 'D:\\DSH\\resources\\app.asar';
const fd = fs.openSync(ASAR, 'r');

const head = fs.readSync.bind(fs);
function readAt(pos, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}
const h0 = readAt(0, 16);
const headerSize = h0.readUInt32LE(12);
const header = JSON.parse(readAt(16, headerSize).toString('utf8'));
const baseOffset = 16 + headerSize;

function findNode(p) {
  const parts = p.split('/').filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur.files || !cur.files[part]) return null;
    cur = cur.files[part];
  }
  return cur;
}
function walk(node, prefix, out) {
  if (node.files) for (const [n, c] of Object.entries(node.files)) walk(c, prefix + '/' + n, out);
  else out.push({ path: prefix, size: node.size, offset: Number(node.offset) });
  return out;
}

const target = process.argv[2];
const n = findNode(target);
if (!n) { console.error('NOT FOUND: ' + target); process.exit(2); }
if (n.files) {
  const out = walk(n, target, []);
  console.log(JSON.stringify({ kind: 'dir', count: out.length, files: out.map(e => ({ p: e.path, size: e.size })) }, null, 1));
} else {
  process.stdout.write(readAt(baseOffset + Number(n.offset), n.size));
}
