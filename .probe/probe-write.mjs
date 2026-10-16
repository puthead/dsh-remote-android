// 临时探针（收尾会删）：证明同一个 junction 路径「读放行、写拒绝」，并打印真实错误码与文案。
import { resolveTarget, READ_MODE, WRITE_MODE } from '../tools/dsh-remote/lib/workspace-fs.mjs';

const allowlist = ['D:\\Workspace\\插件', 'D:\\Workspace\\dsh_android'];
const cases = [
  ['插件 junction（逃逸到 C:\\Users\\Administrator\\.dsh\\profiles\\node_modules）', 'D:\\Workspace\\插件', 'dsh-doc-forge/node_modules'],
  ['dsh_android junction accepts（逃逸到 npm-cache）', 'D:\\Workspace\\dsh_android', '.runtime/acceptance/profiles/node_modules/accepts'],
  ['普通子目录（不该受影响）', 'D:\\Workspace\\插件', 'dsh-doc-forge/lib'],
  ['真越界（读写都必须拒）', 'D:\\Workspace\\插件', '..\\论文'],
];

for (const [label, workspace, requestPath] of cases) {
  console.log(`\n=== ${label}  workspace=${workspace}  path=${requestPath}`);
  for (const mode of [READ_MODE, WRITE_MODE]) {
    try {
      const t = await resolveTarget({ requestPath, workspace, allowlist, mode });
      console.log(`  [${mode}] 放行  path=${t.path}  escaped=${t.escaped}  escapedTo=${t.escapedTo ?? '-'}`);
    } catch (err) {
      console.log(`  [${mode}] 拒绝  code=${err.code}  message=${err.message}`);
    }
  }
}
