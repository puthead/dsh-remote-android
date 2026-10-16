// 语法/解析体检：只用 kotlinc 把改动过的 Kotlin 文件解析一遍。
// 语义解析（找不到 org.json / junit 之类）报的 "unresolved reference" 不算错；
// 我们真正要抓的是语法错误（unexpected token / expecting '}' / 括号不配对）。
// 无 JDK（只有 JRE）时 kotlinc 无法产字节码，所以只跑到解析+语义分析即可。
import { spawnSync } from 'node:child_process';

const JAVA = 'D:\\finalshell\\jre\\bin\\java.exe';
const CP = ['.probe\\kc\\kotlin-compiler.jar', '.probe\\kc\\kotlin-stdlib.jar'].join(';');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node .probe/kotlin-syntax-check.mjs <文件...>');
  process.exit(2);
}

const r = spawnSync(
  JAVA,
  ['-cp', CP, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-nowarn', '-d', '.probe\\kc\\out', ...files],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

// 语法类错误（解析阶段）：这些是真错误
const syntax = lines.filter((l) => /error:.*(expecting|unexpected|Expecting|Unexpected)/.test(l));
// 语义类错误：缺依赖导致，不算语法问题
const unresolved = lines.filter((l) => /unresolved reference|Unresolved reference/.test(l));
const other = lines.filter(
  (l) =>
    /error:/.test(l) &&
    !syntax.includes(l) &&
    !unresolved.includes(l),
);

console.log(`被检查文件: ${files.length}`);
console.log(`语法错误: ${syntax.length}`);
syntax.slice(0, 40).forEach((l) => console.log(`  ${l}`));
console.log(`unresolved reference（缺依赖，预期内）: ${unresolved.length}`);
console.log(`其它错误: ${other.length}`);
other.slice(0, 40).forEach((l) => console.log(`  ${l}`));
process.exit(syntax.length === 0 && other.length === 0 ? 0 : 1);
