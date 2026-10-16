// 一次性探针：在 asar 归档里找 modelCatalog / selectModel 的 RPC 定义（只读，不改仓库源码）。
import { readFileSync, writeFileSync } from 'node:fs';

const ARCHIVE = 'D:\\DSH\\resources\\app.asar';
const buf = readFileSync(ARCHIVE);
const headerSize = buf.readUInt32LE(4);
const headerJsonSize = buf.readUInt32LE(12);
const headerText = buf.toString('utf8', 16, 16 + headerJsonSize);
const header = JSON.parse(headerText);
const baseOffset = 8 + headerSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p);
    else if (typeof entry.offset === 'string' || typeof entry.offset === 'number') files.push({ path: p, entry });
  }
})(header, '');

const hits = [];
for (const f of files) {
  if (!/\.(js|mjs|cjs|json)$/.test(f.path)) continue;
  const off = baseOffset + Number(f.entry.offset);
  const size = Number(f.entry.size);
  if (!Number.isFinite(off) || !Number.isFinite(size) || size > 40_000_000) continue;
  let text;
  try {
    text = buf.toString('utf8', off, off + size);
  } catch {
    continue;
  }
  for (const needle of ['modelCatalog', 'selectModel', 'SessionSelectModelRequest', 'routableProviders']) {
    if (text.includes(needle)) hits.push({ path: f.path, needle, size });
  }
}
writeFileSync('D:\\Workspace\\dsh_android\\.probe\\asar-hits.json', JSON.stringify({ fileCount: files.length, hits }, null, 2));
console.log(`files=${files.length} hits=${hits.length}`);
for (const h of hits) console.log(`${h.needle}\t${h.path}\t${h.size}`);
