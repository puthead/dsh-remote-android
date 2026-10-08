/**
 * 工作区白名单测试（契约 §6.6）：含子目录放行、白名单外拒绝、相对路径拒绝、
 * 不存在拒绝、文件拒绝、`..` 穿越拒绝、空白名单默认拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithin, listWorkspaces, resolveWorkspace } from '../lib/workspace.mjs';

/** 构造：root/{allowed/{sub}, other, file.txt} */
async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-ws-'));
  const allowed = path.join(root, 'allowed');
  const sub = path.join(allowed, 'sub', 'deep');
  const other = path.join(root, 'other');
  await fs.mkdir(sub, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(root, 'file.txt'), 'x', 'utf8');
  return { root, allowed, sub, other };
}

test('isWithin：自身/子目录为真，父目录与同级为假', () => {
  assert.equal(isWithin(path.resolve('D:\\a'), path.resolve('D:\\a')), true);
  assert.equal(isWithin(path.resolve('D:\\a\\b'), path.resolve('D:\\a')), true);
  assert.equal(isWithin(path.resolve('D:\\a'), path.resolve('D:\\a\\b')), false);
  assert.equal(isWithin(path.resolve('D:\\ab'), path.resolve('D:\\a')), false, '前缀相似但不是子目录');
  assert.equal(isWithin(path.resolve('D:\\other'), path.resolve('D:\\a')), false);
});

test('resolveWorkspace：白名单根目录与其子目录均放行', async () => {
  const { root, allowed, sub } = await makeTree();
  const allowlist = [allowed];

  const atRoot = await resolveWorkspace(allowed, { allowlist });
  assert.equal(atRoot.ok, true);
  assert.equal(atRoot.path, await fs.realpath(allowed));

  const inSub = await resolveWorkspace(sub, { allowlist });
  assert.equal(inSub.ok, true, '子目录必须在白名单内');
  assert.equal(inSub.path, await fs.realpath(sub));

  await fs.rm(root, { recursive: true, force: true });
});

test('resolveWorkspace：白名单外、相对路径、不存在、文件、空白名单全部拒绝', async () => {
  const { root, allowed, other } = await makeTree();
  const allowlist = [allowed];

  const outside = await resolveWorkspace(other, { allowlist });
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'bad_request');
  assert.match(outside.message, /不在白名单内/);

  // `..` 穿越：allowed\..\other 归一化后落在白名单之外
  const escape = await resolveWorkspace(path.join(allowed, '..', 'other'), { allowlist });
  assert.equal(escape.ok, false, '必须阻止 .. 穿越');

  const relative = await resolveWorkspace('relative\\dir', { allowlist });
  assert.equal(relative.ok, false);
  assert.match(relative.message, /绝对路径/);

  const missing = await resolveWorkspace(path.join(root, 'not-exist'), { allowlist });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /不存在/);

  const file = await resolveWorkspace(path.join(root, 'file.txt'), { allowlist });
  assert.equal(file.ok, false);
  assert.match(file.message, /必须是目录/);

  const emptyAllowlist = await resolveWorkspace(allowed, { allowlist: [] });
  assert.equal(emptyAllowlist.ok, false, '空白名单必须默认拒绝');

  // 未传 workspace 时回退到默认工作区
  const fallback = await resolveWorkspace(undefined, { allowlist, defaultWorkspace: allowed });
  assert.equal(fallback.ok, true);
  const noDefault = await resolveWorkspace(undefined, { allowlist });
  assert.equal(noDefault.ok, false);
  assert.match(noDefault.message, /defaultWorkspace/);

  await fs.rm(root, { recursive: true, force: true });
});

test('resolveWorkspace：Windows 盘符大小写不敏感', { skip: process.platform !== 'win32' }, async () => {
  const { root, allowed } = await makeTree();
  const upper = allowed.toUpperCase();
  const result = await resolveWorkspace(upper, { allowlist: [allowed] });
  assert.equal(result.ok, true, '同一路径的大小写变体应被识别为白名单内');
  await fs.rm(root, { recursive: true, force: true });
});

test('listWorkspaces：返回 path/label/exists 与 default', async () => {
  const { root, allowed, other } = await makeTree();
  const { workspaces, default: def } = await listWorkspaces({
    allowlist: [allowed, path.join(root, 'ghost')],
    defaultWorkspace: other,
  });
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces[0].label, 'allowed');
  assert.equal(workspaces[0].exists, true);
  assert.equal(workspaces[1].exists, false, '不存在的白名单目录 exists=false');
  assert.equal(def, other);

  const autoDefault = await listWorkspaces({ allowlist: [allowed], defaultWorkspace: null });
  assert.equal(autoDefault.default, allowed);
  await fs.rm(root, { recursive: true, force: true });
});
