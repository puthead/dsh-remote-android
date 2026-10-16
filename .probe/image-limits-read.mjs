/**
 * 探针 3：读出桌面端真实生效的图片上限（`imageLimits` 投影）。
 * 这些数字决定手机端压缩目标：base64 后必须能挤进「中继/网关 1MiB 请求体」。
 */
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const api = new DesktopApi({
  host: '127.0.0.1',
  port: Number(opt('port', '19387')),
  dshHome: opt('home', 'C:\\Users\\Administrator\\.dsh'),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

// 复用已存在的探针会话，没有再新建：只为读投影，不投递。
const probeSession = opt('session', '');
let sessionId = probeSession;
if (!sessionId) {
  const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
  sessionId = created?.sessionId;
  console.log(`新建会话用于读投影：${sessionId}（跑完请删 sessions 目录）`);
}

const projections = await api.projections(sessionId);
console.log('projections keys =', Object.keys(projections ?? {}));
console.log(JSON.stringify(projections, null, 2).slice(0, 4000));
