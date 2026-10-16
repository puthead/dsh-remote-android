// Scan DSH session logs (concatenated zstd frames) for duplicate user turns.
// Usage: node dup-scan.mjs <sessionsDir> [maxFiles]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decompressMultiFrame, parseJsonl } from '../.runtime/zstd-probe.mjs';

const dir = process.argv[2];
const maxFiles = Number(process.argv[3] ?? 12);

const HASH = 'e598c759f492a15f206b76263ffc8ebfa65fa9ca1fc71368ffad275032fc5e45';

const entries = readdirSync(dir)
  .map((name) => {
    const file = join(dir, name, 'session.v4.jsonl.zstd');
    return existsSync(file) ? { name, file, mtime: statSync(file).mtimeMs } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, maxFiles);

for (const e of entries) {
  let events;
  try {
    events = parseJsonl(decompressMultiFrame(readFileSync(e.file)).toString('utf8'));
  } catch (err) {
    console.log(`${e.name}  READ-FAIL ${err.message}`);
    continue;
  }
  const users = events.filter((ev) => ev.type === 'user/message');
  const spliced = events.filter((ev) => ev.type === 'agent/inbox/spliced');
  const text = (ev) => (ev.data?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const counts = new Map();
  for (const ev of users) counts.set(text(ev), (counts.get(text(ev)) ?? 0) + 1);
  const dupes = [...counts.entries()].filter(([, n]) => n > 1);
  const hasHash = readFileSync(e.file).length > 0;
  console.log(
    `\n=== ${e.name}  mtime=${new Date(e.mtime).toISOString()}  events=${events.length} userMsgs=${users.length} spliced=${spliced.length}`,
  );
  if (dupes.length) {
    console.log(`  DUPLICATE user/message texts (${dupes.length}):`);
    for (const [t, n] of dupes) {
      console.log(`    x${n}  ${JSON.stringify(t.slice(0, 80))}`);
      const hits = users.filter((ev) => text(ev) === t);
      for (const h of hits) {
        console.log(`        seq=${h.seq} time=${new Date(h.time).toISOString()} imgs=${(h.data?.content ?? []).filter((c) => c.type === 'image').length}`);
      }
    }
  }
  for (const ev of users) {
    const imgs = (ev.data?.content ?? []).filter((c) => c.type === 'image');
    if (imgs.length && JSON.stringify(imgs).includes(HASH.slice(0, 24))) {
      console.log(`  IMG-HASH-HIT seq=${ev.seq} time=${new Date(ev.time).toISOString()} text=${JSON.stringify(text(ev).slice(0, 60))} imgs=${imgs.length}`);
    }
  }
  // Also count image-bearing user messages regardless of hash.
  const withImg = users.filter((ev) => (ev.data?.content ?? []).some((c) => c.type === 'image'));
  if (withImg.length) {
    console.log(`  user messages with image: ${withImg.length}`);
    for (const ev of withImg) {
      console.log(`      seq=${ev.seq} time=${new Date(ev.time).toISOString()} text=${JSON.stringify(text(ev).slice(0, 40))}`);
    }
  }
}
