/**
 * v2 模型目录与"手机端选模型"：`GET /api/v2/models` + `POST /api/v2/tasks` 的模型字段。
 *
 * 契约 §4.7 / §7.8：手机端的模型选择器必须**永远有东西可渲染**。桌面端接上时给它真目录
 * （`source:'desktop'`），没接上/连不上就给网关配置里的那一个默认项（`source:'config'`）——
 * 所以这个端点**永不 503**，降级信息藏在 `source` 里，由手机端决定怎么提示用户。
 *
 * 隔离红线同 v2-desktop.test.mjs：桌面端一律用 `makeDesktopStub()` 的纯内存替身，
 * 绝不省略 `desktop` 注入（`desktop === undefined` 会让 createGateway 去连用户真实的 19387）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { desktopEvent, makeDesktopStub, waitFor } from './helpers.mjs';
import { startV2 } from './v2-harness.mjs';

/**
 * 桌面端首轮投递要求"先订阅、后投递"，且订阅必须**真的出帧**才会被 runner 认作建立成功
 * （否则 `#submitDesktop` 会一直等在第一帧上，测试直接挂死）。所以每个建任务的桌面桩都要
 * 给一帧 `turn/start`；这也正是真实桌面端的形状。
 */
const desktopFrames = () => [desktopEvent('turn/start', { turn: { id: 'turn-1' }, seq: 1 })];

test('v2/models：桌面端接线 → 透传真目录（source=desktop，分组/档位/失败项逐字段收口）', async (t) => {
  const stub = makeDesktopStub({ entries: [] });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('GET', '/api/v2/models');
  assert.equal(res.status, 200, '模型目录是手机端首屏依赖，任何情况下都不该失败');
  assert.equal(res.json.ok, true);
  // 回体顶层**恰好六个键**：多一个是缺陷，少一个手机端只能按缺失降级（契约 §4.7）
  assert.deepEqual(Object.keys(res.json).sort(), ['default', 'failures', 'groups', 'ok', 'routableProviders', 'source']);
  assert.equal(res.json.source, 'desktop', '接上桌面端就该给真目录，而不是配置里的那一个');

  // 默认项来自桌面端（不是网关配置：harness 配置里是 deepseek-flash，桩里是 deepseek-v4-flash）
  assert.deepEqual(res.json.default, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' });

  assert.deepEqual(res.json.routableProviders, ['deepseek-official'], 'routableProviders 与 groups 不是一回事，必须原样透传');
  assert.equal(res.json.groups.length, 1);
  const group = res.json.groups[0];
  assert.equal(group.id, 'deepseek-official');
  assert.equal(group.name, 'DeepSeek 官方');
  assert.deepEqual(group.models.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  // reasoning 档位是手机端渲染"档位选择器"的依据，丢了这个字段用户就只能选模型不能选档
  const pro = group.models[1];
  assert.equal(pro.name, 'V4 Pro');
  assert.equal(pro.description, '更强的推理档');
  assert.deepEqual(pro.reasoning.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(pro.reasoning.defaultEffort, 'high');
  assert.equal(group.models[0].reasoning, undefined, '不支持 reasoning 的模型不得凭空多出档位');

  // 某个 provider 采集失败 → failures 如实上报（手机端据此提示"部分不可用"）
  assert.deepEqual(res.json.failures, [{ id: 'dsh-llm-pi-ai', name: 'pi-ai', message: '未配置任何路由' }]);
  assert.equal(stub.calls.modelCatalog, 1, '目录必须真的来自桌面端 RPC，不是本地拼的');
});

test('v2/models：未接线（desktop=null）→ 降级 source=config，仍 200 且只有一个默认项', async (t) => {
  const h = await startV2(t); // 默认 desktop: null —— 显式关闭桌面端通道

  const res = await h.request('GET', '/api/v2/models');
  assert.equal(res.status, 200, '桌面端不在也必须给手机端一个可渲染的列表（不能 503）');
  assert.equal(res.json.source, 'config', 'source 用来告诉手机端"这只是网关自己的默认值"');
  // reasoningEffort 用的是**配置里的**默认值，不是 null：网关建 SDK 运行时本来就用这个档位，
  // 降级分支必须与它一致，否则手机端显示的默认档会和实际跑起来的档位不一样。
  // 断言取 harness 配置自身的值（而不是写死某个档位名）：配置以后改了，这条测试不会烂掉。
  assert.deepEqual(res.json.default, {
    provider: h.config.dsh.provider,
    model: h.config.dsh.model,
    reasoningEffort: h.config.dsh.reasoningEffort ?? null,
  });
  assert.deepEqual(res.json.groups, [], '降级时没有真分组');
  assert.deepEqual(res.json.routableProviders, []);
  // 降级必须**自解释**：手机端只有 failures 能回答"为什么列表里只剩一个模型"。
  // 只写日志等于让用户在手机上看到"只有一个模型"却永远不知道原因。
  assert.equal(res.json.failures.length, 1, '降级要带一条原因，否则手机端无法提示');
  assert.equal(res.json.failures[0].id, 'desktop');
  assert.match(res.json.failures[0].message, /未接入桌面端/);
});

test('v2/models：桌面端可达但 RPC 失败 → 仍是 200 + source=config（失败降级不留异常）', async (t) => {
  const stub = makeDesktopStub({ modelCatalogError: Object.assign(new Error('桩：目录采集失败'), { code: 'desktop_error' }) });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('GET', '/api/v2/models');
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'config');
  assert.equal(res.json.default.model, 'deepseek-flash', '降级用网关配置里的模型');
  assert.equal(stub.calls.modelCatalog, 1);
});

test('v2/desktop：新任务带 provider/model → 首轮投递前先 selectModel（sessionId 是刚建的那个）', async (t) => {
  const createdId = 'session-dddddddd-1111-4222-8333-444444444444';
  const stub = makeDesktopStub({
    createdSessionId: createdId,
    entries: [],
    autoFrames: desktopFrames(),
  });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { prompt: '用 Pro 跑', host: 'desktop', workspace: h.extraWs, provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  });
  assert.equal(res.status, 202, `建任务应被接受：${res.text.slice(0, 160)}`);
  assert.equal(res.json.sessionId, createdId);
  assert.equal(res.json.modelApplied, true, '切模型成功必须如实回显 applied');
  assert.equal(res.json.modelWarning, undefined);

  // 顺序是本条测试的重点：桌面端的会话模型是"下一次组合 agent 时生效"，
  // 而首轮投递就会触发组合 —— selectModel 跑到 prompt 后面，这整轮就跑在旧模型上。
  assert.equal(stub.calls.selectModel.length, 1, '必须恰好切一次模型');
  const selected = stub.calls.selectModel[0];
  assert.equal(selected.sessionId, createdId, '切模型必须针对**刚建出来的**那个会话');
  assert.equal(selected.provider, 'deepseek-official');
  assert.equal(selected.model, 'deepseek-v4-pro');
  assert.equal(selected.reasoningEffort, 'high');
  assert.deepEqual(stub.calls.prompt.map((p) => p.sessionId), [createdId], '首轮仍然要投出去');

  // 先后关系本身也要断言：`calls.selectModel` / `calls.prompt` 是分桶的，各自为真也证明不了顺序，
  // 只有跨方法的 `calls.order` 账本能证明「切完再投」。
  const at = (label) => stub.calls.order.indexOf(label);
  assert.ok(at('selectModel') !== -1 && at('prompt') !== -1, `桩应同时记下两次调用：${stub.calls.order.join(' → ')}`);
  assert.ok(at('selectModel') < at('prompt'), `selectModel 必须先于 prompt：${stub.calls.order.join(' → ')}`);
});

test('v2/desktop：只给 model 不给 provider → 从桌面端目录推断 provider（不猜、不送空 provider）', async (t) => {
  const createdId = 'session-eeeeeeee-1111-4222-8333-444444444444';
  const stub = makeDesktopStub({ createdSessionId: createdId, entries: [], autoFrames: desktopFrames() });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { prompt: '只报模型名', host: 'desktop', workspace: h.extraWs, model: 'deepseek-v4-pro' },
  });
  assert.equal(res.status, 202, res.text.slice(0, 160));
  assert.equal(res.json.modelApplied, true);
  // deepseek-v4-pro 在桩目录里只出现在 deepseek-official 这一组 → 可以唯一推断
  assert.equal(stub.calls.selectModel[0].provider, 'deepseek-official');
  assert.equal(stub.calls.modelCatalog >= 1, true, '推断 provider 必须查目录，而不是拿默认值硬套');
});

test('v2/desktop：切模型失败 → 任务照常 202（modelApplied=false + modelWarning），首轮仍投递', async (t) => {
  const createdId = 'session-ffffffff-1111-4222-8333-444444444444';
  const stub = makeDesktopStub({
    createdSessionId: createdId,
    entries: [],
    autoFrames: desktopFrames(),
    selectModelError: Object.assign(new Error('桩：该模型不可路由'), { code: 'session/model-unavailable', status: 502 }),
  });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { prompt: '切不动的模型', host: 'desktop', workspace: h.extraWs, provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  });
  // 会话此时已经真实存在于电脑端：为"选模型没生效"把整个任务判死，用户会丢掉一个已经建好的会话
  assert.equal(res.status, 202, '切模型失败不得让任务失败');
  assert.equal(res.json.accepted, true);
  assert.equal(res.json.sessionId, createdId, '建出来的会话必须照常回给手机端');
  assert.equal(res.json.modelApplied, false);
  assert.match(res.json.modelWarning, /该模型不可路由/, '手机端要能告诉用户"选的模型没生效"');
  assert.deepEqual(stub.calls.prompt.map((p) => p.sessionId), [createdId], '首轮照常投递');

  // 会话必须已经登记进**手机端自己的任务索引**（否则用户看不到它、也就无法重试）。
  // 这里直接读索引文件，而不是查 `/api/v2/sessions`：那个列表来自 DSH home 的会话镜像，
  // 桩建的会话没有真实会话文件、本来就不在里面（电脑端的真值只有桌面端 session/list）。
  // 索引是"先登记再投递"的落点，读文件正好验证了跨网关重启仍能续聊所需的持久化。
  const index = JSON.parse(await readFile(path.join(h.gwHome, 'phone-sessions.json'), 'utf8'));
  assert.ok(index.sessions[createdId], '切模型失败也必须先登记进手机端索引');
  assert.equal(index.sessions[createdId].host, 'desktop');
});

test('v2/desktop：不传模型 → 不碰 selectModel（也不查目录），202 不带模型字段', async (t) => {
  const createdId = 'session-99999999-1111-4222-8333-444444444444';
  const stub = makeDesktopStub({ createdSessionId: createdId, entries: [], autoFrames: desktopFrames() });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('POST', '/api/v2/tasks', { body: { prompt: '用默认模型', host: 'desktop', workspace: h.extraWs } });
  assert.equal(res.status, 202, res.text.slice(0, 160));
  assert.equal(stub.calls.selectModel.length, 0, '没选模型就不该去改电脑端的会话模型（更不该改它的默认模型）');
  assert.equal(stub.calls.modelCatalog, 0, '没选模型就不需要查目录');
  assert.equal(res.json.modelApplied, undefined, '新字段是可选的：没选模型时不下发，老手机端行为不变');
});

// ---------------------------------------------------------------------------
// 只给 `model`、不给 `provider` 的三个分支（契约 §7.8 铁律 4，2026-10-16 裁定）：
// 唯一命中 → 用那个分组（上面第 5 条测试）；多命中 → 目录默认 provider（下一条）；
// 零命中 → **不拿默认 provider 顶替**，跳过切换并如实报 modelWarning（再下一条）。
// ---------------------------------------------------------------------------

test('v2/desktop：只给 model 且多 provider 命中 → 用目录默认 provider（同一模型，不是瞎猜）', async (t) => {
  const createdId = 'session-aaaaaaa1-1111-4222-8333-444444444444';
  const stub = makeDesktopStub({
    createdSessionId: createdId,
    entries: [],
    autoFrames: desktopFrames(),
    // 同一个 model id 经多个 provider 路由是**真实**形状：实测 `deepseek-flash` 同时在
    // `deepseek-official` 与 `deepseek-account` 下。用户选的是"模型"而不是"账号"。
    modelCatalogResult: {
      default: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      routableProviders: ['deepseek-official', 'deepseek-account'],
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek 官方', models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }] },
        { id: 'deepseek-account', name: 'DeepSeek 账号版', models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }] },
      ],
      failures: [],
    },
  });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { prompt: '多 provider 同名模型', host: 'desktop', workspace: h.extraWs, model: 'deepseek-v4-pro' },
  });
  assert.equal(res.status, 202, `多命中是合法场景，不得回 4xx：${res.text.slice(0, 160)}`);
  assert.equal(stub.calls.selectModel.length, 1, '多命中仍要切，只是 provider 由目录默认项决定');
  assert.equal(stub.calls.selectModel[0].provider, 'deepseek-official', '多命中 → 目录默认 provider');
  assert.equal(stub.calls.selectModel[0].model, 'deepseek-v4-pro', '只推断 provider，绝不改模型');
  assert.equal(res.json.modelApplied, true);
});

test('v2/desktop：只给 model 但目录零命中 → 不拿默认 provider 顶替，跳过切换并如实报 modelWarning', async (t) => {
  const createdId = 'session-bbbbbbb2-1111-4222-8333-444444444444';
  const stub = makeDesktopStub({ createdSessionId: createdId, entries: [], autoFrames: desktopFrames() });
  const h = await startV2(t, { desktop: stub });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { prompt: '目录里没有的模型', host: 'desktop', workspace: h.extraWs, model: 'deepseek-not-in-catalog' },
  });
  assert.equal(res.status, 202, '模型不在目录里不是请求错误：任务照常建、照常跑');
  // 零命中最危险的错法是"拿目录默认 provider 顶替"——那等于用另一个模型冒充用户选的模型。
  assert.equal(stub.calls.selectModel.length, 0, '零命中必须跳过 session/selectModel，绝不用默认 provider 顶替');
  assert.equal(res.json.modelApplied, false);
  assert.match(res.json.modelWarning, /目录里没有 deepseek-not-in-catalog/, '手机端要能告诉用户"选的模型没生效"');
  assert.deepEqual(stub.calls.prompt.map((p) => p.sessionId), [createdId], '首轮照常投递');
});

test('v2/tasks：模型字段畸形 → 400 bad_request（不静默当没传）', async (t) => {
  const stub = makeDesktopStub({ entries: [] });
  const h = await startV2(t, { desktop: stub });

  const cases = [
    [{ provider: 123 }, 'provider 必须是非空字符串'],
    [{ provider: '   ' }, 'provider 必须是非空字符串'],
    [{ reasoningEffort: 0 }, 'reasoningEffort 必须是非空字符串'],
    [{ reasoningEffort: '  ' }, 'reasoningEffort 必须是非空字符串'],
  ];
  for (const [extra, message] of cases) {
    const res = await h.request('POST', '/api/v2/tasks', {
      body: { prompt: '畸形模型字段', host: 'desktop', workspace: h.extraWs, model: 'deepseek-v4-pro', ...extra },
    });
    assert.equal(res.status, 400, `畸形模型字段必须 400（静默降级＝界面显示 A、实际跑 B）：${JSON.stringify(extra)}`);
    assert.equal(res.json.error.code, 'bad_request');
    assert.equal(res.json.error.message, message, 'message 逐字为「<字段名> 必须是非空字符串」');
  }
  // 校验必须发生在**建会话之前**：否则手机上会留下一个"建了却没跑"的孤儿会话
  assert.equal(stub.calls.createSession.length, 0, '畸形字段不得先建会话再报错');
  assert.equal(stub.calls.modelCatalog, 0);
});

test('v2/gateway：带模型建任务 → 模型经 SDK initialize 下发（网关路径模型生效的唯一证据）', async (t) => {
  const initFile = path.join(process.env.TEMP ?? '/tmp', `dshr-init-${process.pid}-${Date.now()}.jsonl`);
  t.after(async () => {
    await rm(initFile, { force: true }).catch(() => {});
  });
  // `env` 在 createGateway 之前注入，SDK 子进程 spawn 时继承它（见 v2-harness 的 env 参数）
  const h = await startV2(t, { env: { FAKE_SDK_INIT_FILE: initFile } });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { prompt: '网关路径选模型', host: 'gateway', workspace: h.extraWs, provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  });
  assert.equal(res.status, 202, `网关路径建任务应被接受：${res.text.slice(0, 200)}`);
  assert.equal(res.json.host, 'gateway');
  assert.equal(res.json.modelApplied, true, '网关路径没有第二次 RPC：把模型写进 initialize 即 applied');

  // 模型只在这个握手里下发（lib/session-runner.mjs 的 #ensureRuntime），所以替身进程记下的
  // 那一行 params 就是"手机选的模型真的生效了"的唯一证据。
  const init = await waitFor(
    async () => {
      const text = await readFile(initFile, 'utf8').catch(() => '');
      const lines = text.split('\n').filter((line) => line.trim());
      return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    },
    { message: 'SDK initialize 没有记录到任何 params（子进程没起来？）' },
  );
  assert.equal(init.provider, 'deepseek-account', '手机选的 provider 必须原样进 initialize');
  assert.equal(init.model, 'deepseek-v4-pro');
  assert.equal(init.reasoningEffort, 'high');
});
