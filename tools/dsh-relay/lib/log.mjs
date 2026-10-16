/**
 * 按天滚动的文件日志器（中继侧）。
 *
 * 与网关 `createLogger` 的差别只在默认前缀与目录：中继与网关常在同一台 PC 上跑，
 * 日志必须能分开定位（`relay-YYYYMMDD.log` / `gateway-YYYYMMDD.log`）。
 *
 * 安全约定：写入前统一走 `redactSecrets`，任何调用方都无法把明文令牌/授权头写进日志；
 * 写日志失败绝不影响主流程（磁盘问题不该让隧道中断）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './util.mjs';

/**
 * 本地日期戳 YYYYMMDD（日志按天滚动）。 @param {Date} [d]
 */
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * @param {{dir?: string|null, filePrefix?: string, toConsole?: boolean, now?: () => number, consoleLike?: Console}} opts
 *   `dir` 传 null 表示仅输出到控制台（配置加载阶段还不知道日志目录）。
 */
export function createLogger({ dir = null, filePrefix = 'relay', toConsole = true, now = Date.now, consoleLike = console } = {}) {
  const fileFor = (ts) => (dir ? path.join(dir, `${filePrefix}-${dateStamp(new Date(ts))}.log`) : null);
  let lastFile = null;

  const write = (level, msg) => {
    const ts = now();
    const line = `${new Date(ts).toISOString()} [${level}] ${redactSecrets(msg)}\n`;
    const file = fileFor(ts);
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line, 'utf8'); // 同步写：崩溃时日志不丢，本地小体量可接受
        lastFile = file;
      } catch {
        /* 日志失败不抛出 */
      }
    }
    if (toConsole) {
      // warn/error 走 stderr，便于运维用重定向分离
      const sink = level === 'error' || level === 'warn' ? consoleLike.error : consoleLike.log;
      sink.call(consoleLike, line.trimEnd());
    }
  };

  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => write('debug', m),
    /** @returns {string|null} 最近一次成功写入的日志文件路径（测试用） */
    currentFile: () => lastFile,
    dir,
  };
}

/** 静默日志器：测试与库内默认值使用，避免在断言输出里混入噪声。 */
export const silentLogger = Object.freeze({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  currentFile: () => null,
  dir: null,
});
