// Probe: 从 DSH 会话 jsonl 里列出 ask_user_question 相关记录的时间与形状。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const needle = process.argv[3] ?? 'ask_user_question';
const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
console.log(`lines=${lines.length}`);
const shapes = new Set();
for (const l of lines) {
  try {
    shapes.add(Object.keys(JSON.parse(l)).join(','));
  } catch {
    /* ignore */
  }
}
console.log('shapes:', [...shapes].slice(0, 12));
for (const l of lines) {
  if (!l.includes(needle)) continue;
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  const at = o.at ?? o.timestamp ?? o.time ?? o.createdAt ?? o.ts ?? '';
  const d = at ? new Date(at).toISOString() : '';
  console.log('---', at, d, o.kind ?? o.type ?? '', JSON.stringify(o).slice(0, 260));
}
