/**
 * 取证探针：DSH 桌面端 runtime 的 `session/prompt` 到底收不收「内联 base64 图片块」。
 *
 * 依据（静态取证）：
 *   `.probe/x/api-typert-host.js:1980`
 *   export type PromptContentPart =
 *     | { readonly type: 'text'; readonly text: string }
 *     | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }
 *     | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> }
 *   `.probe/x/api-typert-host.js:1520`
 *   @Remote('prompt') prompt(request: SessionPromptRequest, signal): Promise<SessionPromptValue>
 *   `SessionPromptRequest = {requestId, sessionId, mode:'queue'|'steer', content: readonly PromptContentPart[], clientTimeZone?}`
 *
 * 本探针只做只读 + 一次临时会话，跑完打印会话 id 供人工清理：
 *   node .probe/image-prompt-probe.mjs [--port 19387] [--home <dshHome>] [--keep]
 */
import { randomUUID } from 'node:crypto';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(opt('port', '19387'));
const HOME = opt('home', 'C:\\Users\\Administrator\\.dsh');
const KEEP = argv.includes('--keep');

const api = new DesktopApi({ host: '127.0.0.1', port: PORT, dshHome: HOME, logger: { info: () => {}, warn: () => {}, error: () => {} } });

const line = (t) => console.log(`\n===== ${t} =====`);
const show = (v) => JSON.stringify(v, null, 2)?.slice(0, 2000);

line('1) 桌面端可达性');
try {
  const p = await api.probe();
  console.log('probe:', show(p));
  if (!p.ok) process.exit(2);
} catch (err) {
  console.error('probe 失败：', err?.message ?? err);
  process.exit(2);
}

line('2) 模型目录（看默认路由是否声明图片输入）');
try {
  const catalog = await api.call('session/modelCatalog');
  console.log(show(catalog));
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  for (const g of groups) {
    const models = Array.isArray(g?.models) ? g.models : [];
    console.log(`  供应商 ${g?.providerId ?? g?.id ?? '?'}: ${models.map((m) => `${m.id}${m.name && m.name !== m.id ? `(${m.name})` : ''}`).join(', ')}`);
    for (const m of models) {
      const modalities = m?.inputModalities ?? m?.modalities ?? null;
      if (modalities) console.log(`    ${m.id} inputModalities=${JSON.stringify(modalities)}`);
    }
  }
  console.log('  default =', show(catalog?.default));
} catch (err) {
  console.log('modelCatalog 不可用：', err?.code ?? '', err?.message ?? err);
}

line('3) 建一个临时会话（用于投递图片，跑完会打印 id 供清理）');
let sessionId = null;
try {
  const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
  sessionId = created?.sessionId ?? created?.id ?? null;
  console.log('create ->', show(created));
} catch (err) {
  console.error('createSession 失败：', err?.code ?? '', err?.message ?? err);
  process.exit(2);
}
if (!sessionId) {
  console.error('没拿到 sessionId，终止');
  process.exit(2);
}

line('4) 先投一条纯文本（确认真实链路可跑通）');
try {
  const r = await api.prompt({ sessionId, text: '只回复两个字：收到' });
  console.log('text prompt ->', show(r));
} catch (err) {
  console.error('text prompt 失败：', err?.code ?? '', err?.message ?? err);
}

line('5) 再投一条「文本 + 内联 base64 PNG(1x1)」');
// 1x1 透明 PNG，标准最小合法 PNG
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let imageAccepted = null;
try {
  const r = await api.prompt({
    sessionId,
    content: [
      { type: 'text', text: '这条消息带一张 1x1 的 PNG 测试图。如果你能收到图片就回复"收到图片"，收不到就回复"没有图片"。' },
      { type: 'image', mediaType: 'image/png', data: PNG_1X1, name: 'probe-1x1.png' },
    ],
  });
  imageAccepted = true;
  console.log('image prompt ->', show(r));
} catch (err) {
  imageAccepted = false;
  console.log('image prompt 被拒绝：code=', err?.code ?? '(none)', 'status=', err?.status ?? '(none)');
  console.log('message=', err?.message ?? String(err));
}

line('6) 顺带探一下超大图片块的上限（2.5MiB base64，看是否报体积错）');
try {
  const big = 'A'.repeat(2_500_000);
  const r = await api.prompt({
    sessionId,
    content: [
      { type: 'text', text: '忽略这条（上限探测）。' },
      { type: 'image', mediaType: 'image/png', data: big, name: 'probe-big.png' },
    ],
  });
  console.log('big prompt ->', show(r));
} catch (err) {
  console.log('big prompt 被拒绝：code=', err?.code ?? '(none)', 'status=', err?.status ?? '(none)', 'message=', err?.message ?? String(err));
}

line('结论速览');
console.log('sessionId =', sessionId, KEEP ? '(保留，便于继续观察)' : '(请人工清理)');
console.log('图片块被接受:', imageAccepted === null ? '未测出' : imageAccepted ? '是' : '否');

line('7) 看这个临时会话的转录（图片块是否落成 attachment 引用）');
try {
  const page = await api.page({ sessionId, maxMessages: 20 });
  console.log(JSON.stringify(page, null, 2)?.slice(0, 4000));
} catch (err) {
  console.log('page 失败：', err?.message ?? err);
}

console.log('\n临时会话 id（如需清理：删 %DSH_HOME%\\sessions 下对应目录）：', sessionId);
