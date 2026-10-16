// 一次性探针：复现 v2 套件里 POST /api/v2/tasks 返回 500 的真实原因（与环境相关还是代码相关）。
import { startV2 } from '../tools/dsh-remote/test/v2-harness.mjs';

const t = { after: (fn) => t._cbs.push(fn), _cbs: [], diagnostic: () => {} };
process.on('exit', async () => {});
const h = await startV2(t, {});
const res = await h.request('POST', '/api/v2/tasks', { body: { prompt: '你好', host: 'gateway' } });
console.log('STATUS', res.status, JSON.stringify(res.json).slice(0, 400));
console.log('LAUNCH', JSON.stringify({ cliPath: h.config.dsh.cliPath, electronPath: h.config.dsh.electronPath, exeArgs: h.config.dsh.exeArgs }));
for (const cb of t._cbs) await cb();
process.exit(0);
