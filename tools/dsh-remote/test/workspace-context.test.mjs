/**
 * 回归测试（2026-10-15 用户真机报障）：「工作区里的文件夹点进去就报路径越界」。
 *
 * 根因（已在模拟器与真机上 100% 复现）：手机 App 2.6.0 及更早版本的工作区请求
 * **只发绝对 `path`、从不发 `workspace`**（`DshApiV2.entries/file/changes/diff/search`），
 * 网关 `workspaceContext()` 于是回落到 `defaultWorkspace`，紧接着 `resolveTarget()`
 * 拿「默认工作区的根」去装「另一个白名单工作区里的绝对路径」，词法包含必然失败：
 *
 *     403 workspace_outside  路径越界（不在工作区内）：D:\Workspace\插件
 *
 * 修法两半，本文件守**网关这一半**：缺 `workspace` 时按 `path` 反推它所在的白名单工作区
 * （客户端那一半见 `DshApiV2`/`ConsoleRepository.workspaceFor`，即永远显式带上 `?workspace=`）。
 *
 * 不变量（本文件同时守住安全属性）：
 * 1. 反推只可能返回**白名单里真实存在的工作区**，不给工作区之外的路径开绿灯；
 * 2. 显式传了 `workspace` 就以它为准，**不**因为 `path` 落在别的工作区而"救回来"；
 * 3. 白名单里嵌套（`D:\ws` 与 `D:\ws\sub`）时取最长匹配。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startV2 } from './v2-harness.mjs';

/**
 * harness 的 `seeded.workspace`（`<root>\ws`）只登记在合成 `workspace.json` 里，
 * 磁盘上并不存在；而 `resolveWorkspace` 要求工作区**真实存在且是目录**，
 * 所以这里把目录树造出来。它同时是「白名单里的非默认工作区」。
 */
async function seedDiskTree(ws) {
  await fs.mkdir(path.join(ws, 'sub', 'deep'), { recursive: true });
  await fs.writeFile(path.join(ws, 'note.md'), '# 插件工作区\n', 'utf8');
  await fs.writeFile(path.join(ws, 'sub', 'deep', 'leaf.txt'), 'leaf\n', 'utf8');
  return ws;
}

/** Windows 上 realpath 会规范化大小写/短名，比较路径一律忽略大小写。 */
function assertSamePath(actual, expected, message) {
  assert.equal(String(actual).toLowerCase(), String(expected).toLowerCase(), message);
}

const filesUrl = (p) => `/api/v2/workspaces/files?path=${encodeURIComponent(p)}`;

test('缺 workspace 参数时按绝对 path 反推工作区（越界误拒回归）', async (t) => {
  const h = await startV2(t);
  const ws = await seedDiskTree(h.seeded.workspace);

  // 0) 前提自检：这个工作的确**不是**默认工作区，否则本用例证明不了任何事。
  assert.notEqual(String(h.config.defaultWorkspace).toLowerCase(), String(ws).toLowerCase());
  assert.ok(h.config.workspaceAllowlist.some((entry) => String(entry).toLowerCase() === String(ws).toLowerCase()));

  // 1) 工作区根：改动前这里是 403 workspace_outside（用户截图那句文案）
  const root = await h.request('GET', filesUrl(ws));
  assert.equal(root.status, 200, `工作区根目录应放行，实际 ${root.status} ${root.text}`);
  assertSamePath(root.json.workspace, await fs.realpath(ws), '反推出的工作区应是请求路径所在的那个');
  assert.ok(
    root.json.entries.some((entry) => entry.name === 'note.md'),
    `目录列举结果应包含 note.md，实际 ${JSON.stringify(root.json.entries.map((e) => e.name))}`,
  );

  // 2) 子目录（用户实际点的是"文件夹"）
  const subDir = path.join(ws, 'sub');
  const sub = await h.request('GET', filesUrl(subDir));
  assert.equal(sub.status, 200, `子目录应放行，实际 ${sub.status} ${sub.text}`);
  assertSamePath(sub.json.path, await fs.realpath(subDir), '列举的应是子目录本身');

  // 3) 单文件读取（文件查看页走的是 /workspaces/file）
  const file = await h.request('GET', `/api/v2/workspaces/file?path=${encodeURIComponent(path.join(ws, 'note.md'))}`);
  assert.equal(file.status, 200, `文件应可读，实际 ${file.status} ${file.text}`);
  assert.match(String(file.json.text ?? ''), /插件工作区/);

  // 4) 显式 workspace 仍然生效
  const explicit = await h.request('GET', `${filesUrl(ws)}&workspace=${encodeURIComponent(ws)}`);
  assert.equal(explicit.status, 200, `显式 workspace 应放行，实际 ${explicit.status} ${explicit.text}`);

  // 5) 显式 workspace 与 path 不一致时必须按显式那个判越界 —— 反推**不得**覆盖显式值
  const mismatch = await h.request('GET', `${filesUrl(ws)}&workspace=${encodeURIComponent(h.extraWs)}`);
  assert.equal(mismatch.status, 403, `显式 workspace 不匹配时应拒绝，实际 ${mismatch.status} ${mismatch.text}`);
  assert.equal(mismatch.json.error.code, 'workspace_outside');
});

test('反推不给工作区之外的路径开绿灯', async (t) => {
  const h = await startV2(t);
  await seedDiskTree(h.seeded.workspace);

  // `<root>\outside` 既不在白名单里，也不在任何白名单工作区之下。
  const outside = path.join(h.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n', 'utf8');

  const denied = await h.request('GET', filesUrl(outside));
  assert.equal(denied.status, 403, `工作区外必须拒绝，实际 ${denied.status} ${denied.text}`);
  assert.equal(denied.json.error.code, 'workspace_outside');
  assert.ok(!denied.text.includes('top secret'), '拒绝响应里不得出现目标内容');

  const deniedFile = await h.request('GET', `/api/v2/workspaces/file?path=${encodeURIComponent(path.join(outside, 'secret.txt'))}`);
  assert.equal(deniedFile.status, 403, `工作区外的文件必须拒绝，实际 ${deniedFile.status} ${deniedFile.text}`);
  assert.ok(!deniedFile.text.includes('top secret'), '拒绝响应里不得出现文件内容');

  // 相对 path 不参与反推（无法判断它属于哪个工作区）→ 仍按默认工作区解释。
  // 默认工作区是 `<root>\extra`，它下面没有 `sub`，因此这里不能是 200。
  const relative = await h.request('GET', filesUrl('sub'));
  assert.notEqual(relative.status, 200, `相对 path 不得被解释成 seeded 工作区里的 sub，实际 ${relative.status} ${relative.text}`);
});

test('白名单里嵌套的工作区取最长匹配', async (t) => {
  const h = await startV2(t, {
    mutate: (cfg) => {
      // cfg.workspaceAllowlist = [extraWs, seeded.workspace]，这里再挂一个更深的子工作区
      cfg.workspaceAllowlist = [...cfg.workspaceAllowlist, path.join(cfg.workspaceAllowlist[1], 'sub')];
    },
  });
  const ws = await seedDiskTree(h.seeded.workspace);
  const nested = path.join(ws, 'sub');

  const res = await h.request('GET', filesUrl(nested));
  assert.equal(res.status, 200, `嵌套工作区应放行，实际 ${res.status} ${res.text}`);
  assertSamePath(res.json.workspace, await fs.realpath(nested), '应选更深的那个工作区（最长匹配）');
});
