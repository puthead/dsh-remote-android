// 解压会话转录（zstd，可能是多帧拼接），打印每条记录摘要；图片 base64 只显示长度。
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const raw = readFileSync(file);

/** 扫描 0x28B52FFD 魔数，逐个独立帧解压；失败则在下一个魔数边界重试。 */
function walkFrames(buf) {
  const parts = [];
  let start = 0;
  const isMagic = (i) => buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd;
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

const text = walkFrames(raw);
const lines = text.split('\n').filter((l) => l.trim() !== '');
console.log(`compressed=${raw.length} chars=${text.length} records=${lines.length}`);
const shrink = (s, n = 500) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);

for (const [i, line] of lines.entries()) {
  let obj;
  try { obj = JSON.parse(line); } catch { console.log(`#${i} (unparsed) ${shrink(line, 200)}`); continue; }
  const ev = obj.event ?? obj;
  const data = ev.data ?? {};
  const bits = [`#${i}`, `rec=${obj.type ?? '-'}`, `ev=${ev.type ?? '-'}`, `seq=${ev.seq ?? '-'}`];
  if (data.message) {
    const m = data.message;
    const content = Array.isArray(m.content) ? m.content : [];
    bits.push(`role=${m.role ?? '?'}`);
    bits.push('parts=[' + content.map((p) => {
      if (p?.type === 'text') return `text:${JSON.stringify(shrink(String(p.text ?? ''), 600))}`;
      if (p?.type === 'image') return `IMAGE:${p.mediaType ?? '?'} dataLen=${String(p.data ?? '').length} name=${p.name ?? '-'} ref=${JSON.stringify(p.attachment ?? null)}`;
      return `${p?.type ?? '?'}:${shrink(JSON.stringify(p), 200)}`;
    }).join(' || ') + ']');
  }
  if (data.attachment) bits.push(`attachment=${shrink(JSON.stringify(data.attachment), 300)}`);
  if (data.error) bits.push(`ERROR=${shrink(JSON.stringify(data.error), 400)}`);
  if (data.result !== undefined) bits.push(`result=${shrink(typeof data.result === 'string' ? data.result : JSON.stringify(data.result), 400)}`);
  if (data.name) bits.push(`call=${data.name}`);
  if (data.arguments) bits.push(`args=${shrink(JSON.stringify(data.arguments), 200)}`);
  console.log(bits.join(' '));
}
