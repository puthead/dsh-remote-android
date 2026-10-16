# 互操作脚本（中继 × 网关真链路）

> **手动互操作脚本，不属于自包含单测。** 它们会**真起 relay 与 gateway 两个子进程**（真实 TCP/WS，无 mock），
> 因此串行执行、占用固定端口段 **19100–19750**（与 `scripts/e2e-crossnetwork.ps1` 的 18787/19443 无交集）。
> 自包含单测请用 `tools/dsh-relay/test/*.test.mjs`（`port:0`，可 CI 并发）。
>
> 运行前请确认：Node 用 DSH 自带运行时
> `D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24.21.0），**工作目录 = 仓库根**。
> 无第三方依赖，不需要 npm install。

## 一行命令（任选）

```powershell
$node = 'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

# 1) 互操作冒烟（33 项/模式）：健康面逐字段一致 + 会话/工作区 + 经隧道配对 + 鉴权未被绕过
& $node scripts/tests/interop-smoke.mjs both                  # 先 off 再 selfsigned
& $node scripts/tests/interop-smoke.mjs off --with-task        # 额外真起 SDK 子进程（37 项，消耗额度）

# 2) 边界与恶意输入（51 项/模式）：伪造令牌、跨 home、控制面越权、overflow、429、强杀、自愈
& $node scripts/tests/interop-boundary.mjs off
& $node scripts/tests/interop-boundary.mjs selfsigned

# 3) P0 hello 时序专项（9 项）
& $node scripts/tests/interop-hello-handshake.mjs

# 4) P0 心跳误杀专项（真实网关，压缩心跳跑 N 个周期）
& $node scripts/tests/interop-heartbeat-liveness.mjs 5

# 5) 安全回归：路径规范化绕过（9 项）
& $node scripts/tests/interop-audit-path-bypass.mjs

# 6) 证据型：把经隧道回传的响应头打印出来（逐跳头审计，不做断言）
& $node scripts/tests/interop-audit-headers.mjs
```

## 退出码语义（全部脚本一致）

| 码 | 含义 |
|---|---|
| `0` | 全部断言通过（打印 `=== …：N/N 通过 ===` 或 `总体：PASS`） |
| `1` | 存在失败断言（`FAIL` 行 + 末尾汇总列出失败项） |
| `2` | 脚本自身无法运行（参数/依赖/环境问题） |

`SKIP` 行是"没有断言/环境不适用"，**不计入通过数**（"没测"不能当证据）。

## 端口与期望输出

| 脚本 | relay 端口 | 期望输出（末尾） |
|---|---|---|
| `interop-smoke.mjs off` | 19100 | `=== 互操作冒烟（tls.mode=off）：33/33 通过 ===` + `总体：PASS` |
| `interop-smoke.mjs selfsigned` | 19300 | `=== …（tls.mode=selfsigned）：33/33 通过 ===` |
| `interop-smoke.mjs off --with-task` | 19100 | `=== …（含真实 SDK 任务）：37/37 通过 ===` |
| `interop-boundary.mjs off` | 19500 | `=== 边界与恶意输入（tls.mode=off）：51/51 通过 ===` |
| `interop-boundary.mjs selfsigned` | 19500 | `=== …（tls.mode=selfsigned）：51/51 通过 ===` |
| `interop-hello-handshake.mjs` | 系统分配 | `总体：PASS`（9 条 PASS） |
| `interop-heartbeat-liveness.mjs` | 19600 | `总体：PASS（断言 7/7 通过，另有 1 项 SKIP 不计入）` |
| `interop-audit-path-bypass.mjs` | 19750 | `=== 路径绕过回归：9/9 通过 ===` |
| `interop-audit-headers.mjs` | 19700 | `=== 响应头审计：3 条探针，逐跳头泄漏 N 条 ===` |
| `interop-selftest-cleanup.mjs` | 19200 | `总体：PASS（断言 11/11 通过）`（证明只清理自己的进程） |

gateway 一律 `port: 0`（系统分配，脚本从 stdout 的 `监听地址` 行解析）。

## 铁律：只清理自己拉起的进程（禁止裸杀进程）

> **本套件只会清理自己 `spawn` 出来的 PID**（登记在 `interop-lib.mjs` 的 `OWNED_PIDS` 里），
> 清理入口**只有一个**：`killOwned(pid, {why})`。**禁止**在任何脚本里散落裸的
> `taskkill` / `Stop-Process` / 按**进程名或命令行关键字**匹配的清理代码。
>
> 为什么写进文档：验收脚本曾按关键字清理，把队友正在跑的隔离中继在 B/D 阶段杀掉
> （`connect ECONNREFUSED`），于是"正确实现的红色结论"与"被自己人杀掉的红色结论"在输出上**无法区分** ——
> 一个会被自己人杀掉的 E2E，比没有 E2E 更危险。

`killOwned()` 的三道保护：
1. **登记**：PID 必须由本次运行的 `spawnCollect()` 登记（否则 `SKIP kill pid=…（未登记：不属于本次运行）`）；
2. **创建时间**：该 PID 在系统里的 `CreationDate` 必须晚于本脚本启动（防 PID 复用）；
3. **隔离 home**：该进程命令行里必须包含**本次运行的隔离 home 路径**（防误伤同机队友的同名进程）。
   两道校验任一不过 → 打印 `SKIP kill pid=…（不属于本次运行）` 并跳过，**绝不动别人的进程**。
通过后使用 `taskkill /PID <pid> /T /F`：只杀**这棵子树**（带走网关派生的 dsh 子进程）；
**必须带 `/F`** —— 不带 `/F` 的 taskkill 对无窗口 console 进程不可靠（实测 relay 会拖到 8s 后才退，把"优雅收尾"变成时序赌博）。

### 如何验证（可复跑）
```powershell
# 1) 所有权自检：外部替身进程绝不被杀；自己的进程确实被清掉
& $node scripts/tests/interop-selftest-cleanup.mjs      # 期望 总体：PASS（断言 11/11 通过）

# 2) 并发自检：两个实例用不同端口段同时跑，互不影响
$env:DSH_INTEROP_PORT_BASE='0';  Start-Process $node -ArgumentList 'scripts/tests/interop-heartbeat-liveness.mjs','8' -PassThru -NoNewWindow -RedirectStandardOutput A.txt
Start-Sleep -Milliseconds 1800
$env:DSH_INTEROP_PORT_BASE='50'; & $node scripts/tests/interop-smoke.mjs off          # 期望 exit=0
$env:DSH_INTEROP_PORT_BASE='60'; & $node scripts/tests/interop-selftest-cleanup.mjs  # 期望 exit=0（它自己会 taskkill）
# A 的日志应仍是 总体：PASS（断言 7/7），且**不出现** ECONNREFUSED / 中断痕迹
```
实测（2026-10-08）：A=exit 0 `断言 7/7`、B=exit 0 `总体：PASS`、C=exit 0 `11/11`，A 全程无线索表明被外部打断。

### 端口被占用时怎么办
脚本**不会**自动杀占用者：它会打印端口号与处理建议后报错退出（见下）。要看是谁占的，用
`Get-NetTCPConnection -LocalPort <port> | Select-Object OwningProcess` + `Get-Process -Id <pid>`。

排查**遗留进程**（只列不杀，自己确认归属后再动手）：
```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*interop*' } |
  Select-Object ProcessId, CreationDate, CommandLine
```

### 多人 / 多轮并发跑（端口冲突）

这些脚本用**固定基址**（上表），`startRelay` 启动前会等端口真正空闲（重启 relay 时上一个进程可能还没退干净）。
若你与队友同时跑，或想并行多轮，用环境变量整体挪一段：

```powershell
$env:DSH_INTEROP_PORT_BASE = 50      # 本次运行改用 19150 / 19350 / 19550 / 19650 / 19750+50 …
& $node scripts/tests/interop-smoke.mjs off
```

端口超过 8s 仍未释放时，脚本会**明确报错**（给出端口号与处理建议），而不是抛一段看不懂的栈。
**禁止占用** `18787 / 19443 / 8787 / 19387`（ops-doc 的 E2E 与网关默认端口）。

### 已知的"曾经假红"（排查线索）

- **TLS 下鉴权拒绝读不到 401**：中继 `rejectUpgrade` 原为 `write()+destroy()`，TLS 下会丢弃未 flush 的响应 →
  客户端只看到连接重置（`status=undefined`）。已改为 `end()`（先 flush 再 FIN）并在 1s 后兜底强断；
  `boundary selfsigned` 从此 3/3 稳定 51/51。
- **重启 relay 时端口未释放**：曾表现为"等待 relay 启动 JSON 超时"。现在 `stop()` 会确认进程退出 + 等端口释放，
  `startRelay` 固定端口前也会等 ≤8s。
- **清理误伤队友**（最严重的一类）：按进程名/关键字清理 → 队友的隔离中继被判红。现已收敛到
  `killOwned()` 单一入口 + 三道保护（登记 / 创建时间 / 隔离 home），并有 `interop-selftest-cleanup.mjs` 固化验证。
- **`taskkill` 不带 `/F` 的时序赌博**：曾使 relay 拖到 8s 后才退出、并让兜底误打印
  `SKIP kill pid=…（未由本脚本启动）`（其实那是自己的进程，只是已注销登记）。现已统一 `/T /F`，
  且**确认进程消失后才注销登记**。
- **启动竞态伪装成业务失败**：`stdout` 打印启动 JSON ≠ 端口已可连。若不等就绪就断言，
  一次竞态会级联出十几条 `FAIL`（gateway-dev 实测 `20/30`）。现在 `startRelay`/`startGateway` 都会
  做一次 **TCP 就绪探测**（`waitPortReady`，≤8s），失败时直接给出端口 + stderr 摘要。
- **"进程被杀"伪装成 N 个功能缺陷**：relay 若在运行中被外部结束，后续断言会连锁 `ECONNREFUSED`。
  现在 `httpJson` 会把这类错误翻译成可读根因（实测输出）：
  ```
  connect ECONNREFUSED 127.0.0.1:19305｜relay(pid=27828) 已退出（exitCode=1）→ 端口 19305 无人监听
  ```
  实现要点：清理授权表（`OWNED_PIDS`）成功后会被注销，诊断另存 `EXITED_OWNED` 历史，
  且退出处理持有 spawn 时的**对象引用**（不能在 exit 时回头查表，那时条目可能已被注销、`ports` 会读成空）。

## 证据目录

每次运行都会新建一个隔离目录，结尾会打印路径：

```
<仓库根>/.runtime/interop/run/<label>-<时间戳>/
  relay.stdout.txt / relay.stderr.txt      # 中继原始输出（含心跳/掉线/拒绝日志）
  gateway.stdout.txt / gateway.stderr.txt  # 网关原始输出
  boundary-evidence.txt                    # 边界脚本的关键行
```

根目录可用环境变量覆盖（脚本内不写死）：`$env:DSH_INTEROP_RUNDIR = 'D:\tmp\interop'`。

## 与契约 §6 判据 A~E 的对应（验收用）

`e2e-crossnetwork.ps1` 是 A~E 的**编排入口**，本目录的脚本是**更细粒度的真实链路证据**。
本表是**脚本侧交叉引用**；编排视角的版本见 ops-doc 的 `docs/03-测试/测试计划.md` §9.9 与 `docs/04-验收/验收报告.md` §8.6。

| 判据 | 本目录的脚本 + 参数 | 断言数 | 实测耗时 | 期望输出（末行） |
|---|---|---|---|---|
| **A. 手机无法直连 PC** | ——（由 E2E 的 `netstat` 断言覆盖） | — | — | 支撑事实：本套件 gateway 一律 `host:127.0.0.1` + `port:0` |
| **B. 手机只经中继可达** | `interop-smoke.mjs off` / `selfsigned` | 33 / 33 | 4.4s / 5.9s | `=== 互操作冒烟（tls.mode=…）：33/33 通过 ===` |
| 同上（含真实业务写入） | `interop-smoke.mjs off --with-task` | 37 | 5.7s | `=== …（含真实 SDK 任务）：37/37 通过 ===`（消耗额度，仅验收期） |
| B 的对抗面 | `interop-boundary.mjs off` / `selfsigned` | 51 / 51 | 18s / 19s | `=== 边界与恶意输入（tls.mode=…）：51/51 通过 ===` |
| **C. PC 只出站** | ——（由 E2E `netstat` 覆盖） | — | — | 支撑：`interop-heartbeat-liveness.mjs` 证明网关靠**出站** WS 长连接长期在线 |
| **D. PC 掉线可见** | `interop-boundary.mjs` §7（强杀网关，走 `killOwned` 的 `taskkill /T /F`） | 51 中的 2 项 | 含在上行 | `PASS device 收到 notice{kind:home_offline}`、`PASS … → 503 home_offline` |
| **E. 中继重启自愈** | `interop-boundary.mjs` §8（同端口重启、复用 homes.json） | 51 中的 4 项 | 含在上行 | `PASS 无人工干预自动重连`、`reconnects 递增 0 → 1`、`homeId 不变`、`业务恢复` |

超出 A~E 的回归：`interop-hello-handshake.mjs`（9，4.1s，死锁）、`interop-heartbeat-liveness.mjs`（7+1 SKIP，8.7s，误杀）、
`interop-audit-path-bypass.mjs`（9，3.0s，**安全级**路径绕过）、`interop-audit-headers.mjs`（证据型，3.0s，逐跳头）、
`interop-selftest-cleanup.mjs`（11，6.3s，**清理所有权自检**）。

**建议顺序**（验收自检）：
1. `interop-selftest-cleanup.mjs` —— 先证明"清理不会误伤队友"（共享工作区的前提）；
2. `interop-smoke.mjs off` —— 判据 B 的最快自证；
3. `interop-boundary.mjs off` —— 判据 D/E + 安全面；
4. 你的 `netstat` 断言（判据 A/C）；
5. 需要 wss 证据时再跑两套 `selfsigned`；
6. 验收期最后跑 `--with-task`（唯一消耗模型额度的一档）。
合计（不含 `--with-task`）：**8 套 ≈ 70s**。

**编排要点**：用 `$LASTEXITCODE` 判定（`0/1/2`）**不需要解析输出**；
建议把 `$env:DSH_INTEROP_RUNDIR` 指到 `.runtime/acceptance/` 让证据与 E2E 放一起。
（A/E 的完整编排口径以 ops-doc 的 `e2e-crossnetwork.ps1` 为准。）

## 这些脚本证明过什么

完整报告：**`scripts/tests/interop-R2-report.md`**（含 7 个"只有真互操作/安全审计才能发现"的缺陷、
合规审计逐项结论、证据强度分类、未覆盖边界）。摘要：

- 真链路跑通：`配对 → 设备隧道 → 业务请求 → SSE/大响应 → 掉线 → 自愈`，隧道内 health 与直连**逐字段一致**；
- 经隧道 `POST /api/v2/tasks` 真起 SDK 子进程 → `202 {source:"phone"}` + transcript 可读；
- 强杀网关 → `notice{home_offline}` + `503`；relay 重启 → 网关**无人工干预**重连（`reconnects 0→1`）；
- 安全：伪造/轮换令牌 401 且不透传、跨 home 拒绝、控制面越权 404、**路径规范化绕过已封堵**。

## 维护约定

- 这些脚本**不 mock 传输层**；发现"两侧各自测试都通过但对接失败"的问题时，优先在这里加一条真实链路用例。
- 新增脚本请沿用本文件的头部格式：用途 / 会起哪些进程 / 占用端口 / 用法 / 退出码语义 / 期望输出。
- 运行数据（`.runtime/`）**不入库**；脚本本身必须在仓库里（这是能复现结论的唯一载体）。
