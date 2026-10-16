/**
 * 探针 2：量出「内联 base64 图片块」的真实上限与拒绝形态。
 *
 * 背景（探针 1 已证实）：`session/prompt` 的 content 支持
 *   { type:'image', mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif', data:<base64>, name? }
 * 图片会被 runtime 落成 `C:\Users\Administrator\.dsh\attachments\v1\objects\...`，
 * 转录里变成 `{type:'image', attachment:{attachmentId,mediaType,bytes,width,height,name}}`。
 *
 * 本探针只做「会话建立 + 投递」，并立刻 cancel，尽量不消耗模型额度：
 *   node .probe/image-prompt-limits.mjs [--sizes 100000,700000,900000,1200000]
 */
import { deflateSync } from 'node:zlib';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(opt('port', '19387'));
const HOME = opt('home', 'C:\\Users\\Administrator\\.dsh');
const SIZES = opt('sizes', '100000,700000,900000,1200000,3000000').split(',').map(Number);

/** 造一个「合法」的 PNG：真 zlib 数据 + 正确 CRC。解出来的像素是灰噪点，不重要。 */
function makePng(targetBytes) {
  const w = 640;
  const h = Math.max(1, Math.ceil(targetBytes / (w * 3 + 1)));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * (w * 3 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < w * 3; x += 1) raw[rowStart + 1 + x] = (x * 37 + y * 11) & 0xff;
  }
  const idat = deflateSync(raw, { level: 1 });
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    // CRC32
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, body, c]);
  };
  chunks.push(chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const api = new DesktopApi({ host: '127.0.0.1', port: PORT, dshHome: HOME, logger: { info: () => {}, warn: () => {}, error: () => {} } });
const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
const sessionId = created?.sessionId;
console.log(`probe session = ${sessionId}`);
console.log('size(base64 chars) | png bytes | 结果');

for (const target of SIZES) {
  const png = makePng(target);
  const b64 = png.toString('base64');
  const started = Date.now();
  try {
    const r = await api.prompt({
      sessionId,
      content: [
        { type: 'text', text: '忽略（体积探测）。' },
        { type: 'image', mediaType: 'image/png', data: b64, name: `probe-${target}.png` },
      ],
    });
    console.log(`${b64.length} | ${png.length} | 接受 ${JSON.stringify(r)} (${Date.now() - started}ms)`);
  } catch (err) {
    console.log(`${b64.length} | ${png.length} | 拒绝 code=${err?.code ?? '(none)'} status=${err?.status ?? '(none)'} msg=${err?.message ?? err} (${Date.now() - started}ms)`);
  }
}

try { await api.cancel(sessionId); console.log('已 cancel'); } catch (err) { console.log('cancel 失败:', err?.message ?? err); }
console.log(`清理：删 C:\\Users\\Administrator\\.dsh\\sessions\\--D-Workspace-dsh_android--\\${sessionId}`);
