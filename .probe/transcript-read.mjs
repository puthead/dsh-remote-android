// Probe: decompress the session transcript and surface the ask_user_question records.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync, createZstdDecompress } from 'node:zlib';
import { Readable } from 'node:stream';

const file = process.argv[2];
const needles = (process.argv[3] ?? 'probe_colour').split(',');
const raw = readFileSync(file);
console.log('compressed bytes =', raw.length);

let text = null;
try {
  text = zstdDecompressSync(raw).toString('utf8');
  console.log('MODE = single-frame, chars =', text.length);
} catch (err) {
  console.log('single-frame failed:', String(err.message).slice(0, 120));
}

// Concatenated independent zstd frames: a streaming decoder consumes all of them.
try {
  const chunks = [];
  const dec = createZstdDecompress();
  await new Promise((resolve, reject) => {
    Readable.from([raw]).pipe(dec);
    dec.on('data', (c) => chunks.push(c));
    dec.on('end', resolve);
    dec.on('error', reject);
  });
  const streamed = Buffer.concat(chunks).toString('utf8');
  if (text === null || streamed.length > text.length) {
    text = streamed;
    console.log('MODE = streaming (concatenated frames), chars =', text.length);
  }
} catch (err) {
  console.log('stream decode failed:', String(err.message).slice(0, 160));
}

if (text === null) {
  // Concatenated independent zstd frames: walk them by magic 0x28 B5 2F FD.
  const parts = [];
  let start = 0;
  for (let i = 1; i < raw.length - 3; i += 1) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) {
      if (i > start) {
        try { parts.push(zstdDecompressSync(raw.subarray(start, i)).toString('utf8')); start = i; } catch { /* not a boundary */ }
      }
    }
  }
  try { parts.push(zstdDecompressSync(raw.subarray(start)).toString('utf8')); } catch { /* trailing */ }
  text = parts.join('');
  console.log('MODE = frame-walk, recovered chars =', text.length);
}

const lines = text.split('\n').filter((l) => l.trim() !== '');
console.log('records =', lines.length);
console.log('LAST LINE (trunc 400):', lines.at(-1)?.slice(0, 400));

for (const needle of needles) {
  console.log(`\n===== lines containing ${JSON.stringify(needle)} =====`);
  for (const line of lines) {
    if (!line.includes(needle)) continue;
    let out = line;
    try {
      const obj = JSON.parse(line);
      const ev = obj.event ?? obj;
      const data = ev.data ?? {};
      // Keep only the ask-relevant slices so the output stays readable.
      const keep = { record: obj.type ?? null, eventType: ev.type ?? null, seq: ev.seq ?? null };
      if (data.result !== undefined) keep.result = data.result;
      if (data.callId !== undefined) keep.callId = data.callId;
      if (data.name !== undefined) keep.name = data.name;
      if (data.arguments !== undefined) keep.arguments = data.arguments;
      if (data.message !== undefined && typeof data.message === 'object') {
        const c = data.message.content;
        keep.role = data.message.role ?? null;
        keep.text = Array.isArray(c) ? c.map((p) => p?.text ?? JSON.stringify(p)).join(' ').slice(0, 500) : JSON.stringify(c).slice(0, 500);
      }
      const s = JSON.stringify(keep);
      out = s.length > 1800 ? s.slice(0, 1800) + '…TRUNC' : s;
    } catch { out = out.slice(0, 900); }
    console.log(out);
  }
}
