# dsh-remote —— PC 端远程任务网关

零第三方依赖（只用 `node:` 内置模块）的 Node ESM 守护进程：把 PC 上 DSH 的执行能力
包装成「HTTP + SSE + 配对鉴权」的接口，供手机 App（`android/` 下的 DshRemote）远程下发任务并实时看输出。

- 接口定义以 **`docs/01-设计/API契约.md`** 与 **`docs/01-设计/协议契约-v2.md`** 为唯一准绳；本文件只描述**怎么装、怎么配、怎么排障**。
- 网关自身不调用任何模型 API。它按会话来源选执行者：网关自有任务/会话走
  `dsh --profile headless "<任务>"` 或长驻 `--profile sdk` 子进程；**电脑端会话**走**桌面端 runtime 通道**
  （§6.7），即"让电脑端自己执行这一轮"，网关只做提交与订阅。

---

## 1. 快速开始（3 步）

```powershell
# 1) 配置：复制模板并改成自己的路径（仓库只保留模板，config.json 不入库）
cd tools\dsh-remote
Copy-Item config.example.json config.json
notepad config.json          # 改 dshHome / workspaceAllowlist / dsh.node / dsh.binPath

# 2) 准备凭据目录（dshHome）：必须存在单行 .credentials.yaml
#    内容形如：DEEPSEEK_API_KEY: sk-xxxx      （UTF-8 无 BOM，只有这一行）
#    注意：不要复用 %USERPROFILE%\.dsh\.credentials.yaml（那是新格式，headless profile 解析失败）

# 3) 启动 + 生成配对码
.\dsh-remote.cmd serve
# 另开一个窗口：
.\pair.ps1
```

拿到 6 位配对码后，在手机 App 的配对页面输入即可换取长期令牌。

---

## 2. 目录结构

```
tools/dsh-remote/
├─ gateway.mjs            # 入口 + 本地 CLI（serve / pair / devices / workspaces）
├─ config.example.json    # 配置模板（仓库唯一入库的配置；config.json 由 setup-pc.ps1 生成，已被 .gitignore 忽略）
├─ config.json            # 本机运行配置（含绝对路径，不入库）
├─ dsh-remote.cmd         # Windows 启动器（优先用 DSH 自带 node.exe）
├─ pair.ps1               # 本机生成 6 位配对码
├─ install-service.ps1    # 计划任务开机自启（-Uninstall 卸载）
├─ lib/
│  ├─ config.mjs            # 配置加载/校验/home 解析 + 版本常量（`GATEWAY_VERSION`）
│  ├─ http.mjs              # 路由、鉴权、限速、1MB 请求体上限、v1/v2 端点、SSE
│  ├─ tasks.mjs             # 任务队列、并发调度、执行、持久化
│  ├─ runner.mjs            # argv 数组 spawn、进程树终止、超时、输出聚合
│  ├─ tokens.mjs            # 设备令牌（sha256 + 恒定时间比较）与配对码
│  ├─ events.mjs            # 事件总线（seq + 最近 2000 条环形缓冲 + 断点续传）
│  ├─ workspace.mjs         # 工作区白名单校验
│  ├─ workspace-fs.mjs      # 工作区文件读写
│  ├─ workspace-git.mjs     # 工作区 Git 状态与改动
│  ├─ ratelimit.mjs         # 滑动窗口限速
│  ├─ util.mjs              # 原子写、ULID、脱敏日志、UTF-8 安全截断
│  ├─ dsh-home.mjs          # DSH home 解析（只读镜像根 vs 网关自有 home）
│  ├─ permission.mjs        # 任务级权限档 → 子进程 `DSH_PERMISSION_MODE`
│  ├─ relay-client.mjs      # PC 主动外连中继（`wss://` 隧道）
│  ├─ session-reader.mjs    # 会话投影读取（多帧 zstd、transcript 分页）
│  ├─ session-live.mjs      # 会话占用/租赁（`409 session_busy` 的真值）
│  ├─ session-runner.mjs    # SDK profile 长驻子进程 + 桌面端通道轮次（§6.7）
│  ├─ desktop-api.mjs       # 桌面端 runtime 适配层（单一适配层，§6.7）
│  ├─ phone-sessions.mjs    # 手机新建任务的归属索引 → `createdBy`（§6.8）
│  ├─ ws.mjs                # WebSocket 帧封装（隧道侧）
│  └─ zstd-multiframe.mjs   # 多帧 zstd 解码
└─ test/                  # node:test 单元 + 集成测试（v1/v2 端点、中继隧道、桌面端通道；含 fixtures 替身）
```

运行期数据全部落在 `dshHome`：

```
<dshHome>/
├─ .credentials.yaml      # 子进程 dsh 的凭据（网关只读取，不写入）
├─ devices.json           # 设备令牌库（只存 sha256，无明文）
├─ phone-sessions.json    # **手机新建任务的归属索引**（`createdBy` 的来源，§6.8；上限 500 条，损坏按空索引继续）
├─ tasks/<taskId>.json    # 任务历史与输出（原子写：.tmp + rename）
└─ logs/gateway-YYYYMMDD.log
```

> `phone-sessions.json` **不在** DSH 自己的 home 里（那是 `%USERPROFILE%\.dsh`）：DSH 会话头是 DSH 的格式
> （`session.v4.jsonl.zstd` header），往里塞网关私有字段会污染用户真实 home，且随 DSH 版本变化失效。

---

## 3. 配置项（最终键名，以此为准）

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `0.0.0.0` | 监听地址 |
| `port` | `8787` | 监听端口；`0` = 系统分配（测试用） |
| `dshHome` | `null` | 运行时 home（凭据 + tasks + logs），同时作为子进程的 `DSH_HOME` |
| `serverName` | 主机名 | `health.serverName` |
| `authRequired` | `true` | 除 `health`/`pair/claim` 外是否强制 Bearer 令牌 |
| `maxConcurrent` | `2` | **只限制同时 running 的任务数**；超额进入 `queued` |
| `maxQueue` | `100` | 排队上限；**仅当排队数达到该值**才返回 `429 busy` |
| `defaultTimeoutSec` | `3600` | 任务默认超时 |
| `maxTimeoutSec` | `86400` | `timeoutSec` 上限 |
| `workspaceAllowlist` | `[]` | 绝对路径数组；**空数组 = 拒绝所有任务**（默认拒绝，避免忘记配置导致全盘可写） |
| `defaultWorkspace` | 白名单首项 | 请求未带 `workspace` 时的默认值 |
| `dsh.node` | `null` | DSH 自带 `node.exe` 绝对路径 |
| `dsh.binPath` | `null` | `dsh` CLI 的 `bin.js` 绝对路径 |
| `dsh.profile` | `headless` | profile 名 |
| `dsh.version` | `0.1.0-rc.7` | 仅用于 `health.dshVersion` |
| `dsh.discoverSessionId` | `true` | 是否从 `<dshHome>/sessions` 反查本次任务的 DSH sessionId |
| `dsh.launcherArgs` | `[]` | 插在 `--profile <p>` 与 prompt 之间的**启动器级**参数（如 `--patch`）；**headless 应用不认识的参数会被并入任务文本，默认必须为空** |
| `dsh.env` | `{}` | 追加到子进程的环境变量 |
| `events.bufferSize` | `2000` | 事件环形缓冲条数（断点续传窗口） |
| `events.heartbeatMs` | `15000` | SSE 心跳间隔（`: ping`） |
| `limits.maxBodyBytes` | `1048576` | 请求体上限；超限 `413 payload_too_large` |
| `limits.maxOutputBytes` | `1048576` | 单任务输出上限；超限**只保留尾部**并置 `truncated:true` |
| `limits.pairClaimPerMinute` | `10` | `pair/claim` 每 IP 每分钟请求数 |
| `limits.authFailPerMinute` | `30` | 认证失败每 IP 每分钟次数 |
| `limits.pairCodeTtlMs` | `300000` | 配对码有效期（5 分钟） |
| `limits.maxSseClients` | `16` | 并发 SSE 连接上限，超限 `429 busy` |
| `limits.requestTimeoutMs` | `30000` | 接收完整请求的超时（慢速请求 → 408/回收） |
| `limits.headersTimeoutMs` | `20000` | 接收请求头的超时 |
| `limits.outputFlushMs` | `200` | 输出增量下发节流（毫秒） |
| `limits.outputFlushBytes` | `8192` | 输出增量下发阈值（字节） |
| `tasks.dirName` | `tasks` | 任务目录名（相对 `dshHome`） |
| `log.dirName` / `log.filePrefix` / `log.toConsole` | `logs` / `gateway` / `true` | 日志目录、文件名前缀、是否同时打印到控制台 |

> 提示：`docs/` 中若出现 `maxConcurrency` / `maxQueueLength` / `bind` 等写法均为**旧草案**，
> 请以本表与 `config.example.json` 为准。

---

## 4. 接口摘要

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/health` | 否 | 连通性探测 |
| POST | `/api/v1/pair/open` | 否，**仅回环** | 生成 6 位配对码；非回环来源 `403 forbidden` |
| POST | `/api/v1/pair/claim` | 否 | 用配对码换设备令牌；`deviceId` 必须是**小写 UUID**，否则 `400` |
| GET | `/api/v1/tasks?status=all\|active&limit&cursor` | 是 | 任务列表（倒序 + 游标分页） |
| POST | `/api/v1/tasks` | 是 | 提交任务（`201`） |
| GET | `/api/v1/tasks/{id}` | 是 | 任务详情（`output` 为当前累计输出） |
| POST | `/api/v1/tasks/{id}/cancel` | 是 | 取消（幂等） |
| DELETE | `/api/v1/tasks/{id}` | 是 | 删除；**活动态 `409 conflict`**，终态 `204` |
| GET | `/api/v1/events?taskId&fromSeq` | 是 | SSE 事件流 |
| GET | `/api/v1/workspaces` | 是 | 工作区白名单 |
| GET | `/api/v1/devices` | 是 | 已配对设备 |
| DELETE | `/api/v1/devices/{tokenId}` | 是 | 吊销令牌（`204`） |

统一错误体：`{ "error": { "code": "...", "message": "..." } }`。
错误码：`unauthorized` `forbidden` `not_found` `bad_request` `conflict`(409) `payload_too_large`(413)
`pairing_closed` `pairing_bad_code` `rate_limited` `busy` `internal`。

### 4.1 输出截断与 SSE 拼接（重要）

- 未截断时：客户端把所有 `task.output` 事件的 `delta` 按 `seq` 拼接，**等于**详情接口的 `output`。
- 超过 `limits.maxOutputBytes` 时：**只保留尾部**，`truncated` 置 `true`；
  **已经推送的 delta 不回滚**，此时「拼接结果」会比 `output` 长，
  **客户端应以 `GET /api/v1/tasks/{id}` 的 `output` 为准**（终态时重新拉取一次即可）。

### 4.2 断点续传

- 服务端保留最近 `events.bufferSize`（2000）条事件；重连带 `fromSeq=<最后收到的 seq>`
  （或标准 `Last-Event-ID` 头）即可补齐缺失事件。
- 若请求的 `fromSeq` 早于缓冲区起点，网关会在同一条 SSE 流里补发一条注释行
  `: gap requested=… oldest=…`（注释行不影响解析）。
  此时缓冲区内的事件**不足以补齐**断点，客户端**必须**回源 `GET /api/v1/tasks/{id}`
  用详情接口的 `output` 兜底重建本地状态（Android 端已按此约定实现）。

### 4.3 v2 SSE：按会话订阅与 `turn.started` 去重（网关 `2.1.0`）

- `GET /api/v2/sessions/stream?fromSeq=&tail=&sessionId=`：`sessionId` 是 **v2.5.0 新增的可选参数**。
  **不传 = 全局流**（一条流覆盖两类会话，客户端按事件里的 `sessionId`/`source` 自行分流）—— 与旧版**逐字一致**；
  传了则**只推该会话**的帧；**不带 `sessionId` 的全局事件（如 `heartbeat`）在两种用法下都照常下发**。
  该参数此前被**静默忽略**（单会话订阅会收到所有会话的事件），缺陷编号 **D-07**，
  根因与修复见[变更记录](../../docs/06-项目管理/变更记录.md) §12.3。
- **客户端必须按「会话 + 轮次」去重 `turn.started`**：网关驱动的一轮在总线上**恒有 2 条**
  （① 网关入队时的本地回执，带 `fromSeq`+`turnId`；② DSH `turn_start` 经翻译后的那条），`turn.ended` 仍然唯一。
  这是**设计**（Android 早已在 `ConsoleRepository.kt` 去重），**不要"修"它**，也不要把 `turn.started` 条数当轮次计数。
- **新开一条流并传 `?fromSeq=0` 会回放历史**（包括此前轮次的 `turn.ended`）—— 属契约行为，不是重复投递缺陷；
  探针与客户端请按 `turn` 号或 `seq` 计数，不要按"收到的事件条数"做断言。

### 4.4 v2 模型目录与每任务模型选择（网关 `2.10.0`）

- `GET /api/v2/models`：手机端「选模型」的目录。回体顶层**恰好六个键**
  `{ok, source, default, routableProviders, groups, failures}`；`source` 只有两种取值 ——
  `"desktop"`（真目录来自电脑端 DSH runtime）与 `"config"`（电脑端没接线／连不上，退到网关配置里的那一项）。
- **降级是正常路径，不是 5xx**：拉不到目录时仍 `200` + `source:"config"` + `groups:[]`，
  并在 `failures` 里留一条 `{id:"desktop", name:"电脑端", message:"<这一次为什么降级>"}` ——
  手机端只有它能解释「为什么列表里只剩一个模型」（只写日志＝用户永远看不出是**电脑端没连上**）。
- `POST /api/v2/tasks` 的 `provider` / `model` / `reasoningEffort` **真的生效**（**v1 不变**，见 §7 第 1 条）：
  - `host:"desktop"`：`session/selectModel` 必须在**首轮投递之前**（桌面端会话的模型「下一次组合 agent 时」生效）；
    切失败**不判任务死**（会话这时已真实存在），改回 `modelApplied:false` + `modelWarning:"<原因>"`，任务照常跑；
  - `host:"gateway"`：模型经 SDK `initialize` 握手下发 —— 模型是**每会话/每进程**的，
    同一会话**后续轮次新传的模型被有意忽略**（中途换模型等于杀掉正在跑的轮次）；
  - 字段畸形（`provider`/`reasoningEffort` 出现但不是非空字符串）→ `400 bad_request`，不静默忽略。
  - 只报 `model`、不报 `provider`（合法）：网关按目录反查 provider，**只推断 provider、绝不改 `model`** ——
    唯一命中→用该分组；多命中（`deepseek-flash` 实测同时在 `deepseek-official`/`deepseek-account` 下）→
    用目录默认 provider；零命中→**不拿默认 provider 顶替**，跳过切换并回 `modelApplied:false` + `modelWarning`。
- 逐字错误码与六条铁律见[协议契约 v2](../../docs/01-设计/协议契约-v2.md) §4.7 / §7.8；
  `GET /api/v2/health` 的 `capabilities` 新增 `models` 与 `task.model` —— 老网关没有这两条，
  手机端**先问能力再显示模型选择器**，否则 `model` 被静默丢掉，用户会看到「选了，但用的是别的模型」。

---

## 5. 安全设计

| 项 | 做法 |
|---|---|
| 令牌存储 | 只存 `sha256(令牌)`；`devices.json` 内无明文（有单测断言文件里不含 `dshr_`） |
| 令牌比较 | `crypto.timingSafeEqual`，且遍历全部设备**不提前 break**，避免时间侧信道 |
| 令牌明文 | 只在 `pair/claim` 响应中出现一次；日志写入前统一脱敏（`sk-` / `dshr_` / `Bearer` → `***`） |
| 配对码 | `crypto` 随机数、6 位、一次性、5 分钟过期；新码使旧码立即失效；`pair/open` 仅接受回环来源 |
| 限速 | `pair/claim` 10/min/IP、认证失败 30/min/IP → `429 rate_limited`（带 `Retry-After`） |
| 命令注入 | 子进程一律 `spawn(cmd, argvArray)`、`shell:false`；prompt 作为**单个** argv 元素传递 |
| 工作区 | realpath 归一 + 白名单（含子目录）+ 默认拒绝；防 `..` 穿越与符号链接逃逸 |
| 请求体 | `Content-Length` 预检 + 流式累计上限 1MB，超限立刻 `413` 并关闭连接 |
| 防挂起 | `requestTimeout`/`headersTimeout` + 缩短巡检间隔；SSE 断开即清定时器与订阅 |

---

## 6. 运维

### 6.1 常用 CLI

```powershell
.\dsh-remote.cmd serve                     # 启动网关
.\dsh-remote.cmd pair                      # 生成配对码（走 127.0.0.1 回环）
.\dsh-remote.cmd devices list              # 列出已配对设备
.\dsh-remote.cmd devices revoke <tokenId>  # 吊销令牌（与 REST 共用同一份 devices.json）
.\dsh-remote.cmd workspaces                # 打印白名单
.\dsh-remote.cmd --help
```

### 6.2 开机自启

```powershell
powershell -ExecutionPolicy Bypass -File .\install-service.ps1            # 注册计划任务（登录时启动）
powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -Uninstall # 卸载
```

### 6.3 测试

```powershell
npm test                              # 等价于下面这条
node --test "test/*.test.mjs"
```

> **Node 24 注意**：`node --test test/`（目录参数）在 Node 24.16/24.21 上会报
> `Error: Cannot find module '…\test'` —— 目录参数不再被展开。
> 请改用 `node --test "test/*.test.mjs"`，或直接 `node --test`（自动发现）。
> `package.json` 的 `test` 脚本已按可在 Windows 跑通的写法配置。

**当前冻结跑数（网关 `2.10.0`，2026-10-16）**：在**无文件沙箱**的 shell 上，
`node --test "test/*.test.mjs"`（即 `npm test`）→ **307 / 307 全绿**（`fail 0` / `cancelled 0` / `skipped 0` / `todo 0`），
`exit code 0`，`duration_ms ≈ 240 s`；该跑 `lib/**` + `test/**` 跑前 = 跑后逐项 mtime+size 一致。
用例演进 **171（基线，当时 fail 3）→ 184 → 188 → 189 → 207（审批桥）→ 246 → 250（实时中继）→ 251（跨进程游标）→ 296 → 307（模型目录 `GET /api/v2/models` + 每任务模型选择，+11）**。
本轮 11 条新用例中，证明力最强的一条是 `v2/gateway：带模型建任务 → 模型经 SDK initialize 下发`：它真的起了 SDK 子进程去读 `initialize` 参数（见 `test/fixtures/fake-sdk.mjs` 的 `FAKE_SDK_INIT_FILE`），**只有在不受限 shell 里才会绿**。
`skipped 0` 也是因为该 shell 里 git 与子进程都可用（受限 shell 里那条「本机没有 git」会变成 `skipped`）。

> **受限沙箱里的替代口径（本地自测可以，别当交付读数）**：DSH 文件沙箱禁止 `node --test` 的逐文件子进程
> —— `spawn EPERM`（`node --test` 给子进程接的是**管道** stdio，而沙箱不允许打开命名管道；
> `stdio:'inherit'` 的 spawn 是通的），所以 `npm test` 整仓跑不起来，`spawn` 只在**文件级 runner** 这一步被拦。
> 可用的替代是 `--test-isolation=none`（全部用例挂在**同一个进程**里，没有文件级子进程）：
> 本机实测 **279 / 307**（`fail 27` / `skipped 1` / `duration_ms ≈ 273 s`）。**这 27 条红全是环境边界，不是功能回归**：
> 要么需要 spawn 子进程（`host:"gateway"` 的 SDK 运行时、CLI、v1 tasks、SSE），要么依赖 Windows 的 junction 识别
> （`type=symlink`）。**本轮 11 条新用例在该口径下 10 绿 1 红**，唯一那条红就是上面提到的
> `v2/gateway：带模型建任务 → 模型经 SDK initialize 下发`（它要真子进程，沙箱里只会拿到
> `无法启动会话运行时：spawn EPERM`，这正是它存在的意义：证明模型**确实**进了 `initialize`，而不是被网关记在日志里）。
> **要判定"有没有回归"请用逐文件口径**（每个文件一个进程，最接近 CI）；另一种等价口径是逐文件各跑一次，
> 本机实测合计 `pass 291` / `fail 32` / `skipped 2`（325 条）—— 与单进程口径的差来自 `test/cli.test.mjs`
> 的 CLI 子进程退出码与 `dsh.env` 残留等**顺序敏感性**。别用单进程口径的 fail 数当回归信号。
**冻结口径**：引用跑数前必须确认**「跑前 = 跑后」**（`lib/**` 与 `test/**` 的 mtime + size 逐项一致）——
跑程中有源码写入的那次计数**不算数**（上一轮 188/188 就是因为 D-07 的修复落在跑程里而作废）；
本次 2.10.0 这一跑已按此确认（`lib/**` + `test/**` 逐项 mtime+size 一致，`STABLE=True`）。

**本轮两条回归钉子（`test/v2-desktop.test.mjs`，共 20 条用例）**：

- `v2/desktop：收到 turn/end 后订阅流被显式关闭（WS 句柄不泄漏）` —— 钉住 `session-runner.mjs` 收束路径的
  `await iterator.return?.()`（**D-06**：不补则每跑一轮泄漏一个 WebSocket，进程退不出去）。
- `v2/desktop：?sessionId= 的 SSE 流只收本会话事件（全局流仍全部会话都收）` —— 钉住 SSE 按会话过滤（**D-07**）。

**`2.2.0` 新增的钉子**：

- `test/desktop-watch.test.mjs`（单元）—— 水位线取 `max(outline, stats)`（`pickTurn` **不加 1**，实测
  `turn:3 → 4` 而不是 5）、`running` 过滤、`#retire` 的收尾只跑一次。
- `test/v2-desktop.test.mjs:537` / `:603`（集成，真桩桌面端）—— ①中继把**电脑端自己发起**的轮次推进总线
  （手机端订阅的是**不带** `?sessionId=` 的全局会话流）；②手机端直连桌面的 SSE 订阅在场时**中继让位**，
  同一条会话不会出现两份帧。
- `test/unit.test.mjs:204` —— 总线订阅的**跨进程游标**：`fromSeq > this.seq` 必须被识别为「上个进程的游标」，
  收敛到当前 `seq`（`sub.epochReset === true`）后继续收实时事件，而不是被 `ev.seq <= sub.afterSeq` 永久吞掉；
  正常游标（`fromSeq === seq`）不许被误判。

### 6.4 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| **改了代码后行为没变** | **网关进程还是旧代码** | 见 §6.5：先杀旧进程再启动 |
| `任务全部 failed：无法启动 dsh 进程` | `dsh.node` / `dsh.binPath` 配错 | 用 `Test-Path` 核对两个绝对路径 |
| `plugin tree failed to load: credentials-local` | `.credentials.yaml` 格式不对（用了新格式或带 BOM） | 必须是**单行** `DEEPSEEK_API_KEY: sk-...`，UTF-8 无 BOM |
| `workspace 不在白名单内` | 白名单没配或路径不匹配 | `.\dsh-remote.cmd workspaces` 查看实际生效值 |
| 任务卡在 `queued` | 并发已满 | 看 `health.activeTasks`，或调大 `maxConcurrent` |
| 手机连不上 | 防火墙 / 地址写错 | 放开 8787 入站；先用 `http://<PC-IP>:8787/api/v1/health` 验证 |
| `429 rate_limited` | 触发限速（配对错误码多/令牌错多次） | 等 1 分钟，或检查 App 里的令牌是否正确 |
| 想清空历史 | —— | 停止网关后删除 `<dshHome>\tasks\*.json` |
| 令牌泄漏 | —— | `devices revoke <tokenId>` 后重新配对 |
| 日志里出现 `????` | 用 ANSI 代码页读取了 UTF-8 日志 | 用 `Get-Content -Encoding UTF8` 或 VS Code 打开 |
| **网关回显的 prompt 中文变成 `???`** | **客户端**（PS 5.1）用 cp936 编码了请求体，网关按 UTF-8 解码 | 见 §6.6：这不属于网关缺陷，改用显式 UTF-8 字节发送 |
| 任务 `failed`：`任务超时` | 超过 `timeoutSec`（默认 3600s） | 提交时显式给更大的 `timeoutSec` |

### 6.5 ⚠️ 改了代码后必须重启网关进程

Node 不会热加载已加载的模块：**源码改动只对新启动的进程生效**。
如果发现「代码明明改了，行为还是旧的」，请按下面两步确认并处理：

```powershell
# 1) 判断是否为旧进程：进程启动时间 早于 源文件最后修改时间 → 就是旧进程
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*gateway.mjs*' } |
  Select-Object ProcessId, CreationDate

Get-ChildItem .\lib\*.mjs, .\gateway.mjs | Select-Object Name, LastWriteTime

# 2) 停掉旧进程（只杀命令行为 gateway.mjs 的进程，不影响其它 Node 程序）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*gateway.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 3) 重新启动
.\dsh-remote.cmd serve
```

> 血的教训：曾出现「id 里混入 `undefined`」的验收问题，根因就是**旧进程仍在跑**
> （旧代码 + 旧启动参数），而非磁盘上的源码。

### 6.6 ⚠️ PowerShell 5.1 的中文编码坑（客户端侧，非网关缺陷）

**结论先行**：网关的 UTF-8 解码是正确的；中文变 `???` 是**发送端**把请求体按
ANSI/GBK(cp936) 编码造成的。已用三组对照实验定性：

| 组 | 发送方式 | 网关收到的 prompt | 判定 |
|---|---|---|---|
| A | 显式 `[System.Text.Encoding]::UTF8.GetBytes(json)` + `charset=utf-8` | `只回复：中文正常` ✅ | 网关解码正确 |
| B | `Invoke-RestMethod -Body <string>`（PS 5.1 默认行为） | `???:????` ❌ | 发送端用 cp936 编码 |
| C | 手工发 GBK(cp936) 字节 | 非法 UTF-8 → 被替换为 `?`(0x3F) | 解释了 B 的 `???` |

根因：中文区域设置下 Windows PowerShell 5.1 会把 `-Body <string>` 按 **cp936** 编码后发送，
而契约规定请求体为 UTF-8，网关按 UTF-8 解码 → 多字节字符被替换为 `?`。

```powershell
# ❌ 错误：PS 5.1 会用 cp936 编码字符串体，中文变 ???
Invoke-RestMethod -Uri $u -Method Post -ContentType 'application/json' `
  -Body (@{ prompt = '只回复：中文正常' } | ConvertTo-Json)

# ✅ 正确：自己编码成 UTF-8 字节再发送
$json  = @{ prompt = '只回复：中文正常'; workspace = 'D:\proj' } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$req   = [System.Net.HttpWebRequest]::Create($u)
$req.Method      = 'POST'
$req.ContentType = 'application/json; charset=utf-8'
$req.ContentLength = $bytes.Length
$req.Headers.Add('Authorization', "Bearer $token")
$stream = $req.GetRequestStream()
$stream.Write($bytes, 0, $bytes.Length)   # ← 写字节，不写字符串
$stream.Close()
$resp = $req.GetResponse()
$body = (New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)).ReadToEnd()
$body | ConvertFrom-Json
```

其他可选的正确姿势：

- 用 `curl.exe`（Windows 自带）并把 JSON 存成 UTF-8 无 BOM 文件：
  `curl.exe -s -X POST -H "Content-Type: application/json" --data-binary "@task.json" $u`
- 用 PowerShell 7+（`pwsh`）：其 `Invoke-RestMethod` 对 `-Body <string>` 默认按 UTF-8 发送。
- **手机 App 不受影响**：OkHttp 默认按 UTF-8 编码请求体。

> 排障提示：若怀疑是编码问题，先看网关回显的 `prompt` 字段是否与你发送的一致 ——
> 网关不做任何转码，收到什么字节就按 UTF-8 解出什么字符串。

---

### 6.7 双向同步（桌面端 runtime 通道）

> 契约细节与实测证据见 [协议契约 v2 §7.4/§7.5](../../docs/01-设计/协议契约-v2.md)；这里只讲**怎么确认、怎么排障、怎么回退**。
> **实现状态（2026-10-14 复核）**：**已接入** —— 适配层 `lib/desktop-api.mjs`（621 行，单一适配层，便于 DSH 升级时只改一处），
> 接线在 `lib/http.mjs:26,267-278`（能力探测）、`:895-919`（`writable`/`live`）、`:1000,1015,1048-1099`（轮次与 SSE），
> 以及 `lib/session-runner.mjs:47,516-1028`（`desktop` 注入、`#desktopSnapshot`、`session/prompt` + `session/follow` 轮次）。
> 配置开关 `desktop.enabled`（默认开）；关掉或桌面端不可达时**自动回退**旧语义（`writable:false`、`/turns` 409 `session_busy`）。
> **两处不一致已修（2026-10-14，契约 §7.5 的「实现侧对齐状态」表）**：①`driver` 改为常量
> `DRIVER_DESKTOP='desktop'`/`DRIVER_GATEWAY='gateway'`（`lib/http.mjs:235-236`、`lib/session-runner.mjs:72-73`），
> 并**贯穿四处同一套取值**：列表（`http.mjs:912`）、详情（`:974`）、`/turns` 202 回执（`session-runner.mjs:848`
> 电脑端、`:723` 手机任务）、`/abort` 200 回执（`:1024`，判定见 `http.mjs:1034`）；②`source:"phone"` 现**恒显式下发**
> `driver:"gateway"`。另修兜底 root 的 `source:'pc'` → `'computer'`（`http.mjs:262-264`）。
> **端到端实测（2026-10-14）**：列表 17 条电脑端会话全部 `writable:true`/`driver:"desktop"`，
> `/turns` → `202 {accepted:true, driver:"desktop", source:"computer"}`，SSE `turn.started`×2 → `message.delta`
> → `session.updated` → `turn.ended {reason:"completed", resumable:true}`，`asOfSeq 39→48`。
> 实测修掉两个缺陷：**详情 `live` 改以桌面端 `session/list.running` 为真值**（此前只用文件 mtime，刚跑完一轮的
> 60s 内会误报 `live:true`）；**重复投递收敛**（`session/follow` 与网关轮次通道曾同时产帧，一轮 3 个 `turn.started`
> → 现 2 个、`turn.ended` 唯一）。`test/v2.test.mjs` 目前**无** `driver` 断言。

**它在做什么**：手机对电脑端会话发的每一轮，都提交给**电脑端自己的 runtime** 执行
（`session/prompt`），事件再从 `session/follow` 流回网关转成既有 SSE。于是电脑端 UI 与手机看到的是
**同一个会话的同一条时间线**，不存在"手机另存一份历史"。

**前置条件（缺一不可）**

1. **桌面端 DSH 正在运行**，且其 runtime 在回环端口上可达（本机实测为 `127.0.0.1:19387`）。
2. 网关与桌面端**同机同用户**（凭据依赖当前用户的 `.dsh`）。

**怎么确认桌面端端口**：

```powershell
# 1) 找出桌面端进程占用的回环监听端口（19387 是本机实测值，不保证跨机一致）
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalAddress -in '127.0.0.1','::1' } |
  Select-Object LocalAddress, LocalPort, OwningProcess

# 2) 看是不是 DSH 的桌面/host 进程
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Select-Object ProcessId, CommandLine

# 3) 探活：桌面端 **没有** `/api/health` 之类的探活路由（实测 404），
#    适配层的探测方法是发一个极小 `session/list`（`lib/desktop-api.mjs:330-335` 的 probe()）
#    并比对返回的会话条数；最省事的判据仍是第 1 步（有没有回环监听端口）+ 第 2 步（进程是不是 DSH）。
```

**凭据在哪里（只读，不要复制到别处）**：

| 项 | 位置 / 形态 |
|---|---|
| 文件 | `%USERPROFILE%\.dsh\.credentials.yaml`（即桌面端自己的 home；不是 `dshHome`） |
| 取值 | `records:` → `client-connection/browser-session.payload.secret`，YAML 里是 **base64url** 编码的 32 字节 |
| 用途 | 派生 `dsh-auth-<base64url(sha256(authority))>` cookie：`v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256(secretBytes, body))>` |
| 关键约束 | 请求 `Host` 头必须是回环（`127.0.0.1:<port>`）；脱敏规则同 §5（日志里只留前 4 位） |

> 手动取值（PowerShell，只打印**长度**以确认读到，不打印明文）：

```powershell
$raw = Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml" -Raw
$m = [regex]::Match($raw, 'client-connection/browser-session[\s\S]{0,400}?secret:\s*"?([A-Za-z0-9_\-]+)"?')
if ($m.Success) {
  $b = [Convert]::FromBase64String($m.Groups[1].Value.Replace('-','+').Replace('_','/').PadRight(44,'='))
  "secret bytes = $($b.Length)"    # 期望 32
} else { 'credential not found' }
```

**失败表现与回退（必须按此处理，不要让故障扩散）**

| 现象 | 含义 | 应当的行为 |
|---|---|---|
| 探测不到回环端口 / health 无响应 | **桌面端没在运行**（或 `desktop.enabled=false`） | `source:"computer"` 的会话 `writable:false`（`writableReason:"desktop_disabled"`），退回只读镜像；`source:"phone"` 的能力**不受影响** |
| 401/403 或 cookie 校验失败 | 凭据读取失败（文件不在/格式变了/换用户跑） | 同上回退；日志给出可读原因，**不要**重试轰炸 |
| 方法名或形参名不匹配（`unknown method`、`bad_request`） | **DSH 升级改动了未公开线协议** | 同上回退；适配层需按新协议更新，**不要把错误抛给手机** |
| 会话已 `running` 且不是本网关提交的 | 电脑端自己在跑这一轮 | `409 session_busy`（文案不变），提示"该会话正由电脑端驱动" |
| 提交成功但长时间无事件 | `session/follow` 订阅没建立 | 视为该轮失败并回退；**不要**改用"网关自己重放历史" |

**哪些情况仍然不行（别浪费时间排查）**

1. **Windows 没有 flock**：DSH 的 `SessionAlreadyOwnedError` 互斥在这台机器上不会生效，
   所以"两个写入者同时抢同一会话"只能靠 `session/list.running` + 网关侧租赁**尽力而为**地避免。
2. **权限是电脑端的权限**：该通道等价于"手机持有这台 PC 上 DSH 的完整执行能力"。
   已按用户批准执行（两端同权，不设降权档），因此该通道**只允许回环**访问。
3. **DSH 一升级就可能失效**：这是它**未公开**的线协议；适配层是唯一的改动点，回退路径是
   §7.2 的 SDK profile（回退后电脑端会话退回只读）。

**自检（本通道是否真的在跑）**：对 `session/list` 里的一个会话发起一轮后，
看**电脑端**该会话的 `sessionStats`（turns/steps/decodeTokens）是否增长、`running` 是否在轮内为 `true`；
实测一次完整链路的形状是：`session/fork` → 新会话 → `session/prompt` → `{"accepted":true}` →
`running=true`、`seq 287→288→291`、`sessionStats.turns 2→3`，WS 订阅收到 29 个事件直到 `turn/end`。

### 6.8 手机新建任务落在电脑端（`host` / `createdBy`，网关 `2.1.0`）

> 契约侧全文见 [`docs/01-设计/协议契约-v2.md`](../../docs/01-设计/协议契约-v2.md) §4.2 与 §7.6；本节是**排障与验证**视角。

**是什么**：v2.4.0 只打通了「手机接电脑的会话」（对**已存在**的电脑端会话提交轮次）；`2.1.0` 让手机**新建**的任务
**原生**建在电脑端 DSH 的工作区里 —— 电脑端打开就是同一个会话，**不是接力、不是复制历史**。

**请求字段 `host`（可选）**

| 取值 | 行为 |
|---|---|
| 缺省 | 桌面端通道可用 → 落电脑端；未接入 → 落网关自有 home |
| `"desktop"` | 在电脑端 DSH 里新建会话（**必须同时给 `workspace`**） |
| `"gateway"` | 网关自有 `DSH_HOME`（SDK 子进程，**`access` 只在这个通道生效**） |

**错误码与逐字文案**（手机端应直接显示 `message`）：

| 场景 | 状态码 / `code` | `message`（逐字） |
|---|---|---|
| `host` 取值非法 | `400` `bad_request` | `host 只能是 desktop 或 gateway` |
| `host:"desktop"` 但缺 `workspace` | `400` `bad_request` | `在电脑端新建任务必须指定 workspace（电脑端是按工作区登记会话的）` |
| `host:"desktop"` 但网关未接桌面端 | `503` `desktop_unavailable` | `网关未接入桌面端 DSH runtime，无法在电脑端建会话；请改传 host:"gateway"，或先启动电脑端 DSH` |
| 建会话失败 | `502`（`code` 透传，如 `desktop_error`/`desktop_unauthorized`） | 前缀 `在电脑端创建会话失败：` |
| 会话**已建**、首轮投递失败 | `502`（`code` 透传） | `会话已在电脑端建立（sessionId=…），但首轮投递失败：…` |

> 最后两行不一样很重要：会话**已经真实存在于电脑端了**（也已登记进 `phone-sessions.json`），
> 手机端收到该错误时不要以为「什么都没发生」。

**202 回执**：

| 分支 | 关键字段 |
|---|---|
| 落电脑端 | `source:"computer"` `createdBy:"phone"` `driver:"desktop"` `host:"desktop"` `turnId` `fromSeq` `workspace` |
| 落网关自有 home | `source:"phone"` `createdBy:"phone"` `driver:"gateway"` `host:"gateway"` `turnId` `fromSeq` `access` |

**`createdBy`**：谁**发起**（`phone`/`desktop`）。它与 `source`（数据长在谁家）、`driver`（现在谁在驱动）
**各说各的事，不得互相反推**：落电脑端的手机任务 `source` 必然是 `computer`，靠 `<dshHome>/phone-sessions.json`
（见 §2 运行目录）记住「这条是手机发起的」。索引上限 500 条、**损坏/缺失按空索引继续** —— 最坏只是退化成
`createdBy:"desktop"`，**不影响任何执行路径**。

**落盘顺序（勿实现成「复制会话」）**：`workspace/create {path}`（幂等，拿 `workspaceId`）→
`session/create {workspaceId}` → 登记 `phone-sessions.json` → `session/prompt`。
**必须走 `workspaceId`、不能走 `cwd`**：实测走 `cwd` 建的会话**不登记进任何工作区**，随后
`workspace/insertSessionBefore` 报 `workspace/move-invalid … the session is not accounted`。
网关**从不写** DSH 自己的会话文件（`session.v4.jsonl.zstd`），只在 DSH 侧调用它的方法，
所以 DSH 的会话格式变化不会污染用户 home。

**两条限制（如实呈现，别在客户端美化）**：

1. `host:"desktop"` 时 **`access` 不生效**：权限来自桌面端 DSH 进程自己的 `DSH_PERMISSION_MODE`（全局、非每会话），
   `dsh-web-app/presets/standard.patch.yml` 里没有任何 permission/approval/sandbox 配置。
2. 电脑端会话若在 `approval/policy: ask` 下触发审批，**手机端无法应答**（Remote 方法表里没有批准/拒绝方法），
   该轮会**挂住**直到有人在电脑端 UI 批准。

**排查表**：

| 现象 | 原因 | 处置 |
|---|---|---|
| `503 desktop_unavailable` | 网关没接上桌面端 runtime | 先启动电脑端 DSH；或改传 `host:"gateway"` |
| `400 host 只能是 desktop 或 gateway` | 取值拼错 | 只有这两个值 |
| `400 …必须指定 workspace…` | `host:"desktop"` 但缺 `workspace` | 电脑端是**按工作区**登记会话的 |
| `502 在电脑端创建会话失败：…` | 桌面端调用失败 | 看 `logs/gateway-*.log` 里的 `desktop` 行 |
| `502 会话已在电脑端建立（sessionId=…），但首轮投递失败：…` | 会话**已存在**，只是首轮没投出去 | **不要**当"什么都没发生"——去电脑端看那条会话 |
| 手机端认不出"我发起的" | 老网关没有 `createdBy` | 按旧行为处理（`source === 'phone'`），**不要拒渲染** |

**自检**：跑一次**不带 `host`** 的 `POST /api/v2/tasks`，然后核四点 ——
① 回执含 `source:"computer"` + `createdBy:"phone"` + `driver:"desktop"`；
② `workspace/create` 之后再查该工作区的 `sessionIds`，**应含这条会话**（这是「电脑端能接手」的**唯一**判据，
不是"文件写在同一个目录"）；③ 电脑端该会话的 `sessionStats.turns` 应 +1（实测 `asOfSeq 15 → 20`、`live:false`、用时 2.7 s）；
④ `<dshHome>/phone-sessions.json` 里应出现该 `sessionId`。

**实测证据（2026-10-14，网关 `2.1.0`）**：端到端 `===== 结果：PASS =====`
（`/tasks` 落电脑端：最新 marker **`e2e-task-final` 19 项断言**〔当次 19 项；冻结版探针恒为 29 项，见验收报告 §13「两套 marker 的关系」〕；同探针早期跑为 `e2e-task-first`/`e2e-task-wsfix`。
**接手方向**：marker **`e2e-takeover-final4` 33 项断言** —— 电脑端亲手建的原生会话被手机 `POST /turns` 接手得
`202 {driver:"desktop", source:"computer", fromSeq:3}` 且 `resumable:true`，连续第 2 轮 `202 fromSeq:22`，
手机只旁观时电脑端自跑第 3 轮、手机实时收到 4 条帧，收尾 `asOfSeq 3 → 39`、`turns=3`。
**SSE 按会话过滤**：marker **`e2e-ssfilter-1`**，见 §4.3 与[变更记录](../../docs/06-项目管理/变更记录.md) §12.3 的 D-07）。

### 6.9 电脑端自己发起的轮次实时进总线（网关 `2.2.0`）

**是什么**：网关的会话总线过去只覆盖「手机经 `POST /turns` 投递的轮次」；用户在**电脑端 DSH 界面**里直接发起的轮次
（`source:"computer"`）一个事件都不广播，手机端只能靠进页面时的整份转录 —— 表现就是「能看见旧内容、答完 ask 之后
这条对话再也不往下更新」（用户 2026-10-15 报的原始现象）。

**怎么做**：新增 `lib/desktop-watch.mjs`（`DesktopTurnWatcher`），随网关常驻：每 `config.desktopWatch.pollMs`
（默认 2000ms）问一次桌面端 `session/list`，对 `running` 且**在网关镜像里的**会话 `session/follow`
（水位线 = `max(outline.seq, stats.seq)`，**不加 1** —— 加了会重放上一轮的末帧），再把帧按
`translateDesktopEvent` 转成总线事件（`turn.started` → `message.delta` / `tool.call` / `tool.result` → `turn.ended`），
每条都带 `source:"computer"` + `relayed:true`，作用域 `{sessionId}` 与手机端那条流一致。
**互斥**：`http.mjs` 的 `desktopSse` 探针在场（手机端自己直连桌面端看这条会话）时中继**让位**，避免同一条会话两份帧。

**配置与体检**：`desktopWatch.{enabled,pollMs,streamTimeoutMs,attachTimeoutMs}`，默认 `true / 2000 / 1800000 / 15000`；
`pollMs` 越界（<20ms）启动即 `ConfigError`（集成测试用 30ms）。`/api/v2/health` 的 `sessionRunner.desktopWatch`
给出 `active / watchable / polls / attaches / attachesFailed / relays / turnsEnded / lastError / lastPollAt`，
`capabilities` 新增 **`session.desktopRelay`**（判断"跑的是不是 `2.2.0` 代码"认它，别认版本号 ——
`config.json` 里的 `gatewayVersion` 会覆盖代码常量，见部署手册 §10.1.2）。

**关掉会怎样**：`enabled=false` → 电脑端发起的轮次对手机端**完全静音**（只剩进页面时的整份转录）。

**实测证据（2026-10-15，真实桌面端 + 生产网关 8787）**：

- 进程内总线探针 `.probe/relay-live-e2e.mjs`（`createGateway` 后只订阅总线、不 `listen()`）：真桌面端跑满一轮
  `turn.started turn=4` → 98 帧（`tool.call 27` / `tool.result 26` / `message.delta 17` / `session.updated 26`）
  → `turn.ended reason="completed" relayed=true`，日志 `text=23813 字 工具调用=18 次`，`verdict PASS`。
- 手机端同款 HTTP/SSE 探针 `.probe/relay-sse-e2e.mjs`（走 `/api/v2/sessions/stream`，与 App 的
  `ConsoleStreams.path()` 一致）：163 帧，其中电脑端来源 38 帧、37 帧带 `data.seq`，`verdict PASS`。
- 生产网关 `/api/v2/health` 现场读数：`desktopWatch:{active:["session-3d921c21-…"],watchable:40,polls:237,`
  `attaches:1,attachesFailed:0,relays:179,lastError:null}`；用户随后在真机上确认该会话「已经在实时更新」。

### 6.10 网关重启后客户端带着「上个进程的游标」重连（`lib/events.mjs`）

总线 `seq` 是**进程内**计数器，重启即从 1 重开；而客户端把游标持久化在本地（Android `ConsoleRepository.busCursor`
→ `PrefsStore.saveEventSeq`），重连时把**上个进程**的 `fromSeq` 发回来。旧实现直接把它设成订阅的 `afterSeq`，
`publish()` 里的 `ev.seq <= sub.afterSeq` 于是**静默吞掉该订阅的全部事件**：连接在线、心跳正常、界面一个字不动。
现在 `subscribe()` 把 `fromSeq > this.seq` 识别为跨进程游标 → 收敛到当前 `seq`、只接续实时事件，并回 `epochReset`
供 HTTP 层 warn 留痕（生产日志实证：`会话 SSE 客户端带着上一个进程的游标重连（fromSeq=283 > 本进程最大 seq），已改为只接续实时事件`）。
**不假装能补齐**：停机窗口里的事件在别的进程里，补不了 —— 客户端靠下一次整份转录刷新兜底。

---

## 7. 已知限制与设计取舍

1. **v1 的 `model` / `reasoningEffort` 仍不转发（只记录）**：`dsh --profile headless --help` 表明
   当前 headless profile **只接受「任务文本」一个位置参数**；追加 `--model` 会被并入任务文本、
   污染 prompt，因此 v1 的 `POST /api/v1/tasks` 把这两个字段保存在任务内部元数据里（不影响契约字段），
   **不会**传给 CLI。v1 如需切换模型，请改 `dsh.launcherArgs`（**只放启动器级参数**，如 `--patch <file>`）
   或通过 `dsh.env` 注入环境变量；**不要**把 `--model` 直接塞进 `launcherArgs`——
   headless 应用不认识它，同样会被当成任务文本的一部分。
   **v2 走的是另一条路（网关 `2.10.0` 起）**：`POST /api/v2/tasks` 的 `provider`/`model`/`reasoningEffort`
   会真的生效（目录走 `GET /api/v2/models`），两条宿主路径各自的落点与**真实的限制**如下 —— 见 §4.4 与契约 §7.8：
   - `host:"desktop"`：建会话之后、**首轮投递之前**发 `session/selectModel`。桌面端那个 RPC 的语义是
     "为这个会话选定模型，**并在后台顺手保存桌面端默认模型**" —— 也就是和用户在电脑端 GUI 里点一次模型
     **完全等价**：手机端选一次，电脑端下次新开会话的默认模型也会跟着变。这是它的原生行为，不是网关加戏。
   - `host:"gateway"`：模型经 SDK `initialize` 握手下发，而 SDK 运行时是**每会话一个进程**、模型在
     **进程启动时**就固定了 —— 所以模型是**每任务/每进程**的粒度：**给已经在跑的会话再传一次模型会被有意忽略**
     （该会话仍用它启动时那个模型），网关**不会**为了换模型去重启运行时（重启等于杀掉正在跑的轮次）。
     要换模型就**新建任务**；`host:"desktop"` 下的会话，切换同样在"下一次组合 agent"时才生效。
2. **`busy` 的触发条件**：契约 §3.1 写「并发已满 → 429 busy」，而需求又要求超出并发要排队。
   二者兼容的实现是：并发满 → 进 `queued`；**只有 `queued` 达到 `maxQueue` 才 429 busy**
   （`maxQueue=0` 表示不允许排队）。
3. **`DELETE` 活动任务返回 409 `conflict`**、**请求体超限返回 413 `payload_too_large`**：
   这两个错误码已作为**契约 v1.1 §0 枚举的正式成员**（裁定补充表 A7/A5），不再是临时扩展。
4. **`sessionId` 是「尽力而为」**：headless CLI 不打印 session id，网关通过
   `<dshHome>/sessions/<cwd 编码目录>/session-<uuid>/` 的**新增条目**反查；
   若并发导致候选不唯一，则返回 `null`（宁可缺失也不写错）。
5. **`config.json` 不入库**：仓库只保留 `config.example.json`；`config.json` 含本机绝对路径，
   由 `scripts/setup-pc.ps1` 生成并被 `.gitignore` 忽略。
6. **网关重启会中断运行中的任务**：重启后 `queued`/`running` 任务统一标记为
   `failed`（`网关重启，任务执行已中断`），不会留下永远 running 的僵尸任务。
7. **明文 HTTP**：默认监听 `0.0.0.0:8787` 且为明文，只适合家庭内网；
   外网必须叠加 TLS（Tailscale / frp+TLS / Cloudflare Tunnel），**禁止裸端口映射到公网**。
8. **中继的重启窗口不补**（`2.2.0`）：`desktop-watch` 以"订阅那一刻的水位线"接入，网关停机期间电脑端产生的事件
   不会重放；客户端靠下一次整份转录刷新兜底，所以重启后手机端可能出现一次文本空档（真机本轮未观察到）。
9. **`desktopWatch` 的轮询成本**：默认 2000ms 一次 `session/list`；会话多时（真机 145 条、含 109 条子代理）
   镜像扫描已改为**惰性**（只在确实需要时重扫），但 `attaches`/`relays` 仍随"电脑端同时在跑的会话数"线性增长。
10. **跨进程游标只收敛、不补齐**（`2.2.0`）：见 §6.10 —— 停机窗口里的事件在**别的进程**里，网关拿不回来；
    想让手机端拿到停机期间的内容，只能靠客户端重新拉整份转录（App 在 SSE 重连后本来就会做）。
11. **看门狗是必需品**：本轮生产网关控制台日志里出现过 `^C`（同控制台/同作业对象的终止信号波及），
    进程退出后由 `scripts/watchdog-gateway.ps1` 在 60 秒内拉起；没有它，手机端会静默失联到人工重启。
12. **`GET /api/v2/models` 永不 503、也不缓存**：选择器是手机端常驻控件，而"电脑端没在跑"是正常稳态
    （用户可能就在手机上发任务，电脑那边 DSH 没开）。拉不到目录时回 `200` + `source:"config"`
    + 网关配置里那一个默认模型，降级原因放进 `failures`（`[{id:"desktop",name:"电脑端",message:"…"}]`）给用户看
    —— 只写日志＝用户永远看不出「列表里为什么只剩一个模型」。`source` 是手机端区分"真目录 / 仅网关默认"的唯一判据。
    另外这里**刻意不做缓存**：目录是电脑端的内存态（用户可能刚装了一个 provider），
    缓存只会让手机端看到过期列表；一次 RPC 的成本远低于一次"选了但用不上"的困惑。
