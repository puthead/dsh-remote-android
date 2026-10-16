import fs from 'node:fs';
import zlib from 'node:zlib';
const [id] = process.argv.slice(2);
const dir = `C:\\Users\\Administrator\\.dsh\\sessions\\--D-Workspace-dsh_android--\\${id}`;
const src = `${dir}\\session.v4.jsonl.zstd`;
const raw = fs.readFileSync(src);
const offsets = [];
for (let i = 0; i + 3 < raw.length; i++) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i);
}
offsets.push(raw.length);
const parts = [];
for (let k = 0; k + 1 < offsets.length; k++) {
  try { parts.push(zlib.zstdDecompressSync(raw.subarray(offsets[k], offsets[k + 1])).toString('utf8')); }
  catch (e) { parts.push(`\n{"__decodeError":${JSON.stringify(String(e.message))}}\n`); }
}
const text = parts.join('');
const out = new URL(`./transcript-${id.slice(8, 16)}.jsonl`, import.meta.url);
fs.writeFileSync(out, text);
console.log('frames', offsets.length - 1, 'bytes', text.length);
const lines = text.split('\n').filter(Boolean);
console.log('records', lines.length);
const filter = process.argv[3];
for (const l of lines) {
  if (!filter || new RegExp(filter, 'i').test(l)) console.log('---', l.slice(0, Number(process.argv[4] ?? 1600)));
}
