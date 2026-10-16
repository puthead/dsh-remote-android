// Read-only probe: walk DSH app.asar via Electron's patched fs and locate approval plumbing.
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] ?? 'list';
const needle = process.argv[3] ?? '';
const ROOT = process.env.PROBE_ROOT || 'D:\\DSH\\resources\\app.asar';

function listDir(p, depth = 0, max = 200) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return [`ERR ${p}: ${e.message}`]; }
  for (const e of entries) {
    out.push(`${'  '.repeat(depth)}${e.isDirectory() ? 'D' : 'F'} ${e.name}${e.isFile() ? ` (${fs.statSync(path.join(p, e.name)).size})` : ''}`);
    if (out.length >= max) break;
    if (e.isDirectory() && depth < 1) out = out.concat(listDir(path.join(p, e.name), depth + 1, max - out.length));
  }
  return out;
}

function walk(p, files = [], depth = 0) {
  if (depth > 6) return files;
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return files; }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) walk(full, files, depth + 1);
    else if (/\.(js|mjs|cjs|json)$/.test(e.name)) files.push(full);
  }
  return files;
}

if (mode === 'list') {
  console.log(listDir(ROOT).join('\n'));
} else if (mode === 'names') {
  const files = walk(ROOT);
  console.log(`total files: ${files.length}`);
  console.log(files.slice(0, 400).map((f) => f.slice(ROOT.length + 1)).join('\n'));
} else if (mode === 'grep') {
  const files = walk(ROOT);
  let hits = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!text.includes(needle)) continue;
    const idxs = [];
    let i = -1;
    while ((i = text.indexOf(needle, i + 1)) !== -1 && idxs.length < 6) idxs.push(i);
    hits++;
    console.log(`\n=== ${f.slice(ROOT.length + 1)}  (${idxs.length}${idxs.length === 6 ? '+' : ''} hits, size ${text.length})`);
    for (const ix of idxs) console.log('   …' + text.slice(Math.max(0, ix - 260), ix + 260).replace(/\s+/g, ' ') + '…');
    if (hits >= 12) { console.log('\n(stopped at 12 files)'); break; }
  }
  if (!hits) console.log(`no hits for ${JSON.stringify(needle)}`);
}
