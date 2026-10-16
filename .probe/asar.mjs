import fs from 'node:fs';

const ASAR = 'D:\\DSH\\resources\\app.asar';
const fd = fs.openSync(ASAR, 'r');

function readAt(pos, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}

const head = readAt(0, 16);
const headerSize = head.readUInt32LE(12); // 8-byte pickle prefix (size u32, + size u32), then header size
const headerBuf = readAt(16, headerSize);
const header = JSON.parse(headerBuf.toString('utf8'));
const baseOffset = 16 + headerSize;

const sizeOf = head.readUInt32LE(8);

export function walk(node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix + '/' + name, out);
    }
  } else {
    out.push({ path: prefix, size: node.size, offset: node.offset, unpacked: !!node.unpacked });
  }
}

export function readFile(entry) {
  return readAt(baseOffset + Number(entry.offset), entry.size);
}

export function listAll() {
  const out = [];
  walk(header, '', out);
  return out;
}

export function findNode(p) {
  const parts = p.split('/').filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur.files || !cur.files[part]) return null;
    cur = cur.files[part];
  }
  return cur;
}

if (process.argv[2] === 'stat') {
  console.log(JSON.stringify({ headerSize, baseOffset, sizeOf, fileCount: listAll().length }));
}
