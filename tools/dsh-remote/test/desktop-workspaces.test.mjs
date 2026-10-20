/**
 * 电脑端工作区同步（v2.11.0）：手机端 `GET /workspaces` 必须看到电脑上登记的工作区。
 *
 * 真机根因：网关只返回 `config.workspaceAllowlist`，而电脑端把工作区登记在
 * `<desktopHome>/storages/workspace.json`；用户在电脑上新建的工作区（实测
 * `D:\Workspace\养一只哦鲸鲸`）手机上永远看不到。修法是直接读这份**权威持久化**并合并
 * 进有效白名单 —— 不依赖桌面端 RPC（新版桌面端监听随机端口，离线时更不可达）。
 *
 * 本文件同时守住两条安全边界：
 * 1. 只合并 `workspace.json` 里真实登记的目录，不扫描磁盘；
 * 2. 从表里删除后，手机端列表与文件接口都必须**立刻**失去访问权。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startV2 } from './v2-harness.mjs';

/** 改写合成 DSH home 的 workspace.json（保留 w1，追加/删除额外条目）。 */
async function setDesktopWorkspaces(home, entries) {
  const file = path.join(home, 'storages', 'workspace.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const table = {};
  const ids = [];
  for (const entry of entries) {
    ids.push(entry.id);
    table[entry.id] = {
      path: entry.path,
      title: entry.title ?? path.basename(entry.path),
      sessionIds: entry.sessionIds ?? [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }
  await fs.writeFile(file, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: ids, archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: table },
  }), 'utf8');
}

test('GET /workspaces 合并电脑端 workspace.json，并给出 title/source/sessionCount', async (t) => {
  const h = await startV2(t);
  const desktopWs = path.join(h.root, 'desk-only');
  await fs.mkdir(desktopWs, { recursive: true });
  await fs.writeFile(path.join(desktopWs, 'hello.txt'), '来自电脑端工作区\n', 'utf8');
  await fs.writeFile(path.join(desktopWs, 'deep.md'), '# 同步过来的工作区\n', 'utf8');

  await setDesktopWorkspaces(h.seeded.dshHome, [
    { id: 'w1', path: h.seeded.workspace, title: '合成工作区', sessionIds: [h.seeded.id] },
    { id: 'w2', path: desktopWs, title: '电脑上新建的工作区', sessionIds: [] },
  ]);

  const res = await h.request('GET', '/api/v2/workspaces');
  assert.equal(res.status, 200, res.text);
  const synced = res.json.workspaces.find((workspace) => workspace.path.toLowerCase() === desktopWs.toLowerCase());
  assert.ok(synced, `工作区列表应包含电脑端工作区：${res.text}`);
  assert.equal(synced.source, 'desktop');
  assert.equal(synced.title, '电脑上新建的工作区');
  assert.equal(synced.label, '电脑上新建的工作区', 'label 优先用电脑端标题');
  assert.equal(synced.workspaceId, 'w2');
  assert.equal(synced.exists, true);
  assert.equal(res.json.desktopWorkspaces.count, 2);
  assert.equal(res.json.desktopWorkspaces.enabled, true);

  // 文件接口：手机只发绝对 path（老客户端形态）也要能反推出这个新工作区。
  const file = await h.request('GET', `/api/v2/workspaces/file?path=${encodeURIComponent(path.join(desktopWs, 'hello.txt'))}`);
  assert.equal(file.status, 200, file.text);
  assert.match(file.json.text ?? '', /来自电脑端工作区/);
});

test('电脑端删除工作区后，手机端列表与文件接口立即失去访问权', async (t) => {
  const h = await startV2(t);
  const desktopWs = path.join(h.root, 'desk-remove');
  await fs.mkdir(desktopWs, { recursive: true });
  await fs.writeFile(path.join(desktopWs, 'secret.txt'), '只应在同步存在时可读\n', 'utf8');

  await setDesktopWorkspaces(h.seeded.dshHome, [
    { id: 'w1', path: h.seeded.workspace, title: '合成工作区' },
    { id: 'w2', path: desktopWs, title: '临时的电脑端工作区' },
  ]);
  const first = await h.request('GET', '/api/v2/workspaces');
  assert.ok(first.json.workspaces.some((workspace) => workspace.path.toLowerCase() === desktopWs.toLowerCase()));

  // 在电脑端删除（只改 workspace.json，不删磁盘）→ 下一次列表请求必须不再返回它。
  await setDesktopWorkspaces(h.seeded.dshHome, [
    { id: 'w1', path: h.seeded.workspace, title: '合成工作区' },
  ]);
  const second = await h.request('GET', '/api/v2/workspaces');
  assert.equal(second.status, 200, second.text);
  assert.ok(
    !second.json.workspaces.some((workspace) => workspace.path.toLowerCase() === desktopWs.toLowerCase()),
    `删除后不应再出现在列表：${second.text}`,
  );

  const file = await h.request('GET', `/api/v2/workspaces/file?path=${encodeURIComponent(path.join(desktopWs, 'secret.txt'))}`);
  assert.equal(file.status, 403, file.text);
  assert.equal(file.json.error.code, 'workspace_outside');
});

test('workspace.json 缺失/损坏时保留配置白名单，不把手机端变成空列表', async (t) => {
  const h = await startV2(t);
  await fs.writeFile(path.join(h.seeded.dshHome, 'storages', 'workspace.json'), '{ not json', 'utf8');

  const res = await h.request('GET', '/api/v2/workspaces');
  assert.equal(res.status, 200, res.text);
  assert.ok(
    res.json.workspaces.some((workspace) => workspace.path.toLowerCase() === h.extraWs.toLowerCase()),
    `配置白名单必须仍然可用：${res.text}`,
  );
});

test('v1 /workspaces 保持冻结：不合并电脑端工作区、不带 v2 新字段', async (t) => {
  const h = await startV2(t);
  const desktopWs = path.join(h.root, 'desk-v1');
  await fs.mkdir(desktopWs, { recursive: true });
  await setDesktopWorkspaces(h.seeded.dshHome, [
    { id: 'w1', path: h.seeded.workspace, title: '合成工作区' },
    { id: 'w2', path: desktopWs, title: '只应出现在 v2 的工作区' },
  ]);

  // v2 看得到（对照组，证明 fixture 真的生效）
  const v2 = await h.request('GET', '/api/v2/workspaces');
  assert.ok(
    v2.json.workspaces.some((workspace) => workspace.path.toLowerCase() === desktopWs.toLowerCase()),
    `v2 应合并电脑端工作区：${v2.text}`,
  );

  const v1 = await h.request('GET', '/api/v1/workspaces');
  assert.equal(v1.status, 200, v1.text);
  assert.equal(
    v1.json.workspaces.some((workspace) => workspace.path.toLowerCase() === desktopWs.toLowerCase()),
    false,
    `已交付的 v2.10.0 手机端读 v1，条目集合不能变：${v1.text}`,
  );
  for (const workspace of v1.json.workspaces) {
    assert.equal(workspace.source, undefined, 'v1 条目不得新增 source 字段');
    assert.equal(workspace.title, undefined, 'v1 条目不得新增 title 字段');
    assert.equal(workspace.sessionCount, undefined, 'v1 条目不得新增 sessionCount 字段');
  }
});
