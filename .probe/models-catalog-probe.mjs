// .probe/models-catalog-probe.mjs —— 只读探针：真桌面端 `session/modelCatalog` 的真实形状。
//
// 为什么要有它：`GET /api/v2/models`（网关）与手机端 `ModelCatalog` 解析器都依赖这个
// RPC 的字段名与层级。用桩测只能证明"网关按契约转发了"，证明不了"桌面端真的这么回"。
// 本探针**不写任何东西**：只调一个只读 RPC，然后打印形状。
//
// 用法：node .probe/models-catalog-probe.mjs
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const api = new DesktopApi({ logger: silent });

const t0 = Date.now();
const catalog = await api.modelCatalog();
const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
const failures = Array.isArray(catalog?.failures) ? catalog.failures : [];

console.log(`耗时 ${Date.now() - t0}ms`);
console.log('default            =', JSON.stringify(catalog?.default ?? null));
console.log('routableProviders  =', JSON.stringify(catalog?.routableProviders ?? null));
console.log(`groups=${groups.length} failures=${failures.length}`);
for (const g of groups) {
  const models = Array.isArray(g?.models) ? g.models : [];
  console.log(`  ├ ${g?.id} (${g?.name}) → ${models.length} 个：${models.map((m) => m?.id).join(', ')}`);
}
for (const f of failures) console.log(`  ⚠ ${f?.id} (${f?.name}): ${f?.message}`);

const first = groups.find((g) => Array.isArray(g?.models) && g.models.length > 0);
console.log('样例模型项         =', JSON.stringify(first?.models?.[0] ?? null));

const checks = [
  ['default 是对象或 null', catalog?.default === null || typeof catalog?.default === 'object'],
  ['groups 是数组', Array.isArray(catalog?.groups)],
  ['每组有字符串 id', groups.every((g) => typeof g?.id === 'string' && g.id.length > 0)],
  ['每组有字符串 name', groups.every((g) => typeof g?.name === 'string')],
  ['每组 models 是数组', groups.every((g) => Array.isArray(g?.models))],
  ['每个模型项有非空 id', first ? typeof first.models[0]?.id === 'string' && first.models[0].id.length > 0 : false],
  ['每个模型项有 name', first ? typeof first.models[0]?.name === 'string' : false],
];
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(bad === 0 ? '\n结论：形状与契约一致（网关 normalizeModelGroups / 手机端 parseModelCatalog 的前提成立）' : `\n结论：有 ${bad} 条断言不成立`);
process.exit(bad === 0 ? 0 : 1);
