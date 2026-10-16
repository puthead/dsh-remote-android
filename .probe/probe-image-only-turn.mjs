// 真机复现探针：把 Android 端**纯图轮次**的请求体（`turnBodyJson("", id, images)` 的形状：
// prompt 是空串、content 只有 image 块）原样 POST 到**活着的** live-env 网关，看它接受还是拒绝。
//
// 为什么需要这个探针：模拟器上点「发送」得到
//   发送失败：缺少 prompt（必须是非空字符串）
// 这句文案只可能来自 `session-runner.mjs` 的 `submit()`（http.mjs:1175 的版本没有括号注释）。
// 但按当前源码，`http.mjs` 的 `validateTurnContent()` 在「没有任何非空 text 块」时会把
// `prompt` 换成占位正文 `TURN_IMAGE_ONLY_TEXT`，runner 不可能拿到空串。
// 二者矛盾 → 必须用**真请求**判定活网关跑的是哪一版，而不是继续读源码推理。
//
// 安全边界：只用 `--session` 指定的**一次性验证会话**（默认 None：必须先显式给），
// 失败路径不产生任何副作用；成功后立刻调用 abort 终止这一轮。
const BASE = process.env.GW_BASE ?? 'http://127.0.0.1:18087';
const TOKEN = process.env.GW_TOKEN ?? '';
const IMAGE = process.env.PROBE_IMAGE ?? 'D:\\Workspace\\dsh_android\\android\\evidence\\task4-01-snackbar-visible-once.png';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]);
}

const log = (...a) => console.log('[probe]', ...a);

async function main() {
  const { readFileSync } = await import('node:fs');
  const sessionId = args.get('session');
  if (!sessionId) throw new Error('必须用 --session <id> 指定一个一次性会话');

  const bytes = readFileSync(IMAGE);
  const b64 = bytes.toString('base64');
  log('image', IMAGE, bytes.length, '-> b64', b64.length);

  // 与 Android `DshApiV2.turnBodyJson("", id, images)` 逐字同形：
  //   JSONObject 按插入序输出 {"prompt":"","content":[...],"clientTurnId":"..."}
  //   content 里没有 text 块（文字为空时 Android **不写空 text 块**，见 turnContent 的注释）
  const body = JSON.stringify({
    prompt: '',
    content: [{ type: 'image', mediaType: 'image/png', data: b64, name: 'probe-1000000051.png' }],
    clientTurnId: `probe-imageonly-${Date.now()}`,
  });
  log('body bytes', body.length, '| prompt 字段 = "" (空串) | content 只有 image 块');

  const res = await fetch(`${BASE}/api/v2/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${TOKEN}`,
      'x-api-version': '2',
    },
    body,
  });
  const text = await res.text();
  log('response', res.status, text.slice(0, 400));

  // 一旦被接受就立刻停掉这一轮：探针只关心"收不收"，不关心 agent 说什么。
  if (res.status === 202 || res.status === 200) {
    const abort = await fetch(`${BASE}/api/v2/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-api-version': '2' },
    }).catch((e) => ({ status: 'err', text: async () => String(e?.message ?? e) }));
    log('abort', abort.status, (await abort.text()).slice(0, 200));
  }
}

main().catch((err) => {
  console.error('[probe][ERROR]', err?.stack ?? err);
  process.exitCode = 1;
});
