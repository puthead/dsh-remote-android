// List asar entries matching a path regex.
// usage: node asar-list.mjs <pathRegex> [max]
import { listAll } from './asar.mjs';
const rx = new RegExp(process.argv[2], 'i');
const max = Number(process.argv[3] || 300);
const all = listAll().filter((e) => rx.test(e.path));
console.log(`[${all.length} matches]`);
for (const e of all.slice(0, max)) console.log(`${String(e.size).padStart(9)}  ${e.path}${e.unpacked ? '  [unpacked]' : ''}`);
