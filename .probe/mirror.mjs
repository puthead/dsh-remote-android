import fs from 'node:fs';
import path from 'node:path';

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

const OUT = 'D:\\Workspace\\dsh_android\\.probe\\mirror';
const specs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const spec of specs) {
  const n = findNode(spec.src);
  if (!n) { console.log('MISS ' + spec.src); continue; }
  if (n.files) {
    const out = walk(n, spec.src, []);
    for (const e of out) {
      const rel = e.path.slice(spec.src.length).replace(/^\//, '');
      const dest = path.join(OUT, spec.dest || '', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, readAt(baseOffset + e.offset, e.size));
    }
    console.log('DIR  ' + spec.src + ' -> ' + out.length + ' files');
  } else {
    const dest = path.join(OUT, spec.dest || '', spec.src.split('/').pop());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readAt(baseOffset + Number(n.offset), n.size));
    console.log('FILE ' + spec.src + ' -> ' + dest);
  }
}
