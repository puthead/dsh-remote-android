/**
 * 探针：在**真实桌面端**上验证「电脑端自己发起的轮次」实时中继（`lib/desktop-watch.mjs`）。
 *
 * 用途：单元/集成测试用的是桌面端桩；这一支拿真的 127.0.0.1:19387 跑一遍，确认
 *   ① watcher 真的能从 `session/list` 的 `running` 发现电脑端正在跑的会话；
 *   ② `session/follow` 握手拿到的 `snapshot.cursor` 水位线正确（历史回放不被重推）；
 *   ③ 握手后补发的 `turn.started` 带 `source=computer` / `relayed=true`；
 *   ④ 真实增量事件（`assistant/message` → `message.delta`、`tool/call`、`tool/result`）
 *      带着 `data.seq`（手机端幂等键）落进会话总线。
 *
 * **只读且无副作用**：不投递 prompt、不取消轮次、不写任何会话；只订阅 `session/follow`。
 * **不调用 `gateway.listen()`** —— `relay.connect()` 只在 listen() 里发生（见 lib/http.mjs:1825），
 * 所以本探针绝不会去抢用户手机正在用的那条中继连接。
 *
 * 用法：`node .probe/relay-live-e2e.mjs`（可配 RUN_MS / POLL_MS / SESSION_ID 环境变量）
 */
import { loadConfig } from '../tools/dsh-remote/lib/config.mjs';
import { createGateway } from '../tools/dsh-remote/lib/http.mjs';

const CONFIG_PATH = process.env.DSHR_CONFIG ?? 'C:/Users/Administrator/.dsh-remote/config.json';
const RUN_MS = Number(process.env.RUN_MS ?? 90_000);
const POLL_MS = Number(process.env.POLL_MS ?? 1500);
const SESSION_ID = process.env.SESSION_ID ?? null;

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const config = loadConfig({
  configPath: CONFIG_PATH,
  env: process.env,
  cliOverrides: {
    port: 0,
    desktopWatch: { enabled: true, pollMs: POLL_MS, attachTimeoutMs: 8000, streamTimeoutMs: 10 * 60_000 },
    // 别把探针日志写进生产 logs/ 与 tasks/
    log: { dirName: 'logs-probe-relay', toConsole: false },
    tasks: { dirName: 'tasks-probe-relay' },
  },
});

/** 中继自己的日志（`DesktopTurnWatcher` 通过它汇报订阅/中继）走这里，和生产日志文件分开。 */
const logger = {
  info: (m) => console.log(`${at()} [gw] ${m}`),
  warn: (m) => console.log(`${at()} [gw warn] ${m}`),
  error: (m) => console.log(`${at()} [gw error] ${m}`),
  debug: () => {},
};

console.log(`${at()} 配置：mirror.home=${config.mirror?.resolvedHome} desktopWatch=${JSON.stringify(config.desktopWatch)}`);

const gw = await createGateway(config, { logger });

const counts = new Map();
const frameLog = [];
gw.sessionStream.subscribeSession({
  sessionId: null,
  fromSeq: 0,
  onEvent: (ev) => {
    if (SESSION_ID && ev.sessionId && ev.sessionId !== SESSION_ID) return;
    const type = ev.type;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    // 注意：会话总线的事件是**扁平的**（`EventBus.publish` 把 payload 摊在 ev 上），
    // `ev.data` 是 HTTP/SSE 那一层的形状，别在这里用。
    const d = ev;
    frameLog.push({ at: at(), type, sessionId: ev.sessionId ?? null, dshSeq: ev.dshSeq ?? null, flat: d });
    const tail = [];
    if (d.turn !== undefined) tail.push(`turn=${d.turn}`);
    if (d.fromSeq !== undefined) tail.push(`fromSeq=${d.fromSeq}`);
    if (d.text !== undefined) tail.push(`text=${JSON.stringify(String(d.text).slice(0, 60))}`);
    if (d.name !== undefined) tail.push(`name=${d.name}`);
    if (d.callId !== undefined) tail.push(`callId=${String(d.callId).slice(0, 12)}`);
    if (d.reason !== undefined) tail.push(`reason=${JSON.stringify(d.reason)}`);
    console.log(
      `${at()} ← ${type} session=${String(ev.sessionId ?? '-').slice(-12)} seq=${ev.dshSeq ?? '-'} source=${d.source ?? '-'} relayed=${d.relayed ?? '-'} ${tail.join(' ')}`,
    );
  },
});

// 周期性打印台账，便于在后台作业里看到"到底有没有动"。
const ticker = setInterval(() => {
  const s = gw.stats();
  console.log(`${at()} [stats] desktopWatch=${JSON.stringify(s.desktopWatch)}`);
}, 10_000);
ticker.unref?.();

setTimeout(async () => {
  clearInterval(ticker);
  const s = gw.stats();
  console.log(`\n${at()} ===== 汇总 =====`);
  console.log(`desktopWatch = ${JSON.stringify(s.desktopWatch)}`);
  console.log(`事件计数 = ${JSON.stringify([...counts.entries()])}`);
  const relayed = frameLog.filter((f) => f.flat?.source === 'computer' || f.flat?.relayed === true);
  console.log(`其中带 source=computer / relayed=true 的帧：${relayed.length}`);
  for (const f of relayed.slice(0, 40)) {
    const { data, seq, taskId, at: evAt, ...rest } = f.flat;
    console.log(`  ${f.at} ${f.type} seq=${f.dshSeq} ${JSON.stringify(rest).slice(0, 160)}`);
  }
  const verdict =
    relayed.some((f) => f.type === 'turn.started' && f.flat?.relayed === true) &&
    relayed.some((f) => f.type === 'message.delta')
      ? 'PASS'
      : 'INCONCLUSIVE';
  console.log(`结论：${verdict}`);
  await gw.close().catch((err) => console.log(`关闭出错：${err.message}`));
  process.exit(0);
}, RUN_MS);
