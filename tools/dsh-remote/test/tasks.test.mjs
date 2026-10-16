/**
 * 任务生命周期测试（契约 §3）：成功/失败/取消/超时/队列/校验/列表分页/删除，
 * 以及「取消只杀自己那棵进程树」这一硬性要求的正反两面验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSessionId, listSessions, sessionDirFor } from '../lib/runner.mjs';
import { isAlive, scripted, startHarness, waitFor, waitForExit, waitForTask } from './helpers.mjs';

/** 提交任务并返回 { status, task }。 */
async function submit(h, prompt, extra = {}) {
  const res = await h.request('POST', '/api/v1/tasks', {
    body: { prompt, workspace: h.workspace, ...extra },
  });
  return { httpStatus: res.status, body: res.json, res };
}

test('任务成功：201 返回契约字段，终态 succeeded 且 output 非空', async (t) => {
  const h = await startHarness(t);
  const created = await submit(h, scripted({ mode: 'echo', text: '你好，世界\n第二行输出' }), { title: '中文任务' });
  assert.equal(created.httpStatus, 201);
  const task = created.body;
  assert.match(task.id, /^task_[0-9A-HJKMNP-TV-Z]{26}$/, 'taskId 必须是合法 ULID 格式');
  assert.deepEqual(Object.keys(task).sort(), [
    'access',
    'createdAt',
    'error',
    'exitCode',
    'finishedAt',
    'id',
    'output',
    'prompt',
    'sessionId',
    'startedAt',
    'status',
    'title',
    'truncated',
    'workspace',
  ], '响应字段必须严格等于契约 Task 对象');
  assert.equal(task.access, 'workspace', '缺省权限档必须是「仅当前工作区」');
  assert.equal(task.workspace, await fs.realpath(h.workspace), 'workspace 归一化为真实路径');
  assert.equal(task.output, '');
  assert.equal(task.error, null);

  const done = await waitForTask(h, task.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.exitCode, 0);
  assert.equal(done.output, '你好，世界\n第二行输出', 'output 必须是子进程 stdout 的最终文本');
  assert.equal(done.error, null);
  assert.equal(done.truncated, false);
  assert.ok(done.startedAt >= done.createdAt);
  assert.ok(done.finishedAt >= done.startedAt);
  assert.equal(done.sessionId, null, '替身不产生 DSH 会话目录时应为 null（契约允许）');
});

test('prompt 特殊字符（中文/双引号/单引号/换行/制表/反斜杠/百分号）零改写传递', async (t) => {
  const h = await startHarness(t);
  const prompt = [
    '第一行：中文与 "双引号" 和 \'单引号\'',
    '第二行：D:\\Workspace\\proj\\a.txt 反斜杠',
    '第三行：Tab\there & | < > ^ % 反引号` 与 $(shell) 与 ; 分号',
  ].join('\n');

  const created = await submit(h, prompt, { title: '特殊字符' });
  assert.equal(created.httpStatus, 201);
  const done = await waitForTask(h, created.body.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.output, prompt, 'stdout 必须与 prompt 逐字节一致（未经 shell 解释）');

  // 子进程实际收到的 argv / cwd / DSH_HOME
  // 说明：子进程里 process.argv.slice(2) 天然不含 node 与脚本自身，
  // 因此这里断言「脚本自身 = binPath」+「3 个位置参数」，等价于网关传了 4 段 argv。
  const calls = await h.recorded();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.entry, h.config.dsh.binPath, 'argv[0] 必须是 dsh 入口 bin.js');
  assert.deepEqual(call.argv.slice(0, 2), ['--profile', 'headless'], 'argv[1..2] 必须是 profile 参数');
  assert.equal(call.argv.length, 3, 'argv 数组必须恰好是 [bin.js, --profile, headless, prompt] 四段');
  assert.equal(call.argv[2], prompt, 'prompt 必须作为单个 argv 元素原样到达子进程');
  assert.equal(call.cwd, await fs.realpath(h.workspace), 'cwd 必须是任务 workspace');
  assert.equal(call.dshHome, h.config.home, 'DSH_HOME 必须指向网关 home（含 .credentials.yaml）');
});

test('任务失败：子进程非 0 退出 → failed 且 error 可读、exitCode 保留', async (t) => {
  const h = await startHarness(t);
  const created = await submit(
    h,
    scripted({ mode: 'exit', code: 3, stdout: '部分输出\n', stderr: 'Error: 模型鉴权失败（DEEPSEEK_API_KEY 无效）\nCategoryInfo : 噪声行\n' }),
  );
  const done = await waitForTask(h, created.body.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 3);
  assert.match(done.error, /退出码 3/);
  assert.match(done.error, /模型鉴权失败/, 'error 应包含子进程真实错误信息');
  assert.ok(!done.error.includes('CategoryInfo'), 'error 不应包含 PowerShell 包装噪声');
  assert.equal(done.finishedAt >= done.startedAt, true);
});

test('任务取消：终止整棵进程树（含孙进程），且绝不误杀其它任务', async (t) => {
  const h = await startHarness(t, { maxConcurrent: 2 });
  const a = await submit(h, scripted({ mode: 'tree', ms: 20_000 }));
  const b = await submit(h, scripted({ mode: 'tree', ms: 20_000 }));
  assert.equal(a.httpStatus, 201);
  assert.equal(b.httpStatus, 201);

  const readGrandchild = async (id) => {
    const res = await h.request('GET', `/api/v1/tasks/${id}`);
    const match = /"grandchildPid":(\d+)/.exec(res.json.output ?? '');
    return match ? Number(match[1]) : null;
  };
  const pidA = await waitFor(() => readGrandchild(a.body.id), { message: '任务 A 未报告孙进程 pid' });
  const pidB = await waitFor(() => readGrandchild(b.body.id), { message: '任务 B 未报告孙进程 pid' });
  assert.ok(isAlive(pidA), 'A 的孙进程应存活');
  assert.ok(isAlive(pidB), 'B 的孙进程应存活');

  const canceled = await h.request('POST', `/api/v1/tasks/${a.body.id}/cancel`);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.json.status, 'canceled');
  assert.equal(canceled.json.error, null, '用户主动取消不算错误');

  await waitForExit(pidA, { timeoutMs: 8000 }); // taskkill /T /F 必须连带孙进程
  assert.equal(isAlive(pidB), true, '取消 A 绝不能影响 B 的进程树');

  const bDetail = await h.request('GET', `/api/v1/tasks/${b.body.id}`);
  assert.equal(bDetail.json.status, 'running');

  // 取消幂等：终态任务再次取消返回原对象
  const again = await h.request('POST', `/api/v1/tasks/${a.body.id}/cancel`);
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'canceled');
  assert.equal(again.json.finishedAt, canceled.json.finishedAt);

  await h.request('POST', `/api/v1/tasks/${b.body.id}/cancel`);
  await waitForExit(pidB, { timeoutMs: 8000 });
});

test('排队中取消：queued 任务直接出队置 canceled，不影响运行中任务', async (t) => {
  const h = await startHarness(t, { maxConcurrent: 1 });
  const running = await submit(h, scripted({ mode: 'sleep', ms: 4000, stdout: '开始\n' }));
  await waitFor(async () => (await h.request('GET', `/api/v1/tasks/${running.body.id}`)).json.status === 'running', {
    message: '第一个任务未进入 running',
  });

  const queued = await submit(h, scripted({ mode: 'echo', text: '不应执行' }));
  const queuedDetail = await h.request('GET', `/api/v1/tasks/${queued.body.id}`);
  assert.equal(queuedDetail.json.status, 'queued', '并发已满时必须排队');

  const canceled = await h.request('POST', `/api/v1/tasks/${queued.body.id}/cancel`);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.json.status, 'canceled');
  assert.equal(canceled.json.exitCode, null, '从未执行的排队任务没有退出码');

  // 排队任务取消后不应再被执行
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stillCanceled = await h.request('GET', `/api/v1/tasks/${queued.body.id}`);
  assert.equal(stillCanceled.json.status, 'canceled');

  const runningDetail = await h.request('GET', `/api/v1/tasks/${running.body.id}`);
  assert.equal(runningDetail.json.status, 'running', '运行中任务不受影响');
  await h.request('POST', `/api/v1/tasks/${running.body.id}/cancel`);
});

test('任务超时：超过 timeoutSec 被终止并置 failed（error 说明超时）', async (t) => {
  const h = await startHarness(t);
  const created = await submit(h, scripted({ mode: 'sleep', ms: 10_000 }), { timeoutSec: 1 });
  const started = Date.now();
  const done = await waitForTask(h, created.body.id, { timeoutMs: 8000 });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /任务超时：超过 1 秒/, 'error 必须说明超时与实际时长');
  assert.ok(Date.now() - started < 6000, '应在超时后很快收尾');
});

test('并发已满且队列已满 → 429 busy；有队列空间则排队而非拒绝', async (t) => {
  const noQueue = await startHarness(t, { maxConcurrent: 1, maxQueue: 0 });
  const busy1 = await submit(noQueue, scripted({ mode: 'sleep', ms: 3000 }));
  assert.equal(busy1.httpStatus, 201);
  const busy2 = await submit(noQueue, scripted({ mode: 'echo', text: 'x' }));
  assert.equal(busy2.httpStatus, 429);
  assert.equal(busy2.body.error.code, 'busy');
  await noQueue.request('POST', `/api/v1/tasks/${busy1.body.id}/cancel`);

  const withQueue = await startHarness(t, { maxConcurrent: 1, maxQueue: 5 });
  const q1 = await submit(withQueue, scripted({ mode: 'sleep', ms: 1500 }));
  const q2 = await submit(withQueue, scripted({ mode: 'echo', text: 'queued-ok' }));
  assert.equal(q2.httpStatus, 201, '有队列空间时应入队而不是拒绝');
  const q2detail = await withQueue.request('GET', `/api/v1/tasks/${q2.body.id}`);
  assert.equal(q2detail.json.status, 'queued');
  const q2done = await waitForTask(withQueue, q2.body.id, { timeoutMs: 10_000 });
  assert.equal(q2done.status, 'succeeded');
  assert.equal(q2done.output, 'queued-ok');
  await waitForTask(withQueue, q1.body.id, { timeoutMs: 10_000 });
});

test('提交校验：prompt 空、workspace 越界/相对/不存在、timeoutSec 非法', async (t) => {
  const h = await startHarness(t);
  const outside = path.join(h.sandbox.root, 'outside');
  await fs.mkdir(outside, { recursive: true });

  const cases = [
    [{ prompt: '', workspace: h.workspace }, /prompt 不能为空/],
    [{ prompt: '   ', workspace: h.workspace }, /prompt 不能为空/],
    [{ workspace: h.workspace }, /prompt 不能为空/],
    [{ prompt: 'x', workspace: outside }, /不在白名单内/],
    [{ prompt: 'x', workspace: 'relative\\dir' }, /绝对路径/],
    [{ prompt: 'x', workspace: path.join(h.sandbox.root, 'nope') }, /不存在/],
    [{ prompt: 'x', workspace: h.workspace, timeoutSec: 0 }, /timeoutSec/],
    [{ prompt: 'x', workspace: h.workspace, timeoutSec: 999_999 }, /timeoutSec/],
    [{ prompt: 'x'.repeat(200_001), workspace: h.workspace }, /prompt 过长/],
    // 权限档只认两个契约取值：拼错一律 400，绝不"猜一个档位"（猜错就是提权）
    [{ prompt: 'x', workspace: h.workspace, access: 'yolo' }, /access 只能是/],
    [{ prompt: 'x', workspace: h.workspace, access: 'danger' }, /access 只能是/],
    [{ prompt: 'x', workspace: h.workspace, access: 1 }, /access 必须是字符串/],
    [{ prompt: 'x', workspace: h.workspace, access: {} }, /access 必须是字符串/],
  ];
  for (const [body, pattern] of cases) {
    const res = await h.request('POST', '/api/v1/tasks', { body });
    assert.equal(res.status, 400, `期望 400：${JSON.stringify(body).slice(0, 60)}`);
    assert.equal(res.json.error.code, 'bad_request');
    assert.match(res.json.error.message, pattern);
  }

  // 缺省 title 取 prompt 前 40 字
  const long = 'A'.repeat(60);
  const created = await submit(h, long);
  assert.equal(created.body.title, `${'A'.repeat(40)}…`);
  await waitForTask(h, created.body.id);
});

test('任务列表：倒序 + limit/cursor 分页 + status=active 过滤', async (t) => {
  const h = await startHarness(t, { maxConcurrent: 1 });

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const created = await submit(h, scripted({ mode: 'echo', text: `任务${i}`, chunks: 1 }));
    ids.push(created.body.id);
    await waitForTask(h, created.body.id);
  }
  const longRunning = await submit(h, scripted({ mode: 'sleep', ms: 3000, stdout: '长任务\n' }));

  const page1 = await h.request('GET', '/api/v1/tasks?status=all&limit=2');
  assert.equal(page1.status, 200);
  assert.equal(page1.json.tasks.length, 2);
  assert.ok(page1.json.nextCursor, '还有更多数据时应返回 nextCursor');
  assert.equal(page1.json.tasks[0].createdAt >= page1.json.tasks[1].createdAt, true, '按 createdAt 倒序');

  const page2 = await h.request('GET', `/api/v1/tasks?status=all&limit=2&cursor=${encodeURIComponent(page1.json.nextCursor)}`);
  assert.equal(page2.json.tasks.length, 2);
  assert.equal(page2.json.nextCursor, null, '最后一页 nextCursor 为 null');
  const all = [...page1.json.tasks, ...page2.json.tasks].map((x) => x.id);
  assert.equal(new Set(all).size, 4, '分页不得重复');

  const active = await h.request('GET', '/api/v1/tasks?status=active');
  assert.equal(active.json.tasks.length, 1);
  assert.equal(active.json.tasks[0].id, longRunning.body.id);

  const badStatus = await h.request('GET', '/api/v1/tasks?status=weird');
  assert.equal(badStatus.status, 400);
  const badLimit = await h.request('GET', '/api/v1/tasks?limit=0');
  assert.equal(badLimit.status, 400);

  await h.request('POST', `/api/v1/tasks/${longRunning.body.id}/cancel`);
});

test('删除任务：终态 204、活动任务 409 conflict、未知任务 404', async (t) => {
  const h = await startHarness(t, { maxConcurrent: 1 });
  const created = await submit(h, scripted({ mode: 'echo', text: 'done', chunks: 1 }));
  await waitForTask(h, created.body.id);

  const del = await h.request('DELETE', `/api/v1/tasks/${created.body.id}`);
  assert.equal(del.status, 204);
  assert.equal(del.text, '');
  const gone = await h.request('GET', `/api/v1/tasks/${created.body.id}`);
  assert.equal(gone.status, 404);

  const running = await submit(h, scripted({ mode: 'sleep', ms: 3000 }));
  const delActive = await h.request('DELETE', `/api/v1/tasks/${running.body.id}`);
  assert.equal(delActive.status, 409, 'A2-2：活动态删除必须返回 409 conflict');
  assert.equal(delActive.json.error.code, 'conflict');
  assert.match(delActive.json.error.message, /仅终态任务可删除/);

  const missingCancel = await h.request('POST', '/api/v1/tasks/task_missing/cancel');
  assert.equal(missingCancel.status, 404);
  const missingDelete = await h.request('DELETE', '/api/v1/tasks/task_missing');
  assert.equal(missingDelete.status, 404);

  // 删除后落盘文件也应消失（历史清理）
  const files = await fs.readdir(h.config.tasksDir);
  assert.ok(!files.includes(`${created.body.id}.json`));
  await h.request('POST', `/api/v1/tasks/${running.body.id}/cancel`);
});

test('删除竞态回归：在途 persist 绝不把已删除任务写回磁盘（墓碑 + 写链）', async (t) => {
  const h = await startHarness(t);
  const created = await submit(h, scripted({ mode: 'echo', text: 'done', chunks: 1 }));
  await waitForTask(h, created.body.id);
  const id = created.body.id;
  const file = path.join(h.config.tasksDir, `${id}.json`);

  // 打竞态窗口：persist 内部要经过 mkdir/open/writeFile/sync/rename 多个 await，
  // DELETE 可以插在中间，把文件删掉后又让在途 rename 复活它。
  // 这里不 await persist，紧接着并发删除，逼出"检查通过 → 删除 → rename"的交错。
  const task = h.gateway?.tasks;
  assert.ok(task, 'harness 必须暴露 gateway.tasks 以便做确定性竞态回归');
  const attempts = [];
  for (let i = 0; i < 6; i++) attempts.push(task.persist(task.tasks.get(id)).catch(() => {}));
  const deleted = await h.request('DELETE', `/api/v1/tasks/${id}`);
  assert.equal(deleted.status, 204);
  await Promise.allSettled(attempts);

  // 删除返回后可能有写链尾巴仍在跑，给它们一点时间再断言（真实的落后窗口）
  await new Promise((resolve) => setTimeout(resolve, 50));
  const survived = await fs.readFile(file, 'utf8').then(() => true, () => false);
  assert.equal(survived, false, '已删除任务的文件不得被在途 persist 复活');
  assert.equal(await fs.readdir(h.config.tasksDir).then((f) => f.includes(`${id}.json`)), false);

  // 反向断言：墓碑不得误伤其他任务（新任务照常落盘）
  const other = await submit(h, scripted({ mode: 'echo', text: 'ok', chunks: 1 }));
  await waitForTask(h, other.body.id);
  assert.equal(
    await fs.readdir(h.config.tasksDir).then((f) => f.includes(`${other.body.id}.json`)),
    true,
    '墓碑不得影响其他任务的落盘',
  );
});

test('输出截断：超过 maxOutputBytes 只保留尾部并置 truncated=true（A2-5）', async (t) => {
  const MAX = 2048;
  const TOTAL = 8192;
  const h = await startHarness(t, { limits: { maxOutputBytes: MAX } });

  /** 与 fake-dsh 的 big 模式完全一致的数据流生成器（用于精确比对尾部）。 */
  const generateStream = (size, blockSize = 512) => {
    let out = '';
    let written = 0;
    let index = 0;
    while (written < size) {
      const header = `<${String(index).padStart(4, '0')}>`;
      const body = 'x'.repeat(Math.max(0, Math.min(blockSize, size - written) - header.length));
      out += header + body;
      written += header.length + body.length;
      index++;
    }
    return out;
  };
  const full = generateStream(TOTAL);
  assert.equal(full.length, TOTAL);

  const created = await submit(h, scripted({ mode: 'big', bytes: TOTAL, blockSize: 512 }));
  const done = await waitForTask(h, created.body.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.truncated, true, '超限必须置 truncated=true');
  assert.equal(
    done.output,
    full.slice(-MAX),
    'output 必须是完整数据流的末 2048 字符（保留尾部而非头部，且不切字符）',
  );
  assert.ok(Buffer.byteLength(done.output, 'utf8') <= MAX);
  assert.ok(!done.output.includes('<0000>'), '头部内容必须被丢弃');
  assert.ok(done.output.endsWith('x'), '尾部内容必须保留');

  // 未超限的任务不受影响
  const small = await submit(h, scripted({ mode: 'echo', text: '短输出', chunks: 1 }));
  const smallDone = await waitForTask(h, small.body.id);
  assert.equal(smallDone.truncated, false);
  assert.equal(smallDone.output, '短输出');
});

test('权限档：缺省与显式 workspace 都下发 workspace-write，只有 access=full 才提权', async (t) => {
  const h = await startHarness(t);

  // 缺省（手机旧版本 / 脚本不传字段）必须落在"仅当前工作区"
  const byDefault = await submit(h, scripted({ mode: 'echo', text: '默认档' }));
  assert.equal(byDefault.httpStatus, 201);
  assert.equal(byDefault.body.access, 'workspace', '缺省必须是 workspace');
  await waitForTask(h, byDefault.body.id);

  const explicit = await submit(h, scripted({ mode: 'echo', text: '显式档' }), { access: 'workspace' });
  assert.equal(explicit.body.access, 'workspace');
  await waitForTask(h, explicit.body.id);

  const full = await submit(h, scripted({ mode: 'echo', text: '全权限' }), { access: 'full' });
  assert.equal(full.httpStatus, 201);
  assert.equal(full.body.access, 'full', '响应必须回显契约值 full');
  const done = await waitForTask(h, full.body.id);
  assert.equal(done.access, 'full', 'GET 任务详情同样带回 access');

  // 关键断言：权限档在子进程侧的唯一可观测形态就是 DSH_PERMISSION_MODE
  const calls = await h.recorded();
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.permissionMode),
    ['workspace-write', 'workspace-write', 'danger-full-access'],
    '前两个任务只能是 workspace-write，只有 access=full 的任务才拿到 danger-full-access',
  );
  // argv 里绝不能出现权限参数（DSH 没有这个 flag，出现即说明实现走偏了）
  for (const call of calls) {
    assert.ok(!call.argv.some((a) => a.includes('permission') || a.includes('sandbox')), 'argv 不得夹带权限参数');
  }
});

test('权限档：DSH 原生取值别名归一，响应只回契约值', async (t) => {
  const h = await startHarness(t);
  // 兼容脚本/其它客户端直接写 DSH 的值（不把它们当契约，但接受）
  const res = await h.request('POST', '/api/v1/tasks', {
    body: { prompt: scripted({ mode: 'echo', text: '别名' }), workspace: h.workspace, access: 'danger-full-access' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.access, 'full', '别名必须归一成契约值');
  await waitForTask(h, res.json.id);
  const calls = await h.recorded();
  assert.equal(calls[0].permissionMode, 'danger-full-access');
});

test('权限档：非法取值不启动子进程（400 且无 argv 记录）', async (t) => {
  const h = await startHarness(t);
  const res = await h.request('POST', '/api/v1/tasks', {
    body: { prompt: 'x', workspace: h.workspace, access: 'root' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'bad_request');
  assert.match(res.json.error.message, /access 只能是 workspace（仅当前工作区）或 full（全部权限）/);
  assert.deepEqual(await h.recorded(), [], '被拒的请求绝不能起子进程');
});

test('discoverSessionId：仅识别本次新增的 session 条目，多候选时不猜', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-sess-'));
  const workspace = path.join(home, 'proj');
  await fs.mkdir(workspace, { recursive: true });
  const dir = sessionDirFor(home, workspace);

  await fs.mkdir(path.join(dir, 'session-aaaaaaaa-1111-2222-3333-444444444444'), { recursive: true });
  const before = await listSessions({ home, workspace });
  assert.equal(before.size, 1);
  assert.equal(await discoverSessionId({ home, workspace, before }), null, '无新增时必须返回 null');

  const newDir = 'session-bbbbbbbb-1111-2222-3333-444444444444';
  await fs.mkdir(path.join(dir, newDir), { recursive: true });
  assert.equal(await discoverSessionId({ home, workspace, before }), newDir);

  // 旧布局：session-<uuid>.jsonl 文件同样可识别
  await fs.writeFile(path.join(dir, 'session-cccccccc-1111-2222-3333-444444444444.jsonl'), '{}\n');
  assert.equal(
    await discoverSessionId({ home, workspace, before }),
    null,
    '出现两个新候选时应返回 null（宁可缺失也不写错）',
  );

  // 不存在的目录不应抛异常
  assert.deepEqual(await listSessions({ home, workspace: path.join(home, 'other') }), new Set());
  assert.equal(await discoverSessionId({ home, workspace: path.join(home, 'other'), before: new Set() }), null);
  await fs.rm(home, { recursive: true, force: true });
});
