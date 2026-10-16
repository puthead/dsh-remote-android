// 端到端验证：手机侧「带图片的轮次」经网关 POST /api/v2/sessions/{id}/turns 的 content 透传，
// 真的落到 DSH 桌面端 runtime，并且 agent 真收到图（read_image + 转录里出现 ImageBlock）。
//
// 为什么这么搭：
//  - 真 DesktopApi 连的是用户正在跑的 DSH 桌面 runtime（127.0.0.1:19387）。本脚本**只新建一个
//    一次性会话**来跑验证，不碰用户任何现有会话；跑完把该会话目录删掉。
//  - 网关用自己的临时 home（makeSandbox）+ 真 DesktopApi，端口随机；**不碰 live-env 网关**。
//  - 图片走「手机端压缩后的真实形态」：合法 PNG，大图接近 700 KiB 预算，
//    才能同时验证 base64 膨胀后的 JSON 体在网关 1 MiB 限制内的余量。
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { makeSandbox, pairDevice } from '../tools/dsh-remote/test/helpers.mjs';
import { createGateway } from '../tools/dsh-remote/lib/http.mjs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';
import { createLogger } from '../tools/dsh-remote/lib/util.mjs';

const DSH_HOME = 'C:\\Users\\Administrator\\.dsh';
const DESKTOP_PORT = 19387;
const WORKSPACE = 'D:\\Workspace\\dsh_android';
const MAX_BODY = 1_048_576; // 网关/中继硬上限（不可改，见 config.mjs limits.maxBodyBytes）

const log = (...a) => console.log('[e2e]', ...a);
const fail = (msg) => { console.error('[e2e][FAIL]', msg); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一张**合法** PNG（真 IHDR/IDAT/IEND + 正确 CRC32），保证过 sharp 解码与类型校验。 */
function makePng(width, height, seed = 7) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  let s = seed >>> 0;
  for (let y = 0; y < height; y += 1) {
    const off = y * (1 + width * 3);
    raw[off] = 0; // filter type
    for (let x = 0; x < width * 3; x += 1) {
      s = (s * 1103515245 + 12345) >>> 0;
      raw[off + 1 + x] = (s >>> 16) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 多帧 zstd 转录解码（会话转录是逐帧拼接的）。 */
function readTranscript(file) {
  const buf = readFileSync(file);
  const isMagic = (j) => buf[j] === 0x28 && buf[j + 1] === 0xb5 && buf[j + 2] === 0x2f && buf[j + 3] === 0xfd;
  const parts = [];
  let start = 0;
  for (let j = 4; j < buf.length - 3; j += 1) {
    if (!isMagic(j)) continue;
    try { parts.push(zstdDecompressSync(buf.subarray(start, j)).toString('utf8')); start = j; } catch { /* 非帧边界 */ }
  }
  try { parts.push(zstdDecompressSync(buf.subarray(start)).toString('utf8')); } catch { /* 尾部残帧 */ }
  return parts.join('');
}

/**
 * `--limits` 模式：只校验**请求体边界**，不跑 agent、不建会话、不等转录。
 * 用途：确定「图片 base64 后塞进 1 MiB 网关请求体」的真实余量（413 阈值在哪），
 * 不依赖网关是否已实现 content 透传（关掉 content 用一个同体积的无害字段占位）。
 */
async function limitsMode() {
  for (const target of [1_040_000, 1_048_000, 1_048_500, 1_048_640, 1_049_000]) {
    const sandbox = await makeSandbox(null, { port: 0, host: '127.0.0.1' }, { autoCleanup: true });
    const logger = createLogger({ dir: sandbox.config.logsDir, toConsole: false });
    const gateway = await createGateway(sandbox.config, { logger, desktop: null });
    const port = await gateway.listen();
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = await pairDevice(baseUrl, { deviceName: 'e2e-limits', deviceId: '01234567-89ab-4cde-8f01-23456789abee' });
    // 刻意带一个不存在的 workspace：`onCreateTurn` 在 readJsonBody（限流判定处）之后、
    // 真正起轮次之前就会 400，所以不会产生任何会话副作用。
    const mk = (padLen) => JSON.stringify({
      prompt: 'x',
      clientTurnId: 'c',
      workspace: 'C:\\__e2e_limit_probe_nonexistent__',
      pad: 'A'.repeat(padLen),
    });
    let body = mk(0);
    body = mk(Math.max(0, target - body.length));
    const res = await fetch(`${baseUrl}/api/v2/sessions/session-probe/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}`, 'x-api-version': '2' },
      body,
    }).catch((err) => ({ status: 'fetch-error', text: async () => String(err?.message ?? err) }));
    const text = (await res.text()).slice(0, 140).replace(/\s+/g, ' ');
    log(`limits: body=${body.length} → ${res.status} ${text}`);
    await gateway.close().catch(() => {});
    await sandbox.cleanup();
  }
}

async function main() {
  const sandbox = await makeSandbox(null, {
    port: 0,
    host: '127.0.0.1',
    desktop: { enabled: true, host: '127.0.0.1', port: DESKTOP_PORT, dshHome: DSH_HOME },
    mirror: { enabled: true, dshHome: DSH_HOME },
    workspaceAllowlist: [WORKSPACE],
  }, { autoCleanup: false });

  const logger = createLogger({ dir: sandbox.config.logsDir, toConsole: false });
  const desktop = new DesktopApi({ host: '127.0.0.1', port: DESKTOP_PORT, dshHome: DSH_HOME, logger });
  const gateway = await createGateway(sandbox.config, { logger, desktop });
  const port = await gateway.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = await pairDevice(baseUrl, { deviceName: 'e2e-image', deviceId: '01234567-89ab-4cde-8f01-23456789abef' });
  log('gateway up', baseUrl, 'token', `${token.slice(0, 12)}…`);

  // 1) 建一个一次性桌面会话（跑在真 runtime 上，用完删）
  const session = await desktop.createSession({ cwd: WORKSPACE });
  const sessionId = session?.sessionId ?? session?.session?.sessionId ?? session?.id;
  if (!sessionId) throw new Error(`session/create 未返回 sessionId：${JSON.stringify(session).slice(0, 300)}`);
  log('desktop session', sessionId);

  // 2) 造真实形态的图：小图 + 接近预算的大图
  const small = makePng(64, 64, 3);
  const big = makePng(1400, 1000, 11);
  const smallB64 = small.toString('base64');
  const bigB64 = big.toString('base64');
  log('small png bytes', small.length, 'b64', smallB64.length, '| big png bytes', big.length, 'b64', bigB64.length);

  // 3) 经网关投一次「文本 + 图片」轮次（这就是手机端要走的路径）
  const prompt = 'E2E 图片通道验证：请用 read_image 读我发的两张图，只回它们的尺寸和字节数。';
  const body = {
    prompt,
    clientTurnId: `e2e-${Date.now()}`,
    content: [
      { type: 'text', text: prompt },
      { type: 'image', mediaType: 'image/png', data: smallB64, name: 'e2e-64.png' },
      { type: 'image', mediaType: 'image/png', data: bigB64, name: 'e2e-1400x1000.png' },
    ],
  };
  const raw = JSON.stringify(body);
  log('request body bytes', raw.length, `(上限 ${MAX_BODY}，余量 ${MAX_BODY - raw.length})`);
  if (raw.length > MAX_BODY) fail('请求体超过网关 1 MiB 上限，这个尺寸的图会被 413 拒绝');

  const res = await fetch(`${baseUrl}/api/v2/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}`, 'x-api-version': '2' },
    body: raw,
  });
  const resText = await res.text();
  log('turn response', res.status, resText.slice(0, 400));
  if (res.status !== 202 && res.status !== 200) fail(`带图轮次未被接受：${res.status}`);
  let accepted = null;
  try { accepted = JSON.parse(resText); } catch { /* 非 JSON */ }
  if (accepted && accepted.driver && accepted.driver !== 'desktop') fail(`driver 应为 desktop，实际 ${accepted.driver}`);

  // 4) 等 runtime 处理完，读转录确认 agent 真收到图
  // 真实落盘布局（实测）：sessions/<工作区目录>/<sessionId>/session.v4.jsonl.zstd
  // 顶层平铺的 <sessionId>.jsonl.zstd 是旧布局，作为兜底一并试。
  const dir = path.join(DSH_HOME, 'sessions', '--D-Workspace-dsh_android--');
  const file = path.join(dir, sessionId, 'session.v4.jsonl.zstd');
  const legacyFile = path.join(dir, `${sessionId}.jsonl.zstd`);
  let transcript = null;
  for (let i = 0; i < 60; i += 1) {
    const target = existsSync(file) ? file : (existsSync(legacyFile) ? legacyFile : null);
    if (target) {
      transcript = readTranscript(target);
      const hasImage = /"type":"image"/.test(transcript);
      const hasRead = /read_image/.test(transcript);
      const hasAssistant = /"role":"assistant"/.test(transcript);
      log(`poll ${i}: records=${transcript.split('\n').filter((l) => l.trim()).length} imageBlock=${hasImage} readImage=${hasRead} assistant=${hasAssistant}`);
      if (hasImage && hasRead && hasAssistant) break;
    } else {
      log(`poll ${i}: 转录尚未落盘（${file}）`);
    }
    await sleep(2000);
  }

  if (!transcript) fail('没有找到会话转录文件');
  else if (!/"type":"image"/.test(transcript)) fail('转录里没有 ImageBlock：图片没有真正进入 runtime');
  else if (!/read_image/.test(transcript)) fail('agent 没有调用 read_image：图片可能没被识别');
  else log('OK: agent 收到图片并调用了 read_image');

  // 5) 清理这个一次性会话
  await gateway.close().catch(() => {});
  if (existsSync(file)) rmSync(file, { force: true });
  const metaDir = path.join(dir, sessionId);
  if (existsSync(metaDir)) rmSync(metaDir, { recursive: true, force: true });
  await sandbox.cleanup();
  log('cleaned up');
}

if (process.argv.includes('--limits')) {
  limitsMode().catch((err) => {
    console.error('[e2e][ERROR]', err?.stack ?? err);
    process.exitCode = 1;
  });
} else {
  main().catch((err) => {
    console.error('[e2e][ERROR]', err?.stack ?? err);
    process.exitCode = 1;
  });
}
