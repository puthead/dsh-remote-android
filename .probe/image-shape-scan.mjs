// 扫会话日志，取证「图片块」在 raw jsonl 里的真实形状（只打结构，绝不打印 base64/字节）。
// 目的：手机端内联渲染图片前，先确认三类来源各自的字段：
//   1) user/message 里的内联 image 块（手机发上来的图）
//   2) tool/result / assistant/message 里的 image 块（read_image、图表产物）
//   3) deliverables/presented 里的文件路径（工作区里的图表文件）
// 用法：node .probe/image-shape-scan.mjs [--days 14] [--sessions 80]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const HOME = process.env.USERPROFILE ?? process.env.HOME;
const SESSIONS_ROOT = path.join(HOME, '.dsh', 'sessions');

const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : dflt;
};
const DAYS = argOf('days', 21);
const MAX_SESSIONS = argOf('sessions', 120);

/** 与 .probe/transcript-dump.mjs 同一套多帧 zstd 走法。 */
function walkFrames(buf) {
  const parts = [];
  const isMagic = (i) => buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd;
  let start = 0;
  for (let i = 4; i < buf.length - 3; i += 1) {
    if (!isMagic(i)) continue;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, i)).toString('utf8'));
      start = i;
    } catch { /* 不是帧边界 */ }
  }
  try { parts.push(zstdDecompressSync(buf.subarray(start)).toString('utf8')); } catch { /* 尾部残帧 */ }
  return parts.join('');
}

function sessionFiles() {
  const out = [];
  for (const slug of readdirSync(SESSIONS_ROOT)) {
    const slugDir = path.join(SESSIONS_ROOT, slug);
    let entries;
    try { entries = readdirSync(slugDir); } catch { continue; }
    for (const dir of entries) {
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
        const file = path.join(slugDir, dir, name);
        try {
          const st = statSync(file);
          out.push({ file, slug, dir, mtime: st.mtimeMs, size: st.size });
        } catch { /* 不存在 */ }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);
}

const cutoff = Date.now() - DAYS * 86_400_000;

/** 一个 image 块 → 字段名 + 值规模（不含 data 本体）。 */
function imageShape(block) {
  const keys = Object.keys(block);
  const att = block.attachment && typeof block.attachment === 'object' ? block.attachment : null;
  const attKeys = att ? Object.keys(att) : [];
  const attShape = att
    ? `attachment{${attKeys.map((k) => `${k}=${typeof att[k] === 'string' && k !== 'attachmentId' ? JSON.stringify(String(att[k]).slice(0, 40)) : JSON.stringify(att[k])}`).join(', ')}}`
    : 'attachment=null';
  return `{keys=[${keys.join(',')}] mediaType=${block.mediaType ?? '-'} dataLen=${typeof block.data === 'string' ? block.data.length : '-'} name=${JSON.stringify(block.name ?? null)} ${attShape}}`;
}

function blocksOf(container) {
  if (Array.isArray(container)) return container;
  if (container && Array.isArray(container.content)) return container.content;
  return [];
}

let imageRecords = 0;
let scanned = 0;
const seenKinds = new Map();

for (const s of sessionFiles()) {
  if (s.mtime < cutoff) continue;
  scanned += 1;
  let lines;
  try { lines = walkFrames(readFileSync(s.file)).split('\n').filter((l) => l.trim()); } catch { continue; }
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ev = obj.event ?? obj;
    const data = ev.data ?? {};
    const imageBlocks = [];
    for (const c of [data.content, data.message?.content]) {
      for (const b of blocksOf(c)) if (b?.type === 'image') imageBlocks.push(b);
    }
    const deliverables = ev.type === 'deliverables/presented' && Array.isArray(data.files) ? data.files : null;
    if (imageBlocks.length === 0 && !deliverables) continue;
    imageRecords += 1;
    if (imageRecords > 60) continue;
    const where = `${s.dir}/${path.basename(s.file)}`;
    if (deliverables) {
      console.log(`[deliverables] ${where} seq=${ev.seq} files=${JSON.stringify(deliverables)}`);
      seenKinds.set('deliverables', (seenKinds.get('deliverables') ?? 0) + 1);
      continue;
    }
    for (const b of imageBlocks) {
      const kind = `${ev.type}/${data.message?.role ?? data.role ?? '?'}`;
      seenKinds.set(kind, (seenKinds.get(kind) ?? 0) + 1);
      console.log(`[${kind}] ${where} seq=${ev.seq} ${imageShape(b)}`);
    }
  }
}

console.log(`--- 扫过 ${scanned} 个会话，命中 ${imageRecords} 条含图记录；按来源计数：`);
for (const [k, v] of seenKinds) console.log(`    ${k}: ${v}`);
