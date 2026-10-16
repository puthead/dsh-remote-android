// Kotlin 结构体检（无 JDK 时的替代方案）：
// 1) 括号配对（() [] {}，含嵌套栈深度，能抓出多余/缺失的右括号）；
// 2) 字符串 / 原始字符串 / 字符字面量 / 注释 的闭合（抓出漏掉的 " 或 """）；
// 3) 文件末尾大括号是否回到 0（Kotlin 顶层声明不允许悬空）。
// 用法: node .probe/kotlin-structure-check.mjs <文件...>
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node .probe/kotlin-structure-check.mjs <文件...>');
  process.exit(2);
}

/** 从头到尾扫一遍，记录括号栈与未闭合的字符串/注释。 */
function scan(src) {
  const problems = [];
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let line = 1;
  let i = 0;

  const at = () => `第 ${line} 行`;
  const push = (ch, chLine) => stack.push({ ch, chLine });

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    const next3 = src.slice(i, i + 3);

    // 换行计数（对所有分支统一处理：先看是不是 \n）
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }

    // 行注释
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    // 块注释（Kotlin 支持嵌套）
    if (c === '/' && next === '*') {
      let depth = 1;
      const startLine = line;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '\n') line += 1;
        if (src[i] === '/' && src[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (src[i] === '*' && src[i + 1] === '/') {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      if (depth > 0) problems.push(`${at()} 块注释未闭合（从第 ${startLine} 行开始）`);
      continue;
    }

    // 原始字符串 """..."""
    if (next3 === '"""') {
      const startLine = line;
      i += 3;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\n') line += 1;
        if (src.slice(i, i + 3) === '"""') {
          // Kotlin 允许 """ 后面紧跟更多引号；贪婪吃到最后一个
          while (src[i] === '"') i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) problems.push(`${at()} 原始字符串未闭合（从第 ${startLine} 行开始）`);
      continue;
    }

    // 普通字符串
    if (c === '"') {
      const startLine = line;
      i += 1;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') {
          if (src[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        if (d === '\n') break; // 普通字符串不许跨行
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) problems.push(`${at()} 字符串未闭合（从第 ${startLine} 行开始）`);
      continue;
    }

    // 字符字面量
    if (c === "'") {
      const startLine = line;
      i += 1;
      let closed = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) problems.push(`${at()} 字符字面量未闭合（从第 ${startLine} 行开始）`);
      continue;
    }

    if (c === '(' || c === '[' || c === '{') {
      push(c, line);
      i += 1;
      continue;
    }

    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (!top) {
        problems.push(`${at()} 多出一个 '${c}'`);
      } else if (top.ch !== pairs[c]) {
        problems.push(`${at()} '${c}' 与第 ${top.chLine} 行的 '${top.ch}' 不配对`);
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  for (const left of stack) {
    problems.push(`第 ${left.chLine} 行的 '${left.ch}' 没有闭合`);
  }
  return problems;
}

let bad = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const problems = scan(src);
  const lines = src.split(/\r?\n/).length;
  if (problems.length === 0) {
    console.log(`OK   ${file} (${lines} 行)`);
  } else {
    bad += 1;
    console.log(`FAIL ${file} (${lines} 行)`);
    problems.slice(0, 20).forEach((p) => console.log(`       ${p}`));
  }
}
process.exit(bad === 0 ? 0 : 1);
