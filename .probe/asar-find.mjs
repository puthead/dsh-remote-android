// 从 app.asar 里掏出包含某个关键字的文件（asar 头是一个 JSON，便于直接定位）。
import fs from 'node:fs';

const [, , asarPath, keyword, maxBytesArg] = process.argv;
const maxBytes = Number(maxBytesArg ?? 4000);
const buf = fs.readFileSync(asarPath);

// asar header: uint32 pickled -> 简化解析：先读 16 字节头，再读 header 长度
const headerSize = buf.readUInt32LE(12);
const headerJson = buf.subarray(16, 16 + headerSize).toString('utf8');
const header = JSON.parse(headerJson);
const baseOffset = 16 + headerSize;

const needle = Buffer.from(keyword, 'utf8');
const hits = [];

function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.files) { walk(entry, path); continue; }
    if (typeof entry.size !== 'number' || entry.size > 8 * 1024 * 1024) continue;
    const start = baseOffset + Number(entry.offset);
    const slice = buf.subarray(start, start + entry.size);
    if (slice.includes(needle)) hits.push({ path, size: entry.size, slice });
  }
}
walk(header, '');

console.log(`命中 ${hits.length} 个文件：`);
for (const h of hits) console.log(`  ${h.path}  (${h.size} B)`);
if (hits.length > 0) {
  const target = hits[0];
  const text = target.slice.toString('utf8');
  const at = text.indexOf(keyword);
  console.log(`\n--- ${target.path} @${at} 上下文（${maxBytes} B）---`);
  console.log(text.slice(Math.max(0, at - Math.floor(maxBytes / 3)), at + Math.floor((maxBytes * 2) / 3)));
}
