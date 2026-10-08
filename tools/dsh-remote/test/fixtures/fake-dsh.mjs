/**
 * 测试替身：模拟 `node <bin.js> --profile headless "<prompt>"` 的可观测行为。
 *
 * 为什么需要它：真实 dsh 每次调用都要联网请求模型（秒级 + 消耗额度 + 结果不确定），
 * 无法用来断言「退出码非 0 → failed」「取消 → 进程树被杀」这类确定性行为。
 * 该替身接受与真实 CLI 完全相同的 argv 形状，并把收到的 argv 原样落盘，
 * 使得「prompt 中的中文/引号/换行/反斜杠零改写地到达子进程」可以被精确断言。
 *
 * 协议：prompt 若是 JSON 对象且含 mode 字段，则按脚本执行；否则把 prompt 原样写到 stdout（echo）。
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';

// 记录 argv/cwd/DSH_HOME，供测试断言传递保真性
// 说明：child 侧 process.argv[1] 即被网关作为 argv[0] 传入的 bin.js，
// 因此这里额外记录 entry，使「网关实际传了什么 argv」可被完整断言。
const recordFile = process.env.FAKE_DSH_ARGV_FILE;
if (recordFile) {
  fs.appendFileSync(
    recordFile,
    `${JSON.stringify({ entry: process.argv[1] ?? null, argv, prompt, cwd: process.cwd(), dshHome: process.env.DSH_HOME ?? null })}\n`,
    'utf8',
  );
}

/** 分片写 stdout，模拟真实 CLI 的流式输出。 */
function writeChunks(text, chunks, delayMs, done) {
  const size = Math.max(1, Math.ceil(text.length / chunks));
  let index = 0;
  const step = () => {
    if (index >= text.length) {
      done();
      return;
    }
    process.stdout.write(text.slice(index, index + size));
    index += size;
    setTimeout(step, delayMs);
  };
  step();
}

function parseMode() {
  if (!prompt.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(prompt);
    return parsed && typeof parsed === 'object' && typeof parsed.mode === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

const script = parseMode();

if (!script) {
  // 默认行为：把 prompt 原样回显（用于断言特殊字符）
  writeChunks(prompt, 3, 10, () => {
    process.exitCode = 0;
  });
} else {
  switch (script.mode) {
    case 'echo': {
      writeChunks(script.text ?? '', script.chunks ?? 3, script.delayMs ?? 10, () => {
        process.exitCode = script.code ?? 0;
      });
      break;
    }
    case 'exit': {
      if (script.stderr) process.stderr.write(script.stderr);
      if (script.stdout) process.stdout.write(script.stdout);
      process.exitCode = script.code ?? 1;
      break;
    }
    case 'sleep': {
      if (script.stdout) process.stdout.write(script.stdout);
      setTimeout(() => {
        process.exitCode = script.code ?? 0;
      }, script.ms ?? 1000);
      break;
    }
    case 'tree': {
      // 派生一个"孙进程"，用于验证取消时整棵进程树都被终止
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      process.stdout.write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);
      setTimeout(() => {
        process.exitCode = script.code ?? 0;
      }, script.ms ?? 10_000);
      break;
    }
    case 'big': {
      // 分块输出带序号的数据流：每块形如 `<0007>xxxx…`，
      // 这样测试可以精确断言「超限时保留的是尾部而不是头部」。
      const size = script.bytes ?? 1024;
      const blockSize = script.blockSize ?? 512;
      let written = 0;
      let index = 0;
      const step = () => {
        if (written >= size) {
          process.exitCode = 0;
          return;
        }
        const header = `<${String(index).padStart(4, '0')}>`;
        const body = 'x'.repeat(Math.max(0, Math.min(blockSize, size - written) - header.length));
        process.stdout.write(header + body);
        written += header.length + body.length;
        index++;
        setImmediate(step);
      };
      step();
      break;
    }
    case 'stderr-spam': {
      process.stderr.write(script.stderr ?? 'boom\n');
      process.exitCode = script.code ?? 1;
      break;
    }
    default: {
      process.stderr.write(`fake-dsh: 未知 mode ${script.mode}\n`);
      process.exitCode = 64;
    }
  }
}
