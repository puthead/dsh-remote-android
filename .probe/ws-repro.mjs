/**
 * 只读复现：手机端「工作区越界」根因。
 *
 * 背景（Lead 已核实的真实调用形态）：
 *   Android `data/api/DshApiV2.kt:169-192` 的 5 个工作区端点只发 `path=`（**绝对路径**），
 *   **从不发 `workspace=`**；而网关 `lib/http.mjs:899 workspaceContext(url)` 在缺 `workspace`
 *   时回落到 `config.defaultWorkspace`（本机为 C:\Users\Administrator\dsh-workspace）。
 *   于是 `lib/workspace-fs.mjs resolveTarget()` 会拿「默认工作区根」去装「另一个白名单根里的
 *   绝对路径」→ 词法包含失败 → 403 workspace_outside，文案正好是
 *   「路径越界（不在工作区内）：D:\Workspace\插件」。
 *
 * 这个脚本不改任何文件，只调用网关库函数，把 before/after 打成可核对的证据。
 *
 * 用法：node .probe/ws-repro.mjs [config.json 路径]
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveWorkspace } from '../tools/dsh-remote/lib/workspace.mjs';
import { resolveTarget, listDirectory } from '../tools/dsh-remote/lib/workspace-fs.mjs';

const cfgPath = process.argv[2] ?? path.join(import.meta.dirname, '..', '.runtime', 'live-env', 'config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const allowlist = cfg.workspaceAllowlist;
const defaultWorkspace = cfg.defaultWorkspace;

/** 从白名单里挑一个"存在且不是默认工作区"的条目，模拟用户在 App 里选了它。 */
const selected = allowlist.find((p) => p !== defaultWorkspace) ?? defaultWorkspace;

console.log('config            :', cfgPath);
console.log('defaultWorkspace  :', defaultWorkspace);
console.log('allowlist         :', allowlist.join(' | '));
console.log('selected (模拟点选):', selected);
console.log('');

async function attempt(label, fn) {
  try {
    const value = await fn();
    console.log(`[OK]   ${label}\n       ${JSON.stringify(value).slice(0, 300)}`);
    return { label, ok: true, value };
  } catch (err) {
    console.log(`[FAIL] ${label}\n       code=${err.code ?? '-'} message=${err.message}`);
    return { label, ok: false, code: err.code, message: err.message };
  }
}

// ---- A. 现状：客户端只发绝对 path、不发 workspace → 网关用默认工作区 ----
const asNow = await attempt('A. 现状：无 workspace 参数 + path=选中工作区绝对路径（Android 当前行为）', async () => {
  const workspace = await resolveWorkspace(null, { allowlist, defaultWorkspace });
  if (!workspace.ok) throw new Error(workspace.message);
  return (await resolveTarget({ requestPath: selected, workspace: workspace.path, allowlist, mustExist: true, expect: 'dir' })).realPath;
});

// ---- B. 正确契约：带 workspace 参数 ----
const withParam = await attempt('B. 契约 §4.3：workspace=选中工作区 + path=同一绝对路径', async () => {
  const workspace = await resolveWorkspace(selected, { allowlist, defaultWorkspace });
  if (!workspace.ok) throw new Error(workspace.message);
  return (await resolveTarget({ requestPath: selected, workspace: workspace.path, allowlist, mustExist: true, expect: 'dir' })).realPath;
});

// ---- C. 客户端应发相对路径（根目录 = 空串） ----
const relative = await attempt('C. 契约 §4.3：workspace=选中工作区 + path=""（根目录）', async () => {
  const workspace = await resolveWorkspace(selected, { allowlist, defaultWorkspace });
  if (!workspace.ok) throw new Error(workspace.message);
  const r = await listDirectory({ workspace: workspace.path, allowlist, requestPath: '', depth: 1 });
  return { depth: r.depth, entries: r.entries.length, first: r.entries.slice(0, 3).map((e) => `${e.type}:${e.name}`) };
});

// ---- D. 越权用例必须仍然被拒（回归护栏） ----
const deny = await attempt('D. 负向：workspace=选中工作区 + path=工作区外的绝对路径（必须被拒）', async () => {
  const workspace = await resolveWorkspace(selected, { allowlist, defaultWorkspace });
  if (!workspace.ok) throw new Error(workspace.message);
  return (await resolveTarget({ requestPath: path.resolve(selected, '..'), workspace: workspace.path, allowlist, mustExist: true, expect: 'dir' })).realPath;
});

console.log('\n==== 结论 ====');
console.log(`A(现状) ${asNow.ok ? '通过了（说明本机默认工作区恰好等于选中工作区，未复现）' : `失败 code=${asNow.code} → 与用户截图文案一致`}`);
console.log(`B(带 workspace 参数) ${withParam.ok ? '通过' : '失败'}`);
console.log(`C(根目录列目录) ${relative.ok ? '通过' : '失败'}`);
console.log(`D(负向越权) ${deny.ok ? '❌ 未被拒绝（安全问题）' : `已被拒绝 code=${deny.code}（正确）`}`);
