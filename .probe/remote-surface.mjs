// Read-only: extract the complete client-callable Remote surface (namespace/method) from the
// bundled remote client inside DSH app.asar.
import fs from 'node:fs';

const f = 'D:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-api-remotes\\lib\\client.js';
const t = fs.readFileSync(f, 'utf8');
const re = /namespace:\s*["']([^"']+)["']\s*,\s*method:\s*["']([^"']+)["']/g;
console.log('file size', t.length, 'raw namespace hits', (t.match(/namespace:/g) || []).length);
const set = new Set();
let m;
while ((m = re.exec(t)) !== null) set.add(`${m[1]}/${m[2]}`);
const all = [...set].sort();
console.log(`total remote methods: ${all.length}`);
console.log(all.join('\n'));
