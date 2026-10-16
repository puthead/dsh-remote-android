/**
 * 工作区白名单 / 工作区文件系统测试（契约 §6.6 + §4.3）。
 *
 * 分两部分：
 * 1. `workspace.mjs` 的白名单解析（`resolveWorkspace` / `isWithin` / `listWorkspaces`）；
 * 2. `workspace-fs.mjs` 的读/写分流（2026-10-14 修「工作区里的文件夹进不去」引入）：
 *    [READ] 顺链接读（含指向工作区外的 junction）放行、[WRITE] 仍严格拒绝，
 *    以及中文路径、根自身、depth/条目上限、UNC/ADS 仍拒绝。
 *
 * 原则同仓库其它测试：不 mock 真实代码路径 —— 真的建临时目录、真的建 junction。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithin, listWorkspaces, resolveWorkspace } from '../lib/workspace.mjs';
import {
  MAX_DEPTH,
  MAX_ENTRIES,
  listDirectory,
  readFileEntry,
  resolveTarget,
  searchWorkspace,
} from '../lib/workspace-fs.mjs';

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

/**
 * 构造 fs 测试树：
 *   ws/{子目录 中文目录/深层, 普通文件, 链接目录 -> outside（junction）, 链接文件 -> outside/secret.txt}
 * `outside` **不在**白名单里，用来验证"读放行、写拒绝"。
 * @returns {Promise<{root: string, ws: string, outside: string, linkOk: boolean, linkName: string}>}
 */
async function makeFsTree(t, { allowOutside = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-fs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(ws, '中文目录', '深层'), { recursive: true });
  await fs.mkdir(path.join(ws, 'sub'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(ws, '中文目录', '深层', '说明.md'), '工作区里的中文文件', 'utf8');
  await fs.writeFile(path.join(ws, 'a.txt'), 'hello', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  await fs.writeFile(path.join(outside, 'note.md'), '# 外部的文件\n', 'utf8');

  // 目录联接（Windows junction；其它平台回落成目录符号链接）。
  // Windows 上 junction 的 dirent 不报 isDirectory，只有 lstat().isSymbolicLink() 为真 ——
  // 这正是 npm 装出来的 node_modules 在生产环境里的形态。
  const linkName = 'escape-dir';
  let linkOk = false;
  try {
    await fs.symlink(outside, path.join(ws, linkName), 'junction');
    linkOk = true;
  } catch {
    linkOk = false;
  }
  if (linkOk) {
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'escape-file.txt'), 'file');
    } catch {
      /* 文件符号链接需要额外权限，失败不影响目录联接用例 */
    }
  }
  const allowlist = allowOutside ? [ws, outside] : [ws];
  return { root, ws, outside, linkOk, linkName, allowlist };
}

// ─────────────────────────────────────────── workspace.mjs 白名单

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

// ─────────────────────────────────────────── resolveTarget：基础语义

test('resolveTarget：根自身 / 相对路径 / 尾随分隔符 / 正反斜杠 都落在根上', async (t) => {
  const { ws, allowlist } = await makeFsTree(t);

  const cases = [
    ['空串（根）', ''],
    ['根绝对路径', ws],
    ['根绝对路径 + 尾随反斜杠', ws + '\\'],
    ['根绝对路径 + 正斜杠', ws.replace(/\\/g, '/')],
    ['单点', '.'],
    ['点斜杠', './'],
  ];
  for (const [label, requestPath] of cases) {
    const target = await resolveTarget({ requestPath, workspace: ws, allowlist, mode: 'read' });
    assert.equal(target.isDir, true, `${label} 应解析为目录`);
    assert.equal(target.relative, '.', `${label} 的相对路径应为根`);
    assert.equal(target.path, path.resolve(ws));
  }

  // 相对子目录：两种分隔符 + 尾随分隔符都必须等价
  for (const rel of ['sub', 'sub\\', 'sub/', './sub']) {
    const target = await resolveTarget({ requestPath: rel, workspace: ws, allowlist, mode: 'read' });
    assert.equal(target.isDir, true, `${rel} 应解析为目录`);
    assert.equal(target.relative, 'sub');
  }
  // 绝对子目录也必须等价（手机端 WorkspacePaths.absolute 产出的是绝对路径）
  const abs = await resolveTarget({ requestPath: path.join(ws, 'sub'), workspace: ws, allowlist, mode: 'read' });
  assert.equal(abs.relative, 'sub');
});

test('resolveTarget：中文工作区与中文子目录放行（非 ASCII 不是越界理由）', async (t) => {
  const { ws, allowlist } = await makeFsTree(t);
  const target = await resolveTarget({ requestPath: '中文目录\\深层', workspace: ws, allowlist, mode: 'read' });
  assert.equal(target.isDir, true);
  assert.equal(target.relative, '中文目录/深层');

  const file = await resolveTarget({ requestPath: '中文目录/深层/说明.md', workspace: ws, allowlist, mode: 'read', expect: 'file' });
  assert.equal(file.isFile, true);

  // 中文路径经 realpath 往返后仍然是同一串字节（不能出现"文件名被转码"的假越界）
  const viaRealpath = await resolveTarget({
    requestPath: path.join(ws, '中文目录', '深层', '说明.md'),
    workspace: ws,
    allowlist,
    mode: 'read',
  });
  assert.equal(viaRealpath.path, file.path);
});

// ─────────────────────────────────────────── 读放行 / 写拒绝（核心修复）

test('读放行：[READ] 能进 junction 目录、能读 junction 里的文件，并如实标记 escaped', async (t) => {
  const { ws, outside, linkOk, linkName, allowlist } = await makeFsTree(t);
  if (!linkOk) {
    t.diagnostic('当前环境无法创建 junction/符号链接，跳过链接读放行断言');
    return;
  }

  // 1) parse：junction 本身就是一个"目录"
  const dir = await resolveTarget({ requestPath: linkName, workspace: ws, allowlist, mode: 'read' });
  assert.equal(dir.isDir, true, 'junction 指向目录时必须 isDir=true（否则手机端点不进去）');
  assert.equal(dir.isSymlink, true, 'junction 必须仍被识别为链接（type=symlink）');
  assert.equal(dir.escaped, true, 'junction 落在工作区外，必须标记 escaped');
  assert.equal(dir.escapedTo, outside.replace(/^$/, ''));
  // `path` 按修复前的契约给 realpath；要按用户输入的链接名做 I/O 时取 `lexicalPath`
  // （listDirectory/readFileEntry/searchWorkspace 内部就是这么用的）
  assert.equal(dir.path, await fs.realpath(path.join(path.resolve(ws), linkName)), 'path 保持"解析后落点"的旧契约');
  assert.equal(dir.lexicalPath, path.join(path.resolve(ws), linkName), 'lexicalPath 必须是词法路径（不能用 realpath 换掉链接名）');

  // 2) list：junction 目录里的内容列得出来（旧实现在这里 403）
  const listed = await listDirectory({ workspace: ws, allowlist, requestPath: linkName, depth: 1 });
  assert.deepEqual(
    listed.entries.map((e) => e.name).sort(),
    ['note.md', 'secret.txt'],
    'junction 目录的内容必须列得出来',
  );
  assert.equal(listed.path, path.join(path.resolve(ws), linkName), '列目录要回显用户输入的链接名，而不是真实目录名');
  assert.equal(listed.entries.every((e) => e.escaped === true), true, '每个条目都应标记 escaped');

  // 3) read：junction 里的文件读得出来，并带上 escaped 提示
  const file = await readFileEntry({ workspace: ws, allowlist, requestPath: `${linkName}/secret.txt` });
  assert.equal(file.text, 'secret');
  assert.equal(file.escaped, true);
  assert.equal(file.escapedTo, path.join(outside, 'secret.txt'));
  assert.match(file.escapedNote, /工作区之外/);

  // 4) 根目录列目录时，junction 条目必须是"能继续下钻"的目录条目
  const rootListing = await listDirectory({ workspace: ws, allowlist, requestPath: '', depth: 1 });
  const linkEntry = rootListing.entries.find((e) => e.name === linkName);
  assert.ok(linkEntry, '根目录列表里必须有 junction 条目');
  assert.equal(
    linkEntry.type,
    'dir',
    'junction 必须报 dir：手机端按 type == "dir" 决定"点进去看目录"，报 symlink 会让点一下就走文件查看器并 400「不是文件」',
  );
  assert.equal(linkEntry.escaped, true);
  assert.equal(linkEntry.escapedTo, outside);
  // 指向文件的链接仍然如实报 symlink（手机端据此走文件查看器，而不是当目录下钻）
  const fileLink = rootListing.entries.find((e) => e.name === 'escape-file.txt');
  if (fileLink) assert.equal(fileLink.type, 'symlink');
});

test('写拒绝：[WRITE] 对同一 junction 一律拒绝，错误码与纯越界区分开', async (t) => {
  const { ws, linkOk, linkName, allowlist } = await makeFsTree(t);
  if (!linkOk) {
    t.diagnostic('当前环境无法创建 junction/符号链接，跳过链接写拒绝断言');
    return;
  }

  // 默认 mode 就是 write（严格）——新调用方忘了传 mode 时默认安全
  await assert.rejects(
    () => resolveTarget({ requestPath: linkName, workspace: ws, allowlist }),
    (err) => err.code === 'workspace_symlink_escape',
    '经链接逃逸的写请求必须 403 workspace_symlink_escape（不能复用 workspace_outside）',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: `${linkName}/secret.txt`, workspace: ws, allowlist, mode: 'write', expect: 'file' }),
    (err) => err.code === 'workspace_symlink_escape',
  );
  // 工作区内的普通路径在写模式下照常放行（不能因为修读放行就把写也放宽/收紧）
  const okWrite = await resolveTarget({ requestPath: 'a.txt', workspace: ws, allowlist, mode: 'write', expect: 'file' });
  assert.equal(okWrite.isFile, true);
  assert.equal(okWrite.escaped, false);
  assert.equal(okWrite.escapedTo, null);
});

test('白名单内的工作区之间互相链接不算 escaped（用户自己配的可信关系）', async (t) => {
  const { ws, outside, linkOk, linkName, allowlist } = await makeFsTree(t, { allowOutside: true });
  if (!linkOk) {
    t.diagnostic('当前环境无法创建 junction/符号链接，跳过断言');
    return;
  }
  assert.equal(allowlist.length, 2, '本用例把 outside 也放进白名单');
  const target = await resolveTarget({ requestPath: linkName, workspace: ws, allowlist, mode: 'read' });
  assert.equal(target.escaped, false, '落点在另一个白名单条目内，不该报"跑到工作区之外"');
  assert.equal(target.escapedTo, null);
  assert.equal(target.isDir, true);

  // 白名单之间的链接在写模式下也放行（realpath 仍受白名单约束）
  const write = await resolveTarget({ requestPath: linkName, workspace: ws, allowlist, mode: 'write' });
  assert.equal(write.isDir, true);
  assert.equal(write.escapedTo, null);
  assert.equal(await fs.realpath(write.path), outside);
});

// ─────────────────────────────────────────── 真越界仍然拒绝

test('越界拒绝：`..` 穿越 / 工作区外绝对路径 / UNC / ADS 在读模式下也必须 403', async (t) => {
  const { root, ws, outside, allowlist } = await makeFsTree(t);

  await assert.rejects(
    () => resolveTarget({ requestPath: '..\\outside', workspace: ws, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside',
    '`..` 穿越必须 403 workspace_outside',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: 'sub\\..\\..\\outside', workspace: ws, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: outside, workspace: ws, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside',
    '工作区外的绝对路径（哪怕真实存在）必须 403',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: '\\\\server\\share\\x', workspace: ws, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside' && /UNC/.test(err.message),
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: 'a.txt:secret', workspace: ws, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside' && /备用数据流/.test(err.message),
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: 'nope.txt', workspace: ws, allowlist, mode: 'read', mustExist: true }),
    (err) => err.code === 'not_found',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: 'a.txt', workspace: outside, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside' && /工作区不在白名单内/.test(err.message),
    '工作区本身不在白名单内也必须拒绝',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: root, workspace: path.join(ws, 'a.txt'), allowlist, mode: 'read' }),
    (err) => err.code === 'bad_request' || err.code === 'workspace_outside',
    'workspace 指向文件时必须拒绝',
  );
});

test('UNC 与 ADS 判定函数：`\\\\?\\` 扩展前缀按 UNC 处理（不支持，明确拒绝）', async (t) => {
  const { ws, allowlist } = await makeFsTree(t);
  await assert.rejects(
    () => resolveTarget({ requestPath: `\\\\?\\${path.resolve(ws)}`, workspace: ws, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside' && /UNC/.test(err.message),
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Windows', workspace: ws, allowlist, mode: 'read' }),
    (err) => err.code === 'workspace_outside',
  );
});

// ─────────────────────────────────────────── 深度 / 条目上限

test('listDirectory：depth 上限 MAX_DEPTH，超出被夹住而不是报错', async (t) => {
  const { ws, allowlist } = await makeFsTree(t);
  for (const depth of [MAX_DEPTH, MAX_DEPTH + 10, 0, -3, 'x']) {
    const listed = await listDirectory({ workspace: ws, allowlist, requestPath: '', depth });
    assert.ok(listed.depth >= 1 && listed.depth <= MAX_DEPTH, `depth=${depth} 必须被夹到 1..${MAX_DEPTH}`);
    assert.ok(listed.entries.length > 0);
  }
  assert.equal(MAX_DEPTH, 4, '契约 §4.3 规定 depth 上限为 4');
});

test('listDirectory：大目录按 maxEntries 截断并置 truncated（手机端仍能逐层进入）', async (t) => {
  const { ws, allowlist } = await makeFsTree(t);
  const listed = await listDirectory({ workspace: ws, allowlist, requestPath: '', depth: 1, maxEntries: 3 });
  assert.equal(listed.entries.length, 3);
  assert.equal(listed.truncated, true, '超出上限必须置 truncated=true');
  assert.equal(MAX_ENTRIES, 2000, '契约 §4.3 规定单目录上限 2000 条');

  // 逐层进入不受 depth/条目上限影响：手机每次只请求 depth=1
  const deep = await listDirectory({ workspace: ws, allowlist, requestPath: '中文目录', depth: 1 });
  assert.deepEqual(deep.entries.map((e) => e.name), ['深层']);
  const deeper = await listDirectory({ workspace: ws, allowlist, requestPath: '中文目录/深层', depth: 1 });
  assert.deepEqual(deeper.entries.map((e) => e.name), ['说明.md']);
});

test('listDirectory：默认过滤点文件，showHidden=true 时列出', async (t) => {
  const { ws, allowlist } = await makeFsTree(t);
  await fs.writeFile(path.join(ws, '.隐藏配置'), 'x', 'utf8');
  const normal = await listDirectory({ workspace: ws, allowlist, requestPath: '', depth: 1 });
  assert.equal(normal.entries.some((e) => e.name === '.隐藏配置'), false);
  assert.equal(normal.showHidden, false);
  const hidden = await listDirectory({ workspace: ws, allowlist, requestPath: '', depth: 1, showHidden: true });
  assert.equal(hidden.entries.some((e) => e.name === '.隐藏配置'), true);
  assert.equal(hidden.showHidden, true);
});

// ─────────────────────────────────────────── 搜索（唯一自己往下钻的读端点）

test('searchWorkspace：能搜进 junction 目录，且不会因链接成环而无限递归', async (t) => {
  const { ws, linkOk, linkName, allowlist } = await makeFsTree(t);
  if (!linkOk) {
    t.diagnostic('当前环境无法创建 junction/符号链接，跳过断言');
    return;
  }
  const hit = await searchWorkspace({ workspace: ws, allowlist, q: 'secret', limit: 10 });
  assert.ok(
    hit.matches.some((m) => m.path.includes(linkName)),
    `搜索必须能进 junction 目录（实际命中 ${JSON.stringify(hit.matches.map((m) => m.relative))}）`,
  );

  // 成环：在 junction 目标目录里放一个指回工作区的链接，搜索必须收敛（visitedDirs 去重）
  const loop = path.join(ws, '环');
  try {
    await fs.symlink(ws, loop, 'junction');
  } catch {
    t.diagnostic('无法创建成环链接，跳过收敛断言');
    return;
  }
  const started = Date.now();
  const looped = await searchWorkspace({ workspace: ws, allowlist, q: '不可能命中的词', limit: 10, budgetMs: 4000 });
  assert.equal(looped.matches.length, 0);
  assert.ok(Date.now() - started < 4000, '成环搜索必须在预算内收敛（visitedDirs 去重生效）');
  assert.ok(looped.scannedDirs >= 1);
});

// ─────────────────────────────────────────── readFileEntry 细节

test('readFileEntry：文本/二进制、截断、escaped 字段', async (t) => {
  const { ws, allowlist } = await makeFsTree(t);
  await fs.writeFile(path.join(ws, 'big.txt'), 'x'.repeat(5000), 'utf8');
  await fs.writeFile(path.join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));

  const text = await readFileEntry({ workspace: ws, allowlist, requestPath: 'a.txt' });
  assert.equal(text.binary, false);
  assert.equal(text.text, 'hello');
  assert.equal(text.encoding, 'utf8');
  assert.equal(text.truncated, false);
  assert.equal(text.lines, 1);
  assert.equal(text.escaped, false);
  assert.equal(text.escapedTo, null);
  assert.equal(text.escapedNote, null);
  assert.equal(text.mime, 'text/plain');

  const cut = await readFileEntry({ workspace: ws, allowlist, requestPath: 'big.txt', maxBytes: 100 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 100);
  assert.equal(cut.size, 5000, 'size 必须是完整文件大小，不是截断后的长度');

  const bin = await readFileEntry({ workspace: ws, allowlist, requestPath: 'bin.dat' });
  assert.equal(bin.binary, true);
  assert.equal(bin.text, null);
  assert.equal(bin.encoding, null);

  // 中文文件名往返
  const cn = await readFileEntry({ workspace: ws, allowlist, requestPath: '中文目录/深层/说明.md' });
  assert.equal(cn.text, '工作区里的中文文件');
  assert.equal(cn.name, '说明.md');
  assert.equal(cn.mime, 'text/markdown');
});
