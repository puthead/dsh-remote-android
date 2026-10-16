/**
 * 安全红线独立复核：**网关绝不写入用户的真实 DSH home**（镜像只读）。
 *
 * 为什么需要独立的复核脚本（而不是只看网关自己的测试）：
 *   本轮已经出现过多次「双方各自测试自洽、真实对接才暴露」的缺陷
 *   （WS_GUID 常量、`/api/v1/` 白名单、hello/ready 互相等待、心跳超时阈值==周期）。
 *   "镜像只读"是同级别的风险，因此必须有一套**不依赖被测代码假设**的文件系统复核。
 *
 * 判据（全部基于**文件系统事实**，不调用任何网关代码）：
 *   1. 真实 `~/.dsh/sessions` 下不存在网关自有会话（`sdk-probe*` 或路径含网关特征）；
 *   2. 真实 projcache 里不存在 `cwd` 指向网关 home / 测试目录的会话；
 *   3. 与基线快照相比，真实 home 里**没有新增**疑似网关产物。
 *      桌面端自身在跑时会持续写自己的会话，因此"修改"不算违规，只有"新增出网关特征路径"才算。
 *
 * 用法（推荐在 selftest.ps1 里做成「先快照 → 跑测试 → 再比对」的原子流程）：
 *   node scripts/tests/check-real-dsh-readonly.mjs --snapshot <基线.json>   # 基线不存在则写入并跳过判据 3
 *   node scripts/tests/check-real-dsh-readonly.mjs --snapshot <基线.json>   # 事后复核（判据 3 生效）
 *   node scripts/tests/check-real-dsh-readonly.mjs --home <假 home>          # 阴性对照（证明判据不是恒绿）
 *
 * 退出码：0 = 通过；1 = 发现泄漏或无法判定（会把证据打印出来）。
 * 原作：Lead（2026-10-08）；本副本由 ops-doc 收编进 scripts/tests/ 并补上「基线不存在则写入」，
 * 以避免「首次运行必然报无法判定」的自相矛盾。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
}

const realHome = path.resolve(argOf('--home', path.join(os.homedir(), '.dsh')));
const snapshotFile = argOf('--snapshot', null);

/** 网关侧路径特征；命中任一即视为"网关自有"痕迹。 */
const GATEWAY_MARKERS = [
  /[\\/]\.dsh-remote[\\/]/i,
  /[\\/]dsh-remote[\\/]/i,
  /[\\/]dsh-home[\\/]/i,
  /[\\/]dsh-relay[\\/]/i,
  /[\\/]gw-probe[\\/]/i,
  /[\\/]sdk-probe/i,
  /[\\/]dsh-sdk-probe[\\/]/i,
  /[\\/]dsh-probe-home[\\/]/i,
  /[\\/]\.runtime[\\/]/i,
];

const failures = [];
const notes = [];

function rel(p) {
  return p.startsWith(realHome) ? p.slice(realHome.length) : p;
}

function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(rel(full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

// ---- 判据 1 + 2：会话目录与 projcache 的 cwd ----
const sessionsRoot = path.join(realHome, 'sessions');
const gatewayOwnedSessions = [];
if (fs.existsSync(sessionsRoot)) {
  for (const slug of fs.readdirSync(sessionsRoot)) {
    const slugDir = path.join(sessionsRoot, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const session of fs.readdirSync(slugDir)) {
      const sessionDir = path.join(slugDir, session);
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      const suspicious = /^sdk-probe/i.test(session) || GATEWAY_MARKERS.some((re) => re.test(sessionDir));
      if (suspicious) gatewayOwnedSessions.push(rel(sessionDir));
    }
  }
}
if (gatewayOwnedSessions.length > 0) {
  failures.push(`判据 1 失败：真实 home 的 sessions 下出现网关自有会话 ${gatewayOwnedSessions.length} 个`);
  for (const p of gatewayOwnedSessions.slice(0, 10)) notes.push(`  泄漏目录：${p}`);
} else {
  notes.push('判据 1 通过：sessions 下无网关自有会话（无 sdk-probe / 网关路径痕迹）');
}

const projRoot = path.join(realHome, 'storages', 'session_projcache', 'sessions');
const leakedCwd = [];
if (fs.existsSync(projRoot)) {
  for (const file of fs.readdirSync(projRoot)) {
    if (!file.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(projRoot, file), 'utf8'));
    } catch {
      continue; // 损坏/半写文件不是泄漏证据
    }
    const cwd = parsed?.record?.identity?.cwd;
    if (typeof cwd === 'string' && GATEWAY_MARKERS.some((re) => re.test(cwd))) {
      leakedCwd.push(`${file} -> ${cwd}`);
    }
  }
}
if (leakedCwd.length > 0) {
  failures.push(`判据 2 失败：真实 projcache 里有 ${leakedCwd.length} 个会话的 cwd 指向网关路径`);
  for (const line of leakedCwd.slice(0, 10)) notes.push(`  ${line}`);
} else {
  notes.push('判据 2 通过：projcache 中无会话 cwd 指向网关 home / 测试目录');
}

// ---- 判据 3：与基线快照比对「新增」文件 ----
let snapshotWritten = false;
if (snapshotFile) {
  if (!fs.existsSync(snapshotFile)) {
    // 基线不存在 → 现在写入（原子写），本轮跳过判据 3；这是「先快照 → 跑测试 → 再比对」的第一步
    const snapshot = { generatedAt: new Date().toISOString(), home: realHome, files: walkFiles(realHome).map((p) => ({ p })) };
    fs.mkdirSync(path.dirname(path.resolve(snapshotFile)), { recursive: true });
    const tmp = `${path.resolve(snapshotFile)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, path.resolve(snapshotFile));
    snapshotWritten = true;
    notes.push(`判据 3 跳过：基线快照不存在，已写入 ${path.resolve(snapshotFile)}（${snapshot.files.length} 个文件，${snapshot.generatedAt}）`);
  } else {
    const baseline = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    const before = new Set((baseline.files ?? []).map((f) => f.p));
    const now = walkFiles(realHome);
    const added = now.filter((p) => !before.has(p));
    // 只把"看着像网关产物的新增"当失败；桌面端新建自己的会话是正常的
    const gatewayAdded = added.filter((p) => GATEWAY_MARKERS.some((re) => re.test(p)));
    notes.push(`基线时间：${baseline.generatedAt ?? '(未记录)'}；本次复核：${new Date().toISOString()}`);
    if (gatewayAdded.length > 0) {
      failures.push(`判据 3 失败：真实 home 里新增了 ${gatewayAdded.length} 个疑似网关产物文件`);
      for (const p of gatewayAdded.slice(0, 10)) notes.push(`  新增：${p}`);
    } else {
      notes.push(`判据 3 通过：新增文件 ${added.length} 个，其中无网关路径特征（桌面端自身写入不计）`);
      for (const p of added.slice(0, 5)) notes.push(`  新增（非违规）：${p}`);
    }
  }
} else {
  notes.push('判据 3 跳过：未提供 --snapshot 基线');
}

console.log(`真实 DSH home：${realHome}`);
for (const line of notes) console.log(line);
if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log('');
  console.log(`PASS 镜像只读红线：网关未写入用户真实 DSH home${snapshotWritten ? '（本轮已写入基线，判据 3 下轮生效）' : ''}`);
}
